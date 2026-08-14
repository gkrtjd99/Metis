import { addTask, getTask, listTasks } from "./tasks.js";
import { MetisError, invariant } from "./errors.js";
import { evidenceRefIsCurrent, normalizeEvidenceRefs } from "./provenance.js";
import { repositoryCodeFingerprint, syncRepository } from "./repository.js";
import { getRun, latestArtifact, putArtifact, recordEvent, reopenPhase, touchRun } from "./state.js";
import { asArray, json, makeId, now, parseJson, pathsOverlap } from "./util.js";
import { REVIEW_ROLES as REVIEW_ROLE_NAMES } from "./metadata.js";
import { capabilityNamesFromTask, specialistRolesForCapabilities } from "./capabilities.js";

const REVIEW_ROLES = new Set(REVIEW_ROLE_NAMES);
const REVIEW_STATUSES = new Set(["open", "fixing", "pending-review", "resolved", "accepted", "rejected"]);
const SEVERITIES = new Set(["info", "warning", "error", "critical"]);
const BLOCKING = new Set(["error", "critical"]);

function normalizeFinding(db, projectRoot, runId, task, raw, index) {
  const suppliedId = raw.Id ?? raw.id;
  const id = suppliedId === undefined || suppliedId === null ? makeId("review") : String(suppliedId).trim();
  // Finding IDs become part of repair task IDs and eventually worktree paths.
  // Keep them bounded and path/control-safe at the review boundary; do not
  // truncate hostile identities because truncation could merge two findings.
  invariant(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id), "REVIEW_FINDING_ID_INVALID",
    "Review finding ID must be a bounded path-safe token.", { findingId: id, index });
  const title = String(raw.Title ?? raw.title ?? raw.Claim ?? raw.claim ?? `Review finding ${index + 1}`).trim();
  const description = String(raw.Description ?? raw.description ?? raw.Claim ?? raw.claim ?? title).trim();
  const severity = String(raw.Severity ?? raw.severity ?? "warning").toLowerCase();
  invariant(title && description, "REVIEW_FINDING_FIELDS", "Review finding needs a title and description.");
  invariant(SEVERITIES.has(severity), "REVIEW_FINDING_SEVERITY", `Unsupported review finding severity: ${severity}.`);
  const targetPaths = [...new Set(asArray(raw.TargetPaths ?? raw.targetPaths).map((item) => String(item).trim()).filter(Boolean))];
  const requirementIds = [...new Set(asArray(raw.RequirementIds ?? raw.requirementIds ?? task.requirementIds).map((item) => String(item).trim()).filter(Boolean))];
  for (const id of requirementIds) {
    invariant(db.prepare("SELECT 1 FROM requirements WHERE run_id = ? AND id = ?").get(runId, id), "REVIEW_REQUIREMENT", `Requirement ${id} was not found.`);
  }
  const evidenceRefs = normalizeEvidenceRefs(db, projectRoot, raw.EvidenceRefs ?? raw.evidenceRefs ?? []);
  return {
    id,
    title,
    description,
    severity,
    targetPaths,
    requirementIds,
    evidenceRefs,
    suggestedFix: String(raw.SuggestedFix ?? raw.suggestedFix ?? "").trim() || null,
    reviewKind: task.review_kind ?? task.specialist ?? (task.role === "adversarial-reviewer" ? "completion" : "integration")
  };
}

function terminalRepairStatus(status) {
  return ["completed", "waived", "failed", "blocked"].includes(status);
}

function nextRepairTaskId(db, findingId) {
  const base = `FIX-${findingId}`;
  // Task IDs are globally unique, so avoid colliding with a repair from a
  // different run even when finding identities were supplied by a host.
  const existing = new Set(db.prepare("SELECT id FROM tasks").all().map((row) => row.id));
  if (!existing.has(base)) return base;
  let attempt = 2;
  while (existing.has(`${base}-${attempt}`)) attempt += 1;
  return `${base}-${attempt}`;
}

