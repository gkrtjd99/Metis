import path from "node:path";
import { transaction } from "./db.js";
import { assertBudgetAvailable, consumeBudget } from "./budget.js";
import { activeLeases, cleanupExpiredLeases, runnableTasks, taskConflicts, validateGraph } from "./graph.js";
import { MetisError, invariant } from "./errors.js";
import { loadConfig } from "./config.js";
import { readObject, storeObject } from "./objects.js";
import { repositoryCodeFingerprint, syncRepository } from "./repository.js";
import { getArtifact, getRun, latestArtifact, putArtifact, recordEvent, touchRun } from "./state.js";
import { ensureDefaultMilestone, getMilestone, listMilestones, refreshMilestoneStatuses, validateMilestoneGraph } from "./milestones.js";
import { evidenceRefIsCurrent, evidenceRefIsVerifiable, evidenceSummary, normalizeEvidenceRefs } from "./provenance.js";
import { escalateModelRoute, selectModelRoute } from "./model-routing.js";
import { countTokens } from "./tokens.js";
import { REVIEW_ROLES as REVIEW_ROLE_NAMES, ROLES as ROLE_NAMES } from "./metadata.js";
import { ROLE_PROTOCOLS, defaultTaskKind, resultSchemaForRole, subjectEvidenceRequirement, validateTaskKind } from "./prompt-protocols.js";
import { bindTaskInterfaces, taskInterfaceContracts } from "./interfaces.js";
import { compileTaskPacket, getTaskPacket, taskPacketPolicy, taskPacketStatus } from "./task-packets.js";
import { bindTaskCapabilities, resolveTaskCapabilities, taskCapabilities } from "./capabilities.js";
import {
  cleanupTaskWorkspace,
  finalizeTaskWorkspace,
  getTaskWorkspace,
  prepareTaskWorkspace,
  snapshotWorkspace,
  validateMutableOwnershipPaths
} from "./worktrees.js";
import { removeIntegrationJournal, restoreIntegrationJournal } from "./integration-journal.js";
import { asArray, isSafeRepoPath, json, makeId, normalizeRepoPath, now, parseJson, pathsOverlap, redactValue, sha256, stableStringify } from "./util.js";

const ROLES = new Set(ROLE_NAMES);
const RESULT_STATUSES = new Set(["COMPLETED", "BLOCKED", "FAILED", "UNKNOWN"]);
const TASK_PHASES = Object.freeze(["discover", "research", "design", "plan", "execute", "review", "verify", "curate"]);
const RETRY_CAUSES = new Set(["transient", "reasoning", "contract", "dependency", "integration", "review", "plan", "external"]);
const REVIEW_ROLES = new Set(REVIEW_ROLE_NAMES);
const CRITIC_ROLES = new Set(["design-critic", "plan-critic"]);
const COMPLETION_RESERVATION_PREFIX = "__metis_completion_reservation__:";

function mapAttempt(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    attemptFence: Number(row.attempt_fence),
    attemptNumber: Number(row.attempt_number),
    host: row.host,
    role: row.role,
    tier: row.tier,
    selectedModel: row.selected_model,
    modelSource: row.model_source,
    requestedEffort: row.requested_effort,
    effectiveEffort: row.effective_effort,
    effortSource: row.effort_source,
    supportedEfforts: parseJson(row.supported_efforts_json, []),
    capabilityStatus: row.capability_status,
    reasoningEscalationLevel: Number(row.reasoning_escalation_level ?? 0),
    escalationCause: row.escalation_cause,
    failureClass: row.failure_class,
    failureCause: row.failure_cause,
    spawnBatchId: row.spawn_batch_id,
    status: row.status,
    startAt: row.start_at,
    spawnAcceptedAt: row.spawn_accepted_at,
    executionStartedAt: row.execution_started_at,
    executionEndedAt: row.execution_ended_at,
    terminalAt: row.terminal_at
  };
}

export function taskAttemptHistory(db, taskId) {
  return db.prepare(`
    SELECT * FROM task_attempts
    WHERE task_id = ?
    ORDER BY attempt_number, start_at, id
  `).all(taskId).map(mapAttempt);
}

export function startTaskAttempt(db, run, task, attemptFence, options = {}) {
  const timestamp = options.startAt ?? now();
  const attemptNumber = Number(options.attemptNumber ?? task.attempts);
  const inserted = db.prepare(`
    INSERT INTO task_attempts(
      id, task_id, run_id, attempt_fence, attempt_number, host, role, tier,
      selected_model, model_source, requested_effort, effective_effort,
      effort_source, supported_efforts_json, capability_status,
      reasoning_escalation_level, escalation_cause,
      spawn_batch_id, status, start_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
    ON CONFLICT(task_id, attempt_fence) DO NOTHING
  `).run(
    makeId("attempt"), task.id, run.id, Number(attemptFence), attemptNumber,
    run.host, task.role, task.model_tier, task.selected_model, task.model_source,
    task.requested_effort ?? task.reasoning_effort,
    task.effective_effort ?? task.reasoning_effort,
    task.effort_source ?? "persisted",
    json(parseJson(task.supported_efforts_json, [])),
    task.capability_status ?? "known",
    Number(task.escalation_level ?? 0), options.escalationCause ?? task.escalation_cause ?? null,
    options.spawnBatchId ?? null, timestamp
  );
  invariant(inserted.changes === 1 || db.prepare("SELECT 1 FROM task_attempts WHERE task_id = ? AND attempt_fence = ?").get(task.id, Number(attemptFence)),
    "TASK_ATTEMPT_START", `Attempt ${task.id}/${attemptFence} could not be persisted.`);
  return db.prepare("SELECT * FROM task_attempts WHERE task_id = ? AND attempt_fence = ?").get(task.id, Number(attemptFence));
}

export function bindTaskAttemptBatch(db, taskId, attemptFence, batchId) {
  const changed = db.prepare(`
    UPDATE task_attempts SET spawn_batch_id = ?
    WHERE task_id = ? AND attempt_fence = ? AND status = 'running'
  `).run(batchId ?? null, taskId, Number(attemptFence));
  invariant(changed.changes === 1, "TASK_ATTEMPT_FENCED", `Attempt ${taskId}/${attemptFence} is stale or already terminal.`);
  return true;
}

export function markTaskAttemptSpawnAccepted(db, taskId, attemptFence, acceptedAt = now()) {
  const changed = db.prepare(`
    UPDATE task_attempts
    SET spawn_accepted_at = COALESCE(spawn_accepted_at, ?),
        execution_started_at = COALESCE(execution_started_at, ?)
    WHERE task_id = ? AND attempt_fence = ? AND status = 'running'
  `).run(acceptedAt, acceptedAt, taskId, Number(attemptFence));
  invariant(changed.changes === 1, "TASK_ATTEMPT_FENCED", `Attempt ${taskId}/${attemptFence} is stale or already terminal.`);
  return true;
}

export function finalizeTaskAttempt(db, taskId, attemptFence, status, options = {}) {
  const terminalAt = options.terminalAt ?? now();
  const changed = db.prepare(`
    UPDATE task_attempts
    SET status = ?, failure_class = ?, failure_cause = ?, execution_ended_at = ?, terminal_at = ?
    WHERE task_id = ? AND attempt_fence = ? AND status = 'running'
  `).run(
    status, options.failureClass ?? null, options.failureCause ?? null, terminalAt, terminalAt,
    taskId, Number(attemptFence)
  );
  invariant(changed.changes === 1, "TASK_ATTEMPT_FENCED", `Attempt ${taskId}/${attemptFence} is stale or already terminal.`);
  return true;
}

const ROLE_INSTRUCTIONS = ROLE_PROTOCOLS;

const PHASE_ROLES = Object.freeze({
  discover: new Set(["scout", "researcher", "synthesizer", "task-compiler", "diagnostician", "verifier"]),
  research: new Set(["researcher", "scout", "synthesizer", "task-compiler", "diagnostician", "verifier"]),
  design: new Set(["scout", "researcher", "synthesizer", "designer", "design-critic", "task-compiler", "diagnostician", "verifier"]),
  plan: new Set([...ROLES]),
  execute: new Set(["worker", "coordinator", "integrator", "task-compiler", "diagnostician", "verifier"]),
  review: new Set([...REVIEW_ROLES, "verifier", "task-compiler", "diagnostician"]),
  verify: new Set(["verifier", "adversarial-reviewer", "task-compiler", "diagnostician"]),
  curate: new Set(["curator", "task-compiler", "diagnostician"])
});

function taskCanRunInPhase(task, runPhase) {
  return task.phase === runPhase && runPhase !== "intake" && runPhase !== "complete";
}

function earliestOpenWave(db, runId, phase) {
  const rows = db.prepare(`
    SELECT wave
    FROM tasks
    WHERE run_id = ? AND phase = ?
      AND status NOT IN ('completed', 'waived')
      AND NOT (role = 'coordinator' AND status = 'running')
    ORDER BY wave
  `).all(runId, phase);
  return rows.length > 0 ? Number(rows[0].wave) : null;
}

export function subjectArtifactKind(task) {
  if (task.role === "design-critic") return "design-seal";
  if (task.role === "plan-critic") return "plan";
  if (task.role === "adversarial-reviewer") return "verification-candidate";
  if (task.phase === "review" && (REVIEW_ROLES.has(task.role) || task.role === "verifier")) return "integration-candidate";
  return null;
}

function defaultScheduledPhase(currentPhase, role) {
  if (["discover", "research", "design"].includes(currentPhase)) return currentPhase;
  if (currentPhase === "plan") {
    if (["scout", "researcher", "synthesizer", "designer", "design-critic", "planner", "plan-critic", "task-compiler", "diagnostician"].includes(role)) return "plan";
    if (["worker", "coordinator", "integrator"].includes(role)) return "execute";
    if (REVIEW_ROLES.has(role) && role !== "adversarial-reviewer") return "review";
    if (["verifier", "adversarial-reviewer"].includes(role)) return "verify";
    if (role === "curator") return "curate";
  }
  return currentPhase;
}

function validateScheduledPhase(currentPhase, role, scheduledPhase) {
  invariant(TASK_PHASES.includes(scheduledPhase), "TASK_RUN_PHASE", `Unsupported task run phase: ${scheduledPhase}.`);
  invariant(
    TASK_PHASES.indexOf(scheduledPhase) >= TASK_PHASES.indexOf(currentPhase),
    "TASK_RUN_PHASE",
    `Task run phase ${scheduledPhase} precedes current phase ${currentPhase}.`
  );
  const allowed = {
    scout: new Set(["discover", "research", "design", "plan"]),
    researcher: new Set(["discover", "research", "design", "plan"]),
    synthesizer: new Set(["discover", "research", "design", "plan"]),
    designer: new Set(["design", "plan"]),
    "design-critic": new Set(["design", "plan"]),
    planner: new Set(["plan"]),
    "plan-critic": new Set(["plan"]),
    "task-compiler": new Set(TASK_PHASES),
    worker: new Set(["execute"]),
    coordinator: new Set(["execute"]),
    integrator: new Set(["execute"]),
    diagnostician: new Set(TASK_PHASES),
    reviewer: new Set(["review"]),
    "security-reviewer": new Set(["review"]),
    "database-reviewer": new Set(["review"]),
    "performance-reviewer": new Set(["review"]),
    "accessibility-reviewer": new Set(["review"]),
    "migration-reviewer": new Set(["review"]),
    verifier: new Set(["discover", "research", "design", "execute", "review", "verify"]),
    "adversarial-reviewer": new Set(["verify"]),
    curator: new Set(["curate"])
  };
  invariant(allowed[role].has(scheduledPhase), "TASK_ROLE_RUN_PHASE", `Role ${role} cannot run during ${scheduledPhase}.`);
}

function field(input, camel, pascal, fallback) {
  return input[camel] ?? input[pascal] ?? fallback;
}

export function captureTaskBaseline(db, run, task, config, workspace) {
  syncRepository(db, run.project_root, config, run.id);
  const repositoryFiles = snapshotWorkspace(workspace.path, config);
  const packet = getTaskPacket(db, task.id, config);
  const subjectKind = subjectArtifactKind(task);
  const subjectArtifact = subjectKind ? latestArtifact(db, run.project_root, run.id, subjectKind, ["verified"]) : null;
  const subject = subjectArtifact ? {
    kind: subjectKind,
    artifactId: subjectArtifact.id,
    contentRef: subjectArtifact.content_ref,
    codeFingerprint: parseJson(subjectArtifact.content, {}).codeFingerprint ?? null
  } : null;
  if (subjectKind) invariant(subjectArtifact, "TASK_SUBJECT_ARTIFACT_REQUIRED", `${task.role} requires a current ${subjectKind} artifact before dispatch.`);
  if (subjectKind === "integration-candidate") {
    invariant(subject.codeFingerprint === repositoryCodeFingerprint(db), "TASK_INTEGRATION_CANDIDATE_STALE", "The integration candidate changed before task preparation.");
  }
  const content = {
    taskId: task.id,
    attempt: task.attempts,
    targetPaths: task.targetPaths,
    readOnly: task.readOnly,
    workspaceMode: workspace.mode,
    workspacePath: workspace.path,
    codeFingerprint: repositoryCodeFingerprint(db),
    repositoryFiles,
    packetId: packet.packetId,
    packetHash: packet.packetHash,
    packetVersion: packet.version,
    packetBlueprintHash: packet.blueprintHash,
    subject,
    capturedAt: now()
  };
  const artifact = putArtifact(db, run.project_root, run.id, `task-baseline:${task.id}`, content, {
    taskId: task.id,
    status: "verified",
    metadata: { attempt: task.attempts, immutable: true, workspaceMode: workspace.mode }
  });
  if (workspace.mode === "git-worktree") {
    db.prepare("UPDATE worktrees SET baseline_ref = ?, updated_at = ? WHERE task_id = ?")
      .run(artifact.content_ref, now(), task.id);
  }
  return artifact;
}

function assertTaskSubjectBasis(db, run, task, baseline, config, options = {}) {
  const subjectKind = subjectArtifactKind(task);
  if (!subjectKind) return;
  if (options.sync !== false) syncRepository(db, run.project_root, config, run.id);
  const artifact = latestArtifact(db, run.project_root, run.id, subjectKind, ["verified"]);
  invariant(
    artifact
      && baseline.subject?.kind === subjectKind
      && baseline.subject?.artifactId === artifact.id
      && baseline.subject?.contentRef === artifact.content_ref,
    "TASK_SUBJECT_BASIS_STALE",
    `Task ${task.id} is not bound to the current ${subjectKind} artifact.`
  );
  if (subjectKind === "integration-candidate") {
    const subject = parseJson(artifact.content, {});
    invariant(
      subject.codeFingerprint
        && baseline.subject?.codeFingerprint === subject.codeFingerprint
        && subject.codeFingerprint === repositoryCodeFingerprint(db),
      "TASK_INTEGRATION_CANDIDATE_STALE",
      `Task ${task.id} did not consume the current immutable integration candidate.`
    );
  }
}

/**
 * Subject artifacts are part of a reviewer's immutable input contract. Keep
 * this check against the raw host result: normalizeEvidenceRef intentionally
 * resolves an artifact row and would otherwise replace a forged contentRef
 * with the current one before we could reject it.
 */
