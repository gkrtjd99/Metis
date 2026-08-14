import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { addInterfaceContract, freezeInterfaceContract } from "../src/core/interfaces.js";
import { normalizeEvidenceRef, evidenceRefIsCurrent } from "../src/core/provenance.js";
import { putArtifact } from "../src/core/state.js";
import { storeObject } from "../src/core/objects.js";
import { compileTaskPacket, getTaskPacket, taskPacketStatus } from "../src/core/task-packets.js";
import { addTask, claimTask, finishTask, listTasks } from "../src/core/tasks.js";
import { runtimeArea } from "../src/core/paths.js";
import { forcePhase, makeProject, startTestRun } from "./helpers.js";

function task(id, options = {}) {
  return {
    id,
    title: id,
    goal: `Complete ${id}`,
    role: "worker",
    taskKind: "implementation",
    runPhase: "execute",
    wave: 1,
    readOnly: false,
    targetPaths: [`${id}.js`],
    scope: [id],
    requirementIds: ["REQ-001"],
    acceptanceCriteria: ["The bounded task is complete."],
    expectedOutputs: ["implementation"],
    risk: options.risk ?? "high",
    effort: options.effort ?? "large",
    complexity: options.complexity ?? "high",
    ...options
  };
}

const overlay = {
  ClarifiedObjective: "Complete only the declared task.",
  ExecutionSteps: ["Read the frozen contract.", "Implement the bounded change.", "Run verification."],
  ContextPriorities: [],
  InterfaceNotes: [],
  VerificationPlan: ["test"],
  AdditionalStopConditions: [],
  HandoffNotes: [],
  Ambiguities: []
};

function approvedCompilerFixture(options = {}) {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "llm" } } });
  const { run } = startTestRun(db, root, config, "Authorize a current compiler packet.");
  forcePhase(db, root, config, run.id, "plan");
  const prepared = options.beforeTarget?.({ db, run }) ?? {};
  const target = addTask(db, run.id, task("compiler-target", { ...prepared.target, ...options.target }), config);
  const compiler = listTasks(db, run.id).find((item) => item.compilerTargetTaskId === target.id);
  assert.ok(compiler);
  const claim = claimTask(db, run.id, compiler.id, "compiler", config);
  const compilerOverlay = options.overlay ?? overlay;
  finishTask(db, root, run.id, compiler.id, claim.leaseToken, {
    Status: "COMPLETED",
    TargetTaskId: target.id,
    PacketOverlay: compilerOverlay,
    Files: [],
    Summary: "Approved the bounded packet.",
    EvidenceRefs: [],
    Blockers: []
  }, config);
  return { root, db, config, run, target, compiler };
}

test("oversized valid compiler overlays authorize from the full structured result", () => {
  const hugeObjective = `Clarify the bounded objective ${"x".repeat(50_000)}`;
  const fixture = approvedCompilerFixture({
    overlay: { ...overlay, ClarifiedObjective: hugeObjective }
  });
  try {
    const result = fixture.db.prepare("SELECT result_json FROM tasks WHERE id = ?").get(fixture.compiler.id);
    const parsed = JSON.parse(result.result_json);
    assert.equal(parsed.Status, "COMPLETED");
    assert.equal(parsed.ResultCompacted, true);
    assert.ok(parsed.StructuredRef);
    assert.ok(JSON.stringify(parsed).length < 10_000);
    assert.ok(parsed.CompiledTargetPacket);
    assert.ok(parsed.CompiledTargetPacket.packetRef);
    assert.equal(getTaskPacket(fixture.db, fixture.target.id, fixture.config).packet.Objective, hugeObjective);
  } finally {
    fixture.db.close();
  }
});

test("compiler StructuredRef fallback rejects a valid foreign structured-result object", () => {
  const hugeObjective = `Clarify the bounded objective ${"x".repeat(50_000)}`;
  const fixture = approvedCompilerFixture({ overlay: { ...overlay, ClarifiedObjective: hugeObjective } });
  try {
    const foreignRef = storeObject(fixture.db, fixture.root, "task-structured-result:foreign-compiler", JSON.stringify({
      Status: "COMPLETED",
      TargetTaskId: fixture.target.id,
      PacketOverlay: { ...overlay, ClarifiedObjective: hugeObjective }
    }), { redact: true });
    const row = fixture.db.prepare("SELECT result_json FROM tasks WHERE id = ?").get(fixture.compiler.id);
    const result = JSON.parse(row.result_json);
    fixture.db.prepare("UPDATE tasks SET result_json = ? WHERE id = ?").run(
      JSON.stringify({ ...result, StructuredRef: foreignRef }), fixture.compiler.id
    );
    assert.throws(
      () => compileTaskPacket(fixture.db, fixture.root, fixture.target.id, fixture.config, {
        overlay: { ...overlay, ClarifiedObjective: hugeObjective },
        compilerTaskId: fixture.compiler.id
      }),
      (error) => error.code === "TASK_PACKET_COMPILER_UNTRUSTED"
    );
  } finally {
    fixture.db.close();
  }
});