function shouldClearTerminalRepairIdentity(db, finding) {
  if (!finding?.repair_task_id) return false;
  const repair = db.prepare("SELECT status FROM tasks WHERE id = ? AND run_id = ?")
    .get(finding.repair_task_id, finding.run_id);
  // A terminal repair no longer owns the current report. The next report of
  // the same finding must be allowed to schedule a new bounded repair rather
  // than being silently skipped by reconcileReview.
  if (!repair || terminalRepairStatus(repair.status)) {
    return true;
  }
  return false;
}

export function ingestReviewTask(db, projectRoot, runId, taskId) {
  const run = getRun(db, runId);
  const task = getTask(db, taskId);
  invariant(task.run_id === run.id, "REVIEW_TASK_RUN", "Review task belongs to another run.");
  invariant(REVIEW_ROLES.has(task.role), "REVIEW_TASK_ROLE", `Task ${taskId} is not a review role.`);
  invariant(task.status === "completed", "REVIEW_TASK_STATUS", "Review task must be completed before ingestion.");
  const rawFindings = asArray(task.result?.Findings ?? []);
  // Finding IDs are the durable identity, not a presentation field. Reject
  // malformed duplicate IDs before writing any row so a benign duplicate
  // cannot overwrite a later critical duplicate in the same result.
  const normalizedFindings = rawFindings.map((raw, index) => normalizeFinding(db, projectRoot, run.id, task, raw, index));
  const seenIds = new Set();
  for (const finding of normalizedFindings) {
    const identity = String(finding.id);
    invariant(!seenIds.has(identity), "REVIEW_FINDING_DUPLICATE_ID",
      `Review result contains duplicate finding ID ${identity}.`, { findingId: identity, taskId: task.id });
    seenIds.add(identity);
    const existing = db.prepare("SELECT run_id FROM review_findings WHERE id = ?").get(finding.id);
    invariant(!existing || existing.run_id === run.id, "REVIEW_FINDING_ID_COLLISION",
      `Review finding ID ${identity} already belongs to another run.`, {
        findingId: identity,
        existingRunId: existing?.run_id,
        runId: run.id
      });
  }
  const timestamp = now();
  const inserted = [];
  for (const finding of normalizedFindings) {
    const prior = db.prepare("SELECT * FROM review_findings WHERE id = ? AND run_id = ?")
      .get(finding.id, run.id);
    const repairIdentityCleared = shouldClearTerminalRepairIdentity(db, prior);
    const write = db.prepare(`
      INSERT INTO review_findings(
        id, run_id, reviewer_task_id, review_kind, title, description,
        severity, status, target_paths_json, requirement_ids_json,
        evidence_refs_json, suggested_fix, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        severity = excluded.severity,
        status = CASE WHEN review_findings.status IN ('resolved','accepted','rejected') THEN review_findings.status ELSE 'open' END,
        target_paths_json = excluded.target_paths_json,
        requirement_ids_json = excluded.requirement_ids_json,
        evidence_refs_json = excluded.evidence_refs_json,
        suggested_fix = excluded.suggested_fix,
        repair_task_id = CASE WHEN ? THEN NULL ELSE review_findings.repair_task_id END,
        updated_at = excluded.updated_at
      WHERE review_findings.run_id = excluded.run_id
    `).run(
      finding.id,
      run.id,
      task.id,
      finding.reviewKind,
      finding.title,
      finding.description,
      finding.severity,
      json(finding.targetPaths),
      json(finding.requirementIds),
      json(finding.evidenceRefs),
      finding.suggestedFix,
      timestamp,
      timestamp,
      repairIdentityCleared ? 1 : 0
    );
    invariant(write.changes === 1, "REVIEW_FINDING_ID_COLLISION",
      `Review finding ID ${String(finding.id)} belongs to another run.`, { findingId: String(finding.id), runId: run.id });
    inserted.push(getReviewFinding(db, finding.id));
  }
  putArtifact(db, projectRoot, run.id, `review-result:${task.id}`, {
    taskId: task.id,
    role: task.role,
    reviewKind: task.review_kind ?? task.specialist ?? "integration",
    verdict: task.result?.Verdict ?? (inserted.some((item) => BLOCKING.has(item.severity)) ? "REJECTED" : "APPROVED"),
    findings: inserted.map((item) => item.id),
    evidenceRefs: task.result?.EvidenceRefs ?? [],
    summary: task.result?.Summary ?? ""
  }, { taskId: task.id, status: "verified" });
  touchRun(db, run.id);
  recordEvent(db, run.id, "review.ingested", inserted.some((item) => BLOCKING.has(item.severity)) ? "warning" : "info", {
    taskId: task.id,
    reviewKind: task.review_kind ?? task.specialist ?? "integration",
    findingCount: inserted.length
  });
  return { taskId, findings: inserted };
}