function assertSubjectEvidenceRef(db, run, task, input) {
  const subjectKind = subjectArtifactKind(task);
  if (!subjectKind) return;
  const subject = latestArtifact(db, run.project_root, run.id, subjectKind, ["verified"]);
  invariant(subject, "TASK_SUBJECT_ARTIFACT_REQUIRED", `${task.role} requires a current ${subjectKind} artifact before completion.`);
  const refs = asArray(field(input, "evidenceRefs", "EvidenceRefs", []));
  const typedRefs = refs.filter((ref) => ref && typeof ref === "object" && !Array.isArray(ref));
  const artifactRefs = typedRefs.filter((ref) => ref.type === "artifact");
  const artifactRef = artifactRefs.find((ref) => ref.id === subject.id && ref.contentRef === subject.content_ref);
  invariant(artifactRefs.length > 0, "TASK_SUBJECT_EVIDENCE_REQUIRED",
    `Completed ${task.role} task ${task.id} must return the exact ${subjectKind} EvidenceRef {type:'artifact', id, contentRef}.`, {
      subject: { kind: subjectKind, id: subject.id, contentRef: subject.content_ref },
      received: typedRefs.map((ref) => ({ type: ref.type, id: ref.id, contentRef: ref.contentRef }))
    });
  invariant(artifactRef, "TASK_SUBJECT_EVIDENCE_MISMATCH",
    `Completed ${task.role} task ${task.id} must return the exact ${subjectKind} EvidenceRef {type:'artifact', id, contentRef}.`, {
      subject: { kind: subjectKind, id: subject.id, contentRef: subject.content_ref },
      received: typedRefs.map((ref) => ({ type: ref.type, id: ref.id, contentRef: ref.contentRef }))
    });
}

function baselineForTask(db, run, task) {
  const artifact = latestArtifact(db, run.project_root, run.id, `task-baseline:${task.id}`, ["verified"]);
  invariant(artifact, "TASK_BASELINE_REQUIRED", `Task ${task.id} has no workspace baseline.`);
  try {
    return JSON.parse(artifact.content ?? "{}");
  } catch {
    throw new MetisError("TASK_BASELINE_INVALID", `Task ${task.id} has an invalid workspace baseline.`);
  }
}

function isCompletionReservationOwner(owner) {
  return typeof owner === "string" && owner.startsWith(COMPLETION_RESERVATION_PREFIX);
}

function completionReservationOwner() {
  return `${COMPLETION_RESERVATION_PREFIX}${makeId("finish")}`;
}

function reserveTaskCompletion(db, task, leaseToken, config) {
  return transaction(db, () => {
    const current = db.prepare("SELECT status, owner, attempt_fence FROM tasks WHERE id = ?").get(task.id);
    invariant(current?.status === "running", "TASK_NOT_RUNNING", `Task ${task.id} is ${current?.status ?? "missing"}.`);
    invariant(Number(current.attempt_fence) === Number(task.attempt_fence), "TASK_FENCED", `Task ${task.id} attempt is stale.`);
    if (isCompletionReservationOwner(current.owner)) {
      throw new MetisError("TASK_COMPLETION_RESERVED", `Task ${task.id} already has a completion reservation.`);
    }

    const timestamp = now();
    const leases = db.prepare("SELECT resource, token, fencing_token, owner, expires_at FROM leases WHERE task_id = ?").all(task.id);
    invariant(leases.length > 0, "LEASE_REQUIRED", `Task ${task.id} has no active resource lease.`);
    invariant(leases.every((lease) => lease.token === leaseToken), "LEASE_INVALID", `Invalid lease token for task ${task.id}.`);
    invariant(leases.every((lease) => Number(lease.fencing_token) === Number(task.attempt_fence)), "TASK_FENCED", `Task ${task.id} attempt is stale.`);
    invariant(leases.every((lease) => lease.owner === current.owner), "TASK_COMPLETION_RESERVATION_RACE", `Task ${task.id} lease owner changed.`);
    invariant(leases.every((lease) => Date.parse(lease.expires_at) > Date.now()), "LEASE_EXPIRED", `Task ${task.id} lease expired.`);

    const owner = completionReservationOwner();
    const boundedExpiry = new Date(Date.now() + Number(config.orchestration.leaseMinutes) * 60_000).toISOString();
    const reservationExpiry = leases.reduce(
      (latest, lease) => Date.parse(lease.expires_at) > Date.parse(latest) ? lease.expires_at : latest,
      boundedExpiry
    );
    const claimed = db.prepare(`
      UPDATE tasks SET owner = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND attempt_fence = ? AND owner = ?
    `).run(owner, timestamp, task.id, Number(task.attempt_fence), current.owner);
    invariant(claimed.changes === 1, "TASK_COMPLETION_RESERVATION_RACE", `Task ${task.id} completion reservation was lost.`);
    const updatedLeases = db.prepare(`
      UPDATE leases SET owner = ?, expires_at = ?
      WHERE task_id = ? AND token = ? AND fencing_token = ? AND expires_at > ?
    `).run(owner, reservationExpiry, task.id, leaseToken, Number(task.attempt_fence), timestamp);
    invariant(updatedLeases.changes === leases.length, "TASK_COMPLETION_RESERVATION_RACE", `Task ${task.id} lease changed during completion reservation.`);
    recordEvent(db, task.run_id, "task.completion-reserved", "info", {
      taskId: task.id, attemptFence: Number(task.attempt_fence), owner: current.owner
    });
    return {
      runId: task.run_id,
      taskId: task.id,
      attemptFence: Number(task.attempt_fence),
      leaseToken,
      reservationOwner: owner,
      taskOwner: current.owner,
      leases: leases.map((lease) => ({ resource: lease.resource, expiresAt: lease.expires_at }))
    };
  });
}

function releaseTaskCompletion(db, reservation) {
  if (!reservation) return false;
  return transaction(db, () => {
    const task = db.prepare("SELECT status, owner, attempt_fence FROM tasks WHERE id = ?").get(reservation.taskId);
    if (!task
        || task.status !== "running"
        || Number(task.attempt_fence) !== Number(reservation.attemptFence)
        || task.owner !== reservation.reservationOwner) return false;
    const restored = db.prepare(`
      UPDATE tasks SET owner = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND attempt_fence = ? AND owner = ?
    `).run(reservation.taskOwner, now(), reservation.taskId, Number(reservation.attemptFence), reservation.reservationOwner);
    if (restored.changes !== 1) return false;
    for (const lease of reservation.leases) {
      const restoredLease = db.prepare(`
        UPDATE leases SET owner = ?, expires_at = ?
        WHERE resource = ? AND task_id = ? AND token = ? AND fencing_token = ? AND owner = ?
      `).run(reservation.taskOwner, lease.expiresAt, lease.resource, reservation.taskId,
        reservation.leaseToken, Number(reservation.attemptFence), reservation.reservationOwner);
      invariant(restoredLease.changes === 1, "TASK_COMPLETION_RESERVATION_LOST", `Task ${reservation.taskId} lease reservation changed during release.`);
    }
    recordEvent(db, reservation.runId, "task.completion-reservation-released", "warning", {
      taskId: reservation.taskId, attemptFence: Number(reservation.attemptFence)
    });
    return true;
  });
}

function assertCompletionReservation(db, reservation) {
  const task = db.prepare("SELECT status, owner, attempt_fence FROM tasks WHERE id = ?").get(reservation.taskId);
  invariant(task?.status === "running", "TASK_COMPLETION_RESERVATION_LOST", `Task ${reservation.taskId} is no longer running.`);
  invariant(Number(task.attempt_fence) === Number(reservation.attemptFence), "TASK_FENCED", `Task ${reservation.taskId} attempt is stale.`);
  invariant(task.owner === reservation.reservationOwner, "TASK_COMPLETION_RESERVATION_LOST", `Task ${reservation.taskId} completion reservation is no longer owned.`);
  const leases = db.prepare("SELECT token, fencing_token, owner, expires_at FROM leases WHERE task_id = ?").all(reservation.taskId);
  invariant(leases.length === reservation.leases.length && leases.length > 0, "LEASE_REQUIRED", `Task ${reservation.taskId} lease set changed.`);
  invariant(leases.every((lease) => lease.token === reservation.leaseToken), "LEASE_INVALID", `Task ${reservation.taskId} lease token changed.`);
  invariant(leases.every((lease) => Number(lease.fencing_token) === Number(reservation.attemptFence)), "TASK_FENCED", `Task ${reservation.taskId} lease fence changed.`);
  invariant(leases.every((lease) => lease.owner === reservation.reservationOwner), "TASK_COMPLETION_RESERVATION_LOST", `Task ${reservation.taskId} lease reservation is no longer owned.`);
  invariant(leases.every((lease) => Date.parse(lease.expires_at) > Date.now()), "LEASE_EXPIRED", `Task ${reservation.taskId} lease expired.`);
  invariant(db.prepare("SELECT 1 FROM task_spawn_acks WHERE task_id = ? AND attempt_fence = ?").get(reservation.taskId, Number(reservation.attemptFence)),
    "TASK_SPAWN_NOT_ACKNOWLEDGED", `Task ${reservation.taskId} was not acknowledged as spawned.`);
}

function assertTaskPacketBasis(db, task, baseline, config) {
  const packet = taskPacketStatus(db, task.id, config);
  invariant(packet.current, "TASK_PACKET_BASIS_STALE", `Completed task ${task.id} has no current compiled task packet basis.`, packet);
  invariant(baseline.packetId === packet.packetId && baseline.packetHash === packet.packetHash,
    "TASK_PACKET_BASIS_STALE", `Completed task ${task.id} packet basis changed after claim.`, {
      expectedPacketId: baseline.packetId,
      actualPacketId: packet.packetId,
      expectedPacketHash: baseline.packetHash,
      actualPacketHash: packet.packetHash
    });
  return packet;
}

function compilerTaskTitle(target) {
  return `Compile execution packet for ${target.title}`;
}

function createCompilerTaskForTarget(db, run, target, config) {
  const compiler = addTask(db, run.id, {
    title: compilerTaskTitle(target),
    goal: `Compile task ${target.id} into a self-contained execution packet without changing protected contract fields.`,
    role: "task-compiler",
    taskKind: "compilation",
    runPhase: run.phase,
    wave: run.phase === "plan" ? 1 : Math.max(1, Number(target.wave || 1)),
    readOnly: true,
    complexity: target.complexity,
    risk: target.risk,
    effort: "small",
    sliceType: "compilation",
    priority: Math.max(90, Number(target.priority || 50) + 10),
    requirementIds: target.requirementIds,
    scope: [`Compile task blueprint ${target.id}.`],
    nonGoals: ["Do not modify scope, authority, dependencies, acceptance criteria, or frozen interfaces."],
    constraints: ["Use only the target blueprint and selected evidence.", "Report ambiguities instead of inventing decisions."],
    acceptanceCriteria: [
      "The packet is self-contained for the target subagent.",
      "All protected task fields remain unchanged.",
      "Any unresolved ambiguity is explicit."
    ],
    requiredEvidence: [],
    expectedOutputs: ["task-packet-overlay"],
    contextRefs: [`task-blueprint:${target.id}`],
    stopConditions: ["The target blueprint lacks a required design or interface decision."],
    compilerTargetTaskId: target.id,
    autoGenerated: true,
    authorityBoundary: "local-read",
    __skipPacket: true,
    __skipCompiler: true
  }, config);
  db.prepare("INSERT OR IGNORE INTO task_dependencies(task_id, depends_on) VALUES(?, ?)").run(target.id, compiler.id);
  validateGraph(db, run.id);
  compileTaskPacket(db, run.project_root, compiler.id, config);
  recordEvent(db, run.id, "task-compiler.created", "info", { compilerTaskId: compiler.id, targetTaskId: target.id });
  return getTask(db, compiler.id);
}

