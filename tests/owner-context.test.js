import assert from "node:assert/strict";
import test from "node:test";
import { buildMainContext } from "../src/core/context.js";
import { recordEvent, startRun } from "../src/core/state.js";
import { addTask } from "../src/core/tasks.js";
import { forcePhase, makeProject } from "./helpers.js";
import { now } from "../src/core/util.js";

function idPattern(id) {
  return new RegExp(`(?<![A-Za-z0-9_-])${String(id)}(?![A-Za-z0-9_-])`);
}

function taskPayloadPattern(id) {
  return new RegExp(`"(?:taskId|parentTaskId)":"${String(id)}"`);
}

function taskInput(title, role, extra = {}) {
  return {
    title,
    goal: title,
    role,
    runPhase: "execute",
    targetPaths: role === "coordinator" ? [] : ["src/owner-secret.js"],
    requirementIds: ["REQ-001"],
    ...extra
  };
}

function fixture(options = {}) {
  const project = makeProject({ config: { budgets: { mainContextTokens: 10000, recentEvents: 12 }, ...(options.config ?? {}) } });
  const { db, root, config } = project;
  const { run } = startRun(db, root, config, "Render owner-scoped main context");
  forcePhase(db, root, config, run.id, "execute");
  const owner = addTask(db, run.id, taskInput("ROOT_OWNER_VISIBLE", "coordinator"), config);
  const child = addTask(db, run.id, taskInput("CHILD_TITLE_SHOULD_BE_HIDDEN", "worker", {
    id: "a",
    parentTaskId: owner.id,
    targetPaths: ["secret/child-path-should-be-hidden.js"]
  }), config);
  return { ...project, run, owner, child };
}

function finishSetup(db, taskIds) {
  const timestamp = now();
  for (const [taskId, status] of taskIds) {
    db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, timestamp, taskId);
  }
}

test("main context keeps root tasks/events and collapses child identity and payload", () => {
  const { root, config, db, run, owner, child } = fixture();
  try {
    finishSetup(db, [[owner.id, "running"], [child.id, "blocked"]]);
    recordEvent(db, run.id, "task.finished", "warning", {
      taskId: child.id,
      reason: "CHILD_SECRET_REASON_SHOULD_BE_HIDDEN",
      receipt: "CHILD_SECRET_RECEIPT_SHOULD_BE_HIDDEN"
    });
    db.prepare(`
      INSERT INTO scheduler_batches(
        id, run_id, parent_task_id, phase, status, batch_json, rationale_json,
        controller_fencing_token, claimed_task_ids_json, spawned_task_ids_json, created_at, updated_at
      ) VALUES(?, ?, ?, 'execute', 'spawned', ?, '[]', 1, ?, ?, ?, ?)
    `).run(
      "batch-owner-context", run.id, owner.id, "[]", JSON.stringify([child.id]), JSON.stringify([child.id]), now(), now()
    );
    recordEvent(db, run.id, "scheduler.child-terminal", "warning", {
      batchId: "batch-owner-context",
      reason: "BATCH_CHILD_SECRET_REASON_SHOULD_BE_HIDDEN",
      receipt: "BATCH_CHILD_SECRET_RECEIPT_SHOULD_BE_HIDDEN"
    });
    recordEvent(db, run.id, "task.heartbeat", "info", { taskId: owner.id, marker: "ROOT_EVENT_VISIBLE" });
    const context = buildMainContext(db, root, run.id, config);

    assert.match(context.content, /ROOT_OWNER_VISIBLE/);
    assert.match(context.content, /ROOT_EVENT_VISIBLE/);
    assert.doesNotMatch(context.content, taskPayloadPattern(child.id));
    assert.doesNotMatch(context.content, /CHILD_TITLE_SHOULD_BE_HIDDEN/);
    assert.doesNotMatch(context.content, /child-path-should-be-hidden/);
    assert.doesNotMatch(context.content, /CHILD_SECRET_REASON_SHOULD_BE_HIDDEN/);
    assert.doesNotMatch(context.content, /CHILD_SECRET_RECEIPT_SHOULD_BE_HIDDEN/);
    assert.doesNotMatch(context.content, /BATCH_CHILD_SECRET_REASON_SHOULD_BE_HIDDEN/);
    assert.doesNotMatch(context.content, /BATCH_CHILD_SECRET_RECEIPT_SHOULD_BE_HIDDEN/);
    assert.match(context.content, new RegExp(`Owner ${owner.id}:`));
    assert.match(context.content, /blocked=1/);

    const requestedAction = { type: "ADVANCE_PHASE", command: "metis advance a", instruction: "keep root command a" };
    const actionContext = buildMainContext(db, root, run.id, config, { action: requestedAction });
    assert.equal(actionContext.action.command, "metis advance a");
    assert.match(actionContext.content, /metis advance a/);
  } finally {
    db.close();
  }
});

