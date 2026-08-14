import assert from "node:assert/strict";
import test from "node:test";
import { putArtifact, startRun, advancePhase } from "../src/core/state.js";
import { addTask, claimTask, getRunnableTasks, sealPlan } from "../src/core/tasks.js";
import { cleanupExpiredLeases, validateGraph } from "../src/core/graph.js";
import { makeProject, startTestRun, forcePhase } from "./helpers.js";

function preparePlan(db, root, config) {
  const { run } = startTestRun(db, root, config, "Change two modules");
  putArtifact(db, root, run.id, "discovery", {
    scope: ["src"], constraints: [], nonGoals: [], successCriteria: ["changes complete"], designRequired: false
  });
  forcePhase(db, root, config, run.id, "plan");
  return run;
}

const base = (id, target, dependsOn = []) => ({
  id,
  title: id,
  goal: id,
  role: "worker",
  readOnly: false,
  scope: [target],
  nonGoals: [],
  constraints: [],
  targetPaths: [target],
  interfaces: [],
  acceptanceCriteria: ["done"],
  requiredEvidence: ["diff"],
  dependsOn
});

test("runnable selection prevents overlapping mutable ownership", () => {
  const { root, config, db } = makeProject();
  try {
    const run = preparePlan(db, root, config);
    addTask(db, run.id, base("task_a", "src/auth"), config);
    addTask(db, run.id, base("task_b", "src/auth/login.js"), config);
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id).content);
    forcePhase(db, root, config, run.id, "execute");
    const runnable = getRunnableTasks(db, run.id, 10);
    assert.equal(runnable.length, 1);
    claimTask(db, run.id, runnable[0].id, "worker", config);
    assert.equal(getRunnableTasks(db, run.id, 10).length, 0);
  } finally {
    db.close();
  }
});

test("expired mutable leases fail closed until explicit recovery", () => {
  const { root, config, db } = makeProject({ config: { orchestration: { leaseMinutes: 1 } } });
  try {
    const run = preparePlan(db, root, config);
    addTask(db, run.id, base("task_a", "src/a.js"), config);
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id).content);
    forcePhase(db, root, config, run.id, "execute");
    claimTask(db, run.id, "task_a", "worker", config);
    db.prepare("UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    assert.equal(cleanupExpiredLeases(db), 1);
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'task_a'").get().status, "blocked");
    assert.ok(db.prepare("SELECT 1 FROM leases WHERE task_id = 'task_a'").get());
  } finally {
    db.close();
  }
});

test("graph validation detects a cycle", () => {
  const { root, config, db } = makeProject();
  try {
    const run = preparePlan(db, root, config);
    addTask(db, run.id, base("task_a", "src/a.js"), config);
    addTask(db, run.id, base("task_b", "src/b.js"), config);
    db.prepare("INSERT INTO task_dependencies(task_id, depends_on) VALUES('task_a', 'task_b')").run();
    db.prepare("INSERT INTO task_dependencies(task_id, depends_on) VALUES('task_b', 'task_a')").run();
    assert.throws(() => validateGraph(db, run.id), /cycle/i);
  } finally {
    db.close();
  }
});
