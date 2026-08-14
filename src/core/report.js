import { getRun, latestArtifact } from "./state.js";
import { listTasks } from "./tasks.js";
import { listChecks } from "./checks.js";
import { listDecisions, listFindings } from "./evidence.js";
import { listDocumentImpacts } from "./docs.js";
import { getGoalContract } from "./contracts.js";
import { traceabilityReport } from "./traceability.js";
import { governanceReport } from "./governance.js";
import { reviewReport } from "./reviews.js";
import { budgetStatus } from "./budget.js";
import { progressStatus } from "./progress.js";
import { latestEvaluation } from "./evaluation.js";
import { listMilestones } from "./milestones.js";
import { loadConfig } from "./config.js";

function performanceRows(db, runId) {
  return db.prepare("SELECT type, payload_json, created_at, updated_at, count FROM events WHERE run_id = ? AND type LIKE 'performance.%' ORDER BY created_at, id").all(runId)
    .map((row) => ({ ...row, payload: artifactJson({ content: row.payload_json }) ?? {} }));
}

function timingSummary(values) {
  const sorted = values.filter(Number.isFinite).map(Number).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, totalMs: 0, averageMs: 0, medianMs: 0, p95Ms: 0 };
  const nearestRank = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    count: sorted.length,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
    averageMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    medianMs: nearestRank(0.5),
    p95Ms: nearestRank(0.95)
  };
}