test("compiler StructuredRef fallback rejects an authenticated-object payload tamper", () => {
  const hugeObjective = `Clarify the bounded objective ${"x".repeat(50_000)}`;
  const fixture = approvedCompilerFixture({ overlay: { ...overlay, ClarifiedObjective: hugeObjective } });
  try {
    const row = fixture.db.prepare("SELECT result_json FROM tasks WHERE id = ?").get(fixture.compiler.id);
    const result = JSON.parse(row.result_json);
    const objectRow = fixture.db.prepare("SELECT path FROM objects WHERE hash = ?").get(result.StructuredRef.replace(/^obj_/, ""));
    const objectPath = path.join(runtimeArea(fixture.root, "objects"), objectRow.path.replace(/^objects[\\/]/u, ""));
    const payload = readFileSync(objectPath);
    payload[payload.length - 1] ^= 0xff;
    writeFileSync(objectPath, payload);
    assert.throws(
      () => compileTaskPacket(fixture.db, fixture.root, fixture.target.id, fixture.config, {
        overlay: { ...overlay, ClarifiedObjective: hugeObjective },
        compilerTaskId: fixture.compiler.id
      }),
      (error) => error.code === "TASK_PACKET_COMPILER_UNTRUSTED"
    );
  } finally {
    fixture.db.close();
  }
});

test("artifact evidence authenticates its backing object payload", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Authenticate artifact evidence.");
    const artifact = putArtifact(db, root, run.id, "evidence", { value: "authenticated" });
    const ref = normalizeEvidenceRef(db, root, artifact.id);
    assert.equal(evidenceRefIsCurrent(db, root, ref), true);

    const row = db.prepare("SELECT path FROM objects WHERE hash = ?").get(artifact.content_ref.slice("obj_".length));
    const relative = row.path.replace(/^objects[\\/]/u, "");
    const objectPath = path.join(runtimeArea(root, "objects"), relative);
    const payload = readFileSync(objectPath);
    payload[payload.length - 1] ^= 0xff;
    writeFileSync(objectPath, payload);

    assert.equal(evidenceRefIsCurrent(db, root, ref), false);
  } finally {
    db.close();
  }
});

test("LLM packet overlays require the target's authorized compiler", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Authorize packet compilation.");
    forcePhase(db, root, config, run.id, "plan");
    const target = addTask(db, run.id, task("compiler-target"), config);
    const compiler = listTasks(db, run.id).find((item) => item.compilerTargetTaskId === target.id);
    assert.ok(compiler);

    assert.throws(() => compileTaskPacket(db, root, target.id, config, { overlay }),
      (error) => error.code === "TASK_PACKET_COMPILER_REQUIRED");
    assert.throws(() => compileTaskPacket(db, root, target.id, config, { overlay, compilerTaskId: target.id }),
      (error) => error.code === "TASK_PACKET_COMPILER_UNTRUSTED");
    claimTask(db, run.id, compiler.id, "active-compiler", config);
    assert.throws(() => compileTaskPacket(db, root, target.id, config, { overlay, compilerTaskId: compiler.id }),
      (error) => error.code === "TASK_PACKET_COMPILER_UNTRUSTED");
    assert.equal(taskPacketStatus(db, target.id, config).current, false);
  } finally {
    db.close();
  }
});

