import assert from "node:assert/strict";
import test from "node:test";
import { driveController } from "../src/core/controller.js";
import { advancePhase, putArtifact, startRun } from "../src/core/state.js";
import { freezeGoalContract } from "../src/core/contracts.js";
import { makeProject, startTestRun, forcePhase } from "./helpers.js";

// Keep encrypted object writes deterministic for this focused controller test.
process.env.METIS_OBJECT_KEY ??= "0000000000000000000000000000000000000000000000000000000000000000";

function fastProject() {
  return makeProject({ config: {
    orchestration: {
      requirePlanCritic: false,
      specialistReviews: { enabled: true }
    }
  } });
}

function fastRun(project) {
  const started = startRun(project.db, project.root, project.config, "Drive the bounded parser change");
  freezeGoalContract(project.db, project.root, started.run.id, {
    objective: "Drive the bounded parser change",
    scope: ["src/parser.js"], nonGoals: ["Unrelated changes"], constraints: ["Preserve behavior"],
    successCriteria: ["The bounded parser change is verified."], complexity: "trivial",
    route: { lifecycleProfile: "fast", researchRequired: false, designRequired: false, specialistReviewRequired: false, documentationRequired: true },
    requirements: [{ id: "REQ-DRIVE", title: "Bounded parser change", description: "The parser change is delivered.", kind: "functional", priority: "must", acceptance: ["The parser change is verified."] }]
  });
  forcePhase(project.db, project.root, project.config, started.run.id, "discover");
  return started;
}

test("drive applies deterministic fast-path transitions and stops before spawning", () => {
  const project = fastProject();
  try {
    const started = fastRun(project);
    const first = driveController(project.db, project.root, started.run.id, started.controller, project.config);
    assert.equal(first.type, "SPAWN_BATCH");
    assert.deepEqual(first.applied.map((item) => item.type), ["MATERIALIZE_FAST_PATH_PREREQUISITES", "ADVANCE_PHASE"]);
    assert.equal(first.action.type, "SPAWN_BATCH");
    assert.equal(project.db.prepare("SELECT phase FROM runs WHERE id = ?").get(started.run.id).phase, "execute");

    const taskCount = project.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(started.run.id).count;
    const replay = driveController(project.db, project.root, started.run.id, started.controller, project.config);
    assert.equal(replay.type, "SPAWN_BATCH");
    assert.deepEqual(replay.applied, []);
    assert.equal(project.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(started.run.id).count, taskCount);
  } finally { project.db.close(); }
});

test("drive stops at a user checkpoint and never resolves it", () => {
  const project = makeProject();
  try {
    const started = startTestRun(project.db, project.root, project.config, "Wait for authority", { contract: { researchRequired: false, designRequired: false } });
    forcePhase(project.db, project.root, project.config, started.run.id, "discover");
    putArtifact(project.db, project.root, started.run.id, "discovery", { scope: ["src/parser.js"], knownFacts: [], unknowns: [] });
    advancePhase(project.db, project.root, started.run.id, "research");
    putArtifact(project.db, project.root, started.run.id, "research", { waived: true }, { status: "waived" });
    advancePhase(project.db, project.root, started.run.id, "design");
    putArtifact(project.db, project.root, started.run.id, "design", { decision: "bounded" });
    advancePhase(project.db, project.root, started.run.id, "plan");
    project.db.prepare("UPDATE runs SET status = 'blocked' WHERE id = ?").run(started.run.id);
    const result = driveController(project.db, project.root, started.run.id, started.controller, project.config);
    assert.equal(result.type, "USER_OR_AUTHORITY_REQUIRED");
    assert.equal(project.db.prepare("SELECT status FROM runs WHERE id = ?").get(started.run.id).status, "blocked");
  } finally { project.db.close(); }
});

test("drive fails closed at its iteration cap", () => {
  const project = makeProject();
  try {
    const started = startTestRun(project.db, project.root, project.config, "Drive cap");
    const result = driveController(project.db, project.root, started.run.id, started.controller, project.config, { maxIterations: 1 });
    assert.equal(result.type, "UNRECOVERABLE_BLOCKER");
    assert.equal(result.blocker.code, "DRIVE_ITERATION_CAP");
    assert.equal(result.iterations, 1);
  } finally { project.db.close(); }
});
