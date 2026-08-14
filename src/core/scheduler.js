import { assertBudgetAvailable, budgetStatus, consumeBudget, estimateEffortUsage } from "./budget.js";
import { compactTaskContract } from "./context.js";
import { transaction } from "./db.js";
import { MetisError, invariant } from "./errors.js";
import { activeLeases, runnableTasks, taskConflicts } from "./graph.js";
import { getRun, latestArtifact, recordEvent, touchRun } from "./state.js";
import {
  bindTaskAttemptBatch,
  captureTaskBaseline,
  finalizeTaskAttempt,
  getTask,
  heartbeatTask,
  listTasks,
  markTaskAttemptSpawnAccepted,
  startTaskAttempt,
  subjectArtifactKind,
  taskContract
} from "./tasks.js";
import { escalateModelRoute } from "./model-routing.js";
import { renderSpawnDescriptor } from "../adapters/spawn-descriptors.js";
import { cleanupTaskWorkspace, prepareTaskWorkspace } from "./worktrees.js";
import { json, makeId, now, parseJson } from "./util.js";
import { compileTaskPacket, taskPacketStatus } from "./task-packets.js";

const ROLE_WEIGHT = Object.freeze({
  "design-critic": 100,
  "plan-critic": 100,
  reviewer: 95,
  "security-reviewer": 98,
  "database-reviewer": 96,
  "performance-reviewer": 94,
  "accessibility-reviewer": 94,
  "migration-reviewer": 96,
  "adversarial-reviewer": 100,
  "task-compiler": 99,
  diagnostician: 97,
  synthesizer: 88,
  integrator: 90,
  coordinator: 85,
  verifier: 80,
  designer: 78,
  planner: 78,
  researcher: 72,
  scout: 70,
  worker: 60,
  curator: 55
});

// better-sqlite3 and workspace preparation are synchronous. Host fanout is
// still bounded by orchestration.maxConcurrent (normally four or eight), but
// preparation itself is one serialized lane.
export const SCHEDULER_PREPARATION_CONCURRENCY = 1;

function criticalPathLengths(tasks) {
  const memo = new Map();
  function visit(id, stack = new Set()) {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    const children = tasks.filter((task) => task.dependsOn.includes(id));
    const value = children.length ? 1 + Math.max(...children.map((child) => visit(child.id, new Set(stack)))) : 1;
    memo.set(id, value);
    return value;
  }
  for (const task of tasks) visit(task.id);
  return memo;
}

function taskScore(task, criticalPath) {
  const complexity = { low: 0, medium: 5, high: 10, critical: 15 }[task.complexity] ?? 5;
  const risk = { low: 0, medium: 3, high: 8, critical: 12 }[task.risk] ?? 3;
  return Number(task.priority) * 10
    + Number(criticalPath.get(task.id) ?? 1) * 25
    + Number(ROLE_WEIGHT[task.role] ?? 50)
    + complexity + risk
    - Number(task.escalation_level ?? 0) * 2;
}

function rootVisibility(task, parentTaskId) {
  if (parentTaskId) return task.parent_task_id === parentTaskId;
  return task.parent_task_id === null || task.parent_task_id === undefined;
}

function earliestOpenWave(tasks, phase) {
  const open = tasks.filter((task) => (
    task.phase === phase
    && !["completed", "waived"].includes(task.status)
    && !(task.role === "coordinator" && task.status === "running")
  ));
  return open.length > 0 ? Math.min(...open.map((task) => Number(task.wave ?? 1))) : null;
}

function budgetRequestForBatch(items) {
  const researchCalls = items.filter((item) => item.role === "researcher").length;
  return {
    agentSpawns: items.length,
    ...(researchCalls > 0 ? { researchCalls } : {})
  };
}

function subjectReady(db, projectRoot, runId, task) {
  const kind = subjectArtifactKind(task);
  return !kind || Boolean(latestArtifact(db, projectRoot, runId, kind, ["verified"]));
}

function graphRunnable(task, allTasks, db, runPhase) {
  if (task.status !== "pending" || task.phase !== runPhase) return false;
  if (task.parent_task_id) {
    const parent = allTasks.find((candidate) => candidate.id === task.parent_task_id);
    if (parent?.role !== "coordinator" || parent.status !== "running") return false;
  }
  if (task.dependsOn.some((dependency) => {
    const dependencyTask = allTasks.find((candidate) => candidate.id === dependency);
    return !["completed", "waived"].includes(dependencyTask?.status);
  })) return false;
  if (task.milestone_id) {
    const blocked = db.prepare(`
      SELECT 1
      FROM milestone_dependencies md
      JOIN milestones predecessor ON predecessor.id = md.depends_on
      WHERE md.milestone_id = ? AND predecessor.status NOT IN ('completed', 'waived')
      LIMIT 1
    `).get(task.milestone_id);
    if (blocked) return false;
  }
  return true;
}

