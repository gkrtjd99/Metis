import assert from "node:assert/strict";
import fs from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { addInterfaceContract } from "../src/core/interfaces.js";
import { runtimeArea } from "../src/core/paths.js";
import { putArtifact, startRun } from "../src/core/state.js";
import { buildTaskBlueprint, getTaskPacket, markTaskPacketStale, taskPacketStatus } from "../src/core/task-packets.js";
import { addTask } from "../src/core/tasks.js";
import { forcePhase, makeProject } from "./helpers.js";

function task(overrides = {}) {
  return {
    id: "cache-target",
    title: "Cache target",
    goal: "Keep the packet blueprint current",
    role: "worker",
    taskKind: "implementation",
    runPhase: "execute",
    wave: 1,
    readOnly: false,
    scope: ["src/target.js"],
    targetPaths: ["src/target.js"],
    requirementIds: ["REQ-001"],
    contextRefs: ["artifact:design"],
    interfaceInputs: ["cache-interface"],
    ...overrides
  };
}

test("task packet blueprint cache reuses unchanged blueprints and misses relevant mutations", () => {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "deterministic" } } });
  try {
    const { run } = startRun(db, root, config, "Cache task packets");
    forcePhase(db, root, config, run.id, "plan");
    putArtifact(db, root, run.id, "design", { selectedApproach: "initial" });
    addInterfaceContract(db, run.id, {
      id: "cache-interface",
      name: "cache-interface",
      description: "Initial interface.",
      status: "frozen",
      schema: { value: "string" },
      requirementIds: ["REQ-001"]
    });
    addTask(db, run.id, task(), config);

    const first = buildTaskBlueprint(db, "cache-target", config);
    const second = buildTaskBlueprint(db, "cache-target", config);
    assert.strictEqual(second, first);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.RequirementContext[0]), true);
    assert.throws(() => first.Scope.push("cache contamination"), TypeError);
    assert.throws(() => {
      first.RequirementContext[0].Description = "cache contamination";
    }, TypeError);
    assert.equal(second.RequirementContext[0].Description, "The requested repository change is implemented and verified.");
    const compiled = getTaskPacket(db, "cache-target", config);
    const unchanged = taskPacketStatus(db, "cache-target", config);
    assert.equal(unchanged.current, true);
    assert.equal(unchanged.version, compiled.version);
    assert.equal(unchanged.blueprintHash, compiled.blueprintHash);
    assert.strictEqual(buildTaskBlueprint(db, "cache-target", config), first);

    db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run("running", "2099-01-01T00:00:00.000Z", "cache-target");
    assert.strictEqual(buildTaskBlueprint(db, "cache-target", config), first);

    db.prepare("UPDATE requirements SET description = ? WHERE id = ?").run("Changed requirement.", "REQ-001");
    const requirementChanged = buildTaskBlueprint(db, "cache-target", config);
    assert.notStrictEqual(requirementChanged, first);
    assert.notEqual(requirementChanged.BlueprintHash, first.BlueprintHash);
    assert.equal(taskPacketStatus(db, "cache-target", config).current, false);

    db.prepare("UPDATE interface_contracts SET description = ?, content_hash = ? WHERE id = ?")
      .run("Changed interface.", "changed-interface-hash", "cache-interface");
    const interfaceChanged = buildTaskBlueprint(db, "cache-target", config);
    assert.notEqual(interfaceChanged.BlueprintHash, requirementChanged.BlueprintHash);

    putArtifact(db, root, run.id, "design", { selectedApproach: "changed" });
    const contextChanged = buildTaskBlueprint(db, "cache-target", config);
    assert.notEqual(contextChanged.BlueprintHash, interfaceChanged.BlueprintHash);

    db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("Changed task source.", "cache-target");
    const taskChanged = buildTaskBlueprint(db, "cache-target", config);
    assert.notEqual(taskChanged.BlueprintHash, contextChanged.BlueprintHash);

    markTaskPacketStale(db, "cache-target", "test stale marker");
    const stale = taskPacketStatus(db, "cache-target", config);
    assert.equal(stale.current, false);
    assert.equal(stale.status, "stale");
    assert.equal(stale.version, compiled.version);
  } finally {
    db.close();
  }
});

