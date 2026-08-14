import { CHECKPOINT_KINDS } from "./metadata.js";
import { invariant } from "./errors.js";
import { repositoryCodeFingerprint } from "./repository.js";
import { getRun, recordEvent, touchRun } from "./state.js";
import { asArray, json, makeId, now, parseJson } from "./util.js";

const CHECKPOINT_STATUSES = new Set(["pending", "resolved", "rejected", "waived"]);

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    blocking: Boolean(row.blocking),
    requiredEvidence: parseJson(row.required_evidence_json, [])
  };
}

export function addCheckpoint(db, runId, input) {
  const run = getRun(db, runId);
  const kind = String(input.kind ?? "").trim();
  invariant(CHECKPOINT_KINDS.includes(kind), "CHECKPOINT_KIND", `Unsupported checkpoint kind: ${kind}.`);
  const reason = String(input.reason ?? "").trim();
  invariant(reason, "CHECKPOINT_REASON", "A checkpoint needs a reason.");
  const milestoneId = input.milestoneId ?? null;
  if (milestoneId) {
    invariant(db.prepare("SELECT 1 FROM milestones WHERE id = ? AND run_id = ?").get(milestoneId, run.id), "CHECKPOINT_MILESTONE", `Milestone ${milestoneId} was not found.`);
  }
  const requiredEvidence = [...new Set(asArray(input.requiredEvidence).map((item) => String(item).trim()).filter(Boolean))];
  const id = input.id ?? makeId("checkpoint");
  const timestamp = now();
  db.prepare(`
    INSERT INTO checkpoints(
      id, run_id, milestone_id, kind, reason, blocking, status,
      required_evidence_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, run.id, milestoneId, kind, reason, input.blocking === false ? 0 : 1, json(requiredEvidence), timestamp);
  touchRun(db, run.id);
  recordEvent(db, run.id, "checkpoint.added", "info", { id, kind, reason, milestoneId, blocking: input.blocking !== false, requiredEvidence });
  return getCheckpoint(db, id);
}

export function getCheckpoint(db, id) {
  const row = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id);
  invariant(row, "CHECKPOINT_NOT_FOUND", `Checkpoint ${id} was not found.`);
  return hydrate(row);
}

export function listCheckpoints(db, runId, options = {}) {
  let sql = "SELECT * FROM checkpoints WHERE run_id = ?";
  const params = [runId];
  if (options.status) {
    invariant(CHECKPOINT_STATUSES.has(options.status), "CHECKPOINT_STATUS", `Unsupported checkpoint status: ${options.status}.`);
    sql += " AND status = ?";
    params.push(options.status);
  }
  if (options.kind) {
    invariant(CHECKPOINT_KINDS.includes(options.kind), "CHECKPOINT_KIND", `Unsupported checkpoint kind: ${options.kind}.`);
    sql += " AND kind = ?";
    params.push(options.kind);
  }
  sql += " ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at, id";
  return db.prepare(sql).all(...params).map(hydrate);
}

function evidencePresent(db, runId, reference) {
  const value = String(reference);
  const codeFingerprint = repositoryCodeFingerprint(db);
  if (value.startsWith("browser-scenario:")) {
    const name = value.slice("browser-scenario:".length);
    return Boolean(db.prepare(`
      SELECT 1 FROM browser_scenarios s
      JOIN browser_evidence e ON e.scenario_id = s.id
      WHERE s.run_id = ? AND s.name = ? AND e.status = 'passed'
        AND e.code_fingerprint = ?
      ORDER BY e.created_at DESC LIMIT 1
    `).get(runId, name, codeFingerprint));
  }
  if (value.startsWith("typed:")) {
    const [, type, subjectId] = value.split(":");
    return Boolean(db.prepare(`
      SELECT 1 FROM typed_evidence
      WHERE run_id = ? AND type = ? AND subject_id = ? AND status = 'current'
        AND (code_fingerprint IS NULL OR code_fingerprint = ?)
    `).get(runId, type, subjectId, codeFingerprint));
  }
  if (value.startsWith("artifact:")) {
    const artifactId = value.slice("artifact:".length);
    return Boolean(db.prepare("SELECT 1 FROM artifacts WHERE run_id = ? AND id = ? AND status = 'verified'").get(runId, artifactId));
  }
  return false;
}

export function resolveCheckpoint(db, runId, id, input = {}) {
  const checkpoint = getCheckpoint(db, id);
  invariant(checkpoint.run_id === runId, "CHECKPOINT_RUN_MISMATCH", "Checkpoint does not belong to this run.");
  invariant(checkpoint.status === "pending", "CHECKPOINT_TERMINAL", `Checkpoint ${id} is already ${checkpoint.status}.`);
  const status = String(input.status ?? "resolved").trim();
  invariant(["resolved", "rejected", "waived"].includes(status), "CHECKPOINT_STATUS", `Unsupported checkpoint resolution: ${status}.`);
  const resolution = String(input.resolution ?? "").trim();
  invariant(resolution, "CHECKPOINT_RESOLUTION", "A checkpoint resolution is required.");
  const resolvedBy = String(input.resolvedBy ?? "user").trim();
  if (status === "resolved") {
    const missing = checkpoint.requiredEvidence.filter((reference) => !evidencePresent(db, runId, reference));
    invariant(missing.length === 0, "CHECKPOINT_EVIDENCE_MISSING", `Checkpoint evidence is missing: ${missing.join(", ")}.`, { missing });
  }
  const timestamp = now();
  db.prepare(`
    UPDATE checkpoints
    SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?
    WHERE id = ? AND run_id = ? AND status = 'pending'
  `).run(status, resolution, resolvedBy, timestamp, id, runId);
  touchRun(db, runId);
  recordEvent(db, runId, "checkpoint.resolved", status === "rejected" ? "warning" : "info", { id, status, resolution, resolvedBy });
  return getCheckpoint(db, id);
}

export function checkpointStatus(db, runId) {
  const checkpoints = listCheckpoints(db, runId);
  const pending = checkpoints.filter((item) => item.status === "pending");
  const blocking = pending.filter((item) => item.blocking);
  return {
    runId,
    counts: Object.fromEntries([...CHECKPOINT_STATUSES].map((status) => [status, checkpoints.filter((item) => item.status === status).length])),
    pending,
    blocking,
    pass: blocking.length === 0
  };
}