function performanceReportData(db, runId) {
  const run = getRun(db, runId);
  const config = loadConfig(run.project_root);
  const rows = performanceRows(db, runId);
  const timings = {};
  for (const row of rows) {
    const key = row.type.slice("performance.".length);
    const item = row.payload;
    if (Number.isFinite(Number(item.durationMs))) (timings[key] ??= []).push(Number(item.durationMs));
  }
  const durations = Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, {
    count: values.length, totalMs: values.reduce((sum, value) => sum + value, 0), averageMs: values.reduce((sum, value) => sum + value, 0) / values.length, maxMs: Math.max(...values)
  }]));
  const wallClockMs = Math.max(0, Date.parse(run.updated_at) - Date.parse(run.created_at));
  const taskRows = db.prepare("SELECT id, phase, role, status, attempts, requested_effort, effective_effort, model_tier, selected_model, failure_class, created_at, updated_at FROM tasks WHERE run_id = ?").all(runId);
  const attempts = db.prepare("SELECT * FROM task_attempts WHERE run_id = ? ORDER BY start_at, id").all(runId);
  const failures = {};
  for (const attempt of attempts) {
    if (attempt.failure_class) failures[attempt.failure_class] = (failures[attempt.failure_class] ?? 0) + 1;
  }
  const endpoints = attempts.flatMap((attempt) => [
    { at: Date.parse(attempt.start_at), delta: 1 },
    { at: Date.parse(attempt.terminal_at ?? run.updated_at), delta: -1 }
  ]).filter((item) => Number.isFinite(item.at)).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maximumConcurrent = 0;
  let weightedConcurrencyMs = 0;
  let previousAt = endpoints[0]?.at ?? Date.parse(run.created_at);
  for (const endpoint of endpoints) {
    weightedConcurrencyMs += active * Math.max(0, endpoint.at - previousAt);
    active += endpoint.delta;
    maximumConcurrent = Math.max(maximumConcurrent, active);
    previousAt = endpoint.at;
  }
  const observedSpanMs = endpoints.length > 1 ? Math.max(0, endpoints.at(-1).at - endpoints[0].at) : 0;
  let controllerWaitMs = 0;
  let waitStart = null;
  let waitActive = 0;
  for (const endpoint of endpoints) {
    if (waitActive === 0 && endpoint.delta > 0) waitStart = endpoint.at;
    waitActive += endpoint.delta;
    if (waitActive === 0 && waitStart !== null) {
      controllerWaitMs += Math.max(0, endpoint.at - waitStart);
      waitStart = null;
    }
  }
  const models = {};
  for (const task of taskRows) { const model = task.selected_model ?? task.model_tier ?? "unknown"; models[model] = (models[model] ?? 0) + 1; }
  const budget = db.prepare("SELECT * FROM budget_state WHERE run_id = ?").get(runId);
  const verification = db.prepare("SELECT required, status, updated_at FROM checks WHERE run_id = ? ORDER BY updated_at DESC").all(runId);
  const verificationPassed = verification.length > 0 && verification.every((item) => item.status === "passed");
  const requiredChecks = verification.filter((item) => Boolean(item.required));
  const requiredChecksPassed = requiredChecks.every((item) => item.status === "passed");
  const verificationArtifact = latestArtifact(db, run.project_root, run.id, "verification", ["verified"]);
  const verificationCandidate = latestArtifact(db, run.project_root, run.id, "verification-candidate", ["verified"]);
  const verifiedEvidenceAt = [
    verificationArtifact?.updated_at,
    verificationCandidate?.updated_at,
    ...requiredChecks.map((item) => item.updated_at)
  ].map((value) => Date.parse(value)).filter(Number.isFinite);
  const verifiedAt = run.phase === "complete"
    && run.status === "completed"
    && Boolean(verificationArtifact && verificationCandidate)
    && requiredChecksPassed
    && verifiedEvidenceAt.length > 0
    ? Math.max(...verifiedEvidenceAt)
    : null;
  const countBy = (field) => Object.fromEntries(attempts.reduce((map, attempt) => {
    const value = attempt[field] ?? "unknown";
    map.set(value, (map.get(value) ?? 0) + 1);
    return map;
  }, new Map()));
  const phaseDurations = Object.fromEntries([...new Set(taskRows.map((task) => task.phase))].map((phase) => {
    const phaseTasks = taskRows.filter((task) => task.phase === phase);
    const start = Math.min(...phaseTasks.map((task) => Date.parse(task.created_at)).filter(Number.isFinite));
    const end = Math.max(...phaseTasks.map((task) => Date.parse(task.updated_at)).filter(Number.isFinite));
    return [phase, Math.max(0, end - start)];
  }));
  const attemptDurations = attempts.map((attempt) => ({
    taskId: attempt.task_id,
    durationMs: Math.max(0, Date.parse(attempt.execution_ended_at ?? attempt.terminal_at ?? run.updated_at) - Date.parse(attempt.execution_started_at ?? attempt.spawn_accepted_at ?? attempt.start_at))
  })).filter((item) => Number.isFinite(item.durationMs)).sort((left, right) => right.durationMs - left.durationMs);
  const acceptanceDurations = attempts.map((attempt) => Date.parse(attempt.spawn_accepted_at) - Date.parse(attempt.start_at))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const executionDurations = attempts.map((attempt) => Date.parse(attempt.execution_ended_at ?? attempt.terminal_at) - Date.parse(attempt.execution_started_at ?? attempt.spawn_accepted_at))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const eventTiming = (name) => timingSummary((timings[name] ?? []));
  const phaseTiming = (phase) => timingSummary(attempts
    .filter((attempt) => taskRows.find((task) => task.id === attempt.task_id)?.phase === phase)
    .map((attempt) => Date.parse(attempt.execution_ended_at ?? attempt.terminal_at ?? run.updated_at) - Date.parse(attempt.execution_started_at ?? attempt.spawn_accepted_at ?? attempt.start_at))
    .filter((value) => Number.isFinite(value) && value >= 0));
  const firstAccepted = attempts.map((attempt) => attempt.spawn_accepted_at).filter(Boolean).sort()[0] ?? null;
  const firstWorkerStarted = attempts.filter((attempt) => attempt.role === "worker").map((attempt) => attempt.execution_started_at ?? attempt.spawn_accepted_at).filter(Boolean).sort()[0] ?? null;
  const controllerDeterministic = eventTiming("controller-deterministic");
  const schedulerPreparation = eventTiming("scheduler-preparation");
  const integration = eventTiming("integration-copy");
  return {
    totalWallClockMs: wallClockMs,
    verifiedCompletion: verifiedAt !== null,
    verifiedCompletionTimeMs: verifiedAt ? Math.max(0, verifiedAt - Date.parse(run.created_at)) : null,
    phaseDurationsMs: phaseDurations,
    firstSpawnAt: firstAccepted,
    firstImplementationWorkerAt: firstWorkerStarted,
    timeToFirstSpawnMs: firstAccepted ? Math.max(0, Date.parse(firstAccepted) - Date.parse(run.created_at)) : null,
    timeToFirstImplementationWorkerMs: firstWorkerStarted ? Math.max(0, Date.parse(firstWorkerStarted) - Date.parse(run.created_at)) : null,
    controllerDeterministicTimeMs: controllerDeterministic.totalMs,
    controllerWaitTimeMs: controllerWaitMs,
    schedulerPreparationTimeMs: schedulerPreparation.totalMs,
    hostSpawnAcceptanceTimeMs: timingSummary(acceptanceDurations),
    childExecutionTimeMs: timingSummary(executionDurations),
    integrationTimeMs: integration,
    reviewTimeMs: phaseTiming("review"),
    verificationTimeMs: phaseTiming("verify"),
    curationTimeMs: phaseTiming("curate"),
    timings: durations,
    criticalPath: { kind: "attempt-duration approximation", tasks: attemptDurations.slice(0, 8), durationMs: attemptDurations[0]?.durationMs ?? 0, note: "Longest durable child execution; dependency-edge reconstruction remains conservative." },
    concurrency: {
      totalAgentAttempts: attempts.length,
      max: maximumConcurrent,
      average: observedSpanMs > 0 ? weightedConcurrencyMs / observedSpanMs : 0,
      availableSlots: Number(config.orchestration.maxConcurrent),
      slotUtilization: observedSpanMs > 0 && Number(config.orchestration.maxConcurrent) > 0
        ? weightedConcurrencyMs / observedSpanMs / Number(config.orchestration.maxConcurrent)
        : 0
    },
    retriesByFailureClass: failures,
    requestedEffortCounts: countBy("requested_effort"),
    effectiveEffortCounts: countBy("effective_effort"),
    modelCounts: models,
    tokens: { input: Number(budget?.input_tokens ?? 0), output: Number(budget?.output_tokens ?? 0) },
    verification: { checks: verification.map(({ status, updated_at }) => ({ status, updated_at })), passed: verificationPassed },
    events: rows.length
  };
}

