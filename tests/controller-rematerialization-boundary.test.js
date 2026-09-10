import assert from "node:assert/strict";
import test from "node:test";
import { addCheckpoint } from "../src/core/checkpoints.js";
import { freezeGoalContract } from "../src/core/contracts.js";
import { nextControllerAction, fastPathEligibilityForRun } from "../src/core/controller.js";
import { addTask } from "../src/core/tasks.js";
import { advancePhase, materializeFastPathPrerequisites, reopenPhase, startRun } from "../src/core/state.js";
import { makeProject } from "./helpers.js";

function materializedAndReopened() {
  const project = makeProject({ config: { orchestration: { requirePlanCritic: false } } });
  const started = startRun(project.db, project.root, project.config, "Rematerialize only the canonical fast path");
  freezeGoalContract(project.db, project.root, started.run.id, {
    objective: "Rematerialize only the canonical fast path",
    scope: ["src/parser.js"],
    nonGoals: ["Unrelated changes"],
    constraints: ["Preserve the existing parser behavior."],
    successCriteria: ["The bounded parser change is verified."],
    complexity: "trivial",
    route: {
      lifecycleProfile: "fast",
      researchRequired: false,
      designRequired: false,
      specialistReviewRequired: false,
      documentationRequired: false
    },
    requirements: [{
      id: "REQ-REMAT",
      title: "Preserve the bounded parser behavior",
      description: "The bounded parser behavior remains verified.",
      kind: "functional",
      priority: "must",
      acceptance: ["The bounded parser change is verified."]
    }]
  });
  advancePhase(project.db, project.root, started.run.id, "discover");
  const materialized = materializeFastPathPrerequisites(
    project.db, project.root, started.run.id, started.controller, project.config
  );
  reopenPhase(project.db, started.run.id, "discover", "Reconsider the bounded fast-path inputs.");
  return { project, started, materialized };
}

function untrustedTask(id) {
  return {
    id,
    title: "Untrusted discovery task",
    goal: "Inspect the bounded local input without changing it.",
    role: "scout",
    taskKind: "discovery",
    runPhase: "discover",
    wave: 1,
    readOnly: true,
    scope: ["src/parser.js"],
    nonGoals: ["Do not modify repository files."],
    constraints: ["Use local-read authority only."],
    requirementIds: ["REQ-REMAT"],
    acceptanceCriteria: ["Return bounded discovery evidence."],
    requiredEvidence: ["Current repository evidence"],
    expectedOutputs: ["discovery"],
    dependsOn: []
  };
}

test("fast-path rematerialization does not ignore a noncanonical task sharing its prefix", () => {
  const fixture = materializedAndReopened();
  try {
    const { project, started, materialized } = fixture;
    const prefix = materialized.artifactIds[3].slice(0, -"-plan".length);
    addTask(project.db, started.run.id, untrustedTask(`${prefix}-untrusted-task`), project.config);

    const eligibility = fastPathEligibilityForRun(project.db, started.run.id, project.config);
    assert.equal(eligibility.eligible, false);
    assert.ok(eligibility.reasons.includes("active work exists"));
    const action = nextControllerAction(project.db, project.root, started.run.id, project.config, { sampleProgress: false });
    assert.notEqual(action.type, "MATERIALIZE_FAST_PATH_PREREQUISITES");
  } finally {
    fixture.project.db.close();
  }
});

test("fast-path rematerialization does not ignore a noncanonical authority checkpoint sharing its prefix", () => {
  const fixture = materializedAndReopened();
  try {
    const { project, started } = fixture;
    const checkpointId = `planned-execution-${started.run.id}-untrusted-authority`;
    addCheckpoint(project.db, started.run.id, {
      id: checkpointId,
      kind: "authority",
      blocking: true,
      reason: "An unrelated authority decision is still pending.",
      requiredEvidence: []
    });

    const eligibility = fastPathEligibilityForRun(project.db, started.run.id, project.config);
    assert.equal(eligibility.eligible, false);
    assert.ok(eligibility.reasons.includes("open blockers or blocking checkpoints exist"));
    const action = nextControllerAction(project.db, project.root, started.run.id, project.config, { sampleProgress: false });
    assert.notEqual(action.type, "MATERIALIZE_FAST_PATH_PREREQUISITES");
  } finally {
    fixture.project.db.close();
  }
});

test("fast-path rematerialization does not ignore an unrelated authority checkpoint citing the stale plan", () => {
  const fixture = materializedAndReopened();
  try {
    const { project, started, materialized } = fixture;
    const stalePlanId = materialized.artifactIds.find((id) => id.endsWith("-plan"));
    assert.ok(stalePlanId);
    addCheckpoint(project.db, started.run.id, {
      id: `planned-execution-${started.run.id}-untrusted-authority-with-plan-evidence`,
      kind: "authority",
      blocking: true,
      reason: "An unrelated authority decision cites the stale plan and is still pending.",
      requiredEvidence: [`artifact:${stalePlanId}`]
    });

    const eligibility = fastPathEligibilityForRun(project.db, started.run.id, project.config);
    assert.equal(eligibility.eligible, false);
    assert.ok(eligibility.reasons.includes("open blockers or blocking checkpoints exist"));
    const action = nextControllerAction(project.db, project.root, started.run.id, project.config, { sampleProgress: false });
    assert.notEqual(action.type, "MATERIALIZE_FAST_PATH_PREREQUISITES");
  } finally {
    fixture.project.db.close();
  }
});