export function proposeSchedule(db, projectRoot, runId, config, options = {}) {
  const run = getRun(db, runId);
  const allTasks = listTasks(db, run.id);
  const parentTaskId = options.parentTaskId ?? null;
  const rawRunnable = allTasks
    .filter((task) => graphRunnable(task, allTasks, db, run.phase))
    .filter((task) => rootVisibility(task, parentTaskId));
  const conflictFree = runnableTasks(db, run.id, config.orchestration.maxTasks)
    .map((task) => getTask(db, task.id))
    .filter((task) => rootVisibility(task, parentTaskId));
  const subjectReadyCandidates = conflictFree
    .filter((task) => subjectReady(db, projectRoot, run.id, task));
  const wave = config.delegation?.scheduleByWave === false ? null : earliestOpenWave(allTasks, run.phase);
  let candidates = wave === null
    ? subjectReadyCandidates
    : subjectReadyCandidates.filter((task) => Number(task.wave ?? 1) === wave);
  const earliestWaveCandidates = candidates;
  const earliestWave = earliestWaveCandidates.length;
  const subjectReadyCount = subjectReadyCandidates.length;
  candidates = candidates.filter((task) => {
    if (config.delegation?.requireReadyTaskPacket === false) return true;
    let packet = taskPacketStatus(db, task.id, config);
    if (!packet.current && packet.policy === "deterministic") {
      compileTaskPacket(db, projectRoot, task.id, config);
      packet = taskPacketStatus(db, task.id, config);
    }
    return packet.current;
  });
  const packetReady = candidates.length;
  const running = allTasks.filter((task) => task.status === "running").length;
  const slots = Math.max(0, Number(config.orchestration.maxConcurrent) - running);
  const budget = budgetStatus(db, run.id);
  const spawnRemaining = budget.remaining.agentSpawns ?? slots;
  const requestedLimit = Number(options.limit ?? config.orchestration.maxConcurrent);
  const limit = Math.max(0, Math.min(requestedLimit, slots, spawnRemaining));
  const criticalPath = criticalPathLengths(allTasks);
  const ordered = candidates
    .map((task) => ({ task, score: taskScore(task, criticalPath) }))
    .sort((a, b) => b.score - a.score || a.task.id.localeCompare(b.task.id));
  let researchRemaining = budget.remaining.researchCalls;
  const selected = [];
  const deferredCandidates = [];
  for (const candidate of ordered) {
    if (selected.length >= limit) {
      deferredCandidates.push({ ...candidate, deferredReason: limit === 0 ? "no concurrency or spawn budget" : "lower deterministic score in the active wave" });
      continue;
    }
    if (candidate.task.role === "researcher" && researchRemaining !== null && researchRemaining <= 0) {
      deferredCandidates.push({ ...candidate, deferredReason: "research call budget exhausted" });
      continue;
    }
    selected.push(candidate);
    if (candidate.task.role === "researcher" && researchRemaining !== null) researchRemaining -= 1;
  }
  const batch = selected.map(({ task, score }) => ({
    taskId: task.id,
    title: task.title,
    role: task.role,
    taskKind: task.taskKind,
    wave: task.wave,
    phase: task.phase,
    contractStatus: task.contractStatus,
    milestoneId: task.milestone_id,
    parentTaskId: task.parent_task_id,
    delegationDepth: task.delegation_depth,
    modelTier: task.model_tier,
    model: task.selected_model,
    reasoningEffort: task.reasoning_effort,
    readOnly: task.readOnly,
    targetPaths: task.targetPaths,
    score,
    reason: `wave=${task.wave}, priority=${task.priority}, criticalPath=${criticalPath.get(task.id) ?? 1}, role=${task.role}`
  }));
  const deferred = deferredCandidates.map(({ task, deferredReason }) => ({
    taskId: task.id,
    wave: task.wave,
    reason: deferredReason
  }));
  return {
    runId: run.id,
    phase: run.phase,
    wave,
    parentTaskId: options.parentTaskId ?? null,
    slots,
    budget,
    diagnostics: {
      runnable: rawRunnable.length,
      subjectReady: subjectReadyCount,
      earliestWave,
      packetReady,
      afterConflicts: conflictFree.length,
      selected: batch.length,
      freeSlots: slots,
      requestedLimit
    },
    batch,
    deferred,
    action: batch.length ? "SPAWN_BATCH" : "NO_RUNNABLE_TASKS"
  };
}

function leaseExpiry(config) {
  return new Date(Date.now() + Number(config.orchestration.leaseMinutes) * 60_000).toISOString();
}

function batchRecord(db, batchId) {
  const row = db.prepare("SELECT * FROM scheduler_batches WHERE id = ?").get(batchId);
  invariant(row, "SCHEDULER_BATCH_NOT_FOUND", `Scheduler batch ${batchId} was not found.`);
  return {
    ...row,
    batch: parseJson(row.batch_json, []),
    rationale: parseJson(row.rationale_json, []),
    claimedTaskIds: parseJson(row.claimed_task_ids_json, []),
    spawnedTaskIds: parseJson(row.spawned_task_ids_json, []),
    spawnReceipts: db.prepare(`
      SELECT task_id, attempt_fence, host_receipt, acknowledged_at
      FROM task_spawn_acks WHERE batch_id = ? ORDER BY acknowledged_at, task_id
    `).all(batchId)
  };
}

function receiptMap(receipts, selected, batch, batchId) {
  invariant(receipts && typeof receipts === "object" && !Array.isArray(receipts), "SCHEDULER_RECEIPT_REQUIRED", "Spawn acknowledgement requires a host receipt for every accepted task.");
  const entries = Object.entries(receipts);
  const selectedIds = new Set(selected);
  const unknown = entries.map(([taskId]) => taskId).filter((taskId) => !selectedIds.has(taskId));
  invariant(unknown.length === 0, "SCHEDULER_RECEIPT_TASK", "Spawn receipts contain tasks outside the acknowledged set.", { unknown });
  const result = new Map();
  for (const item of batch.batch.filter((candidate) => selectedIds.has(candidate.taskId))) {
    const raw = receipts[item.taskId];
    const receipt = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.receipt : null;
    invariant(typeof receipt === "string" && receipt.trim().length > 0 && receipt.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(receipt), "SCHEDULER_RECEIPT_REQUIRED", `Spawn acknowledgement for ${item.taskId} requires a bounded host receipt.`);
    invariant(raw.batchId === batchId, "SCHEDULER_RECEIPT_FENCE", `Spawn receipt for ${item.taskId} is bound to another batch.`);
    invariant(raw.taskId === item.taskId, "SCHEDULER_RECEIPT_FENCE", `Spawn receipt for ${item.taskId} is bound to another task.`);
    invariant(Number.isInteger(Number(raw.attemptFence)) && Number(raw.attemptFence) === Number(item.attemptFence), "SCHEDULER_RECEIPT_FENCE", `Spawn receipt for ${item.taskId} is bound to another attempt.`);
    result.set(item.taskId, receipt.trim());
  }
  invariant(result.size === selectedIds.size, "SCHEDULER_RECEIPT_REQUIRED", "Spawn acknowledgement requires a receipt for every accepted task.");
  return result;
}