export function getReviewFinding(db, id) {
  const row = db.prepare("SELECT * FROM review_findings WHERE id = ?").get(id);
  invariant(row, "REVIEW_FINDING_NOT_FOUND", `Review finding ${id} was not found.`);
  return {
    ...row,
    targetPaths: parseJson(row.target_paths_json, []),
    requirementIds: parseJson(row.requirement_ids_json, []),
    evidenceRefs: parseJson(row.evidence_refs_json, [])
  };
}

export function listReviewFindings(db, runId, options = {}) {
  const clauses = ["run_id = ?"];
  const values = [runId];
  if (options.status) { clauses.push("status = ?"); values.push(options.status); }
  if (options.reviewKind) { clauses.push("review_kind = ?"); values.push(options.reviewKind); }
  const rows = db.prepare(`
    SELECT * FROM review_findings WHERE ${clauses.join(" AND ")}
    ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC, created_at
  `).all(...values);
  return rows.map((row) => getReviewFinding(db, row.id));
}

export function setReviewFindingStatus(db, runId, id, status, input = {}) {
  invariant(REVIEW_STATUSES.has(status), "REVIEW_FINDING_STATUS", `Unsupported review finding status: ${status}.`);
  const item = getReviewFinding(db, id);
  invariant(item.run_id === runId, "REVIEW_FINDING_RUN", "Review finding belongs to another run.");
  if (["resolved", "accepted", "rejected"].includes(status)) {
    invariant(String(input.disposition ?? item.disposition ?? "").trim(), "REVIEW_FINDING_DISPOSITION", `${status} review finding needs a disposition.`);
  }
  db.prepare(`
    UPDATE review_findings SET status = ?, disposition = ?, updated_at = ? WHERE id = ?
  `).run(status, input.disposition ?? item.disposition, now(), id);
  touchRun(db, runId);
  recordEvent(db, runId, "review-finding.status", "info", { findingId: id, status });
  return getReviewFinding(db, id);
}

export function requiredSpecialistRoles(tasks, config) {
  if (!config.orchestration.specialistReviews?.enabled) return [];
  const capabilities = [...new Set(tasks.flatMap((task) => capabilityNamesFromTask(task)))];
  return specialistRolesForCapabilities(capabilities);
}

function reviewTasksForKind(db, runId, reviewKind) {
  return listTasks(db, runId).filter((task) => REVIEW_ROLES.has(task.role) && (task.review_kind ?? (task.role === "adversarial-reviewer" ? "completion" : "integration")) === reviewKind);
}

function currentReviewFingerprint(db, projectRoot, runId, reviewKind) {
  if (reviewKind === "completion") {
    const candidate = db.prepare(`
      SELECT id, content_ref, metadata_json FROM artifacts
      WHERE run_id = ? AND kind = 'verification-candidate' AND status = 'verified'
      ORDER BY updated_at DESC LIMIT 1
    `).get(runId);
    return candidate ? { artifactId: candidate.id, contentRef: candidate.content_ref, metadata: parseJson(candidate.metadata_json, {}) } : null;
  }
  // Every review-phase dimension (the general integration review as well as
  // security/database/performance/accessibility/migration reviews) reviews
  // the immutable post-integration candidate. Keep all three identity fields
  // in the approval so a specialist approval cannot float across candidates.
  const candidate = latestArtifact(db, projectRoot, runId, "integration-candidate", ["verified"]);
  if (!candidate) return null;
  const candidateData = parsedArtifact(candidate) ?? {};
  return {
    artifactId: candidate.id,
    contentRef: candidate.content_ref,
    codeFingerprint: candidate.metadata?.codeFingerprint ?? candidateData.codeFingerprint ?? null
  };
}

