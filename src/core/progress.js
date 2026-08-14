import { getRun, recordEvent } from "./state.js";
import { makeId, now, parseJson } from "./util.js";

function metrics(db, runId) {
  const scalar = (sql, ...args) => Number(db.prepare(sql).get(...args)?.count ?? 0);
  return {
    validFindings: scalar("SELECT COUNT(*) AS count FROM findings WHERE run_id = ? AND status = 'valid'", runId),
    verifiedArtifacts: scalar("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND status = 'verified'", runId),
    completedTasks: scalar("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'completed'", runId),
    verifiedRequirements: scalar("SELECT COUNT(*) AS count FROM requirements WHERE run_id = ? AND status = 'verified'", runId),
    passedChecks: scalar("SELECT COUNT(*) AS count FROM checks WHERE run_id = ? AND status = 'passed'", runId),
    resolvedReviewFindings: scalar("SELECT COUNT(*) AS count FROM review_findings WHERE run_id = ? AND status IN ('resolved','accepted','rejected')", runId),
    resolvedRisks: scalar("SELECT COUNT(*) AS count FROM risks WHERE run_id = ? AND status IN ('mitigated','resolved','accepted','rejected')", runId),
    openBlockers: scalar("SELECT COUNT(*) AS count FROM findings WHERE run_id = ? AND status = 'valid' AND kind = 'blocker'", runId)
      + scalar("SELECT COUNT(*) AS count FROM review_findings WHERE run_id = ? AND status IN ('open','fixing','pending-review') AND severity IN ('error','critical')", runId)
      + scalar("SELECT COUNT(*) AS count FROM risks WHERE run_id = ? AND status = 'open' AND severity = 'critical'", runId)
  };
}

function delta(current, previous) {
  const result = {};
  for (const key of Object.keys(current)) result[key] = current[key] - Number(previous?.[key] ?? 0);
  return result;
}

function madeProgress(change) {
  return change.validFindings > 0
    || change.verifiedArtifacts > 0
    || change.completedTasks > 0
    || change.verifiedRequirements > 0
    || change.passedChecks > 0
    || change.resolvedReviewFindings > 0
    || change.resolvedRisks > 0
    || change.openBlockers < 0;
}

export function sampleProgress(db, runId, config, options = {}) {
  const run = getRun(db, runId);
  const existing = db.prepare("SELECT * FROM progress_samples WHERE run_id = ? AND revision = ?").get(run.id, run.revision);
  if (existing) {
    return {
      ...existing,
      metrics: parseJson(existing.metrics_json, {}),
      delta: parseJson(existing.delta_json, {}),
      progressed: Boolean(existing.progressed),
      stalled: existing.stall_count >= Number(config.orchestration.progressStallThreshold ?? 3)
    };
  }
  // A phase is the unit of watchdog progress. Samples from an earlier phase
  // (or an earlier visit to this phase) are not a valid baseline for the
  // current recovery attempt.
  const previous = db.prepare(`
    SELECT * FROM progress_samples
    WHERE run_id = ? AND phase = ?
    ORDER BY revision DESC LIMIT 1
  `).get(run.id, run.phase);
  const current = metrics(db, run.id);
  const change = delta(current, previous ? parseJson(previous.metrics_json, {}) : {});
  const running = Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'running'").get(run.id).count);
  const progress = previous ? madeProgress(change) : true;
  const stallCount = progress || running > 0 || options.ignoreStall
    ? 0
    : Number(previous?.stall_count ?? 0) + 1;
  const id = makeId("progress");
  const timestamp = now();
  db.prepare(`
    INSERT INTO progress_samples(
      id, run_id, phase, revision, metrics_json, delta_json,
      progressed, stall_count, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, revision) DO NOTHING
  `).run(id, run.id, run.phase, run.revision, JSON.stringify(current), JSON.stringify(change), progress ? 1 : 0, stallCount, timestamp);
  const inserted = db.prepare("SELECT changes() AS changes").get().changes;
  if (!inserted) {
    const concurrent = db.prepare("SELECT * FROM progress_samples WHERE run_id = ? AND revision = ?").get(run.id, run.revision);
    return {
      ...concurrent,
      metrics: parseJson(concurrent.metrics_json, {}),
      delta: parseJson(concurrent.delta_json, {}),
      progressed: Boolean(concurrent.progressed),
      stallCount: Number(concurrent.stall_count),
      stalled: Number(concurrent.stall_count) >= Number(config.orchestration.progressStallThreshold ?? 3)
    };
  }
  db.prepare(`
    UPDATE runs SET stalled_count = ?, last_progress_at = CASE WHEN ? = 1 THEN ? ELSE last_progress_at END
    WHERE id = ?
  `).run(stallCount, progress ? 1 : 0, timestamp, run.id);
  const stalled = stallCount >= Number(config.orchestration.progressStallThreshold ?? 3);
  if (stalled) recordEvent(db, run.id, "progress.stalled", "warning", { stallCount, phase: run.phase, metrics: current, delta: change });
  return { id, runId: run.id, phase: run.phase, revision: run.revision, metrics: current, delta: change, progressed: progress, stallCount, stalled };
}

export function progressStatus(db, runId, config = null) {
  const phase = db.prepare("SELECT phase FROM runs WHERE id = ?").get(runId)?.phase;
  if (!phase) return null;
  const row = db.prepare(`
    SELECT * FROM progress_samples
    WHERE run_id = ? AND phase = ?
    ORDER BY revision DESC LIMIT 1
  `).get(runId, phase);
  if (!row) return null;
  const stallCount = Number(row.stall_count ?? 0);
  const threshold = Number(config?.orchestration?.progressStallThreshold ?? 3);
  return {
    ...row,
    metrics: parseJson(row.metrics_json, {}),
    delta: parseJson(row.delta_json, {}),
    progressed: Boolean(row.progressed),
    stallCount,
    stalled: stallCount >= threshold
  };
}
