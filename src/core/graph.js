import { parseJson, pathsOverlap } from "./util.js";
import { MetisError } from "./errors.js";

export function validateGraph(db, runId) {
  const tasks = db.prepare("SELECT id FROM tasks WHERE run_id = ?").all(runId);
  const ids = new Set(tasks.map((task) => task.id));
  const edges = db.prepare(`
    SELECT d.task_id, d.depends_on
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id
    WHERE t.run_id = ?
  `).all(runId);
  const adjacency = new Map([...ids].map((id) => [id, []]));
  for (const edge of edges) {
    if (!ids.has(edge.depends_on)) {
      throw new MetisError("INVALID_DEPENDENCY", `Task ${edge.task_id} depends on a task outside this run.`);
    }
    adjacency.get(edge.depends_on).push(edge.task_id);
  }
  const indegree = new Map([...ids].map((id) => [id, 0]));
  for (const edge of edges) indegree.set(edge.task_id, indegree.get(edge.task_id) + 1);
  const queue = [...ids].filter((id) => indegree.get(id) === 0);
  const ordered = [];
  while (queue.length > 0) {
    const current = queue.shift();
    ordered.push(current);
    for (const next of adjacency.get(current)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (ordered.length !== ids.size) {
    const cycle = [...ids].filter((id) => indegree.get(id) > 0);
    throw new MetisError("TASK_CYCLE", "The task graph contains a cycle.", { tasks: cycle });
  }
  return { valid: true, order: ordered, taskCount: ids.size, edgeCount: edges.length };
}

export function cleanupExpiredLeases(db, at = new Date()) {
  const expired = db.prepare(`
    SELECT DISTINCT l.task_id
    FROM leases l
    JOIN tasks t ON t.id = l.task_id
    WHERE l.expires_at <= ? AND t.status = 'running'
  `).all(at.toISOString());
  if (expired.length === 0) return 0;
  const block = db.prepare(`
    UPDATE tasks SET status = 'blocked', owner = NULL, failure_class = 'transient', escalation_cause = 'lease-expired',
      result_json = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
  `);
  for (const item of expired) {
    const task = db.prepare("SELECT attempt_fence FROM tasks WHERE id = ?").get(item.task_id);
    block.run(JSON.stringify({
      Status: "BLOCKED",
      Summary: "The worker lease expired. Explicit recovery is required before another attempt can start.",
      EvidenceRefs: [],
      Blockers: ["lease-expired"]
    }), at.toISOString(), item.task_id);
    if (task) db.prepare("UPDATE worktrees SET status = 'expired', updated_at = ? WHERE task_id = ? AND attempt_fence = ? AND status = 'active'")
      .run(at.toISOString(), item.task_id, Number(task.attempt_fence));
  }
  return expired.length;
}

export function activeLeases(db) {
  cleanupExpiredLeases(db);
  return db.prepare(`
    SELECT l.resource, l.task_id, l.token, l.fencing_token, l.owner, l.expires_at
    FROM leases l
    JOIN tasks t ON t.id = l.task_id
    JOIN runs r ON r.id = t.run_id
    WHERE r.status = 'active' AND t.status IN ('running', 'blocked')
    ORDER BY l.resource
  `).all();
}

export function taskConflicts(task, leases) {
  if (Boolean(task.read_only)) return [];
  const targets = parseJson(task.target_paths_json, []);
  return leases.filter((lease) => targets.some((target) => pathsOverlap(target, lease.resource)));
}

export function runnableTasks(db, runId, limit = 20) {
  cleanupExpiredLeases(db);
  const candidates = db.prepare(`
    SELECT t.*
    FROM tasks t
    JOIN runs r ON r.id = t.run_id
    WHERE t.run_id = ?
      AND t.status = 'pending'
      AND r.status = 'active'
      AND t.phase = r.phase
      AND (
        t.parent_task_id IS NULL
        OR EXISTS (
          SELECT 1 FROM tasks parent
          WHERE parent.id = t.parent_task_id
            AND parent.run_id = t.run_id
            AND parent.role = 'coordinator'
            AND parent.status = 'running'
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM task_dependencies d
        JOIN tasks p ON p.id = d.depends_on
        WHERE d.task_id = t.id
          AND p.status NOT IN ('completed', 'waived')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM milestone_dependencies md
        JOIN milestones predecessor ON predecessor.id = md.depends_on
        WHERE md.milestone_id = t.milestone_id
          AND predecessor.status NOT IN ('completed', 'waived')
      )
    ORDER BY COALESCE((SELECT sequence FROM milestones WHERE id = t.milestone_id), 0), t.priority DESC, t.created_at ASC
  `).all(runId);
  const leases = activeLeases(db);
  const selected = [];
  const provisional = [...leases];
  for (const task of candidates) {
    if (taskConflicts(task, provisional).length > 0) continue;
    selected.push(task);
    if (!Boolean(task.read_only)) {
      for (const resource of parseJson(task.target_paths_json, [])) {
        provisional.push({ resource, task_id: task.id });
      }
    }
    if (selected.length >= limit) break;
  }
  return selected;
}
