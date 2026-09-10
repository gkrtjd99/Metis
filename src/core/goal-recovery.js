import { buildMainContext } from "./context.js";
import { boundGoalDocuments } from "./goal-documents.js";
import { getGoalContract, validateSourceDocument } from "./contracts.js";
import { getRun, plannedExecutionApprovalStatus } from "./state.js";
import { invariant, MetisError } from "./errors.js";
import { redactSecrets, truncateMiddle } from "./util.js";

function bound(value, fallback, maximum) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.max(1, Math.min(maximum, Math.floor(number))) : fallback;
}

// 원본 경로는 사용하지 않는다. 계약이 가리키는 저장 당시 snapshot만 인증한다.
function sourceSnapshot(db, root, runId, contract) {
  const source = contract?.route?.sourceDocument;
  if (source === undefined || source === null) return null;
  invariant(source && typeof source.artifactId === "string" && /^[-A-Za-z0-9_.]{1,128}$/u.test(source.artifactId)
    && typeof source.contentRef === "string" && /^obj_[0-9a-f]{64}$/u.test(source.contentRef),
  "GOAL_SOURCE_INVALID", "계약 원본 snapshot handle이 올바르지 않습니다.");
  let handle;
  try { handle = validateSourceDocument(db, root, runId, source); }
  catch (error) {
    if (error instanceof MetisError) throw error;
    throw new MetisError("GOAL_SOURCE_AUTH_FAILED", "계약 원본 snapshot 인증에 실패했습니다.");
  }
  return {
    ...handle,
    loadInstructions: {
      artifact: `metis artifact get ${handle.artifactId}`,
      object: `metis object get ${source.contentRef}`
    }
  };
}

/** 인증된 controller가 호출한다. 실행 권한을 획득하거나 다음 동작을 실행하지 않는다. */
export function restoreGoalContext(db, root, runId, config, options = {}) {
  const run = getRun(db, runId);
  const contract = getGoalContract(db, run.id);
  const sourceDocument = sourceSnapshot(db, root, run.id, contract);
  const documents = boundGoalDocuments(db, root, run.id, sourceDocument);
  const limit = bound(options.limit, 8, 20);
  const textLimit = bound(options.textLimit, 240, 600);
  const text = (value) => value == null ? null : truncateMiddle(redactSecrets(String(value)), textLimit);
  const id = (value) => value == null ? null : truncateMiddle(redactSecrets(String(value)), 128);
  const list = (table, columns, where, order, project) => {
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ? ${where}`).get(run.id).count);
    const rows = db.prepare(`SELECT ${columns} FROM ${table} WHERE run_id = ? ${where} ORDER BY ${order} LIMIT ?`).all(run.id, limit);
    return { items: rows.map(project), limit, total, omitted: Math.max(0, total - rows.length) };
  };
  const artifactHandle = (row) => row ? {
    artifactId: id(row.id), kind: id(row.kind), status: id(row.status), contentRef: id(row.content_ref),
    loadInstructions: { artifact: `metis artifact get ${id(row.id)}`, object: row.content_ref ? `metis object get ${id(row.content_ref)}` : null }
  } : null;
  const latestHandle = (kind) => artifactHandle(db.prepare(`
    SELECT id, kind, status, content_ref FROM artifacts WHERE run_id = ? AND kind = ?
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(run.id, kind));
  const approval = plannedExecutionApprovalStatus(db, root, run.id, config);
  const next = {
    type: contract ? "QUERY_NEXT" : "INTAKE_REQUIRED",
    command: `metis next --run ${run.id} --pretty`,
    instruction: contract
      ? "현재 controller 인증으로 next를 별도 조회하세요. 복원은 다음 동작이나 승인을 실행하지 않습니다."
      : "Goal Contract가 없습니다. 원래 요청을 기준으로 intake를 완료하고 계약을 동결하세요."
  };
  const context = buildMainContext(db, root, run.id, config, {
    recovery: true,
    recoveryLimit: limit,
    recoveryTextLimit: textLimit,
    tokenBudget: options.tokenBudget,
    action: next
  });
  // journal payload, credential metadata, worker 결과는 projection에 포함하지 않는다.
  const journal = db.prepare("SELECT COUNT(*) AS entryCount, MAX(sequence) AS lastSequence FROM journal WHERE run_id = ?").get(run.id);
  return {
    protocol: "metis.goal-recovery.v1",
    status: contract ? "restored" : "intake-required",
    run: { id: id(run.id), phase: id(run.phase), status: id(run.status), revision: run.revision },
    originalRequest: {
      kind: sourceDocument ? "prd-snapshot" : "run-goal",
      runId: id(run.id), field: "runs.goal", goal: text(run.goal),
      goalOmittedChars: Math.max(0, String(run.goal).length - textLimit),
      sourceDocument
    },
    contract: contract ? {
      id: id(contract.id), version: contract.version, contractHash: id(contract.contract_hash),
      artifact: artifactHandle(db.prepare(`
        SELECT id, kind, status, content_ref FROM artifacts
        WHERE run_id = ? AND kind = 'goal-contract' AND json_extract(metadata_json, '$.contractId') = ?
        ORDER BY updated_at DESC, id DESC LIMIT 1
      `).get(run.id, contract.id))
    } : null,
    documents,
    planSeal: latestHandle("plan"),
    planReview: latestHandle("plan-review"),
    decisions: list("decisions", "id, title, decision, status", "AND status IN ('active', 'needs-review')", "updated_at DESC, id", (row) => ({
      id: id(row.id), title: text(row.title), decision: text(row.decision), status: id(row.status)
    })),
    tasks: list("tasks", "id, title, status, role, phase", "", "updated_at DESC, id", (row) => ({
      id: id(row.id), title: text(row.title), status: id(row.status), role: id(row.role), phase: id(row.phase)
    })),
    activeAttempts: list("task_attempts", "id, task_id, attempt_number, status, start_at", "AND terminal_at IS NULL", "start_at DESC, id", (row) => ({
      id: id(row.id), taskId: id(row.task_id), attemptNumber: row.attempt_number, status: id(row.status), startedAt: id(row.start_at)
    })),
    failedOrBlockedTasks: list("tasks", "id, title, status", "AND status IN ('failed', 'blocked')", "updated_at DESC, id", (row) => ({
      id: id(row.id), title: text(row.title), status: id(row.status)
    })),
    pendingCheckpoints: list("checkpoints", "id, kind, reason, blocking", "AND status = 'pending'", "created_at DESC, id", (row) => ({
      id: id(row.id), kind: id(row.kind), reason: text(row.reason), blocking: Boolean(row.blocking)
    })),
    executionApproval: { required: approval.required, pass: approval.pass, checkpointId: id(approval.checkpointId) },
    journal: { entryCount: Number(journal.entryCount), lastSequence: journal.lastSequence ?? 0 },
    controller: { authentication: "caller-required", takeoverPerformed: false },
    limits: { listItems: limit, textChars: textLimit },
    context,
    next,
    effects: { contextSnapshotMayBeWritten: true, executionPerformed: false, approvalPerformed: false }
  };
}