function receiptBackedBatchItems(batch) {
  const receiptKeys = new Set(batch.spawnReceipts
    .filter((row) => typeof row.host_receipt === "string" && row.host_receipt.trim().length > 0)
    .map((row) => JSON.stringify([row.task_id, Number(row.attempt_fence)])));
  const acknowledgedKeys = new Set();
  const missing = [];
  for (const item of batch.batch) {
    const key = JSON.stringify([item.taskId, Number(item.attemptFence)]);
    if (receiptKeys.has(key)) {
      acknowledgedKeys.add(key);
    } else {
      missing.push(item.taskId);
    }
  }
  return { acknowledgedKeys, missing };
}

const TRANSIENT_CHILD_TERMINAL_CODES = new Set([
  "server_overloaded", "server-overloaded", "overloaded", "rate_limit", "rate-limited",
  "temporarily_unavailable", "temporary_failure", "transient", "timeout", "timed_out",
  "network_error", "connection_reset", "econnreset", "service_unavailable"
]);
const PERMANENT_CHILD_TERMINAL_CODES = new Set([
  "auth", "authentication", "authorization", "permission_denied", "invalid_api_key",
  "contract", "invalid_request", "unsupported_model", "policy_denied", "forbidden"
]);

function terminalText(outcome) {
  return [
    outcome?.code, outcome?.errorCode, outcome?.failureCode, outcome?.failureClass,
    outcome?.status, outcome?.error, outcome?.error?.code, outcome?.error?.message,
    outcome?.message, outcome?.failureCause
  ].filter((value) => value !== undefined && value !== null).map((value) => String(value).trim().toLowerCase()).join(" ");
}

/**
 * Normalize host child process failures at the scheduler boundary. Unknown
 * failures deliberately fail closed instead of becoming an unbounded retry.
 */
export function classifyChildTerminal(outcome = {}) {
  const text = terminalText(outcome);
  const code = String(outcome.code ?? outcome.errorCode ?? outcome.failureCode ?? outcome.failureClass ?? outcome.error?.code ?? "")
    .trim().toLowerCase().replaceAll(" ", "_");
  if (PERMANENT_CHILD_TERMINAL_CODES.has(code)
    || /auth|permission|invalid[_ -]?api|contract|unsupported[_ -]?model|policy[_ -]?denied|forbidden/u.test(text)) {
    return { classification: "permanent", code: code || null, reason: text || "unknown child terminal failure" };
  }
  if (TRANSIENT_CHILD_TERMINAL_CODES.has(code)
    || /server[_ -]?overload|at capacity|rate[_ -]?limit|temporar(?:y|ily)[_ -]?(?:unavailable|failure)|tim(?:e|ed)[_ -]?out|network|connection[_ -]?(?:reset|closed)|service[_ -]?unavailable/u.test(text)) {
    return { classification: "transient", code: code || null, reason: text || "transient child terminal failure" };
  }
  return { classification: "permanent", code: code || null, reason: text || "unknown child terminal failure" };
}

function boundedChildFailureReason(outcome, classified) {
  const raw = outcome?.message ?? outcome?.error ?? outcome?.failureCause ?? classified.reason;
  return String(raw || `${classified.classification} child terminal failure`).trim().slice(0, 1000);
}

/**
 * Record a host-reported child terminal failure after a valid spawn receipt.
 * Transient provider failures close the current attempt and requeue the task
 * immediately; permanent/auth/contract failures become blocked/failed and
 * never retry blindly.
 */
export function handleChildTerminal(db, projectRoot, runId, batchId, taskId, outcome, config) {
  const classified = classifyChildTerminal(outcome);
  const reason = boundedChildFailureReason(outcome, classified);
  const result = transaction(db, () => {
    const run = getRun(db, runId);
    const batch = batchRecord(db, batchId);
    invariant(batch.run_id === runId, "SCHEDULER_BATCH_RUN", "Scheduler batch belongs to another run.");
    invariant(["prepared", "partially-spawned", "spawned"].includes(batch.status), "SCHEDULER_BATCH_STATUS", `Cannot record a child terminal failure for a ${batch.status} batch.`);
    const item = batch.batch.find((candidate) => candidate.taskId === taskId);
    invariant(item, "SCHEDULER_CHILD_TASK", `Task ${taskId} is not part of scheduler batch ${batchId}.`);
    const receipt = db.prepare(`
      SELECT host_receipt FROM task_spawn_acks
      WHERE batch_id = ? AND task_id = ? AND attempt_fence = ?
        AND host_receipt IS NOT NULL AND length(trim(host_receipt)) > 0
      LIMIT 1
    `).get(batchId, taskId, Number(item.attemptFence));
    invariant(receipt, "SCHEDULER_CHILD_RECEIPT", `Task ${taskId} has no valid spawn receipt for batch ${batchId}.`);
    const task = getTask(db, taskId);
    invariant(task.status === "running" && Number(task.attempt_fence) === Number(item.attemptFence), "TASK_FENCED", `Task ${taskId} is not running on the acknowledged attempt.`);
    const retryable = classified.classification === "transient"
      && Number(task.attempts) < Number(task.max_attempts);
    let budgetAvailable = retryable;
    if (budgetAvailable) {
      try { assertBudgetAvailable(db, runId, { retries: 1 }); }
      catch (error) {
        if (error?.code !== "BUDGET_EXCEEDED") throw error;
        budgetAvailable = false;
      }
    }
    const canRequeue = retryable && budgetAvailable;
    const nextStatus = canRequeue
      ? "pending"
      : (config.delegation?.diagnoseBeforeRetry === true ? "blocked" : "failed");
    const route = canRequeue ? escalateModelRoute(config, task, "transient", { host: run.host }) : null;
    const timestamp = now();
    const changed = db.prepare(`
      UPDATE tasks SET status = ?, owner = NULL, failure_class = ?, escalation_cause = ?,
        model_tier = COALESCE(?, model_tier), selected_model = COALESCE(?, selected_model),
        model_source = COALESCE(?, model_source), requested_effort = COALESCE(?, requested_effort),
        effective_effort = COALESCE(?, effective_effort), effort_source = COALESCE(?, effort_source),
        supported_efforts_json = COALESCE(?, supported_efforts_json), capability_status = COALESCE(?, capability_status),
        reasoning_effort = COALESCE(?, reasoning_effort), escalation_level = COALESCE(?, escalation_level),
        transient_retry_count = transient_retry_count + ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND status = 'running' AND attempt_fence = ? AND owner IS NOT NULL
    `).run(
      nextStatus, classified.classification, reason,
      route?.tier ?? null, route?.model ?? null, route?.modelSource ?? null,
      route?.requestedEffort ?? null, route?.effectiveEffort ?? null, route?.effortSource ?? null,
      route ? json(route.supportedEfforts ?? []) : null, route?.capabilityStatus ?? null,
      route?.reasoningEffort ?? null, route?.escalationLevel ?? null, canRequeue ? 1 : 0, timestamp,
      taskId, runId, Number(item.attemptFence)
    );
    invariant(changed.changes === 1, "TASK_FENCED", `Task ${taskId} changed before host terminal failure was recorded.`);
    finalizeTaskAttempt(db, taskId, Number(item.attemptFence), canRequeue ? "aborted" : "failed", {
      failureClass: classified.classification,
      failureCause: reason,
      terminalAt: timestamp
    });
    db.prepare("DELETE FROM leases WHERE task_id = ? AND fencing_token = ?").run(taskId, Number(item.attemptFence));
    if (canRequeue) consumeBudget(db, runId, { retries: 1 }, { source: `scheduler-child-terminal:${taskId}` });
    touchRun(db, runId);
    recordEvent(db, runId, "scheduler.child-terminal", canRequeue ? "warning" : "error", {
      batchId, taskId, attemptFence: Number(item.attemptFence), hostReceipt: receipt.host_receipt,
      classification: classified.classification, code: classified.code, reason,
      action: canRequeue ? "requeued" : "failed-closed", nextStatus, retryable, budgetAvailable
    });
    return {
      batchId, taskId, attemptFence: Number(item.attemptFence), hostReceipt: receipt.host_receipt,
      classification: classified.classification, code: classified.code, reason,
      action: canRequeue ? "requeued" : "failed-closed", status: nextStatus,
      retryable, budgetAvailable
    };
  });
  cleanupTaskWorkspace(db, projectRoot, taskId, result.action === "requeued" ? "host-transient-retry" : "host-terminal-failure", result.attemptFence);
  return result;
}