export function addTask(db, runId, input, config) {
  const run = getRun(db, runId);
  invariant(Object.hasOwn(PHASE_ROLES, run.phase), "TASK_PHASE", "Tasks cannot be added in the current phase.");
  const taskCount = Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id).count);
  invariant(taskCount < config.orchestration.maxTasks, "TASK_LIMIT", `Run ${run.id} reached its ${config.orchestration.maxTasks}-task limit.`);

  const title = String(field(input, "title", "Title", field(input, "goal", "Goal", ""))).trim();
  const goal = String(field(input, "goal", "Goal", title)).trim();
  const role = String(field(input, "role", "Role", "worker")).toLowerCase();
  const taskKind = String(field(input, "taskKind", "TaskKind", defaultTaskKind(role))).toLowerCase();
  const wave = Number(field(input, "wave", "Wave", 1));
  invariant(title && goal, "TASK_GOAL_REQUIRED", "A task needs a title and goal.");
  invariant(ROLES.has(role), "TASK_ROLE_INVALID", `Unsupported task role: ${role}.`);
  invariant(validateTaskKind(taskKind), "TASK_KIND_INVALID", `Unsupported task kind: ${taskKind}.`);
  invariant(Number.isInteger(wave) && wave > 0, "TASK_WAVE", "Task wave must be a positive integer.");
  invariant(PHASE_ROLES[run.phase].has(role), "TASK_ROLE_PHASE", `Role ${role} cannot be created during ${run.phase}.`);

  const scheduledPhase = String(field(input, "runPhase", "RunPhase", defaultScheduledPhase(run.phase, role))).toLowerCase();
  validateScheduledPhase(run.phase, role, scheduledPhase);
  const mutableRoles = new Set(["worker", "integrator", "curator"]);
  const readOnly = Boolean(field(input, "readOnly", "ReadOnly", !mutableRoles.has(role)));
  if (role === "researcher" && scheduledPhase === "discover") {
    invariant(taskKind === "research", "TASK_RESEARCHER_DISCOVER_KIND", "A researcher in discover must use the fused read-only research task kind.");
    invariant(readOnly, "TASK_RESEARCHER_DISCOVER_READ_ONLY", "A researcher in discover must be read-only.");
    invariant(field(input, "authorityBoundary", "AuthorityBoundary", "local-read") === "local-read",
      "TASK_RESEARCHER_DISCOVER_AUTHORITY", "A researcher in discover must use local-read authority.");
  }
  if (["discover", "research", "design", "review", "verify"].includes(run.phase)) {
    invariant(readOnly, "PHASE_TASK_READ_ONLY", `Only read-only tasks can be created during ${run.phase}.`);
  }
  if (run.phase === "plan" && !mutableRoles.has(role)) {
    invariant(readOnly, "PHASE_TASK_READ_ONLY", `${role} tasks must be read-only.`);
  }
  if (run.phase === "curate" && role !== "curator" && role !== "task-compiler" && role !== "diagnostician") {
    throw new MetisError("TASK_ROLE_PHASE", "Only curator, task-compiler, or diagnostician tasks can be created during curate.");
  }

  const targetPaths = asArray(field(input, "targetPaths", "TargetPaths", [])).map((item) => normalizeRepoPath(String(item)));
  if (!readOnly) invariant(targetPaths.length > 0, "TASK_PATHS_REQUIRED", "A mutable task needs targetPaths.");
  for (const target of targetPaths) invariant(isSafeRepoPath(target), "TASK_PATH_INVALID", `Unsafe repository path: ${target}.`);
  if (!readOnly) validateMutableOwnershipPaths(run.project_root, targetPaths);

  const milestoneId = field(input, "milestoneId", "MilestoneId", null);
  if (milestoneId) {
    const milestone = getMilestone(db, milestoneId);
    invariant(milestone.run_id === run.id, "TASK_MILESTONE", "Task milestone must belong to the same run.");
    const milestoneCount = Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE milestone_id = ?").get(milestoneId).count);
    invariant(milestoneCount < config.orchestration.maxTasksPerMilestone, "MILESTONE_TASK_LIMIT", `Milestone ${milestoneId} reached its task limit.`);
  }

  const parentTaskId = field(input, "parentTaskId", "ParentTaskId", null);
  let delegationDepth = Number(field(input, "delegationDepth", "DelegationDepth", 0));
  if (parentTaskId) {
    const parent = getTask(db, parentTaskId);
    invariant(parent.run_id === run.id, "TASK_PARENT_RUN", "Parent task must belong to the same run.");
    invariant(parent.role === "coordinator", "TASK_PARENT_ROLE", "Only a coordinator can own child tasks.");
    delegationDepth = Number(parent.delegation_depth) + 1;
  }
  invariant(Number.isInteger(delegationDepth) && delegationDepth >= 0, "TASK_DELEGATION_DEPTH", "Delegation depth must be a non-negative integer.");
  invariant(delegationDepth <= Number(config.orchestration.maxDelegationDepth), "TASK_DELEGATION_LIMIT", `Task delegation depth exceeds ${config.orchestration.maxDelegationDepth}.`);

  let requirementIds = [...new Set(asArray(field(input, "requirementIds", "RequirementIds", [])).map((item) => String(item).trim()).filter(Boolean))];
  if (requirementIds.length === 0 && ["execute", "review", "verify", "curate"].includes(scheduledPhase)) {
    const active = db.prepare("SELECT id FROM requirements WHERE run_id = ? AND status <> 'superseded' ORDER BY id").all(run.id);
    if (active.length === 1) requirementIds = [active[0].id];
  }
  for (const requirementId of requirementIds) {
    invariant(db.prepare("SELECT 1 FROM requirements WHERE run_id = ? AND id = ? AND status <> 'superseded'").get(run.id, requirementId),
      "TASK_REQUIREMENT", `Requirement ${requirementId} was not found or is superseded.`);
  }
  if (["execute", "review", "verify", "curate"].includes(scheduledPhase)) {
    invariant(requirementIds.length > 0, "TASK_REQUIREMENTS_REQUIRED", `Task ${title} must link to at least one requirement.`);
  }

  const risk = String(field(input, "risk", "Risk", "medium")).toLowerCase();
  const effort = String(field(input, "effort", "Effort", "medium")).toLowerCase();
  const sliceType = String(field(input, "sliceType", "SliceType", taskKind === "implementation" ? "vertical" : taskKind)).toLowerCase();
  invariant(["low", "medium", "high", "critical"].includes(risk), "TASK_RISK", `Unsupported task risk: ${risk}.`);
  invariant(["small", "medium", "large"].includes(effort), "TASK_EFFORT", `Unsupported task effort: ${effort}.`);
  invariant(["vertical", "horizontal", "mechanical", "review", "verification", "discovery", "research", "synthesis", "design", "planning", "compilation", "integration", "diagnosis", "repair", "curation"].includes(sliceType),
    "TASK_SLICE_TYPE", `Unsupported task slice type: ${sliceType}.`);

  const defaultVerificationModes = role === "verifier" ? ["semantic"] : readOnly ? [] : ["test"];
  let verificationModes = [...new Set(asArray(field(input, "verificationModes", "VerificationModes", defaultVerificationModes))
    .map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  let resolvedCapabilities = resolveTaskCapabilities(db, run.id, { ...input, role, taskKind, targetPaths, requirementIds, verificationModes });
  if (config.productDelivery?.requireBrowserEvidence !== false
      && resolvedCapabilities.some((item) => item.name === "frontend-ui")
      && !verificationModes.includes("browser")) {
    verificationModes = [...verificationModes, "browser"];
    resolvedCapabilities = resolveTaskCapabilities(db, run.id, { ...input, role, taskKind, targetPaths, requirementIds, verificationModes });
  }
  const capabilityNames = resolvedCapabilities.map((item) => item.name);

  const route = selectModelRoute(config, role, {
    host: run.host,
    complexity: field(input, "complexity", "Complexity", "medium"),
    modelTier: field(input, "modelTier", "ModelTier", null),
    model: field(input, "model", "Model", undefined),
    reasoningEffort: field(input, "reasoningEffort", "ReasoningEffort", null)
  });
  const id = input.id ?? input.Id ?? makeId("task");
  const timestamp = now();
  const specialist = REVIEW_ROLES.has(role) && role !== "reviewer" && role !== "adversarial-reviewer"
    ? role.replace(/-reviewer$/u, "")
    : field(input, "specialist", "Specialist", null);
  const reviewKind = REVIEW_ROLES.has(role)
    ? String(field(input, "reviewKind", "ReviewKind", role === "adversarial-reviewer" ? "completion" : "integration"))
    : null;
  const compilerTargetTaskId = field(input, "compilerTargetTaskId", "CompilerTargetTaskId", null);
  if (compilerTargetTaskId) {
    const target = db.prepare("SELECT run_id FROM tasks WHERE id = ?").get(compilerTargetTaskId);
    invariant(target?.run_id === run.id, "TASK_COMPILER_TARGET", `Compiler target ${compilerTargetTaskId} was not found in this run.`);
    invariant(role === "task-compiler", "TASK_COMPILER_ROLE", "Only task-compiler can declare a compiler target.");
  }
  const interfaceInputs = asArray(field(input, "interfaceInputs", "InterfaceInputs", []));
  const interfaceOutputs = asArray(field(input, "interfaceOutputs", "InterfaceOutputs", []));
  const contextRefs = asArray(field(input, "contextRefs", "ContextRefs", []));
  const stopConditions = asArray(field(input, "stopConditions", "StopConditions", []));
  const expectedOutputs = asArray(field(input, "expectedOutputs", "ExpectedOutputs", []));
  const dependencies = asArray(field(input, "dependsOn", "DependsOn", []));

  transaction(db, () => {
    if (role !== "plan-critic" && ["plan", "execute", "review"].includes(run.phase)
        && latestArtifact(db, run.project_root, run.id, "plan", ["verified"])) {
      db.prepare("UPDATE artifacts SET status = 'stale', updated_at = ? WHERE run_id = ? AND kind IN ('plan', 'plan-review') AND status = 'verified'")
        .run(timestamp, run.id);
    }
    if (run.phase === "design" && role !== "design-critic" && latestArtifact(db, run.project_root, run.id, "design-seal", ["verified"])) {
      db.prepare("UPDATE artifacts SET status = 'stale', updated_at = ? WHERE run_id = ? AND kind IN ('design-seal', 'design-review') AND status = 'verified'")
        .run(timestamp, run.id);
    }
    db.prepare(`
      INSERT INTO tasks(
        id, run_id, milestone_id, parent_task_id, delegation_depth, title, goal, role, task_kind, wave, phase, status,
        contract_status, contract_policy, compiler_target_task_id, compiled_packet_id,
        priority, read_only, complexity, risk, effort, slice_type, verification_modes_json, capabilities_json,
        model_tier, selected_model, model_source, requested_effort, effective_effort, effort_source,
        supported_efforts_json, capability_status, reasoning_effort, scope_json, non_goals_json, constraints_json,
        target_paths_json, interfaces_json, interface_inputs_json, interface_outputs_json, context_refs_json,
        stop_conditions_json, expected_outputs_json, acceptance_json, required_evidence_json, requirement_ids_json,
        specialist, review_kind, auto_generated, progress_weight, authority, max_attempts, created_at, updated_at
      ) VALUES(
        $id, $runId, $milestoneId, $parentTaskId, $delegationDepth, $title, $goal, $role, $taskKind, $wave, $phase, 'pending',
        'draft', 'deterministic', $compilerTargetTaskId, NULL,
        $priority, $readOnly, $complexity, $risk, $effort, $sliceType, $verificationModes, $capabilities,
        $modelTier, $selectedModel, $modelSource, $requestedEffort, $effectiveEffort, $effortSource,
        $supportedEfforts, $capabilityStatus, $reasoningEffort, $scope, $nonGoals, $constraints,
        $targetPaths, $interfaces, $interfaceInputs, $interfaceOutputs, $contextRefs,
        $stopConditions, $expectedOutputs, $acceptance, $requiredEvidence, $requirementIds,
        $specialist, $reviewKind, $autoGenerated, $progressWeight, $authority, $maxAttempts, $createdAt, $updatedAt
      )
    `).run({
      $id: id, $runId: run.id, $milestoneId: milestoneId, $parentTaskId: parentTaskId,
      $delegationDepth: delegationDepth, $title: title, $goal: goal, $role: role, $taskKind: taskKind, $wave: wave,
      $phase: scheduledPhase, $priority: Number(field(input, "priority", "Priority", 50)), $readOnly: readOnly ? 1 : 0,
      $complexity: route.complexity, $risk: risk, $effort: effort, $sliceType: sliceType,
      $verificationModes: json(verificationModes), $capabilities: json(capabilityNames),
      $modelTier: route.tier, $selectedModel: route.model, $modelSource: route.modelSource,
      $requestedEffort: route.requestedEffort, $effectiveEffort: route.effectiveEffort,
      $effortSource: route.effortSource, $supportedEfforts: json(route.supportedEfforts ?? []),
      $capabilityStatus: route.capabilityStatus ?? "known", $reasoningEffort: route.reasoningEffort,
      $scope: json(asArray(field(input, "scope", "Scope", []))),
      $nonGoals: json(asArray(field(input, "nonGoals", "NonGoals", []))),
      $constraints: json(asArray(field(input, "constraints", "Constraints", []))),
      $targetPaths: json(targetPaths), $interfaces: json(asArray(field(input, "interfaces", "Interfaces", []))),
      $interfaceInputs: json(interfaceInputs), $interfaceOutputs: json(interfaceOutputs), $contextRefs: json(contextRefs),
      $stopConditions: json(stopConditions), $expectedOutputs: json(expectedOutputs),
      $acceptance: json(asArray(field(input, "acceptanceCriteria", "AcceptanceCriteria", []))),
      $requiredEvidence: json(asArray(field(input, "requiredEvidence", "RequiredEvidence", []))),
      $requirementIds: json(requirementIds), $specialist: specialist, $reviewKind: reviewKind,
      $compilerTargetTaskId: compilerTargetTaskId,
      $autoGenerated: field(input, "autoGenerated", "AutoGenerated", false) ? 1 : 0,
      $progressWeight: Number(field(input, "progressWeight", "ProgressWeight", 1)),
      $authority: field(input, "authorityBoundary", "AuthorityBoundary", readOnly ? "local-read" : "local-write-assigned-paths"),
      $maxAttempts: Number(field(input, "maxAttempts", "MaxAttempts", config.orchestration.maxRetries + 1)),
      $createdAt: timestamp, $updatedAt: timestamp
    });
    bindTaskCapabilities(db, id, resolvedCapabilities);
    bindTaskInterfaces(db, run.id, id, {
      inputs: interfaceInputs,
      outputs: interfaceOutputs,
      allowOutputChange: Boolean(field(input, "allowInterfaceChange", "AllowInterfaceChange", false))
    });
    for (const dependency of dependencies) {
      invariant(db.prepare("SELECT 1 FROM tasks WHERE id = ? AND run_id = ?").get(dependency, run.id), "TASK_DEPENDENCY", `Dependency ${dependency} was not found.`);
      db.prepare("INSERT INTO task_dependencies(task_id, depends_on) VALUES(?, ?)").run(id, dependency);
    }
    for (const requirementId of requirementIds) {
      db.prepare(`
        INSERT INTO trace_links(
          id, run_id, requirement_id, target_type, target_id, relation,
          status, evidence_refs_json, created_at, updated_at
        ) VALUES(?, ?, ?, 'task', ?, 'planned-by', 'current', '[]', ?, ?)
        ON CONFLICT(run_id, requirement_id, target_type, target_id, relation) DO UPDATE SET
          status = 'current', updated_at = excluded.updated_at
      `).run(makeId("trace"), run.id, requirementId, id, timestamp, timestamp);
    }
    validateGraph(db, run.id);
    touchRun(db, run.id);
    recordEvent(db, run.id, "task.created", "info", {
      taskId: id, title, role, taskKind, wave, runPhase: scheduledPhase, milestoneId, parentTaskId,
      delegationDepth, requirementIds, readOnly, modelTier: route.tier, reasoningEffort: route.reasoningEffort,
      risk, effort, sliceType, verificationModes, capabilities: capabilityNames, dependencies,
      interfaceInputs, interfaceOutputs, compilerTargetTaskId
    });
  });

  if (!input.__skipPacket) {
    const policy = taskPacketPolicy(db, id, config);
    const compiled = compileTaskPacket(db, run.project_root, id, config);
    if (policy === "llm" && compiled.status === "needs-compiler" && !input.__skipCompiler) {
      createCompilerTaskForTarget(db, run, getTask(db, id), config);
    }
  }
  return getTask(db, id);
}

export function getTask(db, taskId) {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  invariant(task, "TASK_NOT_FOUND", `Task ${taskId} was not found.`);
  return hydrateTask(db, task);
}

function hydrateTask(db, task) {
  const dependencies = db.prepare("SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY depends_on")
    .all(task.id).map((row) => row.depends_on);
  return {
    ...task,
    taskKind: task.task_kind,
    wave: Number(task.wave),
    contractStatus: task.contract_status,
    contractPolicy: task.contract_policy,
    compilerTargetTaskId: task.compiler_target_task_id,
    compiledPacketId: task.compiled_packet_id,
    readOnly: Boolean(task.read_only),
    scope: parseJson(task.scope_json, []),
    nonGoals: parseJson(task.non_goals_json, []),
    constraints: parseJson(task.constraints_json, []),
    targetPaths: parseJson(task.target_paths_json, []),
    interfaces: parseJson(task.interfaces_json, []),
    interfaceInputs: parseJson(task.interface_inputs_json, []),
    interfaceOutputs: parseJson(task.interface_outputs_json, []),
    interfaceContracts: taskInterfaceContracts(db, task.id),
    contextRefs: parseJson(task.context_refs_json, []),
    stopConditions: parseJson(task.stop_conditions_json, []),
    expectedOutputs: parseJson(task.expected_outputs_json, []),
    acceptanceCriteria: parseJson(task.acceptance_json, []),
    risk: task.risk,
    effort: task.effort,
    sliceType: task.slice_type,
    verificationModes: parseJson(task.verification_modes_json, []),
    capabilities: taskCapabilities(db, task.id),
    requiredEvidence: parseJson(task.required_evidence_json, []),
    requirementIds: parseJson(task.requirement_ids_json, []),
    requestedEffort: task.requested_effort ?? task.reasoning_effort,
    effectiveEffort: task.effective_effort ?? task.reasoning_effort,
    effortSource: task.effort_source ?? "persisted",
    supportedEfforts: parseJson(task.supported_efforts_json, []),
    capabilityStatus: task.capability_status ?? "known",
    transientRetryCount: Number(task.transient_retry_count ?? 0),
    attemptHistory: taskAttemptHistory(db, task.id),
    autoGenerated: Boolean(task.auto_generated),
    result: parseJson(task.result_json, null),
    dependsOn: dependencies
  };
}

export function listTasks(db, runId, status = null) {
  const rows = status
    ? db.prepare("SELECT * FROM tasks WHERE run_id = ? AND status = ? ORDER BY priority DESC, created_at").all(runId, status)
    : db.prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at").all(runId);
  return rows.map((task) => hydrateTask(db, task));
}

export function getRunnableTasks(db, runId, limit) {
  refreshMilestoneStatuses(db, runId);
  return runnableTasks(db, runId, limit).map((task) => hydrateTask(db, task));
}

export function taskContract(db, taskId) {
  const task = getTask(db, taskId);
  const run = getRun(db, task.run_id);
  const taskConfig = loadConfig(run.project_root);
  const packetState = getTaskPacket(db, task.id, taskConfig);
  const packet = packetState.packet;
  let workspace;
  try {
    workspace = getTaskWorkspace(db, task, run.project_root);
  } catch (error) {
    if (error?.code !== "WORKTREE_NOT_ACTIVE") throw error;
    workspace = { path: run.project_root, mode: task.readOnly ? "shared-read-only" : "unprepared" };
  }

  const baselineArtifact = latestArtifact(db, run.project_root, run.id, "workspace-baseline");
  let baseline = {};
  try { baseline = baselineArtifact?.content ? JSON.parse(baselineArtifact.content) : {}; } catch {}
  const taskBaselineArtifact = latestArtifact(db, run.project_root, run.id, `task-baseline:${task.id}`, ["verified"]);
  let taskBaseline = {};
  try { taskBaseline = taskBaselineArtifact?.content ? JSON.parse(taskBaselineArtifact.content) : {}; } catch {}
  const preexistingChanges = asArray(baseline.preexistingChanges)
    .filter((file) => task.readOnly || task.targetPaths.some((target) => pathsOverlap(file, target)));

  const predecessorResults = task.dependsOn.map((id) => {
    const predecessor = getTask(db, id);
    return {
      TaskId: predecessor.id,
      Role: predecessor.role,
      TaskKind: predecessor.taskKind,
      Status: predecessor.status,
      Summary: predecessor.result?.Summary ?? "",
      Decisions: predecessor.result?.Decisions ?? [],
      Breaking: predecessor.result?.Breaking ?? [],
      ProducedArtifacts: predecessor.result?.ProducedArtifacts ?? [],
      InterfaceReport: predecessor.result?.InterfaceReport ?? {},
      Facts: predecessor.result?.Facts ?? [],
      Unknowns: predecessor.result?.Unknowns ?? [],
      RelevantPaths: predecessor.result?.RelevantPaths ?? [],
      Interfaces: predecessor.result?.Interfaces ?? [],
      Risks: predecessor.result?.Risks ?? [],
      Questions: predecessor.result?.Questions ?? [],
      Sources: predecessor.result?.Sources ?? [],
      ResearchFindings: predecessor.result?.ResearchFindings ?? [],
      ResearchConstraints: predecessor.result?.ResearchConstraints ?? [],
      Recommendations: predecessor.result?.Recommendations ?? [],
      ArtifactKind: predecessor.result?.ArtifactKind ?? "",
      ArtifactContent: predecessor.result?.ArtifactContent ?? null,
      Diagnosis: predecessor.result?.Diagnosis ?? null,
      StructuredRef: predecessor.result?.StructuredRef ?? null,
      EvidenceRefs: predecessor.result?.EvidenceRefs ?? []
    };
  });
  const prior = task.result
    ? [{ Attempt: task.attempts, Status: task.result.Status, Summary: task.result.Summary, Blockers: task.result.Blockers ?? [] }]
    : [];

  const artifactKind = subjectArtifactKind(task);
  const subjectArtifact = artifactKind ? latestArtifact(db, run.project_root, run.id, artifactKind, ["verified"]) : null;
  let subjectContent = null;
  try { subjectContent = subjectArtifact?.content ? JSON.parse(subjectArtifact.content) : null; } catch {}
  const runtimeLauncher = path.join(run.project_root, ".agents", "metis", "metis.mjs");
  const evidenceAccess = subjectArtifact ? {
    artifact: {
      command: process.execPath,
      args: ["--no-warnings", runtimeLauncher, "--root", run.project_root, "artifact", "get", subjectArtifact.id, "--pretty"]
    },
    object: {
      command: process.execPath,
      args: ["--no-warnings", runtimeLauncher, "--root", run.project_root, "object", "get", subjectArtifact.content_ref]
    },
    fallback: { command: "metis", args: ["--root", run.project_root, "artifact", "get", subjectArtifact.id, "--pretty"] }
  } : null;

  const children = db.prepare(`
    SELECT id, title, role, task_kind, wave, phase, status, priority, contract_status FROM tasks
    WHERE parent_task_id = ? ORDER BY wave, priority DESC, created_at
  `).all(task.id);
  const openReviewFindings = REVIEW_ROLES.has(task.role)
    ? db.prepare(`
        SELECT id, title, description, severity, status, target_paths_json, requirement_ids_json, suggested_fix
        FROM review_findings
        WHERE run_id = ? AND review_kind = ? AND status IN ('open','fixing','pending-review')
        ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC, created_at
      `).all(run.id, task.review_kind ?? (task.role === "adversarial-reviewer" ? "completion" : "integration")).map((item) => ({
        Id: item.id,
        Title: item.title,
        Description: item.description,
        Severity: item.severity,
        Status: item.status,
        TargetPaths: parseJson(item.target_paths_json, []),
        RequirementIds: parseJson(item.requirement_ids_json, []),
        SuggestedFix: item.suggested_fix
      }))
    : [];

  const currentUpstream = predecessorResults.length
    ? `\n\n# CURRENT UPSTREAM RESULTS\n${JSON.stringify(predecessorResults, null, 2)}`
    : "";
  const runtimeContext = `\n\n# RUNTIME CONTEXT\n${JSON.stringify({
    RepositoryRoot: workspace.path,
    IntegrationRoot: run.project_root,
    WorkspaceMode: workspace.mode,
    LeaseFence: Number(task.attempt_fence),
    PreexistingChanges: preexistingChanges
  }, null, 2)}`;

  return {
    RunId: run.id,
    MilestoneId: task.milestone_id,
    ParentTaskId: task.parent_task_id,
    DelegationDepth: task.delegation_depth,
    RepositoryRoot: workspace.path,
    IntegrationRoot: run.project_root,
    WorkspaceMode: workspace.mode,
    TaskId: task.id,
    TaskKind: task.taskKind,
    Wave: task.wave,
    RunPhase: task.phase,
    Goal: task.goal,
    ContractVersion: run.contract_version,
    RequirementIds: task.requirementIds,
    Background: predecessorResults,
    ChildTaskIds: children.map((item) => item.id),
    ChildTasks: children,
    PastFailures: prior,
    AttemptHistory: task.attemptHistory,
    Scope: task.scope,
    NonGoals: task.nonGoals,
    Constraints: task.constraints,
    TargetPaths: task.targetPaths,
    PreexistingChanges: preexistingChanges,
    Interfaces: task.interfaces,
    InterfaceContracts: task.interfaceContracts,
    AcceptanceCriteria: task.acceptanceCriteria,
    RequiredEvidence: task.requiredEvidence,
    ExpectedOutputs: task.expectedOutputs,
    ContextRefs: task.contextRefs,
    StopConditions: task.stopConditions,
    ...(subjectArtifact ? {
      SubjectArtifact: {
        kind: artifactKind,
        id: subjectArtifact.id,
        contentRef: subjectArtifact.content_ref,
        contentHash: subjectContent?.planHash ?? subjectContent?.designHash ?? subjectArtifact.metadata?.contentHash ?? subjectArtifact.content_ref
      },
      EvidenceAccess: evidenceAccess
    } : {}),
    AuthorityBoundary: task.authority,
    OrchestrationBoundary: "Metis controls task ownership, state, worktrees, integration, and evidence. Host tool permissions remain host-controlled.",
    LeasePolicy: {
      AttemptFence: Number(task.attempt_fence),
      DurationMinutes: Number(taskConfig.orchestration.leaseMinutes),
      HeartbeatSeconds: Number(taskConfig.orchestration.leaseHeartbeatSeconds),
      ExpiryBehavior: "fail-closed; diagnose before explicit retry"
    },
    ReadOnly: task.readOnly,
    AgentType: `metis-${task.role}`,
    ReviewKind: task.review_kind,
    Specialist: task.specialist,
    Risk: task.risk,
    Effort: task.effort,
    SliceType: task.sliceType,
    VerificationModes: task.verificationModes,
    Capabilities: packet.Capabilities,
    ...(REVIEW_ROLES.has(task.role) && task.role !== "adversarial-reviewer" ? {
      ReviewFingerprint: { codeFingerprint: taskBaseline.codeFingerprint ?? repositoryCodeFingerprint(db) }
    } : {}),
    OpenReviewFindings: openReviewFindings,
    RoleInstructions: subjectArtifact
      ? [...packet.RoleProtocol, subjectEvidenceRequirement(artifactKind)]
      : packet.RoleProtocol,
    Complexity: task.complexity,
    ModelTier: task.model_tier,
    Model: task.selected_model,
    ReasoningEffort: task.reasoning_effort,
    EscalationLevel: task.escalation_level,
    ResultTokenBudget: taskConfig.budgets.workerResultTokens,
    TaskPacket: {
      Id: packetState.packetId,
      Version: packetState.version,
      Policy: packetState.policy,
      BlueprintHash: packetState.blueprintHash,
      PacketHash: packetState.packetHash,
      ContentRef: packetState.packetRef,
      LoadCommand: {
        command: process.execPath,
        args: ["--no-warnings", runtimeLauncher, "--root", run.project_root, "object", "get", packetState.packetRef]
      },
      FallbackLoadCommand: { command: "metis", args: ["--root", run.project_root, "object", "get", packetState.packetRef] },
      Content: packet
    },
    CompiledPrompt: `${packet.Prompt}${subjectArtifact ? `\n\n# SUBJECT ARTIFACT EVIDENCE\n${subjectEvidenceRequirement(artifactKind)}` : ""}${currentUpstream}${runtimeContext}`,
    ResultSchema: subjectArtifact
      ? { ...packet.ResultSchema, SubjectEvidenceRequirement: subjectEvidenceRequirement(artifactKind) }
      : packet.ResultSchema
  };
}

export function prepareClaimedTask(db, runId, taskId, owner, config, options = {}) {
  cleanupExpiredLeases(db);
  const requestedTask = getTask(db, taskId);
  if (config.delegation?.requireReadyTaskPacket !== false) {
    let packet = taskPacketStatus(db, requestedTask.id, config);
    if (!packet.current && packet.policy === "deterministic") {
      compileTaskPacket(db, getRun(db, runId).project_root, requestedTask.id, config);
      packet = taskPacketStatus(db, requestedTask.id, config);
    }
    invariant(packet.current, "TASK_PACKET_NOT_READY", `Task ${requestedTask.id} cannot be dispatched until its execution packet is ready.`);
  }
  assertBudgetAvailable(db, runId, {
    agentSpawns: 1,
    ...(requestedTask.role === "researcher" ? { researchCalls: 1 } : {})
  });
  const leaseToken = makeId("lease");
  const timestamp = now();
  const expiresAt = new Date(Date.now() + config.orchestration.leaseMinutes * 60_000).toISOString();
  const claimed = transaction(db, () => {
    const run = getRun(db, runId);
    invariant(run.status === "active", "RUN_NOT_ACTIVE", `Run ${run.id} is ${run.status}.`);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND run_id = ?").get(taskId, run.id);
    invariant(task, "TASK_NOT_FOUND", `Task ${taskId} was not found in this run.`);
    invariant(taskCanRunInPhase(task, run.phase), "CLAIM_PHASE", `Task ${taskId} cannot run during ${run.phase}.`);
    invariant(task.status === "pending", "TASK_NOT_PENDING", `Task ${taskId} is ${task.status}.`);
    if (config.delegation?.scheduleByWave !== false) {
      const wave = earliestOpenWave(db, run.id, run.phase);
      invariant(Number(task.wave) === Number(wave), "TASK_WAVE_NOT_EARLIEST",
        `Task ${taskId} is in wave ${task.wave}, but the earliest open wave is ${wave}.`, {
          taskWave: Number(task.wave), earliestOpenWave: wave
        });
    }
    const requiredSubjectKind = subjectArtifactKind(task);
    if (requiredSubjectKind) {
      invariant(latestArtifact(db, run.project_root, run.id, requiredSubjectKind, ["verified"]),
        "TASK_SUBJECT_ARTIFACT_REQUIRED", `${task.role} requires a current ${requiredSubjectKind} artifact before dispatch.`);
    }
    if (task.parent_task_id) {
      const parent = db.prepare("SELECT role, status FROM tasks WHERE id = ? AND run_id = ?").get(task.parent_task_id, run.id);
      invariant(parent?.role === "coordinator" && parent.status === "running", "TASK_PARENT_NOT_RUNNING", `Parent coordinator ${task.parent_task_id} must be running.`);
    }
    const localAuthorities = new Set(["local-read", "local-write-assigned-paths", "local-command"]);
    if (!localAuthorities.has(task.authority)) {
      const grant = db.prepare("SELECT id FROM artifacts WHERE run_id = ? AND kind = ? AND status = 'verified' ORDER BY updated_at DESC LIMIT 1")
        .get(run.id, `authority-grant:${task.id}`);
      invariant(grant, "AUTHORITY_GRANT_REQUIRED", `Task ${task.id} requires explicit authority for ${task.authority}.`);
    }
    refreshMilestoneStatuses(db, run.id);
    invariant(runnableTasks(db, run.id, 1000).some((candidate) => candidate.id === taskId), "TASK_NOT_RUNNABLE", `Task ${taskId} is not runnable.`);
    const running = Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'running'").get(run.id).count);
    invariant(running < config.orchestration.maxConcurrent, "CONCURRENCY_LIMIT", "The configured concurrency limit is reached.");
    const conflicts = taskConflicts(task, activeLeases(db));
    if (conflicts.length > 0) throw new MetisError("RESOURCE_CONFLICT", "Task resources are already owned.", { conflicts });
    const update = db.prepare(`
      UPDATE tasks SET status = 'running', owner = ?, attempts = attempts + 1,
        attempt_fence = attempt_fence + 1, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(owner, timestamp, taskId);
    invariant(update.changes === 1, "TASK_CLAIM_RACE", `Task ${taskId} was claimed by another worker.`);
    const fence = Number(db.prepare("SELECT attempt_fence FROM tasks WHERE id = ?").get(taskId).attempt_fence);
    startTaskAttempt(db, run, task, fence, { attemptNumber: Number(task.attempts) + 1 });
    const resources = Boolean(task.read_only) ? [`@task:${taskId}`] : parseJson(task.target_paths_json, []);
    for (const resource of resources) {
      db.prepare(`
        INSERT INTO leases(resource, task_id, token, fencing_token, owner, expires_at, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(resource, taskId, leaseToken, fence, owner, expiresAt, timestamp);
    }
    touchRun(db, run.id);
    recordEvent(db, run.id, "task.claimed", "info", { taskId, owner, expiresAt, attemptFence: fence });
    return { runId: run.id, attemptFence: fence };
  });
  const run = getRun(db, claimed.runId);
  try {
    const workspace = prepareTaskWorkspace(db, run, getTask(db, taskId), config);
    captureTaskBaseline(db, run, getTask(db, taskId), config, workspace);
  } catch (error) {
    releaseTaskClaim(db, run.project_root, taskId, claimed.attemptFence, error instanceof Error ? error.message : String(error));
    throw error;
  }
  const updated = getTask(db, taskId);
  const contract = taskContract(db, taskId);
  contract.ResultTokenBudget = config.budgets.workerResultTokens;
  return {
    task: updated, leaseToken, attemptFence: claimed.attemptFence, expiresAt,
    workspacePath: contract.RepositoryRoot, workspaceMode: contract.WorkspaceMode,
    contract, runId: claimed.runId, owner, deferredSpawnAck: options.deferSpawnAck === true
  };
}

export function acknowledgeTaskSpawn(db, runId, taskId, attemptFence, owner, config, batchId = null) {
  return transaction(db, () => {
    const task = getTask(db, taskId);
    invariant(task.run_id === runId && task.status === "running", "TASK_SPAWN_ACK_STATUS", `Task ${taskId} is not running.`);
    invariant(Number(task.attempt_fence) === Number(attemptFence), "TASK_FENCED", `Task ${taskId} attempt is stale.`);
    const existing = db.prepare("SELECT 1 FROM task_spawn_acks WHERE task_id = ? AND attempt_fence = ?").get(taskId, Number(attemptFence));
    if (existing) return { taskId, attemptFence: Number(attemptFence), acknowledged: false };
    const counters = {
      agentSpawns: 1,
      ...(task.role === "researcher" ? { researchCalls: 1 } : {})
    };
    assertBudgetAvailable(db, runId, counters);
    bindTaskAttemptBatch(db, taskId, attemptFence, batchId);
    const inserted = db.prepare(`
      INSERT INTO task_spawn_acks(task_id, attempt_fence, batch_id, owner, acknowledged_at)
      VALUES(?, ?, ?, ?, ?) ON CONFLICT(task_id, attempt_fence) DO NOTHING
    `).run(taskId, Number(attemptFence), batchId, owner, now());
    if (inserted.changes === 0) return { taskId, attemptFence: Number(attemptFence), acknowledged: false };
    markTaskAttemptSpawnAccepted(db, taskId, attemptFence);
    consumeBudget(db, runId, counters, { source: batchId ? `scheduler-spawn:${batchId}:${taskId}` : `task-spawn:${taskId}` });
    recordEvent(db, runId, "task.spawn-acknowledged", "info", { taskId, attemptFence: Number(attemptFence), batchId, owner });
    return { taskId, attemptFence: Number(attemptFence), acknowledged: true };
  });
}

export function claimTask(db, runId, taskId, owner, config) {
  const claim = prepareClaimedTask(db, runId, taskId, owner, config);
  try {
    acknowledgeTaskSpawn(db, runId, taskId, claim.attemptFence, owner, config);
    return claim;
  } catch (error) {
    releaseTaskClaim(db, getRun(db, runId).project_root, taskId, claim.attemptFence, "spawn-ack-failed");
    throw error;
  }
}

export function releaseTaskClaim(db, projectRoot, taskId, attemptFence, reason = "claim-aborted") {
  const task = getTask(db, taskId);
  if (task.status !== "running" || Number(task.attempt_fence) !== Number(attemptFence)) return false;
  const released = transaction(db, () => {
    const changed = db.prepare(`
      UPDATE tasks SET status = 'pending', owner = NULL,
        attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
        updated_at = ?
      WHERE id = ? AND status = 'running' AND attempt_fence = ?
        AND owner NOT LIKE ?
    `)
      .run(now(), taskId, Number(attemptFence), `${COMPLETION_RESERVATION_PREFIX}%`);
    if (changed.changes !== 1) return false;
    finalizeTaskAttempt(db, taskId, Number(attemptFence), "aborted", {
      failureClass: "transient", failureCause: reason
    });
    db.prepare("DELETE FROM leases WHERE task_id = ? AND fencing_token = ?").run(taskId, Number(attemptFence));
    db.prepare("DELETE FROM task_spawn_acks WHERE task_id = ? AND attempt_fence = ?").run(taskId, Number(attemptFence));
    recordEvent(db, task.run_id, "task.claim-released", "warning", { taskId, attemptFence: Number(attemptFence), reason });
    return true;
  });
  if (!released) return false;
  cleanupTaskWorkspace(db, projectRoot, taskId, "claim-released", Number(attemptFence));
  return true;
}

function verifyLease(db, task, leaseToken) {
  const leases = db.prepare("SELECT token, fencing_token, expires_at FROM leases WHERE task_id = ?").all(task.id);
  invariant(leases.length > 0, "LEASE_REQUIRED", `Task ${task.id} has no active resource lease.`);
  invariant(leases.every((lease) => lease.token === leaseToken), "LEASE_INVALID", `Invalid lease token for task ${task.id}.`);
  invariant(leases.every((lease) => Number(lease.fencing_token) === Number(task.attempt_fence)), "TASK_FENCED", `Task ${task.id} attempt is stale.`);
  invariant(leases.every((lease) => Date.parse(lease.expires_at) > Date.now()), "LEASE_EXPIRED", `Task ${task.id} lease expired.`);
}

export function heartbeatTask(db, runId, taskId, leaseToken, config, minutes = null) {
  const run = getRun(db, runId);
  const task = getTask(db, taskId);
  invariant(task.run_id === run.id, "TASK_RUN_MISMATCH", "Task does not belong to this run.");
  invariant(task.status === "running", "TASK_NOT_RUNNING", `Task ${taskId} is ${task.status}.`);
  invariant(!isCompletionReservationOwner(task.owner), "TASK_COMPLETION_RESERVED", `Task ${taskId} has a completion reservation.`);
  verifyLease(db, task, leaseToken);
  const duration = minutes ?? config.orchestration.leaseMinutes;
  invariant(Number.isInteger(duration) && duration > 0, "LEASE_DURATION", "Lease duration must be a positive integer.");
  const expiresAt = new Date(Date.now() + duration * 60_000).toISOString();
  const changed = db.prepare("UPDATE leases SET expires_at = ? WHERE task_id = ? AND token = ? AND fencing_token = ?")
    .run(expiresAt, taskId, leaseToken, Number(task.attempt_fence));
  invariant(changed.changes > 0, "TASK_FENCED", `Task ${taskId} attempt changed concurrently.`);
  db.prepare("UPDATE worktrees SET updated_at = ? WHERE task_id = ? AND attempt_fence = ?").run(now(), taskId, Number(task.attempt_fence));
  touchRun(db, run.id);
  recordEvent(db, run.id, "task.heartbeat", "info", { taskId, expiresAt, attemptFence: Number(task.attempt_fence) });
  return { taskId, expiresAt, attemptFence: Number(task.attempt_fence) };
}

function compactItems(value, maxItems = 80, maxChars = 400) {
  return asArray(value).slice(0, maxItems).map((item) => typeof item === "string" ? item.slice(0, maxChars) : item);
}

function resultTokenCount(db, result, config, model) {
  return countTokens(db, stableStringify(result), { config, model }).tokens;
}

function compactNestedValue(value, options = {}, depth = 0) {
  const maxDepth = options.maxDepth ?? 3;
  const maxItems = options.maxItems ?? 12;
  const maxKeys = options.maxKeys ?? 16;
  const maxChars = options.maxChars ?? 240;
  if (typeof value === "string") return value.slice(0, maxChars);
  if (value === null || typeof value !== "object") return value;
  if (depth >= maxDepth) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) return value.slice(0, maxItems).map((item) => compactNestedValue(item, options, depth + 1));
  return Object.fromEntries(Object.keys(value).sort().slice(0, maxKeys)
    .map((key) => [key, compactNestedValue(value[key], options, depth + 1)]));
}

const MAX_COMPACT_IDENTITY_CHARS = 128;

function compactIdentity(value, preserve = false) {
  const text = String(value ?? "");
  if (preserve || text.length <= MAX_COMPACT_IDENTITY_CHARS) return text;
  const head = Math.floor(MAX_COMPACT_IDENTITY_CHARS / 2);
  return `${text.slice(0, head)}…${text.slice(-(MAX_COMPACT_IDENTITY_CHARS - head - 1))}`;
}

function requiredCriterionId(value, requiredIds) {
  const candidate = String(value ?? "").trim();
  if (!candidate) return null;
  if (requiredIds.has(candidate)) return candidate;
  const matches = [...requiredIds].filter((id) => compactIdentity(id) === candidate);
  invariant(matches.length < 2, "RESULT_CRITERION_ID_AMBIGUOUS", "A bounded acceptance criterion identity matches multiple contract criteria.");
  return matches[0] ?? null;
}

function compactEvidenceRef(ref, preferredId = null, includeMetadata = true) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return compactNestedValue(ref, { maxDepth: 2, maxItems: 4, maxKeys: 8, maxChars: 180 });
  const type = String(ref.type ?? "").toLowerCase();
  const fields = {
    artifact: includeMetadata ? ["type", "id", "kind", "status", "contentRef"] : ["type", "id", "contentRef"],
    source: ["type", "path", "startLine", "endLine", "fileSha256", "sliceSha256"],
    finding: ["type", "id", "status"],
    decision: ["type", "id", "status"],
    command: ["type", "checkId", "name", "status", "commandHash", "outputRef", "exitCode", "codeFingerprint"],
    object: ["type", "ref"],
    note: ["type", "text", "verifiable"]
  }[type];
  if (!fields) return compactNestedValue(ref, { maxDepth: 2, maxItems: 4, maxKeys: 8, maxChars: 180 });
  return Object.fromEntries(fields.filter((key) => key in ref).map((key) => {
    const value = ref[key];
    if (typeof value !== "string") return [key, value];
    if (key === "text") return [key, value.slice(0, 180)];
    const preserve = type === "artifact" && ref.id === preferredId && ["id", "contentRef"].includes(key);
    return [key, compactIdentity(value, preserve)];
  }));
}

