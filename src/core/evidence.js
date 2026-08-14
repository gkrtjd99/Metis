import { invariant } from "./errors.js";
import { getRun, recordEvent, touchRun } from "./state.js";
import {
  evidenceRefIsCurrent,
  evidenceSummary,
  normalizeEvidenceRef,
  normalizeEvidenceRefs
} from "./provenance.js";
import { asArray, json, makeId, now, parseJson } from "./util.js";

const FINDING_STATUSES = new Set(["valid", "stale", "superseded", "resolved"]);
const FINDING_KINDS = new Set(["fact", "observation", "assumption", "constraint", "risk", "blocker"]);
const FINDING_SEVERITIES = new Set(["info", "warning", "error", "critical"]);
const DECISION_STATUSES = new Set(["active", "needs-review", "superseded"]);

function requirementIds(db, runId, values) {
  const ids = [...new Set(asArray(values).map((item) => String(item).trim()).filter(Boolean))];
  for (const id of ids) {
    invariant(db.prepare("SELECT 1 FROM requirements WHERE run_id = ? AND id = ? AND status <> 'superseded'").get(runId, id), "EVIDENCE_REQUIREMENT", `Requirement ${id} was not found.`);
  }
  return ids;
}

function addTraceLinks(db, runId, ids, targetType, targetId, relation, evidenceRefs) {
  const timestamp = now();
  for (const requirementId of ids) {
    db.prepare(`
      INSERT INTO trace_links(
        id, run_id, requirement_id, target_type, target_id, relation,
        status, evidence_refs_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'current', ?, ?, ?)
      ON CONFLICT(run_id, requirement_id, target_type, target_id, relation) DO UPDATE SET
        status = 'current', evidence_refs_json = excluded.evidence_refs_json, updated_at = excluded.updated_at
    `).run(makeId("trace"), runId, requirementId, targetType, targetId, relation, json(evidenceRefs), timestamp, timestamp);
  }
}