export function performanceReport(db, runId) {
  return performanceReportData(db, runId);
}

function artifactJson(artifact) {
  if (!artifact?.content) return null;
  try { return JSON.parse(artifact.content); } catch { return { text: artifact.content }; }
}

export function buildReport(db, runId) {
  const run = getRun(db, runId);
  const config = loadConfig(run.project_root);
  const baselineArtifact = latestArtifact(db, run.project_root, run.id, "workspace-baseline");
  const baseline = artifactJson(baselineArtifact) ?? {};
  const tasks = listTasks(db, run.id);
  const checks = listChecks(db, run.id);
  const decisions = listDecisions(db, run.id, null);
  const findings = listFindings(db, run.id);
  const docs = listDocumentImpacts(db, run.id);
  const contract = getGoalContract(db, run.id);
  const traceability = traceabilityReport(db, run.id, { refreshStatuses: false });
  const governance = governanceReport(db, run.id, config);
  const reviews = reviewReport(db, run.id);
  const budget = budgetStatus(db, run.id);
  const progress = progressStatus(db, run.id);
  const evaluation = latestEvaluation(db, run.id);
  const milestones = listMilestones(db, run.id);
  const currentReviews = {
    design: artifactJson(latestArtifact(db, run.project_root, run.id, "design-review", ["verified", "stale"])),
    plan: artifactJson(latestArtifact(db, run.project_root, run.id, "plan-review", ["verified", "stale"])),
    integration: artifactJson(latestArtifact(db, run.project_root, run.id, "integration-review", ["verified", "stale"])),
    completion: artifactJson(latestArtifact(db, run.project_root, run.id, "completion-review", ["verified", "stale"]))
  };
  const performance = performanceReportData(db, runId);
  return {
    version: 4,
    run: {
      id: run.id,
      goal: run.goal,
      controller: run.controller,
      phase: run.phase,
      status: run.status,
      complexity: run.complexity,
      contractVersion: run.contract_version,
      createdAt: run.created_at,
      updatedAt: run.updated_at
    },
    contract,
    baseline: {
      gitRef: baseline.gitRef ?? run.baseline_ref,
      preexistingChanges: baseline.preexistingChanges ?? []
    },
    milestones: {
      total: milestones.length,
      completed: milestones.filter((item) => item.status === "completed").length,
      active: milestones.filter((item) => item.status === "active").map((item) => item.id),
      pending: milestones.filter((item) => item.status === "pending").map((item) => item.id)
    },
    tasks: {
      total: tasks.length,
      completed: tasks.filter((task) => task.status === "completed").length,
      waived: tasks.filter((task) => task.status === "waived").length,
      blocked: tasks.filter((task) => task.status === "blocked").length,
      failed: tasks.filter((task) => task.status === "failed").length,
      retried: tasks.filter((task) => Number(task.attempts) > 1).length,
      changedFiles: [...new Set(tasks.flatMap((task) => task.result?.Files ?? []))]
    },
    traceability,
    checks,
    decisions,
    governance,
    reviews: { ...reviews, current: currentReviews },
    legacyRisks: findings.filter((item) => ["risk", "blocker"].includes(item.kind) && item.status === "valid"),
    staleFindings: findings.filter((item) => item.status === "stale"),
    documentation: {
      pending: docs.filter((item) => item.status === "pending"),
      resolved: docs.filter((item) => item.status === "resolved")
    },
    budget,
    progress,
    selfEvaluation: evaluation,
    performance
  };
}

