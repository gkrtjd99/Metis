import { budgetStatus } from "./budget.js";
import { storeObject } from "./objects.js";
import { getRun, putArtifact, recordEvent } from "./state.js";
import { traceabilityReport } from "./traceability.js";
import { governanceReport } from "./governance.js";
import { reviewReport } from "./reviews.js";
import { makeId, now, parseJson, stableStringify } from "./util.js";

function count(db, sql, ...args) {
  return Number(db.prepare(sql).get(...args)?.count ?? 0);
}

export function evaluateRun(db, projectRoot, runId, config) {
  const run = getRun(db, runId);
  const budget = budgetStatus(db, run.id);
  const traceability = traceabilityReport(db, run.id, { refreshStatuses: true });
  const governance = governanceReport(db, run.id, config);
  const reviews = reviewReport(db, run.id);
  const context = db.prepare(`
    SELECT COUNT(*) AS count,
      COALESCE(SUM(estimated_tokens), 0) AS estimated,
      COALESCE(AVG(estimated_tokens), 0) AS average,
      COALESCE(MAX(estimated_tokens), 0) AS maximum,
      COALESCE(AVG(CASE WHEN json_extract(quality_json, '$.coverage') IS NOT NULL THEN json_extract(quality_json, '$.coverage') END), 1) AS quality
    FROM context_snapshots WHERE run_id = ?
  `).get(run.id);
  const metrics = {
    phase: run.phase,
    status: run.status,
    durationMs: Math.max(0, Date.now() - new Date(run.created_at).getTime()),
    taskCount: count(db, "SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?", run.id),
    completedTasks: count(db, "SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'completed'", run.id),
    failedTasks: count(db, "SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'failed'", run.id),
    retriedTasks: count(db, "SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND attempts > 1", run.id),
    agentAttempts: count(db, "SELECT COALESCE(SUM(attempts), 0) AS count FROM tasks WHERE run_id = ?", run.id),
    planSeals: count(db, "SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind = 'plan'", run.id),
    phaseReopens: count(db, "SELECT COUNT(*) AS count FROM journal WHERE run_id = ? AND event_type = 'phase.reopened'", run.id),
    stalledSamples: count(db, "SELECT COUNT(*) AS count FROM progress_samples WHERE run_id = ? AND stall_count > 0", run.id),
    reviewFindings: reviews.findings.length,
    blockingReviewFindings: reviews.blocking.length,
    traceability: traceability.summary,
    governance: {
      assumptions: governance.assumptions.length,
      invariants: governance.invariants.length,
      risks: governance.risks.length,
      passForCompletion: governance.passForCompletion
    },
    budget,
    context: {
      snapshots: Number(context.count),
      estimatedTokens: Number(context.estimated),
      averageTokens: Number(context.average),
      maximumTokens: Number(context.maximum),
      semanticCoverage: Number(context.quality)
    }
  };
  const recommendations = [];
  if (metrics.retriedTasks > Math.max(2, Math.ceil(metrics.taskCount * 0.15))) {
    recommendations.push("Reduce task ambiguity or improve model routing. Too many tasks required retries.");
  }
  if (metrics.planSeals > 2) recommendations.push("Improve discovery or design review. The plan was resealed repeatedly.");
  if (metrics.phaseReopens > 2) recommendations.push("Move late findings into earlier design, planning, or specialist review gates.");
  if (metrics.stalledSamples > 0) recommendations.push("Inspect repeated searches and task contracts that did not change durable state.");
  if (metrics.context.semanticCoverage < 0.95) recommendations.push("Raise semantic context coverage before increasing the token budget.");
  if (metrics.blockingReviewFindings > 0) recommendations.push("Do not complete while blocking review findings remain open.");
  if (!traceability.pass) recommendations.push("Close requirement traceability gaps before completion.");
  if (!governance.passForCompletion) recommendations.push("Resolve assumptions, invariant verification, or critical risk dispositions.");
  if (budget.exceeded.length > 0) recommendations.push(`Adjust orchestration or scope. Budget exceeded: ${budget.exceeded.join(", ")}.`);
  if (recommendations.length === 0) recommendations.push("No deterministic metis-policy issue was detected in this run.");
  const report = { version: 1, runId: run.id, metrics, recommendations, createdAt: now() };
  const contentRef = storeObject(db, projectRoot, "self-evaluation", stableStringify(report), { redact: true });
  const id = makeId("eval");
  db.prepare(`
    INSERT INTO self_evaluations(id, run_id, status, metrics_json, recommendations_json, content_ref, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(id, run.id, traceability.pass && governance.passForCompletion && reviews.blocking.length === 0 ? "pass" : "attention", JSON.stringify(metrics), JSON.stringify(recommendations), contentRef, now());
  const artifact = putArtifact(db, projectRoot, run.id, "self-evaluation", report, {
    status: "verified",
    metadata: { evaluationId: id, status: traceability.pass && governance.passForCompletion ? "pass" : "attention" }
  });
  recordEvent(db, run.id, "run.evaluated", "info", { evaluationId: id, recommendationCount: recommendations.length });
  return { id, report, artifact };
}

export function latestEvaluation(db, runId) {
  const row = db.prepare("SELECT * FROM self_evaluations WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(runId);
  if (!row) return null;
  return {
    ...row,
    metrics: parseJson(row.metrics_json, {}),
    recommendations: parseJson(row.recommendations_json, [])
  };
}
