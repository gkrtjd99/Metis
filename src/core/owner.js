import { transaction } from "./db.js";
import { invariant } from "./errors.js";
import { assertOwnerSession, ownerBatch, ownerVerificationGaps } from "./owner-authority.js";
import { abortScheduleBatch, acknowledgeScheduleSpawn, claimSchedule, handleChildTerminal, heartbeatScheduleBatch, proposeSchedule, refreshScheduleBatch } from "./scheduler.js";
import { getTask, heartbeatTask } from "./tasks.js";

function scopedOptions(session, lease, config, options = {}) {
  const maximum = Number(config.delegation?.ownerExecution?.maxConcurrentChildren ?? 4);
  invariant(Number.isInteger(maximum) && maximum > 0, "OWNER_CONCURRENCY", "Owner 동시 실행 한도는 양의 정수여야 합니다.");
  const requested = Number(options.limit ?? maximum);
  invariant(Number.isInteger(requested) && requested > 0, "OWNER_CONCURRENCY", "요청한 동시 실행 한도는 양의 정수여야 합니다.");
  return {
    parentTaskId: session.owner.id,
    ownerLease: lease,
    ownerAttemptFence: Number(session.owner.attempt_fence),
    owner: `owner:${session.owner.id}:${session.owner.attempt_fence}`,
    controllerFencingToken: Number(session.run.controller_fencing_token),
    limit: Math.min(requested, maximum)
  };
}

export function ownerNext(db, root, runId, ownerTaskId, lease, config) {
  const session = assertOwnerSession(db, runId, ownerTaskId, lease, config);
  const rows = db.prepare("SELECT id, role, status, phase FROM tasks WHERE parent_task_id = ? ORDER BY wave, id").all(ownerTaskId);
  const children = rows.slice(0, 24).map((row) => {
    const child = getTask(db, row.id);
    return {
      taskId: child.id, role: child.role, status: child.status,
      summary: String(child.result?.Summary ?? "").slice(0, 400)
    };
  });
  const common = { ownerTaskId, attemptFence: Number(session.owner.attempt_fence), childCount: rows.length, children, childrenTruncated: rows.length > children.length };
  const blockers = rows.filter((child) => ["failed", "blocked"].includes(child.status) || child.phase !== session.owner.phase);
  if (blockers.length) return { ...common, type: "ESCALATE_TO_MAIN", taskIds: blockers.map((child) => child.id), reason: "승인된 task의 실패 또는 phase 변경은 Main에 재계획을 요청해야 합니다." };
  if (rows.length === 0) return { ...common, type: "ESCALATE_TO_MAIN", reason: "승인된 하위 작업이 없습니다. 작업 문서와 plan을 먼저 구성해야 합니다." };
  if (rows.every((child) => ["completed", "waived"].includes(child.status))) {
    const missing = ownerVerificationGaps(db, ownerTaskId);
    return missing.length
      ? { ...common, type: "ESCALATE_TO_MAIN", taskIds: missing, reason: "변경 작업에 의존하는 독립 verifier의 완료 증거가 없습니다." }
      : { ...common, type: "OWNER_READY_TO_FINISH", instruction: "하위 증거를 참조하는 bounded 결과를 작성하고 자신의 task finish를 실행하세요. Main에는 owner 완료만 보고하세요." };
  }
  const proposal = proposeSchedule(db, root, runId, config, scopedOptions(session, lease, config));
  if (proposal.batch.length) return {
    ...common, type: "SPAWN_BATCH", delivery: session.capability.mode === "host-relay" ? "host-relay" : "direct",
    tasks: session.capability.mode === "host-relay"
      ? proposal.batch.map((item) => ({ taskId: item.taskId, role: item.role })) : proposal.batch,
    deferred: proposal.deferred
  };
  const batches = db.prepare("SELECT id FROM scheduler_batches WHERE parent_task_id = ? AND status IN ('claimed','prepared','partially-spawned','spawned')").all(ownerTaskId);
  const currentBatches = batches.filter((batch) => {
    try { ownerBatch(db, session, batch.id); return true; } catch { return false; }
  });
  return {
    ...common, type: "WAIT_FOR_CHILDREN", schedulerBatchIds: currentBatches.map((batch) => batch.id),
    heartbeatSeconds: Number(config.orchestration.leaseHeartbeatSeconds),
    instruction: "현재 owner 세션을 유지하고 하위 완료 이벤트 또는 의존성 해제를 기다리세요. Main의 next loop를 호출하지 마세요."
  };
}

export function claimOwnerSchedule(db, root, runId, ownerTaskId, lease, config, options = {}) {
  const session = assertOwnerSession(db, runId, ownerTaskId, lease, config);
  const claimed = claimSchedule(db, root, runId, config, scopedOptions(session, lease, config, options));
  if (session.capability.mode !== "host-relay") return claimed;
  return {
    action: claimed.batchId ? "RELAY_BATCH" : "NO_RUNNABLE_TASKS",
    ownerTaskId, batchId: claimed.batchId ?? null,
    batch: claimed.batch.map((item) => ({ taskId: item.taskId, role: item.role, attemptFence: item.attemptFence })),
    instruction: "준비된 batch는 최상위 host의 relay 대기열에 등록됩니다. 중첩 spawn이나 Main 권한 요청 없이 자신의 세션과 heartbeat를 유지하며 owner next로 진행 상태를 확인하세요."
  };
}

export function acknowledgeOwnerSpawn(db, root, runId, ownerTaskId, lease, config, batchId, taskIds, receipts) {
  return transaction(db, () => {
    const session = assertOwnerSession(db, runId, ownerTaskId, lease, config);
    ownerBatch(db, session, batchId);
    return acknowledgeScheduleSpawn(db, runId, batchId, taskIds, `owner:${ownerTaskId}:${session.owner.attempt_fence}`, config, receipts);
  });
}

export function heartbeatOwner(db, root, runId, ownerTaskId, lease, config, batchId = null) {
  return transaction(db, () => {
    const session = assertOwnerSession(db, runId, ownerTaskId, lease, config);
    if (batchId) ownerBatch(db, session, batchId);
    const owner = heartbeatTask(db, runId, ownerTaskId, lease, config);
    return { owner, batch: batchId ? heartbeatScheduleBatch(db, runId, batchId, config) : null };
  });
}

export function abortOwnerBatch(db, root, runId, ownerTaskId, lease, config, batchId, reason) {
  const session = assertOwnerSession(db, runId, ownerTaskId, lease, config);
  ownerBatch(db, session, batchId);
  return abortScheduleBatch(db, root, runId, batchId, reason);
}

export function ownerChildFailure(db, root, runId, ownerTaskId, lease, config, batchId, taskId, outcome) {
  const session = assertOwnerSession(db, runId, ownerTaskId, lease, config);
  ownerBatch(db, session, batchId);
  return handleChildTerminal(db, root, runId, batchId, taskId, outcome, config);
}

export function ownerBatchStatus(db, root, runId, ownerTaskId, lease, config, batchId) {
  const session = assertOwnerSession(db, runId, ownerTaskId, lease, config);
  ownerBatch(db, session, batchId);
  return refreshScheduleBatch(db, batchId);
}
