import assert from "node:assert/strict";
import test from "node:test";
import { materializeControllerTaskWave, nextControllerAction } from "../src/core/controller.js";
import { takeoverController } from "../src/core/ownership.js";
import { acknowledgeScheduleSpawn, claimSchedule } from "../src/core/scheduler.js";
import { advancePhase, latestArtifact, putArtifact } from "../src/core/state.js";
import { addTask, finishTask, getTask } from "../src/core/tasks.js";
import { makeProject, spawnReceipts, startTestRun } from "./helpers.js";

function startPredesign(options = {}) {
  const project = makeProject(options.project ?? {});
  const started = startTestRun(project.db, project.root, project.config, "Measure bounded predesign overlap", {
    contract: {
      lifecycleProfile: "full",
      designRequired: false
    }
  });
  advancePhase(project.db, project.root, started.run.id, "discover");
  return { ...project, ...started };
}

function addActionTasks(db, runId, config, action) {
  return action.taskSpecs.map((spec) => addTask(db, runId, spec, config));
}

function acknowledgeBatch(db, runId, config, claimed, owner) {
  acknowledgeScheduleSpawn(
    db,
    runId,
    claimed.batchId,
    claimed.batch.map((item) => item.taskId),
    owner,
    config,
    spawnReceipts(claimed.batch, null, owner)
  );
}

function finishLaneTask(db, root, runId, config, item) {
  const roleFields = item.role === "scout"
    ? { Facts: [`Completed ${item.taskId}.`], Unknowns: [], RelevantPaths: ["package.json"], Interfaces: [], Risks: [] }
    : { Questions: [], Sources: ["frozen-goal-contract"], Findings: [`Completed ${item.taskId}.`], Constraints: [], Recommendations: [], Unknowns: [] };
  finishTask(db, root, runId, item.taskId, item.leaseToken, {
    Status: "COMPLETED",
    Summary: `Completed ${item.taskId}.`,
    Files: [],
    EvidenceRefs: [],
    Blockers: [],
    ...roleFields
  }, config);
}

function finishSynthesisTask(db, root, runId, config, item) {
  const discovery = item.taskId.endsWith("synthesis-discovery");
  finishTask(db, root, runId, item.taskId, item.leaseToken, {
    Status: "COMPLETED",
    Summary: `Completed ${item.taskId}.`,
    Files: [],
    EvidenceRefs: [],
    Blockers: [],
    ArtifactKind: discovery ? "discovery" : "research",
    ArtifactContent: discovery
      ? {
          scope: ["src", "tests"],
          knownFacts: ["Predesign evidence was synthesized from terminal scouts."],
          unknowns: []
        }
      : {
          summary: "Predesign evidence was synthesized from terminal researchers.",
          sources: ["frozen-goal-contract"],
          unknowns: []
        }
  }, config);
}

test("default predesign action creates five real discover wave-one tasks", () => {
  const { root, db, config, run } = startPredesign();
  try {
    assert.equal(config.orchestration.lifecycleOverlap.predesign, true);
    const first = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    const replay = nextControllerAction(db, root, run.id, config, { sampleProgress: false });

    assert.deepEqual(first, replay);
    assert.equal(first.type, "CREATE_PREDESIGN_WAVE");
    assert.equal(first.operation, "materializeControllerTaskWave");
    assert.match(first.command, /metis controller materialize/u);
    assert.equal(first.taskSpecs.length, 5);
    assert.ok(first.taskSpecs.every((spec) => spec.runPhase === "discover" && spec.wave === 1 && spec.readOnly));
    assert.deepEqual(
      Object.fromEntries(["scout", "researcher"].map((role) => [role, first.taskSpecs.filter((spec) => spec.role === role).length])),
      { scout: 3, researcher: 2 }
    );
    assert.equal(new Set(first.taskSpecs.map((spec) => spec.id)).size, 5);
    assert.deepEqual(first.basis, {
      runId: run.id,
      phase: "discover",
      contractVersion: 1,
      discoveryArtifactId: null,
      researchArtifactId: null
    });
    assert.equal(Object.isFrozen(first.basis), true);
  } finally {
    db.close();
  }
});