function compactEvidenceRefs(value, maxItems = 20, preferredKind = null, includeMetadata = true, preferredId = null) {
  const refs = asArray(value);
  const subjectRefs = refs.filter((ref) => ref && typeof ref === "object" && ref.type === "artifact"
    && ((preferredKind && ref.kind === preferredKind) || (preferredId && ref.id === preferredId)));
  const artifactRefs = refs.filter((ref) => ref && typeof ref === "object" && ref.type === "artifact" && !subjectRefs.includes(ref));
  const otherRefs = refs.filter((ref) => !(ref && typeof ref === "object" && ref.type === "artifact"));
  // Artifact refs are provenance/gate inputs (including the review subject),
  // so retain them ahead of verbose notes when the enclosing array is clipped.
  return [...subjectRefs, ...artifactRefs, ...otherRefs].slice(0, maxItems).map((ref) => compactEvidenceRef(ref, preferredId, includeMetadata));
}

function compactTypedFields(value, fields, maxItems = 40, maxText = 320, preferredKind = null, maxEvidenceItems = 4, preferredId = null) {
  const items = asArray(value);
  // Keep the order stable, but make sure failed/blocking typed entries are not
  // pushed out by a long tail of successful entries during final compaction.
  const priority = (item) => {
    const status = String(item?.Status ?? item?.status ?? item?.Severity ?? item?.severity ?? "").toLowerCase();
    return ["critical", "error", "failed", "blocked"].includes(status) ? 0 : 1;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => priority(left.item) - priority(right.item) || left.index - right.index)
    .slice(0, maxItems)
    .sort((left, right) => left.index - right.index)
    .map(({ item }) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const compact = {};
      for (const key of fields) {
        if (!(key in item)) continue;
        const current = item[key];
        compact[key] = typeof current === "string"
          ? (TYPED_IDENTITY_FIELDS.has(key) ? compactIdentity(current) : current.slice(0, maxText))
          : Array.isArray(current)
            ? (/evidence/iu.test(key)
              ? compactEvidenceRefs(current, maxEvidenceItems, preferredKind, false, preferredId)
              : (/targetpaths|requirementids/iu.test(key)
                ? current.slice(0, 12).map((entry) => typeof entry === "string" ? entry.slice(0, 120) : compactNestedValue(entry, { maxDepth: 2, maxItems: 4, maxKeys: 6, maxChars: 120 }))
                : compactNestedValue(current, { maxDepth: 3, maxItems: 12, maxKeys: 12, maxChars: maxText })))
            : (current && typeof current === "object" ? compactNestedValue(current, { maxDepth: 3, maxItems: 12, maxKeys: 12, maxChars: maxText }) : current);
      }
      return compact;
    });
}

