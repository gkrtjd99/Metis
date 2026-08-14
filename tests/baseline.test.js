import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { advancePhase, putArtifact, startRun } from "../src/core/state.js";
import { addTask, taskContract } from "../src/core/tasks.js";
import { makeProject, startTestRun, forcePhase } from "./helpers.js";

test("task contracts expose pre-existing changes without claiming them", () => {
  const { root, config, db } = makeProject();
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }, null, 2));
    const { run } = startTestRun(db, root, config, "Update package metadata safely");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["package.json"], constraints: [], nonGoals: [], successCriteria: ["metadata remains valid"], designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "package_worker",
      title: "Update package metadata",
      goal: "Make a bounded package change",
      role: "worker",
      readOnly: false,
      targetPaths: ["package.json"],
      acceptanceCriteria: ["Metadata remains valid"],
      requiredEvidence: ["package.json"],
      dependsOn: []
    }, config);
    const contract = taskContract(db, "package_worker");
    assert.deepEqual(contract.PreexistingChanges, ["package.json"]);
    assert.equal(contract.AgentType, "metis-worker");
    assert.match(contract.CompiledPrompt, /# OWNED SCOPE/);
    assert.match(contract.CompiledPrompt, /package\.json/);
  } finally {
    db.close();
  }
});