test("predesign lifecycle identity ignores a fuzzy role/title match", () => {
  const { root, db, config, run } = startPredesign();
  try {
    const first = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    addTask(db, run.id, { ...first.taskSpecs[0], id: "legacy-fuzzy-scout" }, config);
    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = 'legacy-fuzzy-scout'").run();

    const replay = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(replay.type, "CREATE_PREDESIGN_WAVE");
    assert.equal(replay.taskSpecs.length, 5);
    assert.ok(replay.taskSpecs.some((spec) => spec.id === first.taskSpecs[0].id));
  } finally {
    db.close();
  }
});

test("real schedule claims keep the fused discover lane within four and eight slots", async (t) => {
  for (const maxConcurrent of [4, 8]) {
    await t.test(`maxConcurrent=${maxConcurrent}`, () => {
      const { root, db, config, run, controller } = startPredesign({
        project: { config: { orchestration: { maxConcurrent } } }
      });
      try {
        assert.equal(config.orchestration.lifecycleOverlap.predesign, true);
        const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
        addActionTasks(db, run.id, config, action);

        const claimed = claimSchedule(db, root, run.id, config, {
          owner: `predesign-${maxConcurrent}`,
          controllerFencingToken: controller.fencingToken,
          limit: maxConcurrent
        });
        assert.equal(claimed.batch.length, Math.min(5, maxConcurrent));
        assert.ok(claimed.batch.length <= maxConcurrent);
        assert.ok(claimed.batch.some((item) => item.role === "scout"));
        assert.ok(claimed.batch.some((item) => item.role === "researcher"));
        assert.equal(claimed.deferred.length, maxConcurrent === 4 ? 1 : 0);
      } finally {
        db.close();
      }
    });
  }
});

test("terminal lane results create disjoint syntheses and skip research agent work", () => {
  const { root, db, config, run, controller } = startPredesign();
  try {
    const first = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    materializeControllerTaskWave(db, root, run.id, first, controller, config);
    const firstClaim = claimSchedule(db, root, run.id, config, {
      owner: "predesign-wave-one",
      controllerFencingToken: controller.fencingToken,
      limit: 8
    });
    assert.equal(firstClaim.batch.length, 5);
    acknowledgeBatch(db, run.id, config, firstClaim, "predesign-wave-one");
    for (const item of firstClaim.batch) finishLaneTask(db, root, run.id, config, item);

    const synthesis = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(synthesis.type, "CREATE_PREDESIGN_SYNTHESIS_WAVE");
    assert.equal(synthesis.operation, "materializeControllerTaskWave");
    assert.equal(synthesis.taskSpecs.length, 2);
    assert.ok(synthesis.taskSpecs.every((spec) => spec.runPhase === "discover" && spec.wave === 2 && spec.role === "synthesizer"));

    const discoverySpec = synthesis.taskSpecs.find((spec) => spec.expectedOutputs.includes("artifact:discovery"));
    const researchSpec = synthesis.taskSpecs.find((spec) => spec.expectedOutputs.includes("artifact:research"));
    assert.equal(discoverySpec.dependsOn.length, 3);
    assert.ok(discoverySpec.acceptanceCriteria.includes("ArtifactKind is discovery."));
    assert.ok(discoverySpec.acceptanceCriteria.includes("ArtifactContent.scope is a non-empty string array."));
    assert.ok(discoverySpec.acceptanceCriteria.includes("ArtifactContent.knownFacts is an array."));
    assert.ok(discoverySpec.acceptanceCriteria.includes("ArtifactContent.unknowns is an array."));
    assert.deepEqual(discoverySpec.constraints, [
      "ArtifactContent must use lowercase scope, knownFacts, and unknowns fields.",
      "Do not emit a duplicate discovery in ProducedArtifacts."
    ]);
    assert.equal(researchSpec.dependsOn.length, 2);
    assert.deepEqual(discoverySpec.dependsOn.filter((id) => researchSpec.dependsOn.includes(id)), []);

    materializeControllerTaskWave(db, root, run.id, synthesis, controller, config);
    const synthesisClaim = claimSchedule(db, root, run.id, config, {
      owner: "predesign-wave-two",
      controllerFencingToken: controller.fencingToken,
      limit: 8
    });
    assert.equal(synthesisClaim.batch.length, 2);
    acknowledgeBatch(db, run.id, config, synthesisClaim, "predesign-wave-two");
    for (const item of synthesisClaim.batch) finishSynthesisTask(db, root, run.id, config, item);

    assert.ok(latestArtifact(db, root, run.id, "discovery", ["verified"]));
    assert.ok(latestArtifact(db, root, run.id, "research", ["verified"]));
    const leaveDiscovery = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(leaveDiscovery.type, "ADVANCE_PHASE");
    assert.equal(leaveDiscovery.targetPhase, "research");
    advancePhase(db, root, run.id, "research");

    const leaveResearch = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(leaveResearch.type, "ADVANCE_PHASE");
    assert.equal(leaveResearch.targetPhase, "design");

    const serialBarriers = ["scouts", "discovery-synthesis", "researchers", "research-synthesis"].length;
    const fusedBarriers = [first.type, synthesis.type].length;
    assert.equal(serialBarriers, 4);
    assert.equal(fusedBarriers, 2);
    assert.equal((serialBarriers - fusedBarriers) / serialBarriers, 0.5);
    // Barrier-count evidence is analytical; this test makes no model or wall-clock speed claim.
  } finally {
    db.close();
  }
});

