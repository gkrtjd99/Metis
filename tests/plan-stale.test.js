import assert from "node:assert/strict";
import test from "node:test";
import { latestArtifact, putArtifact, reopenPhase } from "../src/core/state.js";
import { addTask, sealPlan, waiveTask } from "../src/core/tasks.js";
import { makeProject, startTestRun, forcePhase } from "./helpers.js";

const task = (id) => ({
  id,
  title: id,
  goal: id,
  role: "worker",
  readOnly: false,
  scope: [`src/${id}.js`],
  nonGoals: [],
  constraints: [],
  targetPaths: [`src/${id}.js`],
  interfaces: [],
  acceptanceCriteria: ["done"],
  requiredEvidence: ["diff"],
  dependsOn: []
});

test("replanning during execution makes the previous plan stale", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Implement tasks");
    putArtifact(db, root, run.id, "discovery", { scope: ["src"], constraints: [], nonGoals: [], successCriteria: ["done"], designRequired: false });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, task("one"), config);
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id).content);
    forcePhase(db, root, config, run.id, "execute");
    waiveTask(db, run.id, "one", "covered elsewhere");
    addTask(db, run.id, task("two"), config);
    waiveTask(db, run.id, "two", "test fixture");
    assert.equal(latestArtifact(db, root, run.id, "plan", ["verified"]), null);
    assert.ok(latestArtifact(db, root, run.id, "plan", ["stale"]));
    assert.throws(() => sealPlan(db, run.id), /Reopen the plan phase/i);
    reopenPhase(db, run.id, "plan", "Execution discovered a new required task");
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id).content);
    assert.ok(latestArtifact(db, root, run.id, "plan", ["verified"]));
  } finally {
    db.close();
  }
});