test("unchanged cache hits avoid rereading artifact object payloads", () => {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "deterministic" } } });
  const originalReadFileSync = fs.readFileSync;
  const originalStatSync = fs.statSync;
  let objectPayloadReads = 0;
  let objectMetadataChecks = 0;
  fs.readFileSync = (...args) => {
    const target = String(args[0]);
    if (target.includes(`${path.sep}.metis${path.sep}objects${path.sep}`)) objectPayloadReads += 1;
    return originalReadFileSync(...args);
  };
  fs.statSync = (...args) => {
    const target = String(args[0]);
    if (target.includes(`${path.sep}.metis${path.sep}objects${path.sep}`)) objectMetadataChecks += 1;
    return originalStatSync(...args);
  };
  try {
    const { run } = startRun(db, root, config, "Avoid rereading unchanged packet objects");
    forcePhase(db, root, config, run.id, "plan");
    putArtifact(db, root, run.id, "design", { selectedApproach: "unchanged" });
    addTask(db, run.id, task({ interfaceInputs: [] }), config);

    buildTaskBlueprint(db, "cache-target", config);
    objectPayloadReads = 0;
    const cached = buildTaskBlueprint(db, "cache-target", config);

    assert.equal(objectPayloadReads, 0);
    assert.ok(objectMetadataChecks > 0);
    assert.equal(cached.ResolvedContext[0].Content, JSON.stringify({ selectedApproach: "unchanged" }));
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.statSync = originalStatSync;
    db.close();
  }
});

test("compiler target source hashing rejects cycles with a typed error", () => {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "deterministic" } } });
  try {
    const { run } = startRun(db, root, config, "Reject compiler target cycles");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, task({ id: "compiler-a", contextRefs: [], interfaceInputs: [] }), config);
    addTask(db, run.id, task({ id: "compiler-b", contextRefs: [], interfaceInputs: [] }), config);
    db.prepare("UPDATE tasks SET role = 'task-compiler', compiler_target_task_id = ? WHERE id = ?")
      .run("compiler-b", "compiler-a");
    db.prepare("UPDATE tasks SET role = 'task-compiler', compiler_target_task_id = ? WHERE id = ?")
      .run("compiler-a", "compiler-b");

    assert.throws(
      () => buildTaskBlueprint(db, "compiler-a", config),
      (error) => error.code === "TASK_COMPILER_TARGET_CYCLE"
    );
  } finally {
    db.close();
  }
});

test("context object backing mutation misses the cache and fails authenticated loading", () => {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "deterministic" } } });
  try {
    const { run } = startRun(db, root, config, "Detect context object tampering");
    forcePhase(db, root, config, run.id, "plan");
    putArtifact(db, root, run.id, "design", { selectedApproach: "authenticated" });
    addTask(db, run.id, task({ interfaceInputs: [] }), config);
    const cached = buildTaskBlueprint(db, "cache-target", config);
    assert.strictEqual(buildTaskBlueprint(db, "cache-target", config), cached);

    const ref = cached.ResolvedContext[0].ContentRef;
    const object = db.prepare("SELECT path FROM objects WHERE hash = ?").get(ref.slice(4));
    const relative = object.path.replace(/^objects[\\/]/u, "");
    const file = path.join(runtimeArea(root, "objects"), relative);
    const payload = Buffer.from(readFileSync(file));
    payload[payload.length - 1] ^= 1;
    writeFileSync(file, payload);

    assert.throws(() => buildTaskBlueprint(db, "cache-target", config));
  } finally {
    db.close();
  }
});
