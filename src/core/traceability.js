import { invariant } from "./errors.js";
import { normalizeEvidenceRefs } from "./provenance.js";
import { getRun, lifecycleRoute, recordEvent, touchRun } from "./state.js";
import { json, makeId, now, parseJson } from "./util.js";

const TARGET_TYPES = new Set([
  "design", "decision", "invariant", "task", "artifact", "finding", "check", "risk", "review-finding", "document"
]);
const RELATIONS = new Set([
  "designed-by", "constrained-by", "planned-by", "implemented-by", "verified-by", "risked-by", "reviewed-by", "documented-by"
]);

function targetExists(db, runId, type, id) {
  const table = {
    decision: "decisions",
    invariant: "invariants",
    task: "tasks",
    artifact: "artifacts",
    finding: "findings",
    check: "checks",
    risk: "risks",
    "review-finding": "review_findings",
    document: "document_impacts"
  }[type];
  if (type === "design") {
    return Boolean(db.prepare("SELECT 1 FROM artifacts WHERE run_id = ? AND id = ? AND kind IN ('design','design-seal')").get(runId, id));
  }
  if (!table) return false;
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE run_id = ? AND id = ?`).get(runId, id));
}

export function linkRequirement(db, projectRoot, runId, input) {
  const run = getRun(db, runId);
  const requirementId = String(input.requirementId ?? "").trim();
  const targetType = String(input.targetType ?? "").trim().toLowerCase();
  const targetId = String(input.targetId ?? "").trim();
  const relation = String(input.relation ?? "").trim().toLowerCase();
  invariant(db.prepare("SELECT 1 FROM requirements WHERE id = ? AND run_id = ?").get(requirementId, run.id), "TRACE_REQUIREMENT", `Requirement ${requirementId} was not found.`);
  invariant(TARGET_TYPES.has(targetType), "TRACE_TARGET_TYPE", `Unsupported trace target type: ${targetType}.`);
  invariant(RELATIONS.has(relation), "TRACE_RELATION", `Unsupported trace relation: ${relation}.`);
  invariant(targetId && targetExists(db, run.id, targetType, targetId), "TRACE_TARGET", `${targetType} target ${targetId} was not found.`);
  const evidenceRefs = normalizeEvidenceRefs(db, projectRoot, input.evidenceRefs ?? []);
  const timestamp = now();
  const id = input.id ?? makeId("trace");
  db.prepare(`
    INSERT INTO trace_links(
      id, run_id, requirement_id, target_type, target_id, relation,
      status, evidence_refs_json, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, 'current', ?, ?, ?)
    ON CONFLICT(run_id, requirement_id, target_type, target_id, relation) DO UPDATE SET
      status = 'current', evidence_refs_json = excluded.evidence_refs_json,
      updated_at = excluded.updated_at
  `).run(id, run.id, requirementId, targetType, targetId, relation, json(evidenceRefs), timestamp, timestamp);
  touchRun(db, run.id);
  recordEvent(db, run.id, "trace.linked", "info", { requirementId, targetType, targetId, relation });
  return db.prepare(`
    SELECT * FROM trace_links
    WHERE run_id = ? AND requirement_id = ? AND target_type = ? AND target_id = ? AND relation = ?
  `).get(run.id, requirementId, targetType, targetId, relation);
}

export function listTraceLinks(db, runId, requirementId = null) {
  const rows = requirementId
    ? db.prepare("SELECT * FROM trace_links WHERE run_id = ? AND requirement_id = ? ORDER BY relation, target_type, target_id").all(runId, requirementId)
    : db.prepare("SELECT * FROM trace_links WHERE run_id = ? ORDER BY requirement_id, relation, target_type, target_id").all(runId);
  return rows.map((row) => ({ ...row, evidenceRefs: parseJson(row.evidence_refs_json, []) }));
}

function taskRequirementMap(db, runId) {
  const map = new Map();
  for (const task of db.prepare("SELECT * FROM tasks WHERE run_id = ?").all(runId)) {
    for (const id of parseJson(task.requirement_ids_json, [])) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(task);
    }
  }
  return map;
}

function checkRequirementMap(db, runId) {
  const map = new Map();
  for (const check of db.prepare("SELECT * FROM checks WHERE run_id = ?").all(runId)) {
    for (const id of parseJson(check.requirement_ids_json, [])) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(check);
    }
  }
  return map;
}

function linksFor(links, relation) {
  return links.filter((item) => item.relation === relation && item.status === "current");
}

export function traceabilityReport(db, runId, options = {}) {
  const run = getRun(db, runId);
  const requirements = db.prepare("SELECT * FROM requirements WHERE run_id = ? AND status <> 'superseded' ORDER BY id").all(run.id);
  const allLinks = listTraceLinks(db, run.id);
  const tasksByRequirement = taskRequirementMap(db, run.id);
  const checksByRequirement = checkRequirementMap(db, run.id);
  const route = lifecycleRoute(parseJson(run.route_json, {}));
  const rows = requirements.map((requirement) => {
    const links = allLinks.filter((item) => item.requirement_id === requirement.id);
    const tasks = tasksByRequirement.get(requirement.id) ?? [];
    const checks = checksByRequirement.get(requirement.id) ?? [];
    const designLinks = [
      ...linksFor(links, "designed-by"),
      ...linksFor(links, "constrained-by")
    ];
    const planLinks = linksFor(links, "planned-by");
    const implementationLinks = linksFor(links, "implemented-by");
    const verificationLinks = linksFor(links, "verified-by");
    const planned = planLinks.length > 0 || tasks.length > 0;
    const implementedTasks = tasks.filter((task) => task.status === "completed" && ["worker", "integrator", "curator"].includes(task.role));
    const implemented = implementedTasks.length > 0 || implementationLinks.length > 0;
    const passedChecks = checks.filter((check) => check.status === "passed");
    const verified = passedChecks.length > 0 || verificationLinks.length > 0;
    const designed = route.designRequired === false || designLinks.length > 0;
    const gaps = [];
    if (!designed) gaps.push("design");
    if (!planned) gaps.push("plan");
    if (!implemented) gaps.push("implementation");
    if (!verified) gaps.push("verification");
    return {
      id: requirement.id,
      title: requirement.title,
      priority: requirement.priority,
      storedStatus: requirement.status,
      designed,
      planned,
      implemented,
      verified,
      gaps,
      tasks: tasks.map((task) => ({ id: task.id, status: task.status, role: task.role })),
      checks: checks.map((check) => ({ id: check.id, name: check.name, status: check.status })),
      links
    };
  });
  if (options.refreshStatuses) {
    const timestamp = now();
    for (const item of rows) {
      const next = item.verified ? "verified" : item.implemented ? "implemented" : "active";
      if (item.storedStatus !== "waived" && item.storedStatus !== next) {
        db.prepare("UPDATE requirements SET status = ?, updated_at = ? WHERE run_id = ? AND id = ?").run(next, timestamp, run.id, item.id);
        recordEvent(db, run.id, "requirement.status", "info", { requirementId: item.id, status: next });
      }
    }
  }
  const must = rows.filter((item) => item.priority === "must");
  const uncovered = must.filter((item) => item.gaps.length > 0);
  return {
    runId: run.id,
    requirements: rows,
    summary: {
      total: rows.length,
      must: must.length,
      designed: rows.filter((item) => item.designed).length,
      planned: rows.filter((item) => item.planned).length,
      implemented: rows.filter((item) => item.implemented).length,
      verified: rows.filter((item) => item.verified).length,
      uncoveredMust: uncovered.map((item) => ({ id: item.id, gaps: item.gaps }))
    },
    pass: uncovered.length === 0
  };
}

export function assertTraceability(db, runId) {
  const report = traceabilityReport(db, runId, { refreshStatuses: true });
  invariant(report.pass, "TRACEABILITY_GAPS", "Required goal requirements are not fully traced to verified outcomes.", report);
  return report;
}