test("predesign wave materialization is an exact idempotent replay", () => {
  const { root, db, config, run, controller } = startPredesign();
  try {
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    const first = materializeControllerTaskWave(db, root, run.id, action, controller, config);
    const second = materializeControllerTaskWave(db, root, run.id, action, controller, config);

    assert.deepEqual(first.createdTaskIds, action.taskSpecs.map((spec) => spec.id));
    assert.deepEqual(second.createdTaskIds, []);
    assert.deepEqual(second.existingTaskIds, action.taskSpecs.map((spec) => spec.id));
    assert.equal(second.replayed, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id).count, 5);
  } finally {
    db.close();
  }
});

test("partial predesign materialization is rejected before filling a truncated wave", () => {
  const { root, db, config, run, controller } = startPredesign();
  try {
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    addTask(db, run.id, action.taskSpecs[0], config);
    const truncated = { ...action, taskSpecs: action.taskSpecs.slice(1) };
    assert.throws(
      () => materializeControllerTaskWave(db, root, run.id, truncated, controller, config),
      /complete canonical wave/u
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id).count, 1);
  } finally {
    db.close();
  }
});

test("predesign dispatch rejects a tampered stable contract before scheduling", () => {
  const { root, db, config, run } = startPredesign();
  try {
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    addTask(db, run.id, action.taskSpecs[0], config);
    db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("tampered before dispatch", action.taskSpecs[0].id);

    assert.throws(
      () => nextControllerAction(db, root, run.id, config, { sampleProgress: false }),
      /does not match its canonical contract; refusing dispatch/u
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM scheduler_batches WHERE run_id = ?").get(run.id).count, 0);
  } finally {
    db.close();
  }
});

test("predesign materialization fails closed on an existing ID/spec mismatch", () => {
  const { root, db, config, run, controller } = startPredesign();
  try {
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    addTask(db, run.id, action.taskSpecs[0], config);
    db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("tampered canonical title", action.taskSpecs[0].id);

    assert.throws(
      () => materializeControllerTaskWave(db, root, run.id, action, controller, config),
      /does not match the canonical controller spec/u
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND title = ?").get(run.id, "tampered canonical title").count, 1);
  } finally {
    db.close();
  }
});

test("predesign materialization rejects a stale controller fence", () => {
  const { root, db, config, run, controller } = startPredesign();
  try {
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    takeoverController(db, run.id, { force: true, owner: "replacement", sessionId: "replacement-session" });

    assert.throws(
      () => materializeControllerTaskWave(db, root, run.id, action, controller, config),
      /Another controller session owns this run/u
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id).count, 0);
  } finally {
    db.close();
  }
});

test("predesign materialization rejects cross-run and stale bases before writing tasks", () => {
  const { root, db, config, run, controller } = startPredesign();
  try {
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    const crossRun = { ...action, basis: { ...action.basis, runId: "run-from-another-controller" } };
    assert.throws(
      () => materializeControllerTaskWave(db, root, run.id, crossRun, controller, config),
      /belongs to another run/u
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id).count, 0);

    const foreignTaskSpecs = {
      ...action,
      taskSpecs: action.taskSpecs.map((spec) => ({
        ...spec,
        id: spec.id.replace(`predesign-${run.id}-`, "predesign-foreign-run-")
      }))
    };
    assert.throws(
      () => materializeControllerTaskWave(db, root, run.id, foreignTaskSpecs, controller, config),
      /not canonical for run/u
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id).count, 0);

    putArtifact(db, root, run.id, "discovery", { scope: ["src/core"] });
    assert.throws(
      () => materializeControllerTaskWave(db, root, run.id, action, controller, config),
      /basis is stale/u
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id).count, 0);
  } finally {
    db.close();
  }
});