function parsedArtifact(artifact) {
  if (!artifact?.content) return null;
  try { return JSON.parse(artifact.content); } catch { return null; }
}

function reviewTaskIsCurrent(db, projectRoot, run, task, reviewKind) {
  if (reviewKind !== "completion") {
    const baseline = latestArtifact(db, projectRoot, run.id, `task-baseline:${task.id}`, ["verified"]);
    const data = parsedArtifact(baseline);
    const candidate = latestArtifact(db, projectRoot, run.id, "integration-candidate", ["verified"]);
    const subject = parsedArtifact(candidate);
    const subjectEvidence = asArray(task.result?.EvidenceRefs).some((ref) => (
      ref?.type === "artifact"
      && ref.id === candidate?.id
      && ref.contentRef === candidate?.content_ref
      && evidenceRefIsCurrent(db, projectRoot, ref)
    ));
    return Boolean(
      data?.subject?.kind === "integration-candidate"
      && data.subject.artifactId === candidate?.id
      && data.subject.contentRef === candidate?.content_ref
      && data.subject.codeFingerprint === subject?.codeFingerprint
      && subject?.codeFingerprint === repositoryCodeFingerprint(db)
      && subjectEvidence
    );
  }
  const candidate = latestArtifact(db, projectRoot, run.id, "verification-candidate", ["verified"]);
  if (!candidate) return false;
  return asArray(task.result?.EvidenceRefs).some((ref) => (
    ref?.type === "artifact"
    && ref.id === candidate.id
    && ref.contentRef === candidate.content_ref
    && evidenceRefIsCurrent(db, projectRoot, ref)
  ));
}

function createApprovalArtifact(db, projectRoot, run, reviewKind, tasks, findings) {
  const fingerprint = currentReviewFingerprint(db, projectRoot, run.id, reviewKind);
  invariant(fingerprint, "REVIEW_FINGERPRINT", `${reviewKind} review has no current candidate fingerprint.`);
  const kind = reviewKind === "completion"
    ? "completion-review"
    : reviewKind === "integration"
      ? "integration-review"
      : `review-approval:${reviewKind}`;
  const content = {
    reviewKind,
    verdict: "APPROVED",
    reviewerTaskIds: tasks.map((task) => task.id),
    findingIds: findings.map((item) => item.id),
    fingerprint,
    recordedAt: now()
  };
  return putArtifact(db, projectRoot, run.id, kind, content, {
    status: "verified",
    metadata: { reviewKind, verdict: "APPROVED", ...fingerprint }
  });
}

function reviewCheckpoint(options, name, context) {
  const callback = options?.[name];
  if (callback === undefined) return;
  invariant(typeof callback === "function", "REVIEW_CHECKPOINT_INVALID", `Review checkpoint ${name} must be a function.`);
  callback(context);
}

function syncReviewBasis(db, projectRoot, runId, config) {
  const sync = syncRepository(db, projectRoot, config, runId);
  return { sync, codeFingerprint: repositoryCodeFingerprint(db) };
}

function assertReviewBasisCurrent(db, projectRoot, run, config, reviewKind, tasks, expectedFingerprint) {
  // A repository sync fences the database snapshot against the source tree
  // before and after scanning. Re-checking here catches source changes that
  // occur after the reconciliation's initial sync, before approval is written.
  const basis = syncReviewBasis(db, projectRoot, run.id, config);
  invariant(basis.codeFingerprint === expectedFingerprint, "REVIEW_REPOSITORY_CHANGED",
    "The repository changed while reconciling the review; approval was not recorded.", {
      expectedFingerprint,
      actualFingerprint: basis.codeFingerprint
    });
  const stale = tasks.filter((task) => task.status === "completed" && !reviewTaskIsCurrent(db, projectRoot, run, task, reviewKind));
  invariant(stale.length === 0, "REVIEW_TASKS_STALE", `${reviewKind} review tasks did not review the current candidate.`, {
    tasks: stale.map((task) => task.id)
  });
  return basis;
}