const ACCEPTANCE_RESULT_FIELDS = [
  "Criterion", "criterion", "CriterionId", "criterionId", "Id", "id",
  "Status", "status", "EvidenceRefs", "evidenceRefs", "Evidence", "evidence"
];
const CHECK_RESULT_FIELDS = [
  "Name", "name", "Status", "status", "EvidenceRefs", "evidenceRefs",
  "Evidence", "evidence", "ExitCode", "exitCode", "OutputRef", "outputRef"
];
const REVIEW_FINDING_FIELDS = [
  "Id", "id", "Title", "title", "Claim", "claim", "Description", "description",
  "Severity", "severity", "RequirementIds", "requirementIds", "TargetPaths", "targetPaths",
  "EvidenceRefs", "evidenceRefs", "SuggestedFix", "suggestedFix"
];
const TYPED_IDENTITY_FIELDS = new Set([
  "Id", "id", "Criterion", "criterion", "CriterionId", "criterionId",
  "Name", "name"
]);

function compactAcceptanceResults(value, maxItems, preferredKind = null, maxEvidenceItems = 4, maxText = 240, preferredId = null) {
  return compactTypedFields(value, ACCEPTANCE_RESULT_FIELDS, maxItems, maxText, preferredKind, maxEvidenceItems, preferredId);
}

function acceptanceCriterionId(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  for (const key of ["CriterionId", "criterionId", "Criterion", "criterion", "Id", "id"]) {
    if (item[key] === undefined || item[key] === null) continue;
    const value = String(item[key]).trim();
    if (value) return value;
  }
  return null;
}

function acceptanceCriterionIdSet(task, items) {
  const ids = new Set(asArray(task?.requirementIds).map((item) => String(item).trim()).filter(Boolean));
  for (const criterion of asArray(task?.acceptanceCriteria)) {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) continue;
    const id = acceptanceCriterionId(criterion);
    if (id) ids.add(id);
  }
  // Some contracts express criteria as strings rather than objects. Only treat
  // them as IDs when an outcome actually uses the same value; otherwise the
  // result entries themselves are the authoritative bounded criterion set.
  const outcomeIds = new Set(items.map(acceptanceCriterionId).filter(Boolean));
  for (const criterion of asArray(task?.acceptanceCriteria)) {
    if (typeof criterion !== "string") continue;
    const value = criterion.trim();
      if (value && (outcomeIds.has(value) || [...outcomeIds].some((outcomeId) => compactIdentity(value) === outcomeId))) ids.add(value);
  }
  return ids;
}

function compactAcceptanceOutcome(item, preferredKind, preferredId) {
  if (typeof item === "string") return item.slice(0, MAX_COMPACT_IDENTITY_CHARS);
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return compactNestedValue(item, { maxDepth: 2, maxItems: 4, maxKeys: 6, maxChars: 120 });
  }
  const compact = {};
  const criterionKey = ["Criterion", "criterion", "CriterionId", "criterionId", "Id", "id"]
    .find((key) => item[key] !== undefined && item[key] !== null && String(item[key]).trim());
  const statusKey = ["Status", "status"]
    .find((key) => item[key] !== undefined && item[key] !== null);
  const evidenceKey = ["EvidenceRefs", "evidenceRefs", "Evidence", "evidence"]
    .find((key) => item[key] !== undefined && item[key] !== null);
  if (criterionKey) compact[criterionKey] = compactIdentity(item[criterionKey]);
  if (statusKey) compact[statusKey] = typeof item[statusKey] === "string"
    ? item[statusKey].slice(0, 40)
    : item[statusKey];
  if (evidenceKey) {
    const evidence = item[evidenceKey];
    compact[evidenceKey] = Array.isArray(evidence)
      ? compactEvidenceRefs(evidence, 1, preferredKind, false, preferredId)
      : typeof evidence === "string" ? evidence.slice(0, 120) : compactNestedValue(evidence, { maxDepth: 1, maxItems: 1, maxKeys: 4, maxChars: 80 });
  }
  return compact;
}

function compactAcceptanceResultsForTask(value, task, preferredKind = null, preferredId = null, maxItems = 16) {
  const items = asArray(value);
  const requiredIds = acceptanceCriterionIdSet(task, items);
  const requiredById = new Map();
  const optional = [];

  // A hostile host can repeat one contract criterion arbitrarily many times.
  // Preserve one deterministic, highest-value outcome per distinct required
  // ID rather than allowing duplicates to bypass the item bound.
  const outcomeScore = (item, index) => {
    const status = String(item?.Status ?? item?.status ?? "").toLowerCase();
    const evidence = asArray(item?.EvidenceRefs ?? item?.evidenceRefs ?? item?.Evidence ?? item?.evidence);
    const hasPreferred = evidence.some((ref) => ref && typeof ref === "object" && ref.type === "artifact" && preferredId && ref.id === preferredId);
    const hasVerifiable = evidence.some((ref) => ref && typeof ref === "object" && ref.type !== "note");
    // Prefer a conservative failure over a duplicate success, then prefer the
    // exact subject evidence and finally the first input occurrence.
    return [
      ["failed", "blocked", "error", "critical"].includes(status) ? 2 : 1,
      hasPreferred ? 2 : hasVerifiable ? 1 : 0,
      -index
    ];
  };
  const isHigherScore = (left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] > right[index];
    }
    return false;
  };
  for (const entry of items.map((item, index) => ({ item, index }))) {
    const criterionId = acceptanceCriterionId(entry.item);
    const requiredId = requiredCriterionId(criterionId, requiredIds);
    if (requiredId) {
      const candidate = { ...entry, score: outcomeScore(entry.item, entry.index) };
      const currentByRequiredId = requiredById.get(requiredId);
      if (!currentByRequiredId || isHigherScore(candidate.score, currentByRequiredId.score)) requiredById.set(requiredId, candidate);
    } else optional.push(entry);
  }
  const required = [...requiredById.values()];
  // Contract-required outcomes are never displaced by optional verbose output.
  // Keep a bounded optional tail for compatibility with criteria not represented
  // in the frozen contract (and retain source order for deterministic replay).
  const selected = [...required, ...optional.slice(0, Math.max(0, maxItems - required.length))]
    .sort((left, right) => left.index - right.index);
  return selected.map(({ item }) => compactAcceptanceOutcome(item, preferredKind, preferredId));
}