export function reportMarkdown(report) {
  const must = report.traceability.requirements.filter((item) => item.priority === "must");
  const residualRisks = report.governance.risks.filter((item) => ["open", "accepted"].includes(item.status));
  const lines = [
    "# Metis Report",
    "",
    `**Goal:** ${report.run.goal}`,
    `**Run:** ${report.run.id}`,
    `**Controller:** ${report.run.controller}`,
    `**Status:** ${report.run.status} (${report.run.phase})`,
    `**Contract:** v${report.run.contractVersion} (${report.run.complexity})`,
    "",
    "## Goal Contract",
    "",
    `- Scope: ${report.contract?.scope?.join(", ") || "not recorded"}`,
    `- Non-goals: ${report.contract?.nonGoals?.join(", ") || "none"}`,
    `- Success criteria: ${report.contract?.successCriteria?.length ?? 0}`,
    "",
    "## Requirement coverage",
    "",
    `- Must requirements: ${must.length}`,
    `- Designed: ${must.filter((item) => item.designed).length}`,
    `- Planned: ${must.filter((item) => item.planned).length}`,
    `- Implemented: ${must.filter((item) => item.implemented).length}`,
    `- Verified: ${must.filter((item) => item.verified).length}`,
    `- Traceability pass: ${report.traceability.pass}`,
    ...(must.filter((item) => item.gaps.length).map((item) => `- Gap ${item.id}: ${item.gaps.join(", ")}`)),
    "",
    "## Execution",
    "",
    `- Milestones: ${report.milestones.completed}/${report.milestones.total} completed`,
    `- Tasks: ${report.tasks.completed} completed, ${report.tasks.waived} waived, ${report.tasks.blocked} blocked, ${report.tasks.failed} failed`,
    `- Retried tasks: ${report.tasks.retried}`,
    `- Changed files: ${report.tasks.changedFiles.length}`,
    `- Pre-existing workspace changes: ${report.baseline.preexistingChanges.length}`,
    "",
    "## Verification",
    "",
    ...(report.checks.length ? report.checks.map((check) => `- ${check.name}: ${check.status}`) : ["- No registered checks"]),
    `- Blocking review findings: ${report.reviews.blocking.length}`,
    `- Invariants verified: ${report.governance.invariants.filter((item) => item.status === "verified").length}/${report.governance.invariants.length}`,
    "",
    "## Decisions",
    "",
    ...(report.decisions.length ? report.decisions.map((decision) => `- ${decision.id} [${decision.status}]: ${decision.decision}`) : ["- None"]),
    "",
    "## Residual risks",
    "",
    ...(residualRisks.length ? residualRisks.map((risk) => `- ${risk.id} [${risk.status}/${risk.severity}]: ${risk.title}`) : ["- None"]),
    "",
    "## Budget and progress",
    "",
    `- Budget pass: ${report.budget.pass}`,
    `- Input tokens: ${report.budget.usage.inputTokens}/${report.budget.limits.inputTokens ?? "unbounded"}`,
    `- Agent spawns: ${report.budget.usage.agentSpawns}/${report.budget.limits.agentSpawns ?? "unbounded"}`,
    `- Progress stalled: ${Boolean(report.progress?.stalled)}`,
    "",
    "## Knowledge state",
    "",
    `- Pending documentation impacts: ${report.documentation.pending.length}`,
    `- Stale findings: ${report.staleFindings.length}`,
    `- Self-evaluation: ${report.selfEvaluation?.status ?? "missing"}`,
    ""
  ];
  return lines.join("\n");
}
