import { transaction } from "./db.js";
import { invariant } from "./errors.js";
import { assertOwnerBatchSession, ownerBatch, ownerHostCapability } from "./owner-authority.js";
import { assertController } from "./ownership.js";

function relayBatch(db, runId, batchId, config) {
  const row = db.prepare("SELECT * FROM scheduler_batches WHERE id = ? AND run_id = ?").get(batchId, runId);
  invariant(row?.parent_task_id, "OWNER_RELAY_SCOPE", "Relay는 현재 run의 owner batch만 전달할 수 있습니다.");
  const session = assertOwnerBatchSession(db, row, config);
  invariant(session.capability.mode === "host-relay", "OWNER_RELAY_MODE", "이 owner는 최상위 host relay 방식으로 설정되지 않았습니다.");
  invariant(["prepared", "partially-spawned", "spawned"].includes(row.status), "OWNER_RELAY_STATUS", "준비가 끝난 batch만 relay할 수 있습니다.");
  const batch = ownerBatch(db, session, batchId);
  const accepted = new Set(db.prepare("SELECT task_id FROM task_spawn_acks WHERE batch_id = ?").all(batchId).map((ack) => ack.task_id));
  const pending = batch.items.filter((item) => !accepted.has(item.taskId));
  for (const item of pending) {
    const task = db.prepare("SELECT parent_task_id, status, attempt_fence FROM tasks WHERE id = ? AND run_id = ?").get(item.taskId, runId);
    invariant(task?.parent_task_id === session.owner.id && task.status === "running"
      && Number(task.attempt_fence) === Number(item.attemptFence), "OWNER_RELAY_FENCED", "하위 task가 현재 owner batch의 실행 attempt에 속하지 않습니다.");
    const leases = db.prepare("SELECT token, fencing_token, expires_at FROM leases WHERE task_id = ?").all(item.taskId);
    invariant(leases.length > 0 && leases.every((lease) => lease.token === item.leaseToken
      && Number(lease.fencing_token) === Number(item.attemptFence)
      && Date.parse(lease.expires_at) > Date.now()), "OWNER_RELAY_FENCED", "하위 task lease가 만료되거나 교체되었습니다.");
    invariant(item.spawn && item.contract && item.workspacePath, "OWNER_RELAY_UNPREPARED", "Relay할 실행 계약과 workspace가 준비되지 않았습니다.");
    const spawn = item.spawn;
    invariant(spawn.protocol === "metis.spawn.v1" && spawn.host === session.run.host
      && spawn.run_id === runId && spawn.parent_task_id === session.owner.id
      && spawn.task_name === item.taskId && spawn.batch_id === batchId
      && Number(spawn.attempt_fence) === Number(item.attemptFence)
      && spawn.workspace_path === item.workspacePath && spawn.workspace_mode === item.workspaceMode
      && spawn.completion_owner === session.owner.id
      && spawn.terminal_handoff?.task_id === item.taskId && spawn.terminal_handoff?.lease === item.leaseToken,
    "OWNER_RELAY_CONTRACT", "저장된 실행 descriptor가 현재 host·task·batch 계약과 일치하지 않습니다.");
  }
  return { session, batch, pending };
}

export function ownerRelayRequests(db, runId, config) {
  const run = db.prepare("SELECT host FROM runs WHERE id = ?").get(runId);
  const capability = ownerHostCapability(config, run?.host);
  if (!capability.supported || capability.mode !== "host-relay") return { requests: [], truncated: false };
  const rows = db.prepare(`
    SELECT id, parent_task_id FROM scheduler_batches
    WHERE run_id = ? AND parent_task_id IS NOT NULL AND status IN ('prepared', 'partially-spawned')
    ORDER BY created_at, id LIMIT 25
  `).all(runId);
  const requests = rows.slice(0, 24).flatMap((row) => {
    try {
      const { pending } = relayBatch(db, runId, row.id, config);
      return pending.length ? [{ batchId: row.id, ownerTaskId: row.parent_task_id, pendingCount: pending.length, status: "ready" }] : [];
    } catch (error) {
      if (!error.code?.startsWith("OWNER_") && !["CONTROLLER_EXPIRED", "RUN_NOT_ACTIVE", "NESTED_DELEGATION_UNSUPPORTED"].includes(error.code)) throw error;
      return [{ batchId: row.id, ownerTaskId: row.parent_task_id, status: "blocked", code: error.code }];
    }
  });
  return { requests, truncated: rows.length > 24 };
}

export function readOwnerRelayBatch(db, runId, batchId, credentials, config) {
  return transaction(db, () => {
    assertController(db, runId, credentials);
    const { session, batch, pending } = relayBatch(db, runId, batchId, config);
    return {
      protocol: "metis.owner-relay.v1",
      host: session.run.host,
      runId,
      ownerTaskId: session.owner.id,
      ownerHostReceipt: session.receipt,
      ownerAttemptFence: Number(session.owner.attempt_fence),
      controllerFencingToken: Number(session.run.controller_fencing_token),
      batchId: batch.id,
      action: pending.length ? "SPAWN_BATCH" : "NO_PENDING_SPAWNS",
      batch: pending.map((item) => ({
        taskId: item.taskId,
        attemptFence: item.attemptFence,
        workspacePath: item.workspacePath,
        workspaceMode: item.workspaceMode,
        spawn: item.spawn
      })),
      instruction: "최상위 host에서 기존 task별 idempotency key로 별도 agent를 생성하세요. 재조회는 새 실행 요청이 아니므로 host 기록을 먼저 확인하고, 실제 receipt만 schedule ack로 기록하세요. Controller credentials를 하위 agent에 전달하지 마세요. 작업 판단과 완료 처리는 parent owner가 유지합니다."
    };
  });
}