function compactChecks(value, maxItems, preferredKind = null, maxEvidenceItems = 4, maxText = 240, preferredId = null) {
  return compactTypedFields(value, CHECK_RESULT_FIELDS, maxItems, maxText, preferredKind, maxEvidenceItems, preferredId);
}

function compactReviewFindings(value, maxItems, preferredKind = null, maxEvidenceItems = 4, maxText = 360, preferredId = null) {
  return compactTypedFields(value, REVIEW_FINDING_FIELDS, maxItems, maxText, preferredKind, maxEvidenceItems, preferredId);
}

function compactList(value, maxItems, maxChars = 240, maxKeys = 12) {
  return asArray(value).slice(0, maxItems).map((item) => typeof item === "string"
    ? item.slice(0, maxChars)
    : compactNestedValue(item, { maxDepth: 3, maxItems: 10, maxKeys, maxChars }));
}

function acceptanceResultsWithinBudget(value, task, preferredKind, preferredId, tokenBudget, build, minimalBuild, db, config, model) {
  const bounded = compactAcceptanceResultsForTask(value, task, preferredKind, preferredId, 16);
  const requiredIds = acceptanceCriterionIdSet(task, bounded);
  const required = bounded.filter((item) => requiredCriterionId(acceptanceCriterionId(item), requiredIds));
  const optional = bounded.filter((item) => !requiredCriterionId(acceptanceCriterionId(item), requiredIds));
  for (let optionalCount = optional.length; optionalCount >= 0; optionalCount -= 1) {
    const selected = new Set([...required, ...optional.slice(0, optionalCount)]);
    const acceptanceResults = bounded.filter((item) => selected.has(item));
    const candidate = build(acceptanceResults);
    if (resultTokenCount(db, candidate, config, model) <= tokenBudget) return candidate;
  }
  const requiredOnly = bounded.filter((item) => requiredCriterionId(acceptanceCriterionId(item), requiredIds));
  const minimal = minimalBuild(requiredOnly);
  if (resultTokenCount(db, minimal, config, model) <= tokenBudget) return minimal;
  throw new MetisError(
    "RESULT_REQUIRED_OVER_BUDGET",
    "Contract-required acceptance evidence cannot fit the worker result budget after deterministic compaction."
  );
}

function compactResult(result, projectRoot, db, taskId, config, model) {
  const tokenBudget = Math.max(100, Number(config.budgets.workerResultTokens));
  const full = stableStringify(result);
  if (resultTokenCount(db, result, config, model) <= tokenBudget) return result;
  const taskForCompaction = getTask(db, taskId);
  const preferredSubjectKind = subjectArtifactKind(taskForCompaction);
  const preferredSubjectId = preferredSubjectKind
    ? latestArtifact(db, projectRoot, taskForCompaction.run_id, preferredSubjectKind, ["verified"])?.id ?? null
    : null;
  const structuredRef = storeObject(db, projectRoot, `task-structured-result:${taskId}`, full, { redact: true });
  let compact = {
    ...result,
    Files: result.Files.slice(0, 80),
    ActualChangedFiles: asArray(result.ActualChangedFiles).slice(0, 80),
    Signatures: result.Signatures.slice(0, 40),
    Decisions: result.Decisions.slice(0, 20),
    Findings: compactReviewFindings(result.Findings, 30, preferredSubjectKind, 4, 360, preferredSubjectId),
    Summary: result.Summary.slice(0, 900),
    AcceptanceResults: compactAcceptanceResultsForTask(result.AcceptanceResults, taskForCompaction, preferredSubjectKind, preferredSubjectId, 60),
    Checks: compactChecks(result.Checks, 60, preferredSubjectKind, 4, 240, preferredSubjectId),
    EvidenceRefs: compactEvidenceRefs(result.EvidenceRefs, 100, preferredSubjectKind, true, preferredSubjectId),
    Blockers: result.Blockers.slice(0, 20),
    TargetTaskId: result.TargetTaskId,
    PacketOverlay: result.PacketOverlay,
    StructuredRef: structuredRef,
    ResultCompacted: true
  };
  if (resultTokenCount(db, compact, config, model) > tokenBudget) {
    compact = {
      Status: result.Status,
      Verdict: result.Verdict,
      Files: result.Files.slice(0, 40),
      ActualChangedFiles: asArray(result.ActualChangedFiles).slice(0, 40),
      Integrated: result.Integrated,
      Signatures: result.Signatures.slice(0, 20),
      Breaking: result.Breaking,
      Decisions: result.Decisions.slice(0, 10),
      Findings: compactReviewFindings(result.Findings, 15, preferredSubjectKind, 4, 360, preferredSubjectId),
      Summary: result.Summary.slice(0, 500),
      AcceptanceResults: compactAcceptanceResultsForTask(result.AcceptanceResults, taskForCompaction, preferredSubjectKind, preferredSubjectId, 30),
      Checks: compactChecks(result.Checks, 30, preferredSubjectKind, 4, 240, preferredSubjectId),
      EvidenceRefs: compactEvidenceRefs(result.EvidenceRefs, 50, preferredSubjectKind, true, preferredSubjectId),
      Blockers: result.Blockers.slice(0, 10),
      Facts: compactList(result.Facts, 40),
      Unknowns: compactList(result.Unknowns, 30),
      RelevantPaths: compactList(result.RelevantPaths, 60),
      Interfaces: compactList(result.Interfaces, 30),
      Risks: compactList(result.Risks, 30),
      Questions: compactList(result.Questions, 30),
      Sources: compactList(result.Sources, 40),
      ResearchFindings: compactList(result.ResearchFindings, 30),
      ResearchConstraints: compactList(result.ResearchConstraints, 30),
      Recommendations: compactList(result.Recommendations, 30),
      ArtifactKind: result.ArtifactKind,
      Diagnosis: compactNestedValue(result.Diagnosis),
      TargetTaskId: result.TargetTaskId,
      PacketOverlay: compactNestedValue(result.PacketOverlay),
      RawRef: result.RawRef,
      StructuredRef: structuredRef,
      ResultCompacted: true
    };
  }
  if (resultTokenCount(db, compact, config, model) > tokenBudget) {
    const finalCompact = {
      Status: result.Status,
      ...(result.Verdict ? { Verdict: result.Verdict } : {}),
      Files: compactList(result.Files, 4, 40),
      ActualChangedFiles: compactList(result.ActualChangedFiles, 4, 40),
      Integrated: result.Integrated,
      Breaking: compactList(result.Breaking, 2, 40),
      Summary: result.Summary.slice(0, 20),
      // These typed fields drive verification and review reconciliation. Keep
      // their schema-bearing fields even when prose and broad context are gone.
      AcceptanceResults: compactAcceptanceResultsForTask(result.AcceptanceResults, taskForCompaction, preferredSubjectKind, preferredSubjectId),
      Checks: compactChecks(result.Checks, 1, preferredSubjectKind, 1, 40, preferredSubjectId),
      Findings: compactReviewFindings(result.Findings, 1, preferredSubjectKind, 1, 10, preferredSubjectId),
      EvidenceRefs: compactEvidenceRefs(result.EvidenceRefs, 1, preferredSubjectKind, true, preferredSubjectId),
      Blockers: compactList(result.Blockers, 2, 40),
      Facts: compactList(result.Facts, 1, 20, 2),
      Unknowns: [],
      RelevantPaths: compactList(result.RelevantPaths, 1, 40),
      Interfaces: [],
      Risks: compactList(result.Risks, 1, 20, 2),
      Questions: [],
      Sources: compactList(result.Sources, 1, 20, 2),
      ResearchFindings: [],
      ResearchConstraints: [],
      Recommendations: [],
      ArtifactKind: String(result.ArtifactKind ?? "").slice(0, 40),
      Diagnosis: compactNestedValue(result.Diagnosis, { maxDepth: 2, maxItems: 2, maxKeys: 4, maxChars: 40 }),
      TargetTaskId: String(result.TargetTaskId ?? "").slice(0, 120),
      PacketOverlay: compactNestedValue(result.PacketOverlay, { maxDepth: 2, maxItems: 2, maxKeys: 4, maxChars: 10 }),
      RawRef: result.RawRef,
      StructuredRef: structuredRef,
      ResultCompacted: true
    };
    if (resultTokenCount(db, finalCompact, config, model) <= tokenBudget) {
      compact = finalCompact;
    } else {
      // The last envelope keeps only fields consumed by completion/review gates.
      // In particular, do not trade away any contract criterion outcome for
      // descriptive context when the result has several criteria.
      const buildEmergencyCompact = (acceptanceResults) => ({
        Status: result.Status,
        ...(result.Verdict ? { Verdict: result.Verdict } : {}),
        Files: compactList(result.Files, 2, 32),
        ActualChangedFiles: compactList(result.ActualChangedFiles, 2, 32),
        Integrated: result.Integrated,
        Breaking: compactList(result.Breaking, 2, 40),
        Summary: result.Summary.slice(0, 20),
        AcceptanceResults: acceptanceResults,
        Checks: compactChecks(result.Checks, 1, preferredSubjectKind, 1, 24, preferredSubjectId),
        Findings: compactReviewFindings(result.Findings, 1, preferredSubjectKind, 1, 24, preferredSubjectId),
        EvidenceRefs: compactEvidenceRefs(result.EvidenceRefs, 1, preferredSubjectKind, true, preferredSubjectId),
        Blockers: compactList(result.Blockers, 1, 24),
        RawRef: result.RawRef,
        StructuredRef: structuredRef,
        ResultCompacted: true
      });
      const buildMinimalEmergencyCompact = (acceptanceResults) => ({
        Status: result.Status,
        ...(result.Verdict ? { Verdict: result.Verdict } : {}),
        Breaking: compactList(result.Breaking, 1, 40),
        AcceptanceResults: acceptanceResults,
        EvidenceRefs: compactEvidenceRefs(result.EvidenceRefs, 1, preferredSubjectKind, true, preferredSubjectId),
        StructuredRef: structuredRef,
        ResultCompacted: true
      });
      compact = acceptanceResultsWithinBudget(
        result.AcceptanceResults,
        taskForCompaction,
        preferredSubjectKind,
        preferredSubjectId,
        tokenBudget,
        buildEmergencyCompact,
        buildMinimalEmergencyCompact,
        db,
        config,
        model
      );
    }
  }
  return compact;
}

function normalizeResult(input, projectRoot, evidenceRoot, db, taskId) {
  const status = String(field(input, "status", "Status", "UNKNOWN")).toUpperCase();
  invariant(RESULT_STATUSES.has(status), "RESULT_STATUS_INVALID", `Unsupported result status: ${status}.`);
  const files = [...new Set(asArray(field(input, "files", "Files", [])).map((file) => normalizeRepoPath(String(file))))];
  const task = getTask(db, taskId);
  if (!task.readOnly) {
    for (const file of files) {
      invariant(isSafeRepoPath(file), "TASK_FILE_PATH_INVALID", `Task ${taskId} reported an unsafe file path: ${file}.`);
      invariant(task.targetPaths.some((target) => pathsOverlap(file, target)), "TASK_FILE_OUT_OF_SCOPE", `Task ${taskId} reported a file outside its owned paths: ${file}.`, { file, targetPaths: task.targetPaths });
    }
  }
  const evidenceRefs = normalizeEvidenceRefs(db, evidenceRoot, field(input, "evidenceRefs", "EvidenceRefs", []));
  const reviewLike = CRITIC_ROLES.has(task.role) || REVIEW_ROLES.has(task.role);
  const preferredSubjectKind = subjectArtifactKind(task);
  const preferredSubjectId = preferredSubjectKind
    ? latestArtifact(db, projectRoot, task.run_id, preferredSubjectKind, ["verified"])?.id ?? null
    : null;
  const result = {
    Status: status,
    ...(field(input, "failureClass", "FailureClass", null) ? { FailureClass: String(field(input, "failureClass", "FailureClass", "")).trim().toLowerCase() } : {}),
    ...(field(input, "failureCause", "FailureCause", null) ? { FailureCause: String(field(input, "failureCause", "FailureCause", "")).trim().slice(0, 1200) } : {}),
    ...(reviewLike ? {
      Verdict: String(field(input, "verdict", "Verdict", "REJECTED")).toUpperCase(),
      Findings: compactItems(field(input, "findings", "Findings", []), 80, 1200)
    } : {}),
    Files: files,
    Signatures: compactItems(field(input, "signatures", "Signatures", []), 80, 500),
    Breaking: compactItems(field(input, "breaking", "Breaking", []), 80, 800),
    Decisions: compactItems(field(input, "decisions", "Decisions", []), 80, 800),
    Summary: String(field(input, "summary", "Summary", "")).slice(0, 1800),
    // Acceptance outcomes are typed contract evidence. Normalize them before
    // the raw result is persisted so hostile nested payloads cannot bypass the
    // active-state bounds through an untyped object field.
    AcceptanceResults: compactAcceptanceResultsForTask(field(input, "acceptanceResults", "AcceptanceResults", []), task, preferredSubjectKind, preferredSubjectId, 100),
    InterfaceReport: field(input, "interfaceReport", "InterfaceReport", { Consumed: [], Produced: [], Changed: [] }),
    Checks: compactItems(field(input, "checks", "Checks", []), 100, 1200),
    ProducedArtifacts: compactItems(field(input, "producedArtifacts", "ProducedArtifacts", []), 80, 5000),
    EvidenceRefs: evidenceRefs,
    Blockers: compactItems(field(input, "blockers", "Blockers", []), 80, 800),
    Facts: compactItems(field(input, "facts", "Facts", []), 120, 1200),
    Unknowns: compactItems(field(input, "unknowns", "Unknowns", []), 120, 1200),
    RelevantPaths: compactItems(field(input, "relevantPaths", "RelevantPaths", []), 120, 500),
    Interfaces: compactItems(field(input, "interfaces", "Interfaces", []), 80, 1200),
    Risks: compactItems(field(input, "risks", "Risks", []), 80, 1200),
    Questions: compactItems(field(input, "questions", "Questions", []), 80, 1200),
    Sources: compactItems(field(input, "sources", "Sources", []), 100, 1200),
    ResearchFindings: task.role === "researcher" ? compactItems(field(input, "findings", "Findings", []), 100, 1200) : [],
    ResearchConstraints: task.role === "researcher" ? compactItems(field(input, "constraints", "Constraints", []), 80, 1200) : [],
    Recommendations: compactItems(field(input, "recommendations", "Recommendations", []), 80, 1200),
    ArtifactKind: String(field(input, "artifactKind", "ArtifactKind", "")).trim(),
    ArtifactContent: field(input, "artifactContent", "ArtifactContent", null),
    PlanDraft: field(input, "planDraft", "PlanDraft", null),
    TargetTaskId: String(field(input, "targetTaskId", "TargetTaskId", "")).trim(),
    PacketOverlay: field(input, "packetOverlay", "PacketOverlay", null),
    Diagnosis: field(input, "diagnosis", "Diagnosis", null)
  };
  if (reviewLike) {
    invariant(["APPROVED", "REJECTED"].includes(result.Verdict), "REVIEW_VERDICT", `${task.role} verdict must be APPROVED or REJECTED.`);
    const blocking = result.Findings.filter((item) => ["error", "critical"].includes(String(item?.Severity ?? item?.severity ?? "").toLowerCase()));
    if (blocking.length > 0) invariant(result.Verdict === "REJECTED", "REVIEW_BLOCKING_VERDICT", `${task.role} cannot approve with blocking findings.`);
  }
  if (task.role === "task-compiler" && status === "COMPLETED") {
    invariant(result.TargetTaskId, "TASK_COMPILER_TARGET_REQUIRED", "A completed task compiler must return TargetTaskId.");
    invariant(result.PacketOverlay && typeof result.PacketOverlay === "object", "TASK_COMPILER_OVERLAY_REQUIRED", "A completed task compiler must return PacketOverlay.");
  }
  if (task.role === "planner" && status === "COMPLETED") {
    invariant(result.PlanDraft && typeof result.PlanDraft === "object", "PLAN_DRAFT_REQUIRED", "A completed planner must return PlanDraft.");
  }
  if (task.role === "diagnostician" && status === "COMPLETED") {
    invariant(result.Diagnosis && typeof result.Diagnosis === "object", "DIAGNOSIS_REQUIRED", "A completed diagnostician must return Diagnosis.");
  }
  if (status === "COMPLETED") {
    invariant(result.Summary.trim(), "RESULT_SUMMARY_REQUIRED", `Completed task ${taskId} needs a summary.`);
    if (task.requiredEvidence.length > 0) {
      const producedArtifactsAllowed = task.expectedOutputs.some((item) => typeof item === "string" && item.startsWith("artifact:"));
      invariant(result.EvidenceRefs.some(evidenceRefIsVerifiable) || (producedArtifactsAllowed && result.ProducedArtifacts.length > 0),
        "RESULT_EVIDENCE_REQUIRED", `Completed task ${taskId} needs evidence references or declared produced artifacts.`);
    }
    invariant(result.Blockers.length === 0, "RESULT_COMPLETED_BLOCKERS", `Completed task ${taskId} cannot report open blockers.`);
  }
  if (status === "BLOCKED") {
    invariant(result.Blockers.length > 0, "RESULT_BLOCKER_REQUIRED", `Blocked task ${taskId} must identify at least one blocker.`);
  }
  const raw = input.raw ?? input.Raw ?? input.logs ?? input.Logs;
  if (raw !== undefined) result.RawRef = storeObject(db, projectRoot, `task-result:${taskId}`, typeof raw === "string" ? raw : stableStringify(raw), { redact: true });
  return result;
}

