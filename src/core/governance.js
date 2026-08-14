import { invariant } from "./errors.js";
import { normalizeEvidenceRefs } from "./provenance.js";
import { getRun, recordEvent, touchRun } from "./state.js";
import { asArray, json, makeId, now, parseJson } from "./util.js";

const SEVERITIES = new Set(["info", "warning", "error", "critical"]);
const IMPACTS = new Set(["low", "medium", "high", "critical"]);
const ASSUMPTION_STATUSES = new Set(["open", "validated", "rejected", "superseded"]);
const INVARIANT_STATUSES = new Set(["active", "verified", "violated", "superseded"]);
const RISK_STATUSES = new Set(["open", "mitigated", "accepted", "resolved", "rejected"]);
const LIKELIHOODS = new Set(["unlikely", "possible", "likely", "almost-certain"]);

function requirementIds(db, runId, values) {
  const ids = [...new Set(asArray(values).map((item) => String(item).trim()).filter(Boolean))];
  for (const id of ids) {
    invariant(db.prepare("SELECT 1 FROM requirements WHERE run_id = ? AND id = ?").get(runId, id), "GOVERNANCE_REQUIREMENT", `Requirement ${id} was not found.`);
  }
  return ids;
}

export function addAssumption(db, projectRoot, runId, input) {
  const run = getRun(db, runId);
  const statement = String(input.statement ?? input.claim ?? "").trim();
  const confidence = Number(input.confidence ?? 0.5);
  const impact = String(input.impact ?? "medium").toLowerCase();
  const severity = String(input.severity ?? (impact === "critical" ? "critical" : impact === "high" ? "error" : "warning")).toLowerCase();
  const status = String(input.status ?? "open").toLowerCase();
  invariant(statement, "ASSUMPTION_STATEMENT", "An assumption needs a statement.");
  invariant(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1, "ASSUMPTION_CONFIDENCE", "Assumption confidence must be between 0 and 1.");
  invariant(IMPACTS.has(impact), "ASSUMPTION_IMPACT", `Unsupported assumption impact: ${impact}.`);
  invariant(SEVERITIES.has(severity), "ASSUMPTION_SEVERITY", `Unsupported assumption severity: ${severity}.`);
  invariant(ASSUMPTION_STATUSES.has(status), "ASSUMPTION_STATUS", `Unsupported assumption status: ${status}.`);
  const evidenceRefs = normalizeEvidenceRefs(db, projectRoot, input.evidenceRefs ?? []);
  const id = input.id ?? makeId("asm");
  const timestamp = now();
  db.prepare(`
    INSERT INTO assumptions(
      id, run_id, statement, confidence, impact, severity, status,
      evidence_refs_json, validation_task_id, disposition, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    run.id,
    statement,
    confidence,
    impact,
    severity,
    status,
    json(evidenceRefs),
    input.validationTaskId ?? null,
    input.disposition ?? null,
    timestamp,
    timestamp
  );
  touchRun(db, run.id);
  recordEvent(db, run.id, "assumption.created", "info", { assumptionId: id, impact, confidence });
  return getAssumption(db, id);
}

export function getAssumption(db, id) {
  const row = db.prepare("SELECT * FROM assumptions WHERE id = ?").get(id);
  invariant(row, "ASSUMPTION_NOT_FOUND", `Assumption ${id} was not found.`);
  return { ...row, evidenceRefs: parseJson(row.evidence_refs_json, []) };
}

export function listAssumptions(db, runId, status = null) {
  const rows = status
    ? db.prepare("SELECT * FROM assumptions WHERE run_id = ? AND status = ? ORDER BY impact DESC, created_at").all(runId, status)
    : db.prepare("SELECT * FROM assumptions WHERE run_id = ? ORDER BY status, impact DESC, created_at").all(runId);
  return rows.map((row) => ({ ...row, evidenceRefs: parseJson(row.evidence_refs_json, []) }));
}

export function setAssumptionStatus(db, projectRoot, runId, id, status, input = {}) {
  invariant(ASSUMPTION_STATUSES.has(status), "ASSUMPTION_STATUS", `Unsupported assumption status: ${status}.`);
  const item = getAssumption(db, id);
  invariant(item.run_id === runId, "ASSUMPTION_RUN", "Assumption does not belong to this run.");
  const refs = normalizeEvidenceRefs(db, projectRoot, input.evidenceRefs ?? item.evidenceRefs);
  if (status === "validated") invariant(refs.length > 0, "ASSUMPTION_EVIDENCE", "A validated assumption needs evidence.");
  db.prepare(`
    UPDATE assumptions SET status = ?, evidence_refs_json = ?, disposition = ?, updated_at = ?
    WHERE id = ?
  `).run(status, json(refs), input.disposition ?? item.disposition, now(), id);
  touchRun(db, runId);
  recordEvent(db, runId, "assumption.status", "info", { assumptionId: id, status });
  return getAssumption(db, id);
}

export function addInvariant(db, projectRoot, runId, input) {
  const run = getRun(db, runId);
  const title = String(input.title ?? "").trim();
  const description = String(input.description ?? title).trim();
  const severity = String(input.severity ?? "error").toLowerCase();
  const status = String(input.status ?? "active").toLowerCase();
  invariant(title && description, "INVARIANT_FIELDS", "An invariant needs a title and description.");
  invariant(SEVERITIES.has(severity), "INVARIANT_SEVERITY", `Unsupported invariant severity: ${severity}.`);
  invariant(INVARIANT_STATUSES.has(status), "INVARIANT_STATUS", `Unsupported invariant status: ${status}.`);
  const evidenceRefs = normalizeEvidenceRefs(db, projectRoot, input.evidenceRefs ?? []);
  const verificationRefs = normalizeEvidenceRefs(db, projectRoot, input.verificationRefs ?? []);
  const requirements = requirementIds(db, run.id, input.requirementIds ?? []);
  const id = input.id ?? makeId("inv");
  const timestamp = now();
  db.prepare(`
    INSERT INTO invariants(
      id, run_id, title, description, severity, status,
      evidence_refs_json, verification_refs_json, requirement_ids_json,
      created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, run.id, title, description, severity, status, json(evidenceRefs), json(verificationRefs), json(requirements), timestamp, timestamp);
  touchRun(db, run.id);
  recordEvent(db, run.id, "invariant.created", "info", { invariantId: id, severity });
  return getInvariant(db, id);
}

export function getInvariant(db, id) {
  const row = db.prepare("SELECT * FROM invariants WHERE id = ?").get(id);
  invariant(row, "INVARIANT_NOT_FOUND", `Invariant ${id} was not found.`);
  return {
    ...row,
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    verificationRefs: parseJson(row.verification_refs_json, []),
    requirementIds: parseJson(row.requirement_ids_json, [])
  };
}

export function listInvariants(db, runId, status = null) {
  const rows = status
    ? db.prepare("SELECT * FROM invariants WHERE run_id = ? AND status = ? ORDER BY severity DESC, created_at").all(runId, status)
    : db.prepare("SELECT * FROM invariants WHERE run_id = ? ORDER BY status, severity DESC, created_at").all(runId);
  return rows.map((row) => getInvariant(db, row.id));
}

export function setInvariantStatus(db, projectRoot, runId, id, status, input = {}) {
  invariant(INVARIANT_STATUSES.has(status), "INVARIANT_STATUS", `Unsupported invariant status: ${status}.`);
  const item = getInvariant(db, id);
  invariant(item.run_id === runId, "INVARIANT_RUN", "Invariant does not belong to this run.");
  const refs = normalizeEvidenceRefs(db, projectRoot, input.verificationRefs ?? item.verificationRefs);
  if (status === "verified") invariant(refs.length > 0, "INVARIANT_VERIFICATION", "A verified invariant needs verification evidence.");
  db.prepare(`
    UPDATE invariants SET status = ?, verification_refs_json = ?, updated_at = ? WHERE id = ?
  `).run(status, json(refs), now(), id);
  touchRun(db, runId);
  recordEvent(db, runId, "invariant.status", status === "violated" ? "error" : "info", { invariantId: id, status });
  return getInvariant(db, id);
}

export function addRisk(db, projectRoot, runId, input) {
  const run = getRun(db, runId);
  const title = String(input.title ?? input.description ?? "").trim();
  const description = String(input.description ?? title).trim();
  const severity = String(input.severity ?? "warning").toLowerCase();
  const likelihood = String(input.likelihood ?? "possible").toLowerCase();
  const status = String(input.status ?? "open").toLowerCase();
  invariant(title && description, "RISK_FIELDS", "A risk needs a title and description.");
  invariant(SEVERITIES.has(severity), "RISK_SEVERITY", `Unsupported risk severity: ${severity}.`);
  invariant(LIKELIHOODS.has(likelihood), "RISK_LIKELIHOOD", `Unsupported risk likelihood: ${likelihood}.`);
  invariant(RISK_STATUSES.has(status), "RISK_STATUS", `Unsupported risk status: ${status}.`);
  const evidenceRefs = normalizeEvidenceRefs(db, projectRoot, input.evidenceRefs ?? []);
  const verificationRefs = normalizeEvidenceRefs(db, projectRoot, input.verificationRefs ?? []);
  const requirements = requirementIds(db, run.id, input.requirementIds ?? []);
  const id = input.id ?? makeId("risk");
  const timestamp = now();
  db.prepare(`
    INSERT INTO risks(
      id, run_id, title, description, severity, likelihood, status,
      mitigation, disposition, owner, evidence_refs_json, verification_refs_json,
      requirement_ids_json, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    run.id,
    title,
    description,
    severity,
    likelihood,
    status,
    input.mitigation ?? null,
    input.disposition ?? null,
    input.owner ?? null,
    json(evidenceRefs),
    json(verificationRefs),
    json(requirements),
    timestamp,
    timestamp
  );
  touchRun(db, run.id);
  recordEvent(db, run.id, "risk.created", severity === "critical" ? "error" : "warning", { riskId: id, severity, likelihood });
  return getRisk(db, id);
}

export function getRisk(db, id) {
  const row = db.prepare("SELECT * FROM risks WHERE id = ?").get(id);
  invariant(row, "RISK_NOT_FOUND", `Risk ${id} was not found.`);
  return {
    ...row,
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    verificationRefs: parseJson(row.verification_refs_json, []),
    requirementIds: parseJson(row.requirement_ids_json, [])
  };
}

export function listRisks(db, runId, status = null) {
  const rows = status
    ? db.prepare("SELECT * FROM risks WHERE run_id = ? AND status = ? ORDER BY severity DESC, created_at").all(runId, status)
    : db.prepare("SELECT * FROM risks WHERE run_id = ? ORDER BY status, severity DESC, created_at").all(runId);
  return rows.map((row) => getRisk(db, row.id));
}

export function setRiskStatus(db, projectRoot, runId, id, status, input = {}) {
  invariant(RISK_STATUSES.has(status), "RISK_STATUS", `Unsupported risk status: ${status}.`);
  const item = getRisk(db, id);
  invariant(item.run_id === runId, "RISK_RUN", "Risk does not belong to this run.");
  const verificationRefs = normalizeEvidenceRefs(db, projectRoot, input.verificationRefs ?? item.verificationRefs);
  if (["mitigated", "resolved"].includes(status)) {
    invariant(String(input.mitigation ?? item.mitigation ?? "").trim(), "RISK_MITIGATION", `${status} risk needs a mitigation.`);
    invariant(verificationRefs.length > 0, "RISK_VERIFICATION", `${status} risk needs verification evidence.`);
  }
  if (status === "accepted") invariant(String(input.disposition ?? item.disposition ?? "").trim(), "RISK_DISPOSITION", "Accepted risk needs a disposition.");
  db.prepare(`
    UPDATE risks SET status = ?, mitigation = ?, disposition = ?, owner = ?,
      verification_refs_json = ?, updated_at = ? WHERE id = ?
  `).run(
    status,
    input.mitigation ?? item.mitigation,
    input.disposition ?? item.disposition,
    input.owner ?? item.owner,
    json(verificationRefs),
    now(),
    id
  );
  touchRun(db, runId);
  recordEvent(db, runId, "risk.status", "info", { riskId: id, status });
  return getRisk(db, id);
}

export function governanceReport(db, runId, config) {
  const assumptions = listAssumptions(db, runId);
  const invariants = listInvariants(db, runId);
  const risks = listRisks(db, runId);
  const blockingAssumptions = assumptions.filter((item) => item.status === "open" && ["high", "critical"].includes(item.impact));
  const violatedInvariants = invariants.filter((item) => item.status === "violated");
  const unverifiedCriticalInvariants = invariants.filter((item) => ["error", "critical"].includes(item.severity) && item.status === "active");
  const openCriticalRisks = risks.filter((item) => item.status === "open" && item.severity === "critical");
  return {
    assumptions,
    invariants,
    risks,
    blockers: {
      assumptions: blockingAssumptions,
      violatedInvariants,
      unverifiedCriticalInvariants,
      risks: openCriticalRisks
    },
    passForExecution: blockingAssumptions.length <= Number(config.orchestration.maxOpenHighImpactAssumptions ?? 0)
      && violatedInvariants.length === 0,
    passForCompletion: blockingAssumptions.length === 0
      && violatedInvariants.length === 0
      && unverifiedCriticalInvariants.length === 0
      && openCriticalRisks.length <= Number(config.orchestration.maxOpenCriticalRisks ?? 0)
  };
}