test("nested coordinator descendants collapse into the top-level owner", () => {
  const { root, config, db, run, owner, child } = fixture();
  try {
    const nested = addTask(db, run.id, taskInput("NESTED_COORDINATOR_HIDDEN", "coordinator", {
      parentTaskId: owner.id
    }), config);
    const grandchild = addTask(db, run.id, taskInput("GRANDCHILD_TITLE_HIDDEN", "worker", {
      parentTaskId: nested.id,
      targetPaths: ["secret/grandchild-path.js"]
    }), config);
    finishSetup(db, [[owner.id, "running"], [child.id, "completed"], [nested.id, "running"], [grandchild.id, "failed"]]);
    const context = buildMainContext(db, root, run.id, config);

    assert.match(context.content, new RegExp(`Owner ${owner.id}:`));
    assert.match(context.content, /failed=1/);
    assert.doesNotMatch(context.content, idPattern(nested.id));
    assert.doesNotMatch(context.content, idPattern(grandchild.id));
    assert.doesNotMatch(context.content, /NESTED_COORDINATOR_HIDDEN|GRANDCHILD_TITLE_HIDDEN|grandchild-path/);
  } finally {
    db.close();
  }
});

test("cyclic owner ancestry fails closed without leaking descendants", () => {
  const { root, config, db, run, owner, child } = fixture();
  try {
    db.prepare("UPDATE tasks SET parent_task_id = ? WHERE id = ?").run(child.id, owner.id);
    recordEvent(db, run.id, "task.finished", "warning", {
      taskId: child.id,
      reason: "CYCLIC_SECRET_REASON_SHOULD_BE_HIDDEN"
    });
    const context = buildMainContext(db, root, run.id, config);
    assert.doesNotMatch(context.content, idPattern(owner.id));
    assert.doesNotMatch(context.content, taskPayloadPattern(child.id));
    assert.doesNotMatch(context.content, /CYCLIC_SECRET_REASON_SHOULD_BE_HIDDEN/);
  } finally {
    db.close();
  }
});

test("child event aggregation remains bounded with many events", () => {
  const { root, config, db, run, owner, child } = fixture({ config: { budgets: { mainContextTokens: 900, recentEvents: 2 } } });
  try {
    finishSetup(db, [[owner.id, "running"], [child.id, "failed"]]);
    for (let index = 0; index < 400; index += 1) {
      recordEvent(db, run.id, `child.secret.${index}`, "warning", {
        taskId: child.id,
        reason: `RAW_REASON_${index}`,
        receipt: `RAW_RECEIPT_${index}`
      });
    }
    const context = buildMainContext(db, root, run.id, config);
    assert.ok(context.estimatedTokens <= 1000, `context used ${context.estimatedTokens} tokens`);
    assert.doesNotMatch(context.content, /RAW_REASON_|RAW_RECEIPT_/);
    assert.doesNotMatch(context.content, taskPayloadPattern(child.id));
    assert.match(context.content, new RegExp(`Owner ${owner.id}:`));
  } finally {
    db.close();
  }
});