test("predesign overlap has an explicit false opt-out", () => {
  const { root, db, config, run } = startPredesign({
    project: { config: { orchestration: { lifecycleOverlap: { predesign: false } } } }
  });
  try {
    assert.equal(config.orchestration.lifecycleOverlap.predesign, false);
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(action.type, "CREATE_DISCOVERY_WAVE");
    assert.equal(action.taskSpecs.length, 3);
    assert.ok(action.taskSpecs.every((spec) => spec.role === "scout" && spec.runPhase === "discover"));
  } finally {
    db.close();
  }
});

test("ordinary discovery waves use the same fenced exact materializer", () => {
  const { root, db, config, run, controller } = startPredesign({
    project: { config: { orchestration: { lifecycleOverlap: { predesign: false } } } }
  });
  try {
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(action.type, "CREATE_DISCOVERY_WAVE");
    const first = materializeControllerTaskWave(db, root, run.id, action, controller, config);
    const second = materializeControllerTaskWave(db, root, run.id, action, controller, config);
    assert.deepEqual(first.createdTaskIds, action.taskSpecs.map((spec) => spec.id));
    assert.equal(second.replayed, true);
    assert.deepEqual(second.existingTaskIds, action.taskSpecs.map((spec) => spec.id));
  } finally {
    db.close();
  }
});

test("ordinary discovery wave rejects a modified task before any insert", () => {
  const { root, db, config, run, controller } = startPredesign({
    project: { config: { orchestration: { lifecycleOverlap: { predesign: false } } } }
  });
  try {
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    const modified = {
      ...action,
      taskSpecs: action.taskSpecs.map((spec, index) => index === 0 ? { ...spec, goal: "modified" } : spec)
    };
    assert.throws(() => materializeControllerTaskWave(db, root, run.id, modified, controller, config), /canonical contract/u);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id).count, 0);
  } finally {
    db.close();
  }
});

test("ordinary discovery synthesis has a stable exact replay contract", () => {
  const { root, db, config, run, controller } = startPredesign({
    project: { config: { orchestration: { lifecycleOverlap: { predesign: false } } } }
  });
  try {
    const scouts = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    materializeControllerTaskWave(db, root, run.id, scouts, controller, config);
    db.prepare("UPDATE tasks SET status = 'completed' WHERE run_id = ? AND role = 'scout'").run(run.id);
    const synthesis = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(synthesis.type, "CREATE_DISCOVERY_SYNTHESIS");
    assert.equal(synthesis.taskSpecs[0].id, `discovery-${run.id}-synthesis`);
    const result = materializeControllerTaskWave(db, root, run.id, synthesis, controller, config);
    assert.deepEqual(result.createdTaskIds, [`discovery-${run.id}-synthesis`]);
    const persisted = getTask(db, `discovery-${run.id}-synthesis`);
    assert.deepEqual(persisted.constraints, [
      "ArtifactContent must use lowercase scope, knownFacts, and unknowns fields.",
      "Do not emit a duplicate discovery in ProducedArtifacts."
    ]);
    assert.ok(persisted.acceptanceCriteria.includes("ArtifactContent.scope is a non-empty string array."));
    assert.ok(persisted.acceptanceCriteria.includes("ArtifactContent.knownFacts is an array."));
    assert.ok(persisted.acceptanceCriteria.includes("ArtifactContent.unknowns is an array."));
    assert.equal(materializeControllerTaskWave(db, root, run.id, synthesis, controller, config).replayed, true);
  } finally {
    db.close();
  }
});
