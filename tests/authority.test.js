import assert from "node:assert/strict";
import test from "node:test";
import { advancePhase, putArtifact, startRun } from "../src/core/state.js";
import { addTask, claimTask, sealPlan } from "../src/core/tasks.js";
import { makeProject, startTestRun, forcePhase } from "./helpers.js";

test("non-local authority requires a task-scoped grant", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Prepare an external release");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["release.json"], constraints: [], nonGoals: [], successCriteria: ["release prepared"], designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "publish_release",
      title: "Publish release",
      goal: "Publish the release",
      role: "worker",
      readOnly: false,
      scope: ["release.json"],
      nonGoals: [],
      constraints: [],
      targetPaths: ["release.json"],
      interfaces: [],
      acceptanceCriteria: ["Release is published"],
      requiredEvidence: ["release identifier"],
      authorityBoundary: "external-release-write",
      dependsOn: []
    }, config);
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id).content);
    forcePhase(db, root, config, run.id, "execute");
    assert.throws(() => claimTask(db, run.id, "publish_release", "worker", config), /explicit authority/i);
    putArtifact(db, root, run.id, "authority-grant:publish_release", {
      granted: true,
      scope: "publish one release"
    });
    const claimed = claimTask(db, run.id, "publish_release", "worker", config);
    assert.equal(claimed.task.status, "running");
  } finally {
    db.close();
  }
});
