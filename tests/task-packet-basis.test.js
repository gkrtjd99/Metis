import assert from "node:assert/strict";
import test from "node:test";
import { compileTaskPacket, buildTaskBlueprint, taskExecutionBasis, taskPacketStatus } from "../src/core/task-packets.js";
import { putArtifact, startRun } from "../src/core/state.js";
import { addTask } from "../src/core/tasks.js";
import { forcePhase, makeProject } from "./helpers.js";

function packetTask(overrides = {}) {
  return {
    id: "basis-task",
    title: "Basis task",
    goal: "Compile a packet against the current execution basis.",
    role: "worker",
    taskKind: "implementation",
    runPhase: "execute",
    wave: 1,
    readOnly: true,
    scope: ["src/basis.js"],
    targetPaths: [],
    requirementIds: ["REQ-001"],
    contextRefs: ["artifact:design", "task-result:upstream"],
    acceptanceCriteria: ["The packet is current."],
    requiredEvidence: ["Current packet basis"],
    verificationModes: ["test"],
    dependsOn: [],
    ...overrides
  };
}

function basisProject() {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "deterministic" } } });
  const started = startRun(db, root, config, "Compile from an immutable execution basis");
  const run = forcePhase(db, root, config, started.run.id, "plan");
  const design = putArtifact(db, root, run.id, "design", { selectedApproach: "basis-v1" });
  addTask(db, run.id, packetTask(), config);
  return { root, db, config, run, design };
}

test("deterministic packets expose the current immutable execution basis", () => {
  const { root, db, config, run, design } = basisProject();
  try {
    const blueprint = buildTaskBlueprint(db, "basis-task", config);
    const expected = {
      ContractVersion: Number(run.contract_version),
      Artifacts: [{
        Ref: "artifact:design",
        ArtifactId: design.id,
        ContentRef: design.content_ref,
        Status: "verified",
        ContentHash: design.content_ref
      }]
    };
    assert.deepEqual(blueprint.ExecutionBasis, expected);
    assert.deepEqual(taskExecutionBasis(db, "basis-task", config), expected);

    const compiled = compileTaskPacket(db, root, "basis-task", config);
    assert.deepEqual(compiled.packet.ExecutionBasis, expected);
    assert.equal("RepositoryFingerprint" in blueprint, false);
  } finally {
    db.close();
  }
});

test("replacing a resolved artifact invalidates the cached blueprint and packet", () => {
  const { root, db, config, run, design } = basisProject();
  try {
    const first = buildTaskBlueprint(db, "basis-task", config);
    compileTaskPacket(db, root, "basis-task", config);
    const replacement = putArtifact(db, root, run.id, "design", { selectedApproach: "basis-v2" });
    db.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?").run("2099-01-01T00:00:00.000Z", replacement.id);

    const second = buildTaskBlueprint(db, "basis-task", config);
    assert.notStrictEqual(second, first);
    assert.notEqual(second.BlueprintHash, first.BlueprintHash);
    assert.notEqual(second.ExecutionBasis.Artifacts[0].ArtifactId, design.id);
    assert.equal(second.ExecutionBasis.Artifacts[0].ArtifactId, replacement.id);
    assert.equal(taskPacketStatus(db, "basis-task", config).current, false);
    assert.equal(taskPacketStatus(db, "basis-task", config).status, "stale");
  } finally {
    db.close();
  }
});

test("changing the run contract version invalidates the cached blueprint basis", () => {
  const { root, db, config, run } = basisProject();
  try {
    const first = buildTaskBlueprint(db, "basis-task", config);
    compileTaskPacket(db, root, "basis-task", config);
    db.prepare("UPDATE runs SET contract_version = contract_version + 1 WHERE id = ?").run(run.id);

    const second = buildTaskBlueprint(db, "basis-task", config);
    assert.notEqual(second.ExecutionBasis.ContractVersion, first.ExecutionBasis.ContractVersion);
    assert.notEqual(second.BlueprintHash, first.BlueprintHash);
    assert.equal(taskPacketStatus(db, "basis-task", config).current, false);
  } finally {
    db.close();
  }
});

test("cached blueprints and their execution basis remain deeply frozen", () => {
  const { db, config } = basisProject();
  try {
    const first = buildTaskBlueprint(db, "basis-task", config);
    const second = buildTaskBlueprint(db, "basis-task", config);
    assert.strictEqual(second, first);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.ExecutionBasis), true);
    assert.equal(Object.isFrozen(first.ExecutionBasis.Artifacts), true);
    assert.equal(Object.isFrozen(first.ExecutionBasis.Artifacts[0]), true);
    assert.throws(() => { first.ExecutionBasis.Artifacts[0].Status = "tampered"; }, TypeError);
  } finally {
    db.close();
  }
});