export const recordChildTerminal = handleChildTerminal;

function rollbackBatchTasks(db, projectRoot, batch, reason) {
  const spawned = new Set(batch.spawnedTaskIds);
  const acceptedTaskIds = batch.batch.filter((item) => spawned.has(item.taskId)).map((item) => item.taskId);
  const rejectedTaskIds = batch.batch.filter((item) => !spawned.has(item.taskId)).map((item) => item.taskId);
  for (const item of batch.batch) {
    if (spawned.has(item.taskId)) continue;
      const changed = db.prepare(`
        UPDATE tasks SET status = 'pending', owner = NULL,
        attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END, updated_at = ?
      WHERE id = ? AND status = 'running' AND attempt_fence = ?
    `).run(now(), item.taskId, Number(item.attemptFence));
    if (changed.changes > 0) {
      finalizeTaskAttempt(db, item.taskId, Number(item.attemptFence), "aborted", {
        failureClass: "transient", failureCause: reason
      });
      db.prepare("DELETE FROM leases WHERE task_id = ? AND fencing_token = ?").run(item.taskId, Number(item.attemptFence));
      db.prepare("DELETE FROM task_spawn_acks WHERE task_id = ? AND attempt_fence = ?").run(item.taskId, Number(item.attemptFence));
      cleanupTaskWorkspace(db, projectRoot, item.taskId, "scheduler-aborted", Number(item.attemptFence));
    }
  }
  db.prepare("UPDATE scheduler_batches SET status = 'aborted', aborted_reason = ?, updated_at = ? WHERE id = ?")
    .run(reason, now(), batch.id);
  return { acceptedTaskIds, rejectedTaskIds };
}