test("deterministic packets still compile and an approved LLM packet resists direct overwrite", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Preserve packet compilation paths.");
    forcePhase(db, root, config, run.id, "plan");
    const deterministic = addTask(db, run.id, task("deterministic-target", {
      risk: "low", effort: "small", complexity: "low"
    }), config);
    assert.equal(compileTaskPacket(db, root, deterministic.id, config).status, "ready");

    const target = addTask(db, run.id, task("approved-target"), config);
    const compiler = listTasks(db, run.id).find((item) => item.compilerTargetTaskId === target.id);
    const claim = claimTask(db, run.id, compiler.id, "compiler", config);
    finishTask(db, root, run.id, compiler.id, claim.leaseToken, {
      Status: "COMPLETED",
      TargetTaskId: target.id,
      PacketOverlay: overlay,
      Files: [],
      Summary: "Approved the bounded packet.",
      EvidenceRefs: [],
      Blockers: []
    }, config);

    const before = db.prepare("SELECT id, version, packet_hash FROM task_packets WHERE task_id = ? AND status = 'ready'").get(target.id);
    assert.equal(taskPacketStatus(db, target.id, config).current, true);
    assert.throws(() => compileTaskPacket(db, root, target.id, config, { overlay }),
      (error) => error.code === "TASK_PACKET_COMPILER_REQUIRED");
    const after = db.prepare("SELECT id, version, packet_hash FROM task_packets WHERE task_id = ? AND status = 'ready'").get(target.id);
    assert.deepEqual(after, before);
    assert.equal(getTaskPacket(db, target.id, config).packet.Objective, overlay.ClarifiedObjective);
  } finally {
    db.close();
  }
});

test("stale compiler approvals reject target compilation after contract, artifact, or interface drift", () => {
  const cases = [
    {
      name: "contract",
      mutate({ db, target }) {
        db.prepare("UPDATE tasks SET goal = ? WHERE id = ?").run("The target contract changed.", target.id);
      }
    },
    {
      name: "artifact",
      target: { contextRefs: ["artifact:design"] },
      beforeTarget({ db, run }) {
        putArtifact(db, run.project_root, run.id, "design", { selectedApproach: "v1" });
      },
      mutate({ db, root, run }) {
        const replacement = putArtifact(db, root, run.id, "design", { selectedApproach: "v2" });
        db.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?").run("2099-01-01T00:00:00.000Z", replacement.id);
      }
    },
    {
      name: "interface",
      beforeTarget({ db, run }) {
        const v1 = addInterfaceContract(db, run.id, {
          id: "iface-compiler-v1",
          name: "compiler-api",
          description: "Compiler approval interface.",
          status: "frozen",
          schema: { request: { value: "string" } },
          requirementIds: ["REQ-001"]
        });
        return { target: { interfaceInputs: [v1.id] } };
      },
      mutate({ db, run }) {
        const v2 = addInterfaceContract(db, run.id, {
          id: "iface-compiler-v2",
          name: "compiler-api",
          description: "Changed compiler approval interface.",
          status: "draft",
          schema: { request: { value: "string", version: "number" } },
          requirementIds: ["REQ-001"]
        });
        freezeInterfaceContract(db, run.id, v2.id);
      }
    }
  ];

  for (const scenario of cases) {
    const fixture = approvedCompilerFixture({ target: scenario.target, beforeTarget: scenario.beforeTarget });
    try {
      scenario.mutate(fixture);
      assert.equal(taskPacketStatus(fixture.db, fixture.compiler.id, fixture.config).current, false, `${scenario.name} drift must stale compiler packet`);
      assert.equal(taskPacketStatus(fixture.db, fixture.target.id, fixture.config).current, false, `${scenario.name} drift must stale target packet`);
      assert.throws(
        () => compileTaskPacket(fixture.db, fixture.root, fixture.target.id, fixture.config, {
          overlay,
          compilerTaskId: fixture.compiler.id
        }),
        (error) => error.code === "TASK_PACKET_COMPILER_UNTRUSTED"
      );
    } finally {
      fixture.db.close();
    }
  }
});

test("compiler approval is bound to the exact packet identity captured at claim", () => {
  const fixture = approvedCompilerFixture();
  try {
    const before = dbPacket(fixture.db, fixture.compiler.id);
    const recompiled = compileTaskPacket(fixture.db, fixture.root, fixture.compiler.id, fixture.config);
    assert.notEqual(recompiled.id, before.id);
    assert.equal(taskPacketStatus(fixture.db, fixture.compiler.id, fixture.config).current, true);
    assert.throws(
      () => compileTaskPacket(fixture.db, fixture.root, fixture.target.id, fixture.config, {
        overlay,
        compilerTaskId: fixture.compiler.id
      }),
      (error) => error.code === "TASK_PACKET_COMPILER_UNTRUSTED"
    );
  } finally {
    fixture.db.close();
  }
});

function dbPacket(db, taskId) {
  return db.prepare("SELECT id, packet_hash, blueprint_hash FROM task_packets WHERE task_id = ? AND status = 'ready'").get(taskId);
}