function interfaceUsageEntry(value, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "TASK_INTERFACE_REPORT", `${label} interface entries must be objects with Id or Name and ContentHash.`);
  const selector = String(value.Id ?? value.id ?? value.Name ?? value.name ?? "").trim();
  const contentHash = String(value.ContentHash ?? value.contentHash ?? "").trim();
  invariant(selector, "TASK_INTERFACE_REPORT", `${label} interface entries need an Id or Name.`);
  invariant(contentHash, "TASK_INTERFACE_HASH_REQUIRED", `${label} interface ${selector} needs ContentHash.`);
  return { selector, contentHash };
}

function findDeclaredInterface(task, selector, direction) {
  return task.interfaceContracts.find((item) => item.direction === direction && (item.id === selector || item.name === selector));
}

function validateInterfaceUsage(task, values, direction, label, required) {
  const seen = new Set();
  for (const value of values) {
    const entry = interfaceUsageEntry(value, label);
    const declared = findDeclaredInterface(task, entry.selector, direction);
    invariant(declared, "TASK_INTERFACE_UNDECLARED", `Task ${task.id} reported undeclared ${label.toLowerCase()} interface ${entry.selector}.`);
    invariant(entry.contentHash === declared.content_hash, "TASK_INTERFACE_HASH_MISMATCH", `Task ${task.id} used stale ${label.toLowerCase()} interface ${entry.selector}.`, {
      expected: declared.content_hash,
      actual: entry.contentHash,
      interfaceId: declared.id,
      version: declared.version
    });
    seen.add(declared.id);
  }
  if (!required) return;
  for (const declared of task.interfaceContracts.filter((item) => item.direction === direction)) {
    invariant(seen.has(declared.id), direction === "input" ? "TASK_INTERFACE_INPUT_MISSING" : "TASK_INTERFACE_OUTPUT_MISSING",
      `Task ${task.id} did not attest ${label.toLowerCase()} interface ${declared.name} v${declared.version}.`);
  }
}

function validateInterfaceReport(task, result) {
  const report = result.InterfaceReport && typeof result.InterfaceReport === "object" && !Array.isArray(result.InterfaceReport)
    ? result.InterfaceReport
    : {};
  const consumed = asArray(report.Consumed ?? report.consumed);
  const produced = asArray(report.Produced ?? report.produced);
  validateInterfaceUsage(task, consumed, "input", "Consumed", result.Status === "COMPLETED");
  validateInterfaceUsage(task, produced, "output", "Produced", result.Status === "COMPLETED");

  const changed = asArray(report.Changed ?? report.changed);
  const allowed = task.interfaceContracts.filter((item) => item.direction === "output" && item.allowChange);
  for (const value of changed) {
    invariant(value && typeof value === "object" && !Array.isArray(value), "TASK_INTERFACE_REPORT", "Changed interface entries must be objects.");
    const selector = String(value.Id ?? value.id ?? value.Name ?? value.name ?? "").trim();
    invariant(selector, "TASK_INTERFACE_REPORT", "Changed interface entries need an Id or Name.");
    invariant(allowed.some((item) => item.id === selector || item.name === selector), "TASK_INTERFACE_CHANGE_FORBIDDEN", `Task ${task.id} cannot change interface ${selector}.`);
  }
}

function taskOutputEntries(task, result) {
  const expectedKinds = new Set(task.expectedOutputs
    .filter((item) => typeof item === "string" && item.startsWith("artifact:"))
    .map((item) => item.slice("artifact:".length)));
  const explicitArtifacts = [...asArray(result.ProducedArtifacts)];
  const canonicalKind = task.role === "synthesizer" ? String(result.ArtifactKind ?? "").trim() : "";
  const seenKinds = new Set();
  for (const item of explicitArtifacts) {
    const kind = String(item?.Kind ?? item?.kind ?? "").trim();
    invariant(kind, "TASK_ARTIFACT_KIND", `Task ${task.id} produced an artifact without a kind.`);
    const normalizedKind = kind.toLowerCase();
    invariant(!seenKinds.has(normalizedKind), "TASK_ARTIFACT_DUPLICATE", `Task ${task.id} produced duplicate artifact kind ${kind}.`);
    invariant(!canonicalKind || normalizedKind !== canonicalKind.toLowerCase(), "TASK_ARTIFACT_DUPLICATE", `Task ${task.id} duplicated canonical artifact kind ${canonicalKind} in ProducedArtifacts.`);
    seenKinds.add(normalizedKind);
  }
  const artifacts = canonicalKind && result.ArtifactContent !== null
    ? [{ Kind: canonicalKind, Status: "verified", Content: result.ArtifactContent, Metadata: { synthesized: true } }, ...explicitArtifacts]
    : explicitArtifacts;
  const normalizedArtifacts = artifacts.map((item) => {
    const kind = String(item?.Kind ?? item?.kind ?? "").trim();
    invariant(kind, "TASK_ARTIFACT_KIND", `Task ${task.id} produced an artifact without a kind.`);
    if (expectedKinds.size > 0) invariant(expectedKinds.has(kind), "TASK_ARTIFACT_UNDECLARED", `Task ${task.id} produced undeclared artifact ${kind}.`);
    const status = String(item?.Status ?? item?.status ?? "verified").toLowerCase();
    invariant(["verified", "draft"].includes(status), "TASK_ARTIFACT_STATUS", `Unsupported task artifact status: ${status}.`);
    return {
      kind,
      status,
      content: item?.Content ?? item?.content ?? {},
      metadata: item?.Metadata ?? item?.metadata ?? {}
    };
  });
  return {
    artifacts: normalizedArtifacts,
    planDraft: task.role === "planner" ? result.PlanDraft : null,
    diagnosis: task.role === "diagnostician" ? result.Diagnosis : null
  };
}

function persistTaskOutputs(db, run, task, entries) {
  const persisted = [];
  for (const entry of entries.artifacts) {
    const artifact = putArtifact(db, run.project_root, run.id, entry.kind, entry.content, {
      taskId: task.id,
      status: entry.status,
      metadata: entry.metadata
    });
    persisted.push({ id: artifact.id, kind: entry.kind, contentRef: artifact.content_ref, status: entry.status });
  }
  if (task.role === "planner" && entries.planDraft) {
    const artifact = putArtifact(db, run.project_root, run.id, `plan-draft:${task.id}`, entries.planDraft, {
      taskId: task.id,
      status: "verified",
      metadata: { plannerTaskId: task.id }
    });
    persisted.push({ id: artifact.id, kind: artifact.kind, contentRef: artifact.content_ref, status: artifact.status });
  }
  if (task.role === "diagnostician" && entries.diagnosis) {
    const artifact = putArtifact(db, run.project_root, run.id, `diagnosis:${task.id}`, entries.diagnosis, {
      taskId: task.id,
      status: "verified"
    });
    persisted.push({ id: artifact.id, kind: artifact.kind, contentRef: artifact.content_ref, status: artifact.status });
  }
  return persisted;
}

function validateCurrentResultEvidence(db, workspaceRoot, projectRoot, task, evidenceRefs) {
  const missingSources = evidenceRefs.filter((ref) => ref?.type === "source" && (ref.missing || !ref.fileSha256 || !ref.sliceSha256));
  invariant(missingSources.length === 0, "TASK_RESULT_EVIDENCE_SOURCE_MISSING",
    `Completed task ${task.id} cites missing source evidence: ${missingSources.map(evidenceSummary).join(", ")}.`, {
      evidence: missingSources.map(evidenceSummary)
    });
  const stale = evidenceRefs.filter((ref) => {
    if (ref?.type === "note") return false;
    const evidenceRoot = ref?.type === "source" ? workspaceRoot : projectRoot;
    return !evidenceRefIsCurrent(db, evidenceRoot, ref);
  });
  invariant(stale.length === 0, "TASK_RESULT_EVIDENCE_STALE",
    `Completed task ${task.id} cites stale or invalid evidence: ${stale.map(evidenceSummary).join(", ")}.`, {
      evidence: stale.map(evidenceSummary)
    });
}