function cleanupPreparedWorkspaces(db, projectRoot, items, status) {
  const failures = [];
  for (const item of items) {
    const workspace = db.prepare(`
      SELECT status FROM worktrees WHERE task_id = ? AND attempt_fence = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(item.taskId, Number(item.attemptFence));
    if (workspace?.status !== "active") continue;
    try {
      cleanupTaskWorkspace(db, projectRoot, item.taskId, status, Number(item.attemptFence));
    } catch (error) {
      failures.push({ taskId: item.taskId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}

function stalePreparationError(batchId, reason, details = {}) {
  return new MetisError("SCHEDULER_PREPARATION_STALE", `Scheduler batch ${batchId} lost its claimed preparation fence: ${reason}.`, details);
}

function preparedContract(db, config, host, batchId, item, task) {
  const rawContract = taskContract(db, item.taskId);
  const contract = compactTaskContract(rawContract, config.budgets.taskPacketTokens, {
    db, config, model: task.selected_model
  });
  assertBudgetAvailable(db, task.run_id, {
    inputTokens: contract.estimatedTokens,
    outputTokens: Number(config.budgets.workerResultTokens ?? 0)
  }, {
    effort: task.effective_effort ?? task.requested_effort ?? task.reasoning_effort ?? "medium",
    estimatedInputTokens: contract.estimatedTokens,
    estimatedOutputTokens: Number(config.budgets.workerResultTokens ?? 0)
  });
  if (task.role === "worker" && (contract.truncated || contract.overBudget)) {
    recordEvent(db, task.run_id, "performance.prompt-budget-warning", "warning", {
      taskId: task.id,
      batchId,
      renderedTokens: contract.estimatedTokens,
      configuredTaskPacketTokens: Number(config.budgets.taskPacketTokens),
      truncated: Boolean(contract.truncated),
      overBudget: Boolean(contract.overBudget)
    });
  }
  return {
    ...item,
    batchId,
    workspacePath: rawContract.RepositoryRoot,
    workspaceMode: rawContract.WorkspaceMode,
    contract,
    spawn: renderSpawnDescriptor(host, task, contract, {
      batchId,
      attemptFence: item.attemptFence,
      leaseToken: item.leaseToken,
      parentRoot: rawContract.IntegrationRoot ?? task.run_project_root ?? rawContract.RepositoryRoot
    })
  };
}

function assertAttemptTokenBudget(db, runId, batch, config) {
  let includesMax = false;
  const estimate = batch.reduce((total, item) => {
    const task = db.prepare("SELECT requested_effort, effective_effort, reasoning_effort FROM tasks WHERE id = ? AND run_id = ?").get(item.taskId, runId);
    invariant(task, "TASK_NOT_FOUND", `Task ${item.taskId} was not found.`);
    const effort = task.effective_effort ?? task.requested_effort ?? task.reasoning_effort ?? "medium";
    if (effort === "max") includesMax = true;
    const usage = estimateEffortUsage(
      Number(config.budgets.taskPacketTokens ?? 0),
      Number(config.budgets.workerResultTokens ?? 0),
      effort
    );
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    return total;
  }, { inputTokens: 0, outputTokens: 0 });
  if (includesMax) {
    assertBudgetAvailable(db, runId, estimate, {
      effort: "max",
      estimatedInputTokens: estimate.inputTokens,
      estimatedOutputTokens: Math.ceil(estimate.outputTokens / 2.25)
    });
  }
  return assertBudgetAvailable(db, runId, estimate);
}

export function claimSchedule(db, projectRoot, runId, config, options = {}) {
  const preparationStarted = performance.now();
  const owner = String(options.owner ?? "metis-main").trim();
  invariant(owner, "SCHEDULER_OWNER", "Schedule claim needs an owner.");
  const proposal = proposeSchedule(db, projectRoot, runId, config, options);
  if (proposal.batch.length === 0) return { ...proposal, batchId: null };
  const proposalBudget = budgetRequestForBatch(proposal.batch);
  assertBudgetAvailable(db, runId, proposalBudget);
  assertAttemptTokenBudget(db, runId, proposal.batch, config);
  const batchId = makeId("batch");
  const expiresAt = leaseExpiry(config);
  const selected = transaction(db, () => {
    const run = getRun(db, runId);
    invariant(run.status === "active", "RUN_NOT_ACTIVE", `Run ${run.id} is ${run.status}.`);
    const currentTasks = listTasks(db, run.id);
    const running = currentTasks.filter((task) => task.status === "running").length;
    const freeSlots = Math.max(0, Number(config.orchestration.maxConcurrent) - running);
    invariant(proposal.batch.length <= freeSlots, "CONCURRENCY_LIMIT", "The configured concurrency limit changed before this batch could be claimed.", {
      requested: proposal.batch.length, running, freeSlots
    });
    assertBudgetAvailable(db, run.id, proposalBudget);
    assertAttemptTokenBudget(db, run.id, proposal.batch, config);
    const controllerFence = Number(options.controllerFencingToken ?? run.controller_fencing_token);
    invariant(controllerFence === Number(run.controller_fencing_token), "CONTROLLER_FENCED", "The scheduler controller token is stale.");
    if (config.delegation?.scheduleByWave !== false) {
      const wave = earliestOpenWave(currentTasks, run.phase);
      invariant(proposal.batch.every((item) => Number(item.wave) === Number(wave)), "SCHEDULER_WAVE_RACE", "The earliest open wave changed before this batch could be claimed.", {
        proposedWave: proposal.wave, currentWave: wave
      });
    }
    const runnableIds = new Set(runnableTasks(db, run.id, config.orchestration.maxTasks).map((task) => task.id));
    for (const item of proposal.batch) invariant(runnableIds.has(item.taskId), "SCHEDULER_CLAIM_RACE", `Task ${item.taskId} is no longer runnable.`);
    const provisional = [...activeLeases(db)];
    const claimed = [];
    for (const item of proposal.batch) {
      const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND run_id = ?").get(item.taskId, run.id);
      invariant(task?.status === "pending", "SCHEDULER_CLAIM_RACE", `Task ${item.taskId} is no longer pending.`);
      if (config.delegation?.requireReadyTaskPacket !== false) {
        invariant(taskPacketStatus(db, item.taskId, config).current, "TASK_PACKET_NOT_READY", `Task ${item.taskId} packet changed before claim.`);
      }
      const conflicts = taskConflicts(task, provisional);
      if (conflicts.length > 0) throw new MetisError("RESOURCE_CONFLICT", `Task ${item.taskId} conflicts with an active lease.`, { conflicts });
      const changed = db.prepare(`
        UPDATE tasks SET status = 'running', owner = ?, attempts = attempts + 1,
          attempt_fence = attempt_fence + 1, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(owner, now(), item.taskId);
      invariant(changed.changes === 1, "SCHEDULER_CLAIM_RACE", `Task ${item.taskId} was claimed concurrently.`);
      const attemptFence = Number(db.prepare("SELECT attempt_fence FROM tasks WHERE id = ?").get(item.taskId).attempt_fence);
      const leaseToken = makeId("lease");
      const resources = Boolean(task.read_only) ? [`@task:${item.taskId}`] : parseJson(task.target_paths_json, []);
      for (const resource of resources) {
        db.prepare(`
          INSERT INTO leases(resource, task_id, token, fencing_token, owner, expires_at, created_at)
          VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(resource, item.taskId, leaseToken, attemptFence, owner, expiresAt, now());
        provisional.push({ resource, task_id: item.taskId });
      }
      claimed.push({ ...item, attemptFence, leaseToken, expiresAt });
    }
    db.prepare(`
      INSERT INTO scheduler_batches(
        id, run_id, parent_task_id, phase, status, batch_json, rationale_json,
        controller_fencing_token, claimed_task_ids_json, spawned_task_ids_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 'claimed', ?, ?, ?, ?, '[]', ?, ?)
    `).run(
      batchId, run.id, options.parentTaskId ?? null, proposal.phase,
      json(claimed), json(claimed.map((item) => item.reason)), controllerFence,
      json(claimed.map((item) => item.taskId)), now(), now()
    );
    for (const item of claimed) {
      const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND run_id = ?").get(item.taskId, run.id);
      startTaskAttempt(db, run, task, item.attemptFence, {
        attemptNumber: Number(task.attempts),
        spawnBatchId: batchId
      });
    }
    touchRun(db, run.id);
    recordEvent(db, run.id, "scheduler.batch-claimed", "info", {
      batchId, taskIds: claimed.map((item) => item.taskId), parentTaskId: options.parentTaskId ?? null,
      controllerFencingToken: controllerFence
    });
    return claimed;
  });

  const prepared = [];
  try {
    const run = getRun(db, runId);
    for (const item of selected) {
      const task = getTask(db, item.taskId);
      const workspace = prepareTaskWorkspace(db, run, task, config);
      heartbeatScheduleBatch(db, runId, batchId, config, { preparation: true });
      captureTaskBaseline(db, run, getTask(db, item.taskId), config, workspace);
      heartbeatScheduleBatch(db, runId, batchId, config, { preparation: true });
      prepared.push(preparedContract(db, config, run.host, batchId, item, task));
      heartbeatScheduleBatch(db, runId, batchId, config, { preparation: true });
    }
  } catch (error) {
    const batch = batchRecord(db, batchId);
    const currentRun = getRun(db, runId);
    if (batch.status === "claimed"
      && Number(batch.controller_fencing_token) === Number(currentRun.controller_fencing_token)) {
      try {
        abortScheduleBatch(db, projectRoot, runId, batchId, error instanceof Error ? error.message : String(error));
      } catch (abortError) {
        const cleanupFailures = cleanupPreparedWorkspaces(db, projectRoot, selected, "scheduler-stale-preparation");
        throw stalePreparationError(batchId, "preparation abort lost its controller fence", {
          cause: error instanceof Error ? error.message : String(error),
          abortCause: abortError instanceof Error ? abortError.message : String(abortError),
          abortCode: abortError?.code,
          cleanupFailures
        });
      }
    } else {
      const cleanupFailures = cleanupPreparedWorkspaces(db, projectRoot, selected, "scheduler-stale-preparation");
      throw stalePreparationError(batchId, `batch is ${batch.status}`, {
        cause: error instanceof Error ? error.message : String(error),
        cleanupFailures
      });
    }
    throw error;
  }
  try {
    transaction(db, () => {
      const run = getRun(db, runId);
      const batch = batchRecord(db, batchId);
      if (batch.status !== "claimed") throw stalePreparationError(batchId, `batch is ${batch.status}`);
      invariant(
        Number(batch.controller_fencing_token) === Number(run.controller_fencing_token),
        "CONTROLLER_FENCED",
        `Scheduler batch ${batchId} lost its controller fence before preparation persistence.`
      );
      for (const item of selected) {
        const task = db.prepare("SELECT status, attempt_fence FROM tasks WHERE id = ? AND run_id = ?").get(item.taskId, runId);
        if (task?.status !== "running" || Number(task.attempt_fence) !== Number(item.attemptFence)) {
          throw stalePreparationError(batchId, `task ${item.taskId} no longer owns attempt ${item.attemptFence}`);
        }
        const lease = db.prepare(`
          SELECT 1 FROM leases WHERE task_id = ? AND token = ? AND fencing_token = ?
          LIMIT 1
        `).get(item.taskId, item.leaseToken, Number(item.attemptFence));
        if (!lease) throw stalePreparationError(batchId, `task ${item.taskId} lost its preparation lease`);
      }
      const changed = db.prepare("UPDATE scheduler_batches SET status = 'prepared', batch_json = ?, updated_at = ? WHERE id = ? AND status = 'claimed' AND controller_fencing_token = ?")
        .run(json(prepared), now(), batchId, Number(run.controller_fencing_token));
      if (changed.changes !== 1) throw stalePreparationError(batchId, "claimed status changed before persistence");
    });
  } catch (error) {
    const batch = batchRecord(db, batchId);
    let cleanupFailures = [];
    const currentRun = getRun(db, runId);
    if (batch.status === "claimed"
      && Number(batch.controller_fencing_token) === Number(currentRun.controller_fencing_token)) {
      try {
        abortScheduleBatch(db, projectRoot, runId, batchId, error instanceof Error ? error.message : String(error));
      } catch (cleanupError) {
        cleanupFailures = cleanupPreparedWorkspaces(db, projectRoot, selected, "scheduler-stale-preparation");
        cleanupFailures.unshift({
          taskId: null,
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          code: cleanupError?.code
        });
      }
    } else {
      cleanupFailures = cleanupPreparedWorkspaces(db, projectRoot, selected, "scheduler-stale-preparation");
    }
    if (error?.code === "SCHEDULER_PREPARATION_STALE" && cleanupFailures.length === 0) throw error;
    throw stalePreparationError(batchId, error instanceof Error ? error.message : String(error), { cleanupFailures });
  }
  recordEvent(db, runId, "performance.scheduler-preparation", "info", {
    operationId: batchId,
    batchId,
    taskCount: prepared.length,
    durationMs: Math.round((performance.now() - preparationStarted) * 100) / 100
  });
  return {
    ...proposal,
    batchId,
    batch: prepared,
    preparationConcurrency: SCHEDULER_PREPARATION_CONCURRENCY,
    preparation: {
      mode: "serialized",
      concurrency: SCHEDULER_PREPARATION_CONCURRENCY,
      bounded: true
    },
    hostFanoutConcurrency: prepared.length,
    action: "SPAWN_BATCH"
  };
}

export function acknowledgeScheduleSpawn(db, runId, batchId, taskIds, owner, config, receipts) {
  return transaction(db, () => {
    const run = getRun(db, runId);
    const batch = batchRecord(db, batchId);
    invariant(batch.run_id === runId, "SCHEDULER_BATCH_RUN", "Scheduler batch belongs to another run.");
    invariant(
      Number(batch.controller_fencing_token) === Number(run.controller_fencing_token),
      "CONTROLLER_FENCED",
      `Scheduler batch ${batchId} belongs to a previous controller and cannot be acknowledged.`
    );
    invariant(["prepared", "partially-spawned", "spawned"].includes(batch.status), "SCHEDULER_BATCH_STATUS", `Cannot acknowledge a ${batch.status} batch.`);
    const selected = taskIds?.length ? new Set(taskIds) : new Set(batch.claimedTaskIds);
    const persisted = new Set(db.prepare(`
      SELECT task_id FROM task_spawn_acks WHERE batch_id = ?
    `).all(batchId).map((row) => row.task_id));
    const unknown = [...selected].filter((taskId) => !batch.claimedTaskIds.includes(taskId));
    invariant(unknown.length === 0, "SCHEDULER_ACK_TASK", "Spawn acknowledgement contains tasks outside this batch.", { unknown });
    const receiptByTask = receiptMap(receipts, selected, batch, batchId);
    const toAck = batch.batch.filter((item) => selected.has(item.taskId) && !persisted.has(item.taskId));
    const inserted = [];
    if (toAck.length > 0) {
      for (const item of toAck) {
        const task = getTask(db, item.taskId);
        invariant(task.status === "running" && Number(task.attempt_fence) === Number(item.attemptFence), "TASK_FENCED", `Task ${item.taskId} attempt is stale.`);
        bindTaskAttemptBatch(db, item.taskId, item.attemptFence, batchId);
        const changed = db.prepare(`
          INSERT INTO task_spawn_acks(task_id, attempt_fence, batch_id, owner, host_receipt, acknowledged_at)
          VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, attempt_fence) DO NOTHING
        `).run(item.taskId, Number(item.attemptFence), batchId, owner, receiptByTask.get(item.taskId), now());
        if (changed.changes === 1) {
          markTaskAttemptSpawnAccepted(db, item.taskId, item.attemptFence);
          inserted.push(item);
        }
      }
      if (inserted.length > 0) {
        const insertedResearch = inserted.filter((item) => item.role === "researcher").length;
        assertBudgetAvailable(db, runId, {
          agentSpawns: inserted.length,
          ...(insertedResearch ? { researchCalls: insertedResearch } : {})
        });
        consumeBudget(db, runId, {
          agentSpawns: inserted.length,
          ...(insertedResearch ? { researchCalls: insertedResearch } : {})
        }, { source: `scheduler-spawn:${batchId}` });
      }
    }
    const conflicting = db.prepare(`
      SELECT task_id, host_receipt FROM task_spawn_acks WHERE batch_id = ?
    `).all(batchId).filter((row) => receiptByTask.has(row.task_id) && row.host_receipt !== receiptByTask.get(row.task_id));
    invariant(conflicting.length === 0, "SCHEDULER_RECEIPT_CONFLICT", "A task was acknowledged with a different host receipt.", { conflicting });
    const spawned = db.prepare(`
      SELECT task_id FROM task_spawn_acks WHERE batch_id = ? ORDER BY acknowledged_at, task_id
    `).all(batchId).map((row) => row.task_id);
    const status = spawned.length === batch.claimedTaskIds.length ? "spawned" : "partially-spawned";
    db.prepare("UPDATE scheduler_batches SET status = ?, spawned_task_ids_json = ?, updated_at = ? WHERE id = ?")
      .run(status, json(spawned), now(), batchId);
    recordEvent(db, runId, "scheduler.spawn-acknowledged", "info", {
      batchId,
      taskIds: inserted.map((item) => item.taskId),
      receipts: inserted.map((item) => ({ taskId: item.taskId, attemptFence: Number(item.attemptFence), hostReceipt: receiptByTask.get(item.taskId) })),
      status
    });
    return {
      batchId,
      status,
      acknowledgedTaskIds: inserted.map((item) => item.taskId),
      spawnedTaskIds: spawned,
      receipts: db.prepare("SELECT task_id, attempt_fence, host_receipt FROM task_spawn_acks WHERE batch_id = ? ORDER BY acknowledged_at, task_id").all(batchId)
    };
  });
}

export function abortScheduleBatch(db, projectRoot, runId, batchId, reason, options = {}) {
  invariant(String(reason ?? "").trim(), "SCHEDULER_ABORT_REASON", "A scheduler abort needs a reason.");
  const fenced = options.expectedStatus !== undefined
    || options.expectedUpdatedAt !== undefined
    || options.expectedControllerFencingToken !== undefined;
  if (fenced) {
    invariant(
      options.expectedStatus !== undefined
        && options.expectedUpdatedAt !== undefined
        && options.expectedControllerFencingToken !== undefined,
      "SCHEDULER_ABORT_FENCE_REQUIRED",
      "A fenced scheduler abort requires expectedStatus, expectedUpdatedAt, and expectedControllerFencingToken."
    );
  }
  return transaction(db, () => {
    const run = getRun(db, runId);
    const batch = batchRecord(db, batchId);
    invariant(batch.run_id === runId, "SCHEDULER_BATCH_RUN", "Scheduler batch belongs to another run.");
    if (Number(batch.controller_fencing_token) !== Number(run.controller_fencing_token)) {
      invariant(
        fenced && Number(options.expectedControllerFencingToken) === Number(run.controller_fencing_token),
        "CONTROLLER_FENCED",
        `Scheduler batch ${batchId} belongs to a previous controller; current controller fencing is required for recovery.`
      );
    }
    if (fenced) {
      invariant(
        Number(options.expectedControllerFencingToken) === Number(run.controller_fencing_token),
        "CONTROLLER_FENCED",
        `Scheduler recovery abort for ${batchId} does not belong to the current controller.`,
        {
          expectedControllerFencingToken: Number(options.expectedControllerFencingToken),
          currentControllerFencingToken: Number(run.controller_fencing_token)
        }
      );
      invariant(
        batch.status === String(options.expectedStatus)
          && batch.updated_at === String(options.expectedUpdatedAt),
        "SCHEDULER_ABORT_FENCED",
        `Scheduler batch ${batchId} changed after the stale observation; refusing delayed recovery abort.`,
        {
          expected: {
            status: String(options.expectedStatus),
            updatedAt: String(options.expectedUpdatedAt),
            controllerFencingToken: Number(run.controller_fencing_token)
          },
          actual: {
            status: batch.status,
            updatedAt: batch.updated_at,
            controllerFencingToken: Number(run.controller_fencing_token)
          }
        }
      );
    }
    const accounting = rollbackBatchTasks(db, projectRoot, batch, String(reason).trim());
    recordEvent(db, runId, "scheduler.batch-aborted", "warning", {
      batchId,
      reason: String(reason).trim(),
      ...accounting
    });
    return { ...batchRecord(db, batchId), ...accounting };
  });
}

export function heartbeatScheduleBatch(db, runId, batchId, config, options = {}) {
  // Preparation cannot have receipt-backed child leases yet.  Keep this
  // watchdog observation read-only so a host process that is paused between
  // filesystem preparation steps cannot hold a SQLite write transaction and
  // block the controller's fenced stale-observation update.
  if (options.preparation) {
    const run = getRun(db, runId);
    const batch = batchRecord(db, batchId);
    invariant(batch.run_id === runId, "SCHEDULER_BATCH_RUN", "Scheduler batch belongs to another run.");
    const currentFence = Number(run.controller_fencing_token);
    const requestedFence = options.controllerFencingToken ?? options.expectedControllerFencingToken;
    if (requestedFence !== undefined) {
      invariant(Number(requestedFence) === currentFence, "CONTROLLER_FENCED", "Scheduler heartbeat controller token is stale.");
    }
    invariant(Number(batch.controller_fencing_token) === currentFence,
      "CONTROLLER_FENCED", `Scheduler batch ${batchId} belongs to a previous controller.`);
    invariant(batch.status === "claimed", "SCHEDULER_BATCH_STATUS", `Cannot heartbeat a ${batch.status} preparation batch.`);
    const { missing: missingReceiptTaskIds } = receiptBackedBatchItems(batch);
    return {
      batchId,
      status: batch.status,
      preparationPending: true,
      missingReceiptTaskIds,
      recoveryRequired: missingReceiptTaskIds.length > 0,
      heartbeats: [],
      nextHeartbeatSeconds: Number(config.orchestration.leaseHeartbeatSeconds)
    };
  }
  return transaction(db, () => {
    const run = getRun(db, runId);
    const batch = batchRecord(db, batchId);
    invariant(batch.run_id === runId, "SCHEDULER_BATCH_RUN", "Scheduler batch belongs to another run.");
    const currentFence = Number(run.controller_fencing_token);
    const requestedFence = options.controllerFencingToken ?? options.expectedControllerFencingToken;
    if (requestedFence !== undefined) {
      invariant(Number(requestedFence) === currentFence, "CONTROLLER_FENCED", "The scheduler heartbeat controller token is stale.");
    }
    const isTakeoverRecovery = Number(batch.controller_fencing_token) !== currentFence;
    if (isTakeoverRecovery) {
      invariant(
        requestedFence !== undefined && Number(requestedFence) === currentFence,
        "CONTROLLER_FENCED",
        `Scheduler batch ${batchId} belongs to a previous controller; current controller fencing is required for recovery.`
      );
    }
    invariant(
      !isTakeoverRecovery || (!options.preparation && batch.spawnedTaskIds.length > 0),
      "CONTROLLER_FENCED",
      `Scheduler batch ${batchId} belongs to a previous controller and cannot be heartbeated.`
    );
    const allowedStatuses = options.preparation ? ["claimed"] : ["claimed", "prepared", "partially-spawned", "spawned", "aborted"];
    invariant(allowedStatuses.includes(batch.status), "SCHEDULER_BATCH_STATUS", `Cannot heartbeat a ${batch.status} batch.`);
    const { acknowledgedKeys, missing: missingReceipts } = receiptBackedBatchItems(batch);
    const results = [];
    for (const item of batch.batch) {
      if (!acknowledgedKeys.has(JSON.stringify([item.taskId, Number(item.attemptFence)]))) continue;
      const task = getTask(db, item.taskId);
      if (task.status !== "running" || Number(task.attempt_fence) !== Number(item.attemptFence)) continue;
      results.push(heartbeatTask(db, runId, item.taskId, item.leaseToken, config));
    }
    if (missingReceipts.length === 0) {
      db.prepare("UPDATE scheduler_batches SET updated_at = ? WHERE id = ? AND status = ?")
        .run(now(), batchId, batch.status);
    } else {
      recordEvent(db, runId, "scheduler.spawn-receipt-missing", "warning", { batchId, taskIds: missingReceipts, status: batch.status });
    }
    return {
      batchId,
      status: batch.status,
      preparationPending: batch.status === "claimed",
      missingReceiptTaskIds: missingReceipts,
      recoveryRequired: missingReceipts.length > 0,
      heartbeats: results,
      nextHeartbeatSeconds: Number(config.orchestration.leaseHeartbeatSeconds)
    };
  });
}

export function refreshScheduleBatch(db, batchId) {
  return transaction(db, () => {
    const batch = batchRecord(db, batchId);
    const statuses = batch.batch.map((item) => {
      const task = db.prepare("SELECT status, attempt_fence FROM tasks WHERE id = ?").get(item.taskId);
      // A host-transient requeue keeps the historical descriptor immutable;
      // once a newer fenced attempt is claimed, the old batch is detached.
      if (task?.status === "pending" && Number(task.attempt_fence) > Number(item.attemptFence)) return "detached";
      return task?.status ?? "missing";
    });
    const refreshableStatuses = ["claimed", "prepared", "partially-spawned", "spawned"];
    if (refreshableStatuses.includes(batch.status)
      && statuses.length > 0
      && statuses.every((status) => ["completed", "waived", "failed", "blocked", "detached"].includes(status))) {
      const changed = db.prepare(`
        UPDATE scheduler_batches
        SET status = 'completed', updated_at = ?
        WHERE id = ? AND status IN ('claimed', 'prepared', 'partially-spawned', 'spawned')
          AND status = ? AND updated_at = ?
      `).run(now(), batchId, batch.status, batch.updated_at);
      if (changed.changes !== 1) return batchRecord(db, batchId);
    }
    return batchRecord(db, batchId);
  });
}
