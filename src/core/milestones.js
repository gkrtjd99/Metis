import { invariant } from "./errors.js";
import { getRun, recordEvent, touchRun } from "./state.js";
import { asArray, json, makeId, now, parseJson } from "./util.js";

const TERMINAL_TASKS = new Set(["completed", "waived"]);
const TERMINAL_MILESTONES = new Set(["completed", "waived"]);

function hydrate(db, row) {
  const dependsOn = db.prepare("SELECT depends_on FROM milestone_dependencies WHERE milestone_id = ? ORDER BY depends_on")
    .all(row.id).map((item) => item.depends_on);
  const tasks = db.prepare(`
    SELECT status, COUNT(*) AS count FROM tasks WHERE milestone_id = ? GROUP BY status
  `).all(row.id);
  return {
    ...row,
    acceptanceCriteria: parseJson(row.acceptance_json, []),
    entryCriteria: parseJson(row.entry_criteria_json, []),
    exitCriteria: parseJson(row.exit_criteria_json, []),
    userVisibleOutcome: row.user_visible_outcome,
    requirementIds: parseJson(row.requirement_ids_json, []),
    dependsOn,
    taskCounts: Object.fromEntries(tasks.map((item) => [item.status, Number(item.count)]))
  };
}

export function addMilestone(db, runId, input) {
  const run = getRun(db, runId);
  invariant(["intake", "discover", "research", "design", "plan"].includes(run.phase), "MILESTONE_PHASE", "Milestones must be defined before execution.");
  const title = String(input.title ?? input.Title ?? "").trim();
  const objective = String(input.objective ?? input.Objective ?? title).trim();
  invariant(title && objective, "MILESTONE_FIELDS", "A milestone needs title and objective.");
  const id = input.id ?? makeId("mile");
  const parentId = input.parentId ?? input.ParentId ?? null;
  if (parentId) {
    const parent = db.prepare("SELECT run_id FROM milestones WHERE id = ?").get(parentId);
    invariant(parent?.run_id === run.id, "MILESTONE_PARENT", "Milestone parent must belong to the same run.");
  }
  const requirementIds = [...new Set(asArray(input.requirementIds ?? input.RequirementIds).map((item) => String(item).trim()).filter(Boolean))];
  for (const requirementId of requirementIds) {
    invariant(db.prepare("SELECT 1 FROM requirements WHERE run_id = ? AND id = ?").get(run.id, requirementId), "MILESTONE_REQUIREMENT", `Requirement ${requirementId} was not found.`);
  }
  const timestamp = now();
  const acceptance = asArray(input.acceptanceCriteria ?? input.AcceptanceCriteria);
  const entryCriteria = asArray(input.entryCriteria ?? input.EntryCriteria);
  const exitCriteria = asArray(input.exitCriteria ?? input.ExitCriteria ?? acceptance);
  const userVisibleOutcome = String(input.userVisibleOutcome ?? input.UserVisibleOutcome ?? objective).trim();
  invariant(userVisibleOutcome && exitCriteria.length > 0, "MILESTONE_DELIVERY_CONTRACT", "A milestone needs a user-visible outcome and exit criteria.");
  db.prepare(`
    INSERT INTO milestones(
      id, run_id, parent_id, title, objective, status, sequence, acceptance_json,
      entry_criteria_json, exit_criteria_json, user_visible_outcome, requirement_ids_json, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    run.id,
    parentId,
    title,
    objective,
    Number(input.sequence ?? input.Sequence ?? 1),
    json(acceptance),
    json(entryCriteria),
    json(exitCriteria),
    userVisibleOutcome,
    json(requirementIds),
    timestamp,
    timestamp
  );
  for (const dependency of asArray(input.dependsOn ?? input.DependsOn)) {
    const candidate = db.prepare("SELECT run_id FROM milestones WHERE id = ?").get(dependency);
    invariant(candidate?.run_id === run.id, "MILESTONE_DEPENDENCY", `Milestone dependency ${dependency} is invalid.`);
    db.prepare("INSERT INTO milestone_dependencies(milestone_id, depends_on) VALUES(?, ?)").run(id, dependency);
  }
  validateMilestoneGraph(db, run.id);
  touchRun(db, run.id);
  recordEvent(db, run.id, "milestone.created", "info", { id, title, parentId });
  return getMilestone(db, id);
}

export function getMilestone(db, id) {
  const row = db.prepare("SELECT * FROM milestones WHERE id = ?").get(id);
  invariant(row, "MILESTONE_NOT_FOUND", `Milestone ${id} was not found.`);
  return hydrate(db, row);
}

export function listMilestones(db, runId) {
  refreshMilestoneStatuses(db, runId);
  return db.prepare("SELECT * FROM milestones WHERE run_id = ? ORDER BY sequence, created_at").all(runId).map((row) => hydrate(db, row));
}

export function validateMilestoneGraph(db, runId) {
  const rows = db.prepare("SELECT id FROM milestones WHERE run_id = ?").all(runId);
  const ids = new Set(rows.map((row) => row.id));
  const edges = new Map([...ids].map((id) => [id, []]));
  for (const row of db.prepare(`
    SELECT milestone_id, depends_on FROM milestone_dependencies
    WHERE milestone_id IN (SELECT id FROM milestones WHERE run_id = ?)
  `).all(runId)) {
    invariant(ids.has(row.depends_on), "MILESTONE_DEPENDENCY", `Unknown milestone dependency ${row.depends_on}.`);
    edges.get(row.milestone_id).push(row.depends_on);
  }
  for (const row of db.prepare("SELECT id, parent_id FROM milestones WHERE run_id = ? AND parent_id IS NOT NULL").all(runId)) {
    invariant(ids.has(row.parent_id), "MILESTONE_PARENT", `Unknown milestone parent ${row.parent_id}.`);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    invariant(!visiting.has(id), "MILESTONE_CYCLE", `Milestone graph contains a cycle at ${id}.`);
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return { milestoneCount: ids.size, edges: [...edges.values()].reduce((sum, items) => sum + items.length, 0) };
}

export function ensureDefaultMilestone(db, runId) {
  let milestones = db.prepare("SELECT id FROM milestones WHERE run_id = ? ORDER BY sequence, created_at").all(runId);
  if (milestones.length === 0) {
    const id = makeId("mile");
    const timestamp = now();
    db.prepare(`
      INSERT INTO milestones(
        id, run_id, title, objective, status, sequence, acceptance_json, entry_criteria_json,
        exit_criteria_json, user_visible_outcome, requirement_ids_json, created_at, updated_at
      ) VALUES(?, ?, 'Implementation', 'Complete the sealed execution plan.', 'pending', 1,
        '["All required implementation tasks complete"]', '[]', '["All required implementation tasks complete"]',
        'The sealed implementation plan is complete and verified.', ?, ?, ?)
    `).run(id, runId, json(db.prepare("SELECT id FROM requirements WHERE run_id = ? AND status <> 'superseded'").all(runId).map((item) => item.id)), timestamp, timestamp);
    milestones = [{ id }];
  }
  const defaultId = milestones[0].id;
  db.prepare("UPDATE tasks SET milestone_id = ? WHERE run_id = ? AND milestone_id IS NULL AND phase IN ('execute', 'review', 'verify', 'curate')")
    .run(defaultId, runId);
  return defaultId;
}

export function refreshMilestoneStatuses(db, runId) {
  const rows = db.prepare("SELECT id, status FROM milestones WHERE run_id = ? ORDER BY sequence, created_at").all(runId);
  const terminal = (status) => TERMINAL_MILESTONES.has(status);
  for (let pass = 0; pass < Math.max(1, rows.length + 1); pass += 1) {
    let changed = false;
    for (const milestone of rows) {
      const current = db.prepare("SELECT status FROM milestones WHERE id = ?").get(milestone.id)?.status ?? milestone.status;
      if (current === "waived") continue;
      const tasks = db.prepare("SELECT status FROM tasks WHERE milestone_id = ?").all(milestone.id);
      const dependencies = db.prepare(`
        SELECT m.status FROM milestone_dependencies d JOIN milestones m ON m.id = d.depends_on
        WHERE d.milestone_id = ?
      `).all(milestone.id);
      const children = db.prepare("SELECT status FROM milestones WHERE parent_id = ?").all(milestone.id);
      const work = [...tasks, ...children];
      let status = "pending";
      if (dependencies.some((item) => item.status === "failed")) status = "blocked";
      else if (dependencies.some((item) => !terminal(item.status))) status = "blocked";
      else if (work.some((item) => item.status === "failed")) status = "failed";
      else if (work.some((item) => item.status === "blocked")) status = "blocked";
      else if (work.length > 0 && work.every((item) => terminal(item.status))) status = "completed";
      else if (work.some((item) => item.status === "running" || item.status === "active" || item.status === "completed")) status = "active";
      if (status !== current) {
        db.prepare("UPDATE milestones SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), milestone.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const current = db.prepare(`
    SELECT m.id FROM milestones m
    WHERE m.run_id = ? AND m.status NOT IN ('completed', 'waived')
      AND (EXISTS(SELECT 1 FROM tasks t WHERE t.milestone_id = m.id)
           OR NOT EXISTS(SELECT 1 FROM milestones c WHERE c.parent_id = m.id))
    ORDER BY m.sequence, m.created_at LIMIT 1
  `).get(runId)?.id ?? null;
  db.prepare("UPDATE runs SET current_milestone_id = ? WHERE id = ?").run(current, runId);
}

export function milestoneSummary(db, runId) {
  return listMilestones(db, runId).map((item) => ({
    id: item.id,
    parentId: item.parent_id,
    title: item.title,
    status: item.status,
    sequence: item.sequence,
    dependsOn: item.dependsOn,
    taskCounts: item.taskCounts,
    requirementIds: item.requirementIds,
    userVisibleOutcome: item.userVisibleOutcome,
    entryCriteria: item.entryCriteria,
    exitCriteria: item.exitCriteria
  }));
}