export function finishTask(db, projectRoot, runId, taskId, leaseToken, input, config = null) {
  const run = getRun(db, runId);
  const task = getTask(db, taskId);
  invariant(task.run_id === run.id, "TASK_RUN_MISMATCH", "Task does not belong to the active run.");
  invariant(task.status === "running", "TASK_NOT_RUNNING", `Task ${taskId} is ${task.status}.`);
  verifyLease(db, task, leaseToken);
  invariant(db.prepare("SELECT 1 FROM task_spawn_acks WHERE task_id = ? AND attempt_fence = ?").get(task.id, Number(task.attempt_fence)),
    "TASK_SPAWN_NOT_ACKNOWLEDGED", `Task ${task.id} was not acknowledged as spawned.`);
  const effectiveConfig = config ?? loadConfig(run.project_root);
  const workspace = getTaskWorkspace(db, task, run.project_root);
  const requestedStatus = String(field(input, "status", "Status", "UNKNOWN")).toUpperCase();
  if (requestedStatus === "COMPLETED") assertSubjectEvidenceRef(db, run, task, input);
  const normalized = normalizeResult(input, projectRoot, workspace.path, db, taskId);
  validateInterfaceReport(task, normalized);
  const outputEntries = taskOutputEntries(task, normalized);
  if (normalized.Status === "COMPLETED") {
    const baseline = baselineForTask(db, run, task);
    assertTaskPacketBasis(db, task, baseline, effectiveConfig);
    assertTaskSubjectBasis(db, run, task, baseline, effectiveConfig);
    validateCurrentResultEvidence(db, workspace.path, run.project_root, task, normalized.EvidenceRefs);
  }
  let compilerCompletion = null;
  if (task.role === "task-compiler" && normalized.Status === "COMPLETED") {
    invariant(task.compilerTargetTaskId === normalized.TargetTaskId, "TASK_COMPILER_TARGET_MISMATCH", `Compiler ${task.id} returned target ${normalized.TargetTaskId}; expected ${task.compilerTargetTaskId}.`);
    compilerCompletion = { targetTaskId: task.compilerTargetTaskId, overlay: normalized.PacketOverlay };
  }
  if (task.role === "coordinator" && normalized.Status === "COMPLETED") {
    const children = db.prepare("SELECT id, status FROM tasks WHERE parent_task_id = ?").all(task.id);
    const nonTerminalChildren = children.filter((item) => !["completed", "waived"].includes(item.status));
    invariant(nonTerminalChildren.length === 0, "COORDINATOR_CHILDREN_NON_TERMINAL", `Coordinator ${task.id} cannot finish before its child tasks.`, { children: nonTerminalChildren });
  }
  const baseline = baselineForTask(db, run, task);
  let completionReservation = reserveTaskCompletion(db, task, leaseToken, effectiveConfig);
  let integrationJournal = null;
  let integrationLock = null;
  let integrationCommitted = false;
  try {
    const workspaceResult = finalizeTaskWorkspace(db, run, task, normalized.Status, normalized.Files, baseline, effectiveConfig);
    integrationJournal = workspaceResult.integrationJournal;
    integrationLock = workspaceResult.integrationLock;
    const verified = {
      ...normalized,
      ActualChangedFiles: workspaceResult.actualChangedFiles,
      WorkspaceMode: workspaceResult.workspaceMode,
      WorkspacePatchRef: workspaceResult.patchRef,
      Integrated: workspaceResult.integrated
    };
    const result = redactValue(compactResult(verified, projectRoot, db, taskId, effectiveConfig, task.selected_model));
    let nextStatus;
    if (result.Status === "COMPLETED") nextStatus = "completed";
    else if (result.Status === "BLOCKED") nextStatus = "blocked";
    else if (result.Status === "FAILED" && effectiveConfig.delegation?.diagnoseBeforeRetry !== true && task.attempts < task.max_attempts) nextStatus = "pending";
    else if (result.Status === "FAILED" && effectiveConfig.delegation?.diagnoseBeforeRetry === true) nextStatus = "blocked";
    else nextStatus = "failed";
    transaction(db, () => {
      assertCompletionReservation(db, completionReservation);
      if (nextStatus === "completed") {
        assertTaskPacketBasis(db, task, baseline, effectiveConfig);
        assertTaskSubjectBasis(db, run, task, baseline, effectiveConfig, { sync: false });
      }
      putArtifact(db, run.project_root, run.id, `task-changes:${task.id}`, {
      taskId: task.id,
      attempt: task.attempts,
      resultStatus: verified.Status,
      actualChangedFiles: verified.ActualChangedFiles,
      workspaceMode: verified.WorkspaceMode,
      patchRef: verified.WorkspacePatchRef,
      integrated: verified.Integrated,
      recordedAt: now()
    }, { taskId: task.id, status: "verified", metadata: { attempt: task.attempts } });
    const producedArtifactRefs = nextStatus === "completed"
      ? persistTaskOutputs(db, run, task, outputEntries)
      : [];
    const failureClass = nextStatus === "completed" ? null : (result.FailureClass ?? task.failure_class ?? null);
    const failureCause = nextStatus === "completed" ? null : (result.FailureCause ?? result.Summary ?? null);
    let persistedResult = producedArtifactRefs.length > 0
      ? { ...result, ProducedArtifactRefs: producedArtifactRefs }
      : result;
    const changed = db.prepare(`
      UPDATE tasks SET status = ?, result_json = ?, owner = NULL, failure_class = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND attempt_fence = ? AND owner = ?
    `).run(nextStatus, json(persistedResult), failureClass, now(), taskId, Number(task.attempt_fence), completionReservation.reservationOwner);
    invariant(changed.changes === 1, "TASK_FENCED", `Task ${taskId} attempt changed concurrently.`);
    const attemptStatus = result.Status === "COMPLETED" ? "completed" : result.Status.toLowerCase();
    finalizeTaskAttempt(db, taskId, Number(task.attempt_fence), attemptStatus, { failureClass, failureCause });
    if (nextStatus === "completed" && compilerCompletion) {
      const compiledTarget = compileTaskPacket(db, run.project_root, compilerCompletion.targetTaskId, effectiveConfig, {
        overlay: compilerCompletion.overlay,
        compilerTaskId: task.id,
        compilerResult: normalized
      });
      persistedResult = {
        ...persistedResult,
        CompiledTargetPacket: {
          id: compiledTarget.id,
          taskId: compiledTarget.taskId,
          version: compiledTarget.version,
          status: compiledTarget.status,
          policy: compiledTarget.policy,
          blueprintHash: compiledTarget.blueprintHash,
          packetHash: compiledTarget.packetHash,
          packetRef: compiledTarget.packetRef
        }
      };
      const attached = db.prepare(`
        UPDATE tasks SET result_json = ?, updated_at = ?
        WHERE id = ? AND status = 'completed' AND attempt_fence = ?
      `).run(json(persistedResult), now(), taskId, Number(task.attempt_fence));
      invariant(attached.changes === 1, "TASK_FENCED", `Task ${taskId} compiler result changed concurrently.`);
    }
    db.prepare("DELETE FROM leases WHERE task_id = ? AND fencing_token = ?").run(taskId, Number(task.attempt_fence));
    touchRun(db, run.id);
    recordEvent(db, run.id, "task.finished", nextStatus === "completed" ? "info" : "warning", {
      taskId,
      status: nextStatus,
      resultStatus: result.Status,
      workspaceMode: result.WorkspaceMode,
      evidenceRefs: persistedResult.EvidenceRefs,
      blockers: persistedResult.Blockers
    });
    const batchRows = db.prepare(`
      SELECT DISTINCT batch_id FROM task_spawn_acks
      WHERE task_id = ? AND batch_id IS NOT NULL
    `).all(taskId);
    for (const { batch_id: batchId } of batchRows) {
      const batch = db.prepare("SELECT claimed_task_ids_json FROM scheduler_batches WHERE id = ?").get(batchId);
      if (!batch) continue;
      const claimedTaskIds = parseJson(batch.claimed_task_ids_json, []);
      const terminal = claimedTaskIds.length > 0 && claimedTaskIds.every((id) => {
        const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id);
        return ["completed", "waived", "failed", "blocked"].includes(row?.status);
      });
      if (terminal) {
        db.prepare(`
          UPDATE scheduler_batches SET status = 'completed', updated_at = ?
          WHERE id = ? AND status IN ('claimed', 'prepared', 'partially-spawned', 'spawned')
        `)
          .run(now(), batchId);
      }
    }
    if (nextStatus === "completed") {
      const relations = [];
      if (["worker", "integrator", "curator"].includes(task.role)) relations.push("implemented-by");
      if (["verifier", "adversarial-reviewer"].includes(task.role)) relations.push("verified-by");
      if (REVIEW_ROLES.has(task.role)) relations.push("reviewed-by");
      for (const relation of relations) {
        for (const requirementId of task.requirementIds) {
          db.prepare(`
            INSERT INTO trace_links(
              id, run_id, requirement_id, target_type, target_id, relation,
              status, evidence_refs_json, created_at, updated_at
            ) VALUES(?, ?, ?, 'task', ?, ?, 'current', ?, ?, ?)
            ON CONFLICT(run_id, requirement_id, target_type, target_id, relation) DO UPDATE SET
              status = 'current', evidence_refs_json = excluded.evidence_refs_json,
              updated_at = excluded.updated_at
          `).run(makeId("trace"), run.id, requirementId, task.id, relation, json(persistedResult.EvidenceRefs ?? []), now(), now());
        }
      }
      db.prepare(`
        UPDATE review_findings SET status = 'pending-review', updated_at = ?
        WHERE repair_task_id = ? AND status = 'fixing'
      `).run(now(), task.id);
    }
    });
    if (integrationLock) {
      integrationLock.release();
      integrationLock = null;
    }
    integrationCommitted = true;
    if (workspaceResult.deferredWorktreeCleanup) {
      try {
        cleanupTaskWorkspace(db, run.project_root, task.id, "cleaned", Number(task.attempt_fence));
      } catch (error) {
        // The task is already durably integrated. Leave the row as integrated
        // so stale-worktree maintenance can retry cleanup without changing
        // the task result or reopening the main-workspace transaction.
        recordEvent(db, run.id, "task.worktree-cleanup-deferred", "warning", {
          taskId: task.id,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (workspaceResult.integrated) {
      try {
        syncRepository(db, run.project_root, effectiveConfig, run.id);
      } catch (error) {
        recordEvent(db, run.id, "repository.sync-deferred", "warning", {
          taskId: task.id,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (integrationJournal) {
      try { removeIntegrationJournal(integrationJournal); } catch {}
      integrationJournal = null;
    }
    completionReservation = null;
    refreshMilestoneStatuses(db, run.id);
    return getTask(db, taskId);
  } catch (error) {
    if (integrationLock) {
      try { integrationLock.abort(); } catch {}
      integrationLock = null;
    }
    if (integrationJournal && !integrationCommitted) {
      let restored = false;
      try {
        restoreIntegrationJournal(integrationJournal);
        restored = true;
      } finally {
        // Preserve the recovery journal when restoration itself fails.
        if (restored) removeIntegrationJournal(integrationJournal);
      }
    }
    try { releaseTaskCompletion(db, completionReservation); } catch {}
    throw error;
  }
}

export function waiveTask(db, runId, taskId, reason) {
  const task = getTask(db, taskId);
  const run = getRun(db, runId);
  invariant(task.run_id === run.id, "TASK_RUN_MISMATCH", "Task does not belong to this run.");
  invariant(
    task.role !== "verifier" && !REVIEW_ROLES.has(task.role),
    "TASK_MANDATORY_EVIDENCE_WAIVER",
    "Verifier and independent review tasks cannot be waived."
  );
  invariant(["pending", "blocked", "failed"].includes(task.status), "TASK_WAIVE_STATUS", `Cannot waive a ${task.status} task.`);
  db.prepare("UPDATE tasks SET status = 'waived', result_json = ?, updated_at = ? WHERE id = ?")
    .run(json({ Status: "COMPLETED", Summary: `Waived: ${reason}`, EvidenceRefs: [], Blockers: [] }), now(), taskId);
  db.prepare("DELETE FROM leases WHERE task_id = ?").run(taskId);
  cleanupTaskWorkspace(db, run.project_root, taskId, "waived");
  touchRun(db, runId);
  recordEvent(db, runId, "task.waived", "warning", { taskId, reason });
  const batches = db.prepare(`
    SELECT DISTINCT sb.id, sb.claimed_task_ids_json
    FROM scheduler_batches sb
    JOIN task_spawn_acks tsa ON tsa.batch_id = sb.id
    WHERE tsa.task_id = ?
  `).all(taskId);
  for (const batch of batches) {
    const claimedTaskIds = parseJson(batch.claimed_task_ids_json, []);
    const terminal = claimedTaskIds.length > 0 && claimedTaskIds.every((id) => {
      const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id);
      return ["completed", "waived", "failed", "blocked"].includes(row?.status);
    });
    if (terminal) db.prepare("UPDATE scheduler_batches SET status = 'completed', updated_at = ? WHERE id = ?").run(now(), batch.id);
  }
  refreshMilestoneStatuses(db, runId);
  return getTask(db, taskId);
}

export function retryTask(db, runId, taskId, reason, config = null, cause = "transient") {
  invariant(reason?.trim(), "TASK_RETRY_REASON", "A retry needs a reason.");
  invariant(RETRY_CAUSES.has(cause), "TASK_RETRY_CAUSE", `Unsupported retry cause: ${cause}.`);
  const run = getRun(db, runId);
  const effectiveConfig = config ?? loadConfig(run.project_root);
  const retry = transaction(db, () => {
    const currentRow = db.prepare("SELECT run_id, status, attempts, max_attempts, attempt_fence, owner, transient_retry_count, failure_class, escalation_cause FROM tasks WHERE id = ?").get(taskId);
    invariant(currentRow, "TASK_NOT_FOUND", `Task ${taskId} was not found.`);
    invariant(currentRow.run_id === run.id, "TASK_RUN_MISMATCH", "Task does not belong to this run.");
    invariant(["blocked", "failed"].includes(currentRow.status), "TASK_RETRY_STATUS", `Cannot retry a ${currentRow.status} task.`);
    invariant(Number(currentRow.attempts) < Number(currentRow.max_attempts), "TASK_RETRY_LIMIT", `Task ${taskId} exhausted its retry limit.`);
    invariant(!currentRow.owner, "TASK_RETRY_OWNER", `Task ${taskId} is still owned by an active worker.`);
    const classifiedFailure = currentRow.failure_class && currentRow.failure_class !== "transient";
    const diagnosisEvidence = db.prepare(`
      SELECT a.*, t.context_refs_json
      FROM artifacts a JOIN tasks t ON t.id = a.task_id
      WHERE a.run_id = ? AND a.kind LIKE 'diagnosis:%' AND a.status = 'verified'
        AND t.role = 'diagnostician' AND t.status = 'completed'
        AND t.updated_at >= (SELECT COALESCE(terminal_at, start_at) FROM task_attempts WHERE task_id = ? AND attempt_fence = ?)
      ORDER BY a.updated_at DESC LIMIT 1
    `).get(run.id, taskId, Number(currentRow.attempt_fence));
    let diagnosis = null;
    if (diagnosisEvidence) {
      const refs = parseJson(diagnosisEvidence.context_refs_json, []);
      const bound = refs.some((item) => String(typeof item === "string" ? item : item?.ref ?? item?.id ?? "").includes(taskId));
      if (bound) {
        try { diagnosis = JSON.parse(readObject(db, run.project_root, diagnosisEvidence.content_ref)); } catch { diagnosis = null; }
      }
    }
    const diagnosisMatches = diagnosis?.FailureClass === cause
      || diagnosis?.failureClass === cause
      || diagnosis?.Cause === cause
      || diagnosis?.cause === cause;
    if (effectiveConfig.delegation?.diagnoseBeforeRetry === true
      && (classifiedFailure || ["contract", "dependency", "plan", "external"].includes(cause))
      && !diagnosisMatches) {
      throw new MetisError("TASK_RETRY_DIAGNOSIS_REQUIRED", `Task ${taskId} needs diagnosis evidence before a ${cause} retry.`);
    }
    if (cause === "external" && !/(condition|constraint|authority|evidence).*(changed|updated|resolved|provided)/iu.test(reason)) {
      throw new MetisError("TASK_RETRY_EXTERNAL_EVIDENCE_REQUIRED", "External retries require evidence that the blocking condition changed.");
    }
    assertBudgetAvailable(db, run.id, { retries: 1 });
    const task = getTask(db, taskId);
    const route = escalateModelRoute(effectiveConfig, task, cause, { host: run.host });
    const timestamp = now();
    const changed = db.prepare(`
      UPDATE tasks SET status = 'pending', owner = NULL, failure_class = ?, escalation_cause = ?,
        model_tier = ?, selected_model = ?, model_source = ?, requested_effort = ?, effective_effort = ?,
        effort_source = ?, supported_efforts_json = ?, capability_status = ?, reasoning_effort = ?,
        escalation_level = ?, transient_retry_count = transient_retry_count + ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND status = ? AND attempts = ? AND attempt_fence = ? AND owner IS NULL
    `).run(
      cause, cause, route.tier, route.model, route.modelSource, route.requestedEffort, route.effectiveEffort,
      route.effortSource, json(route.supportedEfforts ?? []), route.capabilityStatus ?? "known", route.reasoningEffort,
      route.escalationLevel, cause === "transient" ? 1 : 0, timestamp,
      taskId, run.id, currentRow.status, Number(currentRow.attempts), Number(currentRow.attempt_fence)
    );
    invariant(changed.changes === 1, "TASK_RETRY_RACE", `Task ${taskId} changed concurrently; retry was not applied.`);
    db.prepare("DELETE FROM leases WHERE task_id = ?").run(taskId);
    recordEvent(db, runId, "task.retried", "warning", {
      taskId,
      reason: reason.trim(),
      cause,
      attempts: task.attempts,
      escalationLevel: route.escalationLevel,
      modelTier: route.tier,
      reasoningEffort: route.reasoningEffort
    });
    consumeBudget(db, run.id, { retries: 1 }, { source: `task-retry:${taskId}` });
    touchRun(db, runId);
    refreshMilestoneStatuses(db, runId);
    return { attemptFence: Number(currentRow.attempt_fence) };
  });
  // Filesystem cleanup is intentionally outside the state transaction, and
  // is pinned to the retried attempt so a fast new claim cannot be removed.
  cleanupTaskWorkspace(db, run.project_root, taskId, "retry", retry.attemptFence);
  return getTask(db, taskId);
}

export function sealPlan(db, runId, config = null) {
  const run = getRun(db, runId);
  invariant(run.phase === "plan", "PLAN_SEAL_PHASE", "Reopen the plan phase before sealing or resealing a plan.");
  const effectiveConfig = config ?? loadConfig(run.project_root);
  const executionTasks = listTasks(db, runId)
    .filter((task) => ["execute", "review", "verify", "curate"].includes(task.phase));
  invariant(executionTasks.length > 0, "PLAN_TASKS_REQUIRED", "The execution plan needs at least one task.");
  const milestoneCount = Number(db.prepare("SELECT COUNT(*) AS count FROM milestones WHERE run_id = ?").get(runId).count);
  if (milestoneCount === 0) {
    invariant(
      executionTasks.length <= effectiveConfig.orchestration.maxTasksPerMilestone,
      "PLAN_MILESTONES_REQUIRED",
      "Large plans must define explicit milestones before sealing."
    );
    ensureDefaultMilestone(db, runId);
  } else {
    ensureDefaultMilestone(db, runId);
  }
  const graph = validateGraph(db, runId);
  const milestoneGraph = validateMilestoneGraph(db, runId);
  const tasks = listTasks(db, runId)
    .filter((task) => ["execute", "review", "verify", "curate"].includes(task.phase))
    .map((task) => ({
      id: task.id,
      milestoneId: task.milestone_id,
      parentTaskId: task.parent_task_id,
      delegationDepth: task.delegation_depth,
      title: task.title,
      role: task.role,
      runPhase: task.phase,
      reviewKind: task.review_kind,
      specialist: task.specialist,
      requirementIds: task.requirementIds,
      dependsOn: task.dependsOn,
      targetPaths: task.targetPaths,
      acceptanceCriteria: task.acceptanceCriteria,
      requiredEvidence: task.requiredEvidence,
      risk: task.risk,
      effort: task.effort,
      sliceType: task.sliceType,
      verificationModes: task.verificationModes,
      capabilities: task.capabilities.map((item) => item.name),
      modelTier: task.model_tier,
      model: task.selected_model,
      reasoningEffort: task.reasoning_effort
    }));
  const milestones = listMilestones(db, runId).map((milestone) => ({
    id: milestone.id,
    parentId: milestone.parent_id,
    title: milestone.title,
    objective: milestone.objective,
    sequence: milestone.sequence,
    dependsOn: milestone.dependsOn,
    acceptanceCriteria: milestone.acceptanceCriteria,
    entryCriteria: milestone.entryCriteria,
    exitCriteria: milestone.exitCriteria,
    userVisibleOutcome: milestone.userVisibleOutcome
  }));
  const contract = latestArtifact(db, run.project_root, run.id, "goal-contract", ["verified"]);
  const designReview = latestArtifact(db, run.project_root, run.id, "design-review", ["verified", "waived"]);
  const payload = {
    version: 4,
    contract: contract ? { id: contract.id, contentRef: contract.content_ref, contractHash: contract.metadata.contractHash ?? null } : null,
    designReview: designReview ? { id: designReview.id, contentRef: designReview.content_ref } : null,
    graph,
    milestoneGraph,
    milestones,
    tasks
  };
  const planHash = sha256(stableStringify(payload));
  return { graph, milestoneGraph, milestones, tasks, planHash, content: { ...payload, planHash } };
}
