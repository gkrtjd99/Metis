import { invariant } from "./errors.js";
import { normalizeEvidenceRefs } from "./provenance.js";
import { getRun, recordEvent, touchRun } from "./state.js";
import { asArray, isSafeRepoPath, json, makeId, now, parseJson } from "./util.js";

function validateRequirements(db, runId, values) {
  const ids = [...new Set(asArray(values).map((item) => String(item).trim()).filter(Boolean))];
  for (const id of ids) invariant(db.prepare("SELECT 1 FROM requirements WHERE run_id = ? AND id = ?").get(runId, id), "DOC_REQUIREMENT", `Requirement ${id} was not found.`);
  return ids;
}

export function addDocumentImpact(db, runId, path, reason, evidenceRefs = [], requirementIds = []) {
  const run = getRun(db, runId);
  invariant(path?.trim() && reason?.trim(), "DOC_IMPACT_FIELDS", "Document impact needs path and reason.");
  invariant(path === "<documentation-review>" || isSafeRepoPath(path), "DOC_IMPACT_PATH", `Unsafe document path: ${path}.`);
  const refs = normalizeEvidenceRefs(db, run.project_root, evidenceRefs);
  const requirements = validateRequirements(db, run.id, requirementIds);
  const id = makeId("doc");
  const timestamp = now();
  db.prepare(`
    INSERT INTO document_impacts(
      id, run_id, path, reason, status, evidence_refs_json, requirement_ids_json, created_at, updated_at
    ) VALUES(?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    ON CONFLICT(run_id, path, reason) DO UPDATE SET
      status = 'pending', disposition = NULL,
      evidence_refs_json = excluded.evidence_refs_json,
      requirement_ids_json = excluded.requirement_ids_json,
      updated_at = excluded.updated_at
  `).run(id, run.id, path.trim(), reason.trim(), json(refs), json(requirements), timestamp, timestamp);
  touchRun(db, run.id);
  recordEvent(db, run.id, "docs.impact", "info", { path, reason, requirementIds: requirements });
  return listDocumentImpacts(db, run.id).find((item) => item.path === path && item.reason === reason);
}

export function listDocumentImpacts(db, runId, status = null) {
  const rows = status
    ? db.prepare("SELECT * FROM document_impacts WHERE run_id = ? AND status = ? ORDER BY path, reason").all(runId, status)
    : db.prepare("SELECT * FROM document_impacts WHERE run_id = ? ORDER BY status, path, reason").all(runId);
  return rows.map((row) => ({
    ...row,
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    requirementIds: parseJson(row.requirement_ids_json, [])
  }));
}

export function resolveDocumentImpact(db, runId, selector, disposition = "updated", evidenceRefs = []) {
  const run = getRun(db, runId);
  const rows = selector.id
    ? db.prepare("SELECT * FROM document_impacts WHERE id = ? AND run_id = ?").all(selector.id, run.id)
    : db.prepare("SELECT * FROM document_impacts WHERE path = ? AND run_id = ? AND status = 'pending'").all(selector.path, run.id);
  invariant(rows.length > 0, "DOC_IMPACT_NOT_FOUND", "No matching pending document impact exists.");
  const refs = normalizeEvidenceRefs(db, run.project_root, evidenceRefs);
  for (const row of rows) {
    const requirements = parseJson(row.requirement_ids_json, []);
    db.prepare("UPDATE document_impacts SET status = 'resolved', disposition = ?, evidence_refs_json = ?, updated_at = ? WHERE run_id = ? AND id = ?")
      .run(disposition, json(refs.length ? refs : parseJson(row.evidence_refs_json, [])), now(), run.id, row.id);
    for (const requirementId of requirements) {
      db.prepare(`
        INSERT INTO trace_links(
          id, run_id, requirement_id, target_type, target_id, relation,
          status, evidence_refs_json, created_at, updated_at
        ) VALUES(?, ?, ?, 'document', ?, 'documented-by', 'current', ?, ?, ?)
        ON CONFLICT(run_id, requirement_id, target_type, target_id, relation) DO UPDATE SET
          status = 'current', evidence_refs_json = excluded.evidence_refs_json, updated_at = excluded.updated_at
      `).run(makeId("trace"), run.id, requirementId, row.id, json(refs), now(), now());
    }
    recordEvent(db, run.id, "docs.resolved", "info", { id: row.id, path: row.path, disposition, requirementIds: requirements });
  }
  touchRun(db, run.id);
  return rows.map((row) => ({ ...row, status: "resolved", disposition }));
}
