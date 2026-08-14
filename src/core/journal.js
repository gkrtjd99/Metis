import { invariant } from "./errors.js";
import { json, makeId, now, parseJson, redactValue, sha256, stableStringify } from "./util.js";

function projectedState(db, runId) {
  if (!runId) return null;
  const run = db.prepare("SELECT id, phase, status, revision, contract_version, stalled_count FROM runs WHERE id = ?").get(runId);
  if (!run) return null;
  const taskCounts = db.prepare(`
    SELECT status, COUNT(*) AS count FROM tasks WHERE run_id = ? GROUP BY status ORDER BY status
  `).all(runId);
  const requirementCounts = db.prepare(`
    SELECT status, COUNT(*) AS count FROM requirements WHERE run_id = ? GROUP BY status ORDER BY status
  `).all(runId);
  const riskCounts = db.prepare(`
    SELECT status, COUNT(*) AS count FROM risks WHERE run_id = ? GROUP BY status ORDER BY status
  `).all(runId);
  return {
    run,
    tasks: Object.fromEntries(taskCounts.map((item) => [item.status, Number(item.count)])),
    requirements: Object.fromEntries(requirementCounts.map((item) => [item.status, Number(item.count)])),
    risks: Object.fromEntries(riskCounts.map((item) => [item.status, Number(item.count)]))
  };
}

export function appendJournal(db, runId, eventType, payload = {}, options = {}) {
  const timestamp = now();
  const state = projectedState(db, runId);
  const stateHash = state ? sha256(stableStringify(state)) : null;
  const id = options.id ?? makeId("jrn");
  const safePayload = redactValue(payload);
  db.prepare(`
    INSERT INTO journal(
      id, run_id, actor, event_type, entity_type, entity_id,
      causation_id, payload_json, state_hash, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    runId ?? null,
    options.actor ?? "runtime",
    eventType,
    options.entityType ?? null,
    options.entityId ?? null,
    options.causationId ?? null,
    json(safePayload),
    stateHash,
    timestamp
  );
  return db.prepare("SELECT * FROM journal WHERE id = ?").get(id);
}

export function listJournal(db, runId, options = {}) {
  const limit = Math.max(1, Math.min(10000, Number(options.limit ?? 500)));
  const after = Number(options.after ?? 0);
  const rows = db.prepare(`
    SELECT * FROM journal
    WHERE run_id = ? AND sequence > ?
    ORDER BY sequence ASC
    LIMIT ?
  `).all(runId, after, limit);
  return rows.map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) }));
}

function applyProjection(projection, entry) {
  const payload = entry.payload;
  projection.sequence = entry.sequence;
  projection.lastStateHash = entry.state_hash;
  projection.timeline.push({
    sequence: entry.sequence,
    event: entry.event_type,
    entityType: entry.entity_type,
    entityId: entry.entity_id,
    payload,
    createdAt: entry.created_at
  });
  if (entry.event_type === "run.started") {
    projection.run.status = "active";
    projection.run.phase = payload.phase ?? "intake";
  }
  if (entry.event_type === "phase.changed" || entry.event_type === "phase.reopened") {
    projection.run.phase = payload.to;
  }
  if (entry.event_type === "run.blocked") projection.run.status = "blocked";
  if (entry.event_type === "run.resumed") projection.run.status = "active";
  if (entry.event_type === "run.completed") projection.run.status = "completed";
  if (entry.event_type === "task.created") projection.tasks[payload.taskId] = "pending";
  if (entry.event_type === "task.claimed") projection.tasks[payload.taskId] = "running";
  if (entry.event_type === "task.finished") projection.tasks[payload.taskId] = payload.status;
  if (entry.event_type === "task.waived") projection.tasks[payload.taskId] = "waived";
  if (entry.event_type === "requirement.status") projection.requirements[payload.requirementId] = payload.status;
  if (entry.event_type === "risk.status") projection.risks[payload.riskId] = payload.status;
  return projection;
}

export function replayJournal(db, runId, options = {}) {
  invariant(runId, "JOURNAL_RUN_REQUIRED", "Journal replay needs a run ID.");
  const entries = listJournal(db, runId, { limit: options.limit ?? 10000, after: 0 });
  const projection = entries.reduce(applyProjection, {
    runId,
    run: { phase: null, status: null },
    tasks: {},
    requirements: {},
    risks: {},
    sequence: 0,
    lastStateHash: null,
    timeline: []
  });
  const current = projectedState(db, runId);
  const currentHash = current ? sha256(stableStringify(current)) : null;
  return {
    ...projection,
    entryCount: entries.length,
    currentState: current,
    currentStateHash: currentHash,
    journalStateHash: projection.lastStateHash,
    stateHashMatches: projection.lastStateHash === currentHash
  };
}
