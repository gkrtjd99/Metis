import { invariant } from "./errors.js";
import { parseJson } from "./util.js";

export function ownerHostCapability(config, host) {
  const capability = config.delegation?.ownerExecution?.hosts?.[host];
  const supported = capability?.childSpawning === true
    && ["host-session", "nested-agent", "host-relay"].includes(capability.mode)
    && typeof capability.evidence === "string" && capability.evidence.trim().length > 0;
  return {
    supported,
    mode: supported ? capability.mode : null,
    evidence: supported ? capability.evidence.trim() : null
  };
}

export function assertOwnerSession(db, runId, ownerTaskId, leaseToken, config) {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  invariant(run?.status === "active", "RUN_NOT_ACTIVE", "Owner는 활성 run에서만 작업할 수 있습니다.");
  invariant(Date.parse(run.controller_expires_at) > Date.now(), "CONTROLLER_EXPIRED", "Main controller lease가 만료되었습니다.");
  const owner = db.prepare("SELECT * FROM tasks WHERE id = ? AND run_id = ?").get(ownerTaskId, runId);
  invariant(owner?.role === "coordinator" && owner.status === "running" && Boolean(owner.read_only),
    "OWNER_NOT_RUNNING", "실행 중인 읽기 전용 coordinator만 subtree를 운영할 수 있습니다.");
  const leases = db.prepare("SELECT token, fencing_token, expires_at FROM leases WHERE task_id = ?").all(owner.id);
  invariant(typeof leaseToken === "string" && leaseToken.length > 0 && leases.length > 0
    && leases.every((lease) => lease.token === leaseToken), "OWNER_LEASE_INVALID", "Owner lease가 일치하지 않습니다.");
  invariant(leases.every((lease) => Number(lease.fencing_token) === Number(owner.attempt_fence)
    && Date.parse(lease.expires_at) > Date.now()), "OWNER_FENCED", "Owner attempt가 만료되거나 교체되었습니다.");
  const receipt = db.prepare(`
    SELECT a.host_receipt, b.controller_fencing_token FROM task_spawn_acks a
    JOIN scheduler_batches b ON b.id = a.batch_id
    WHERE a.task_id = ? AND a.attempt_fence = ? AND b.run_id = ?
  `).get(owner.id, Number(owner.attempt_fence), runId);
  invariant(receipt?.host_receipt?.trim(), "OWNER_RECEIPT_REQUIRED", "Owner에 실제 host spawn receipt가 필요합니다.");
  invariant(Number(receipt.controller_fencing_token) === Number(run.controller_fencing_token),
    "OWNER_FENCED", "Owner를 실행한 controller fence가 교체되었습니다.");
  const capability = ownerHostCapability(config, run.host);
  invariant(capability.supported, "NESTED_DELEGATION_UNSUPPORTED",
    "하위 agent를 실행할 수 있는 owner host/session capability를 먼저 등록해야 합니다.", { host: run.host });
  invariant(Number(config.orchestration.maxConcurrent) >= 2, "OWNER_CONCURRENCY", "Owner 실행에는 공통 슬롯이 최소 2개 필요합니다.");
  invariant(owner.phase === run.phase, "OWNER_PHASE", "Owner phase가 현재 run과 다릅니다.");
  return { owner, run, receipt: receipt.host_receipt, capability };
}

export function ownerBatch(db, session, batchId) {
  const batch = db.prepare("SELECT * FROM scheduler_batches WHERE id = ?").get(batchId);
  invariant(batch?.run_id === session.run.id && batch.parent_task_id === session.owner.id,
    "OWNER_BATCH_SCOPE", "다른 owner의 batch에는 접근할 수 없습니다.");
  const items = parseJson(batch.batch_json, []);
  invariant(Number(batch.controller_fencing_token) === Number(session.run.controller_fencing_token)
    && items.length > 0 && items.every((item) => Number(item.ownerAttemptFence) === Number(session.owner.attempt_fence)),
  "OWNER_FENCED", "Batch가 현재 owner attempt에 속하지 않습니다.");
  return { ...batch, items };
}

export function assertOwnerBatchSession(db, batch, config) {
  const lease = db.prepare("SELECT token FROM leases WHERE task_id = ? LIMIT 1").get(batch.parent_task_id);
  const session = assertOwnerSession(db, batch.run_id, batch.parent_task_id, lease?.token, config);
  ownerBatch(db, session, batch.id);
  return session;
}

export function assertOwnerSpawnReceipts(db, session, receipts) {
  const used = new Set();
  for (const [taskId, hostReceipt] of receipts) {
    invariant(hostReceipt !== session.receipt.trim(), "OWNER_INDEPENDENCE", "Owner와 하위 agent는 별도 host 세션이어야 합니다.");
    invariant(!used.has(hostReceipt), "OWNER_INDEPENDENCE", "하위 작업마다 독립 host receipt가 필요합니다.");
    used.add(hostReceipt);
    const reused = db.prepare(`
      SELECT 1 FROM task_spawn_acks a JOIN tasks t ON t.id = a.task_id
      WHERE t.parent_task_id = ? AND a.task_id <> ? AND a.host_receipt = ? LIMIT 1
    `).get(session.owner.id, taskId, hostReceipt);
    invariant(!reused, "OWNER_INDEPENDENCE", "실행과 검증에 동일한 agent를 재사용할 수 없습니다.");
  }
}

export function ownerVerificationGaps(db, ownerTaskId) {
  const children = db.prepare("SELECT id, role, status, read_only, attempt_fence FROM tasks WHERE parent_task_id = ?").all(ownerTaskId);
  const receiptFor = (id) => db.prepare(`
    SELECT a.host_receipt FROM task_spawn_acks a JOIN tasks t ON t.id = a.task_id
    WHERE a.task_id = ? AND a.attempt_fence = t.attempt_fence
  `).get(id)?.host_receipt?.trim();
  const ownerReceipt = receiptFor(ownerTaskId);
  const dependencies = new Map(children.map((child) => [child.id, db.prepare("SELECT depends_on FROM task_dependencies WHERE task_id = ?").all(child.id).map((row) => row.depends_on)]));
  function dependsOn(taskId, target, visited = new Set()) {
    if (visited.has(taskId)) return false;
    visited.add(taskId);
    return (dependencies.get(taskId) ?? []).some((id) => id === target || dependsOn(id, target, visited));
  }
  const verifiers = children.filter((child) => child.role === "verifier" && Boolean(child.read_only) && child.status === "completed");
  return children.filter((child) => !Boolean(child.read_only) && child.status !== "waived"
    && !verifiers.some((verifier) => {
      const receipt = receiptFor(verifier.id);
      const workerReceipt = receiptFor(child.id);
      return ownerReceipt && workerReceipt && receipt && workerReceipt !== ownerReceipt
        && receipt !== ownerReceipt && receipt !== workerReceipt && dependsOn(verifier.id, child.id);
    })).map((child) => child.id);
}