function resolveRepairedFindingsNotReproduced(db, runId, reviewKind, tasks) {
  const reported = new Set();
  for (const task of tasks.filter((item) => item.status === "completed")) {
    for (const raw of asArray(task.result?.Findings)) {
      const id = String(raw?.Id ?? raw?.id ?? "").trim();
      if (id) reported.add(id);
    }
  }
  const pending = db.prepare(`
    SELECT id FROM review_findings
    WHERE run_id = ? AND review_kind = ? AND status = 'pending-review'
  `).all(runId, reviewKind);
  const resolved = [];
  for (const item of pending) {
    if (reported.has(item.id)) continue;
    db.prepare(`
      UPDATE review_findings SET status = 'resolved',
        disposition = 'Repair completed and the independent re-review did not reproduce the finding.',
        updated_at = ? WHERE id = ?
    `).run(now(), item.id);
    resolved.push(item.id);
  }
  return resolved;
}

function inferredRepairRequirements(db, runId, finding) {
  if (finding.requirementIds.length > 0) return finding.requirementIds;
  const tasks = listTasks(db, runId).filter((task) => task.phase === "execute" && task.targetPaths.some((target) => finding.targetPaths.some((path) => pathsOverlap(target, path))));
  const inferred = [...new Set(tasks.flatMap((task) => task.requirementIds))];
  if (inferred.length > 0) return inferred;
  return db.prepare("SELECT id FROM requirements WHERE run_id = ? AND priority = 'must' AND status <> 'superseded' ORDER BY id")
    .all(runId).map((item) => item.id);
}