export function addFinding(db, projectRoot, runId, input) {
  const run = getRun(db, runId);
  const claim = String(input.claim ?? input.Claim ?? "").trim();
  invariant(claim, "FINDING_CLAIM_REQUIRED", "A finding needs a claim.");
  const sources = normalizeEvidenceRefs(db, projectRoot, input.sources ?? input.Sources ?? []);
  const kind = String(input.kind ?? input.Kind ?? "fact").toLowerCase();
  const severity = String(input.severity ?? input.Severity ?? "info").toLowerCase();
  const status = String(input.status ?? input.Status ?? "valid").toLowerCase();
  const confidence = Number(input.confidence ?? input.Confidence ?? 1);
  invariant(FINDING_KINDS.has(kind), "FINDING_KIND", `Unsupported finding kind: ${kind}.`);
  invariant(FINDING_SEVERITIES.has(severity), "FINDING_SEVERITY", `Unsupported finding severity: ${severity}.`);
  invariant(FINDING_STATUSES.has(status), "FINDING_STATUS", `Unsupported finding status: ${status}.`);
  invariant(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1, "FINDING_CONFIDENCE", "Finding confidence must be between 0 and 1.");
  if (status === "valid") {
    const invalid = sources.filter((ref) => !evidenceRefIsCurrent(db, projectRoot, ref));
    invariant(invalid.length === 0, "FINDING_EVIDENCE_INVALID", `Finding evidence is not current: ${invalid.map(evidenceSummary).join(", ")}`);
  }
  const ids = requirementIds(db, run.id, input.requirementIds ?? input.RequirementIds ?? []);
  const targetPaths = [...new Set(asArray(input.targetPaths ?? input.TargetPaths).map((item) => String(item).trim()).filter(Boolean))];
  const sourceTaskId = input.sourceTaskId ?? input.SourceTaskId ?? null;
  if (sourceTaskId) invariant(db.prepare("SELECT 1 FROM tasks WHERE id = ? AND run_id = ?").get(sourceTaskId, run.id), "FINDING_SOURCE_TASK", `Source task ${sourceTaskId} was not found.`);
  const id = input.id ?? makeId("find");
  const timestamp = now();
  db.prepare(`
    INSERT INTO findings(
      id, run_id, source_task_id, claim, kind, confidence, relevance, severity, status,
      sources_json, requirement_ids_json, target_paths_json, suggested_fix, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, run.id, sourceTaskId, claim, kind, confidence,
    input.relevance ?? input.Relevance ?? null, severity, status, json(sources),
    json(ids), json(targetPaths), input.suggestedFix ?? input.SuggestedFix ?? null,
    timestamp, timestamp
  );
  const relation = kind === "risk" ? "risked-by" : kind === "constraint" ? "constrained-by" : null;
  if (relation) addTraceLinks(db, run.id, ids, "finding", id, relation, sources);
  touchRun(db, run.id);
  recordEvent(db, run.id, "finding.added", severity, { id, kind, claim, requirementIds: ids, sources: sources.map(evidenceSummary) });
  return getFinding(db, id);
}

export function getFinding(db, id) {
  const row = db.prepare("SELECT * FROM findings WHERE id = ?").get(id);
  invariant(row, "FINDING_NOT_FOUND", `Finding ${id} was not found.`);
  return {
    ...row,
    sources: parseJson(row.sources_json, []),
    requirementIds: parseJson(row.requirement_ids_json, []),
    targetPaths: parseJson(row.target_paths_json, [])
  };
}

export function listFindings(db, runId, options = {}) {
  let sql = "SELECT * FROM findings WHERE run_id = ?";
  const params = [runId];
  if (options.status) { sql += " AND status = ?"; params.push(options.status); }
  if (options.kind) { sql += " AND kind = ?"; params.push(options.kind); }
  sql += " ORDER BY CASE severity WHEN 'critical' THEN 5 WHEN 'error' THEN 4 WHEN 'warning' THEN 3 ELSE 1 END DESC, updated_at DESC";
  return db.prepare(sql).all(...params).map((row) => ({
    ...row,
    sources: parseJson(row.sources_json, []),
    requirementIds: parseJson(row.requirement_ids_json, []),
    targetPaths: parseJson(row.target_paths_json, [])
  }));
}

export function setFindingStatus(db, projectRoot, runId, id, status, note = null) {
  const finding = getFinding(db, id);
  invariant(finding.run_id === runId, "FINDING_RUN_MISMATCH", "Finding does not belong to this run.");
  invariant(FINDING_STATUSES.has(status), "FINDING_STATUS", `Unsupported finding status: ${status}.`);
  let sources = finding.sources;
  if (status === "valid") {
    sources = finding.sources.map((source) => normalizeEvidenceRef(db, projectRoot, source));
    const invalid = sources.filter((source) => !evidenceRefIsCurrent(db, projectRoot, source)).map(evidenceSummary);
    invariant(invalid.length === 0, "FINDING_SOURCE_MISSING", `Cannot revalidate finding ${id}; sources are invalid: ${invalid.join(", ")}`);
  }
  db.prepare("UPDATE findings SET status = ?, sources_json = ?, updated_at = ? WHERE run_id = ? AND id = ?")
    .run(status, json(sources), now(), runId, id);
  if (["stale", "superseded", "resolved"].includes(status)) {
    db.prepare("UPDATE trace_links SET status = 'stale', updated_at = ? WHERE run_id = ? AND target_type = 'finding' AND target_id = ?")
      .run(now(), runId, id);
  }
  touchRun(db, runId);
  recordEvent(db, runId, "finding.status", "info", { id, status, note });
  return getFinding(db, id);
}

export function addDecision(db, runId, input) {
  const run = getRun(db, runId);
  const title = String(input.title ?? input.Title ?? "").trim();
  const decision = String(input.decision ?? input.Decision ?? "").trim();
  const rationale = String(input.rationale ?? input.Rationale ?? "").trim();
  invariant(title && decision && rationale, "DECISION_FIELDS_REQUIRED", "A decision needs title, decision, and rationale.");
  const status = String(input.status ?? input.Status ?? "active").toLowerCase();
  invariant(DECISION_STATUSES.has(status), "DECISION_STATUS", `Unsupported decision status: ${status}.`);
  const evidenceRefs = normalizeEvidenceRefs(db, run.project_root, input.evidenceRefs ?? input.EvidenceRefs ?? []);
  const watchRefs = normalizeEvidenceRefs(db, run.project_root, input.watchRefs ?? input.WatchRefs ?? evidenceRefs);
  if (status === "active") {
    const invalid = [...evidenceRefs, ...watchRefs].filter((ref) => !evidenceRefIsCurrent(db, run.project_root, ref));
    invariant(invalid.length === 0, "DECISION_EVIDENCE_INVALID", `Decision evidence is not current: ${invalid.map(evidenceSummary).join(", ")}`);
  }
  const ids = requirementIds(db, run.id, input.requirementIds ?? input.RequirementIds ?? []);
  const id = input.id ?? makeId("dec");
  const timestamp = now();
  if (["execute", "review", "verify"].includes(run.phase)) {
    db.prepare("UPDATE artifacts SET status = 'stale', updated_at = ? WHERE run_id = ? AND kind IN ('plan', 'plan-review') AND status = 'verified'")
      .run(timestamp, run.id);
  }
  db.prepare(`
    INSERT INTO decisions(
      id, run_id, title, decision, rationale, status,
      evidence_refs_json, watch_refs_json, requirement_ids_json,
      affects_json, review_after, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, run.id, title, decision, rationale, status, json(evidenceRefs), json(watchRefs),
    json(ids), json(asArray(input.affects ?? input.Affects)), input.reviewAfter ?? input.ReviewAfter ?? null,
    timestamp, timestamp
  );
  addTraceLinks(db, run.id, ids, "decision", id, "designed-by", evidenceRefs);
  touchRun(db, run.id);
  recordEvent(db, run.id, "decision.added", "info", { id, title, requirementIds: ids, affects: asArray(input.affects ?? input.Affects) });
  return getDecision(db, id);
}

export function getDecision(db, id) {
  const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(id);
  invariant(row, "DECISION_NOT_FOUND", `Decision ${id} was not found.`);
  return {
    ...row,
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    watchRefs: parseJson(row.watch_refs_json, []),
    requirementIds: parseJson(row.requirement_ids_json, []),
    affects: parseJson(row.affects_json, [])
  };
}

export function setDecisionStatus(db, runId, id, status, note = null) {
  const decision = getDecision(db, id);
  const run = getRun(db, runId);
  invariant(decision.run_id === run.id, "DECISION_RUN_MISMATCH", "Decision does not belong to this run.");
  invariant(DECISION_STATUSES.has(status), "DECISION_STATUS", `Unsupported decision status: ${status}.`);
  if (status === "active") {
    const invalid = [...decision.evidenceRefs, ...decision.watchRefs].filter((ref) => !evidenceRefIsCurrent(db, run.project_root, ref));
    invariant(invalid.length === 0, "DECISION_EVIDENCE_STALE", `Decision ${id} still depends on invalid evidence: ${invalid.map(evidenceSummary).join(", ")}`);
  }
  db.prepare("UPDATE decisions SET status = ?, updated_at = ? WHERE run_id = ? AND id = ?")
    .run(status, now(), run.id, id);
  db.prepare("UPDATE trace_links SET status = ?, updated_at = ? WHERE run_id = ? AND target_type = 'decision' AND target_id = ?")
    .run(status === "active" ? "current" : "stale", now(), run.id, id);
  touchRun(db, run.id);
  recordEvent(db, run.id, "decision.status", "info", { id, status, note });
  return getDecision(db, id);
}

export function listDecisions(db, runId, status = "active") {
  const rows = status
    ? db.prepare("SELECT * FROM decisions WHERE run_id = ? AND status = ? ORDER BY created_at").all(runId, status)
    : db.prepare("SELECT * FROM decisions WHERE run_id = ? ORDER BY created_at").all(runId);
  return rows.map((row) => ({
    ...row,
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    watchRefs: parseJson(row.watch_refs_json, []),
    requirementIds: parseJson(row.requirement_ids_json, []),
    affects: parseJson(row.affects_json, [])
  }));
}