export function reconcileReview(db, projectRoot, runId, config, options = {}) {
  let run = getRun(db, runId);
  // Reconcile may be called directly by the CLI/API, without a preceding
  // controller action. Refresh the repository first so source drift stales
  // candidates and approvals before any currentness or fingerprint check.
  const initialBasis = syncReviewBasis(db, projectRoot, run.id, config);
  // This is a synchronous, side-effect-free extension point for callers that
  // need to coordinate an external source update. It also makes the TOCTOU
  // fence deterministic in tests without mocking repository internals.
  reviewCheckpoint(options, "beforeCurrentness", {
    runId: run.id,
    reviewKind: options.reviewKind ?? null,
    codeFingerprint: initialBasis.codeFingerprint
  });
  const currentBasis = syncReviewBasis(db, projectRoot, run.id, config);
  invariant(currentBasis.codeFingerprint === initialBasis.codeFingerprint, "REVIEW_REPOSITORY_CHANGED",
    "The repository changed after review reconciliation started; approval was not recorded.", {
      expectedFingerprint: initialBasis.codeFingerprint,
      actualFingerprint: currentBasis.codeFingerprint
    });
  run = getRun(db, runId);
  const reviewKind = String(options.reviewKind ?? (run.phase === "verify" ? "completion" : "integration"));
  const tasks = reviewTasksForKind(db, run.id, reviewKind);
  invariant(tasks.length > 0, "REVIEW_TASKS_REQUIRED", `No ${reviewKind} review tasks exist.`);
  if (reviewKind === "completion") {
    // Never ingest or approve an adversarial result without a currently
    // verified candidate. Reopened repairs mark the previous candidate stale,
    // and a fresh candidate must be produced before the adversarial wave can
    // run again.
    invariant(
      latestArtifact(db, projectRoot, run.id, "verification-candidate", ["verified"]),
      "REVIEW_CANDIDATE_REQUIRED",
      "Completion review requires a current verified verification candidate."
    );
  }
  const incomplete = tasks.filter((task) => task.status !== "completed");
  invariant(incomplete.length === 0, "REVIEW_TASKS_INCOMPLETE", `${reviewKind} review tasks must all complete; review evidence cannot be waived.`, {
    tasks: incomplete.map((task) => ({ id: task.id, status: task.status }))
  });
  const staleReviewTasks = tasks.filter((task) => task.status === "completed" && !reviewTaskIsCurrent(db, projectRoot, run, task, reviewKind));
  invariant(staleReviewTasks.length === 0, "REVIEW_TASKS_STALE", `${reviewKind} review tasks did not review the current candidate.`, { tasks: staleReviewTasks.map((task) => task.id) });
  for (const task of tasks.filter((item) => item.status === "completed")) {
    // Re-ingest every completed review attempt. The upsert preserves terminal
    // dispositions but refreshes open findings from the current attempt.
    ingestReviewTask(db, projectRoot, run.id, task.id);
  }
  const resolvedAfterRepair = resolveRepairedFindingsNotReproduced(db, run.id, reviewKind, tasks);
  const rejectedTasks = tasks.filter((task) => String(task.result?.Verdict ?? "REJECTED").toUpperCase() !== "APPROVED");
  const findings = listReviewFindings(db, run.id, { reviewKind });
  const blocking = findings.filter((item) => BLOCKING.has(item.severity) && !["resolved", "accepted", "rejected"].includes(item.status));
  if (blocking.length === 0 && rejectedTasks.length === 0) {
    reviewCheckpoint(options, "beforeApproval", {
      runId: run.id,
      reviewKind,
      codeFingerprint: currentBasis.codeFingerprint
    });
    assertReviewBasisCurrent(db, projectRoot, run, config, reviewKind, tasks, currentBasis.codeFingerprint);
    const artifact = createApprovalArtifact(db, projectRoot, run, reviewKind, tasks, findings);
    recordEvent(db, run.id, "review.approved", "info", { reviewKind, artifactId: artifact.id, taskIds: tasks.map((task) => task.id) });
    return { reviewKind, status: "APPROVED", artifact, findings, resolvedAfterRepair };
  }
  if (rejectedTasks.length > 0 && blocking.length === 0) {
    return {
      reviewKind,
      status: "REPLAN_REQUIRED",
      rejectedTaskIds: rejectedTasks.map((task) => task.id),
      reason: "A reviewer rejected the candidate without actionable structured blocking findings."
    };
  }
  const missingPaths = blocking.filter((item) => item.targetPaths.length === 0);
  if (missingPaths.length > 0 || !config.orchestration.autoCreateRepairTasks) {
    return {
      reviewKind,
      status: "REPLAN_REQUIRED",
      blocking,
      missingTargetPaths: missingPaths.map((item) => item.id)
    };
  }
  if (run.phase !== "execute") {
    reopenPhase(db, run.id, "execute", `${reviewKind} review produced ${blocking.length} blocking finding(s).`);
    run = getRun(db, run.id);
  }
  const created = [];
  for (const finding of blocking) {
    if (finding.repair_task_id) continue;
    const taskId = nextRepairTaskId(db, finding.id);
    const repair = addTask(db, run.id, {
      id: taskId,
      title: `Resolve ${finding.title}`,
      goal: finding.suggested_fix || finding.description,
      role: "worker",
      runPhase: "execute",
      readOnly: false,
      autoGenerated: true,
      complexity: finding.severity === "critical" ? "high" : "medium",
      targetPaths: finding.targetPaths,
      scope: finding.targetPaths,
      constraints: ["Resolve only the linked review finding.", "Preserve unrelated behavior."],
      acceptanceCriteria: [
        `Review finding ${finding.id} is no longer reproducible.`,
        "Relevant tests pass."
      ],
      requiredEvidence: ["Changed files", "Focused test or final-state evidence"],
      requirementIds: inferredRepairRequirements(db, run.id, finding),
      authority: "local-write-assigned-paths"
    }, config);
    db.prepare(`
      UPDATE review_findings SET status = 'fixing', repair_task_id = ?, updated_at = ? WHERE id = ?
    `).run(repair.id, now(), finding.id);
    created.push(repair);
  }
  recordEvent(db, run.id, "review.repairs-created", "warning", { reviewKind, findingIds: blocking.map((item) => item.id), taskIds: created.map((item) => item.id) });
  return { reviewKind, status: "FIXES_SCHEDULED", blocking, repairTasks: created };
}

export function reviewReport(db, runId) {
  const findings = listReviewFindings(db, runId);
  const tasks = listTasks(db, runId).filter((task) => REVIEW_ROLES.has(task.role));
  return {
    runId,
    tasks: tasks.map((task) => ({ id: task.id, role: task.role, reviewKind: task.review_kind, status: task.status })),
    findings,
    blocking: findings.filter((item) => BLOCKING.has(item.severity) && !["resolved", "accepted", "rejected"].includes(item.status))
  };
}
