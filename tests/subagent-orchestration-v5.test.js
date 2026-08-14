import assert from "node:assert/strict";
import test from "node:test";
import { buildMainContext, compactTaskContract } from "../src/core/context.js";
import { nextControllerAction } from "../src/core/controller.js";
import { addInterfaceContract, freezeInterfaceContract } from "../src/core/interfaces.js";
import { currentPlanDraftBinding, ingestPlanDraft } from "../src/core/plan-ingest.js";
import { claimSchedule, proposeSchedule } from "../src/core/scheduler.js";
import { advancePhase, gateReport, putArtifact } from "../src/core/state.js";
import { compileTaskPacket, getTaskPacket, taskPacketStatus } from "../src/core/task-packets.js";
import { addTask, claimTask, finishTask, getTask, listTasks, sealPlan, taskContract } from "../src/core/tasks.js";
import { forcePhase, makeProject, startTestRun } from "./helpers.js";

function boundedTask(id, options = {}) {
  return {
    id,
    title: options.title ?? id,
    goal: options.goal ?? `Complete ${id}`,
    role: options.role ?? "worker",
    taskKind: options.taskKind,
    runPhase: options.runPhase ?? "execute",
    wave: options.wave ?? 1,
    readOnly: options.readOnly ?? true,
    targetPaths: options.targetPaths ?? [],
    scope: options.scope ?? [id],
    nonGoals: options.nonGoals ?? ["Do not expand the declared scope."],
    constraints: options.constraints ?? ["Preserve frozen interfaces."],
    acceptanceCriteria: options.acceptanceCriteria ?? [`${id} has current verification evidence.`],
    requiredEvidence: options.requiredEvidence ?? [],
    expectedOutputs: options.expectedOutputs ?? ["structured-result"],
    requirementIds: options.requirementIds ?? ["REQ-001"],
    dependsOn: options.dependsOn ?? [],
    risk: options.risk ?? "medium",
    effort: options.effort ?? "medium",
    complexity: options.complexity ?? "medium",
    verificationModes: options.verificationModes,
    capabilities: options.capabilities,
    contextRefs: options.contextRefs,
    interfaceInputs: options.interfaceInputs,
    interfaceOutputs: options.interfaceOutputs
  };
}

function fourSlicePlanDraft({ description = "Shared slice result contract." } = {}) {
  return {
    parallelism: {
      eligible: true,
      independentSlices: 4,
      desiredWidth: 4,
      minimumSameWaveImplementationTasks: 4,
      rationale: "Four independent source slices have disjoint paths and no dependencies."
    },
    interfaces: [{
      id: "slice-result-v1",
      name: "slice-result",
      description,
      schema: { value: "string" },
      requirementIds: ["REQ-001"]
    }],
    milestones: [{
      id: "m-slices",
      title: "Complete four slices",
      objective: "All independent source slices return their complete values.",
      userVisibleOutcome: "All four slice behaviors are complete.",
      exitCriteria: ["REQ-001 is implemented and verified."],
      requirementIds: ["REQ-001"],
      dependsOn: []
    }],
    tasks: Array.from({ length: 4 }, (_, index) => ({
      id: `slice-${index + 1}`,
      title: `Implement slice ${index + 1}`,
      goal: `Return the complete value for slice ${index + 1}.`,
      role: "worker",
      taskKind: "implementation",
      runPhase: "execute",
      wave: 1,
      milestoneId: "m-slices",
      readOnly: false,
      targetPaths: [`src/slice-${index + 1}.js`],
      scope: [`src/slice-${index + 1}.js`],
      acceptanceCriteria: [`slice-${index + 1}.js returns its complete value.`],
      requiredEvidence: ["Current test evidence"],
      expectedOutputs: ["implementation"],
      requirementIds: ["REQ-001"],
      dependsOn: [],
      interfaceInputs: [],
      interfaceOutputs: [],
      risk: "low",
      effort: "small",
      complexity: "low"
    }))
  };
}

test("deterministic task packets compile role, scope, context, capability procedure, and result schema", () => {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "deterministic" } } });
  try {
    const { run } = startTestRun(db, root, config, "Implement a login interface");
    forcePhase(db, root, config, run.id, "plan");
    putArtifact(db, root, run.id, "design", { selectedApproach: "Reuse the current form primitives.", interfaces: ["login-api-v1"] });
    addTask(db, run.id, boundedTask("login-ui", {
      readOnly: false,
      targetPaths: ["app/login/LoginForm.tsx"],
      scope: ["Implement login form interaction states."],
      capabilities: ["frontend-ui"],
      verificationModes: ["test", "browser"],
      contextRefs: ["artifact:design"]
    }), config);

    const state = getTaskPacket(db, "login-ui", config);
    assert.equal(state.policy, "deterministic");
    assert.match(state.packet.Prompt, /# ROLE\nworker/);
    assert.match(state.packet.Prompt, /# REQUIREMENTS/);
    assert.match(state.packet.Prompt, /REQ-001/);
    assert.match(state.packet.Prompt, /# WHY/);
    assert.match(state.packet.Prompt, /The requested repository change is implemented and verified/);
    assert.match(state.packet.Prompt, /# OWNED SCOPE/);
    assert.match(state.packet.Prompt, /app\/login\/LoginForm\.tsx/);
    assert.match(state.packet.Prompt, /Reuse the repository's components, tokens, layout rules/);
    assert.match(state.packet.Prompt, /# RESULT SCHEMA/);
    assert.equal(state.packet.Context.Selected[0].Ref, "artifact:design");
    assert.match(state.packet.Context.Selected[0].Content, /current form primitives/);

    const contract = taskContract(db, "login-ui");
    assert.match(contract.CompiledPrompt, /# CAPABILITY PROCEDURES/);
    assert.equal(contract.TaskPacket.Content.TaskId, "login-ui");
  } finally {
    db.close();
  }
});

test("a clipped host contract retains an executable packet load command", () => {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "deterministic" } } });
  try {
    const { run } = startTestRun(db, root, config, "Load a clipped task packet");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, boundedTask("large-packet", {
      scope: Array.from({ length: 30 }, (_, index) => `Detailed scope item ${index}`),
      acceptanceCriteria: Array.from({ length: 30 }, (_, index) => `Acceptance criterion ${index}`)
    }), config);
    const contract = taskContract(db, "large-packet");
    const compact = compactTaskContract(contract, 220, { db, config, model: contract.Model });
    const parsed = JSON.parse(compact.content);
    assert.equal(compact.truncated, true);
    assert.ok(parsed.Packet.ContentRef);
    assert.equal(parsed.Packet.LoadCommand.command, process.execPath);
    assert.match(parsed.PacketLoadInstruction, /object get/);
  } finally {
    db.close();
  }
});

test("complex or high-risk tasks use a fresh task-compiler before dispatch", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Implement a sensitive change");
    forcePhase(db, root, config, run.id, "plan");
    const target = addTask(db, run.id, boundedTask("sensitive-worker", {
      readOnly: false,
      targetPaths: ["src/auth/session.js"],
      risk: "high",
      effort: "large",
      complexity: "high",
      capabilities: ["security"]
    }), config);
    assert.equal(target.contractStatus, "needs-compiler");
    const compiler = listTasks(db, run.id).find((item) => item.compilerTargetTaskId === target.id);
    assert.ok(compiler);
    assert.equal(compiler.role, "task-compiler");
    assert.deepEqual(target.dependsOn, [compiler.id]);
    assert.equal(taskPacketStatus(db, target.id, config).current, false);

    const proposal = proposeSchedule(db, root, run.id, config);
    assert.deepEqual(proposal.batch.map((item) => item.taskId), [compiler.id]);
    const claim = claimTask(db, run.id, compiler.id, "compiler", config);
    assert.equal(claim.contract.TaskPacket.Content.CompilerTarget.TaskId, target.id);
    assert.deepEqual(claim.contract.TaskPacket.Content.CompilerTarget.TargetPaths, ["src/auth/session.js"]);
    assert.match(claim.contract.CompiledPrompt, /# COMPILER TARGET BLUEPRINT/);
    finishTask(db, root, run.id, compiler.id, claim.leaseToken, {
      Status: "COMPLETED",
      TargetTaskId: target.id,
      PacketOverlay: {
        ClarifiedObjective: "Update the session path without changing the public session interface.",
        ExecutionSteps: ["Read the frozen interface.", "Implement the bounded change.", "Run the auth tests."],
        ContextPriorities: ["session interface", "current auth tests"],
        InterfaceNotes: [],
        VerificationPlan: ["test"],
        AdditionalStopConditions: [],
        HandoffNotes: [],
        Ambiguities: []
      },
      Files: [],
      Summary: "Compiled a bounded execution packet.",
      EvidenceRefs: [],
      Blockers: []
    }, config);

    const ready = taskPacketStatus(db, target.id, config);
    assert.equal(ready.current, true);
    assert.equal(ready.policy, "llm");
    assert.match(getTaskPacket(db, target.id, config).packet.Prompt, /without changing the public session interface/);
  } finally {
    db.close();
  }
});

test("plan-time compiler tasks share one parallel compilation wave", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Compile future execution waves in parallel");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, boundedTask("later-wave-sensitive", {
      wave: 4,
      risk: "high",
      effort: "large",
      complexity: "high"
    }), config);
    const compiler = listTasks(db, run.id).find((task) => task.role === "task-compiler");
    assert.ok(compiler);
    assert.equal(compiler.phase, "plan");
    assert.equal(compiler.wave, 1);
  } finally {
    db.close();
  }
});

test("task compiler overlays cannot change protected contract fields and ambiguities block dispatch", () => {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "llm" } } });
  try {
    const { run } = startTestRun(db, root, config, "Compile a bounded task");
    forcePhase(db, root, config, run.id, "plan");
    const target = addTask(db, run.id, boundedTask("compiled-target", {
      readOnly: false,
      targetPaths: ["src/value.js"]
    }), config);
    assert.throws(() => compileTaskPacket(db, root, target.id, config, {
      overlay: { TargetPaths: ["."] }
    }), (error) => error.code === "TASK_PACKET_PROTECTED_FIELD");

    const blocked = compileTaskPacket(db, root, target.id, config, {
      overlay: { Ambiguities: ["The public return type is not defined."] }
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(getTask(db, target.id).contractStatus, "blocked");
  } finally {
    db.close();
  }
});

test("frozen interfaces are injected and a replacement invalidates linked task packets", () => {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "deterministic" } } });
  try {
    const { run } = startTestRun(db, root, config, "Use a frozen API contract");
    forcePhase(db, root, config, run.id, "plan");
    const v1 = addInterfaceContract(db, run.id, {
      id: "iface-login-v1",
      name: "login-api",
      description: "Login request and response contract.",
      status: "frozen",
      schema: { request: { email: "string" }, response: { ok: "boolean" } },
      requirementIds: ["REQ-001"]
    });
    addTask(db, run.id, boundedTask("api-consumer", {
      interfaceInputs: [v1.id]
    }), config);
    const packet = getTaskPacket(db, "api-consumer", config);
    assert.equal(packet.packet.InterfaceContracts[0].Name, "login-api");
    assert.equal(packet.packet.InterfaceContracts[0].Version, 1);

    const v2 = addInterfaceContract(db, run.id, {
      id: "iface-login-v2",
      name: "login-api",
      description: "Login request and response contract with error code.",
      status: "draft",
      schema: { request: { email: "string" }, response: { ok: "boolean", errorCode: "string|null" } },
      requirementIds: ["REQ-001"]
    });
    freezeInterfaceContract(db, run.id, v2.id);
    assert.equal(taskPacketStatus(db, "api-consumer", config).current, false);
    assert.equal(getTask(db, "api-consumer").contractStatus, "stale");
  } finally {
    db.close();
  }
});



test("completed tasks attest the exact frozen interface versions they consume and produce", () => {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "deterministic" } } });
  try {
    const { run } = startTestRun(db, root, config, "Use an exact shared interface");
    forcePhase(db, root, config, run.id, "plan");
    const contract = addInterfaceContract(db, run.id, {
      id: "iface-shared-v1",
      name: "shared-value",
      description: "Exact value exchanged by two tasks.",
      status: "frozen",
      schema: { value: "number" },
      requirementIds: ["REQ-001"]
    });
    const task = addTask(db, run.id, boundedTask("interface-consumer", {
      interfaceInputs: [contract.id]
    }), config);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, task.id, "worker", config);

    assert.throws(() => finishTask(db, root, run.id, task.id, claim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Used the shared value.",
      InterfaceReport: {
        Consumed: [{ Id: contract.id, ContentHash: "stale-hash" }],
        Produced: [],
        Changed: []
      },
      EvidenceRefs: [],
      Blockers: []
    }, config), (error) => error.code === "TASK_INTERFACE_HASH_MISMATCH");

    const completed = finishTask(db, root, run.id, task.id, claim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Used the exact frozen shared value contract.",
      InterfaceReport: {
        Consumed: [{ Id: contract.id, Name: contract.name, ContentHash: contract.content_hash }],
        Produced: [],
        Changed: []
      },
      EvidenceRefs: [],
      Blockers: []
    }, config);
    assert.equal(completed.status, "completed");
  } finally {
    db.close();
  }
});

test("the scheduler dispatches only the earliest open wave", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 4 } } });
  try {
    const { run } = startTestRun(db, root, config, "Run work in waves");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, boundedTask("wave-1-a", { wave: 1 }), config);
    addTask(db, run.id, boundedTask("wave-1-b", { wave: 1 }), config);
    addTask(db, run.id, boundedTask("wave-2", { wave: 2 }), config);
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, { owner: "main" });
    assert.equal(claimed.wave, 1);
    assert.deepEqual(new Set(claimed.batch.map((item) => item.taskId)), new Set(["wave-1-a", "wave-1-b"]));
    assert.ok(claimed.deferred.some((item) => item.taskId === "wave-2") || !claimed.batch.some((item) => item.taskId === "wave-2"));
  } finally {
    db.close();
  }
});

test("a running or blocked earlier wave prevents later-wave dispatch", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 4 } } });
  try {
    const { run } = startTestRun(db, root, config, "Keep wave barriers strict");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, boundedTask("wave-1-running", { wave: 1 }), config);
    addTask(db, run.id, boundedTask("wave-2-ready", { wave: 2 }), config);
    forcePhase(db, root, config, run.id, "execute");

    claimTask(db, run.id, "wave-1-running", "worker", config);
    let proposal = proposeSchedule(db, root, run.id, config);
    assert.equal(proposal.wave, 1);
    assert.deepEqual(proposal.batch, []);

    db.prepare("UPDATE tasks SET status = 'blocked', owner = NULL WHERE id = ?").run("wave-1-running");
    db.prepare("DELETE FROM leases WHERE task_id = ?").run("wave-1-running");
    proposal = proposeSchedule(db, root, run.id, config);
    assert.equal(proposal.wave, 1);
    assert.deepEqual(proposal.batch, []);
  } finally {
    db.close();
  }
});

test("discovery is a scout fan-out followed by a synthesizer, never Main repository work", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Understand the repository");
    forcePhase(db, root, config, run.id, "discover");
    const first = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(first.type, "CREATE_DISCOVERY_WAVE");
    assert.equal(first.taskSpecs.length, 3);
    assert.ok(first.taskSpecs.every((item) => item.role === "scout" && item.wave === 1));
    assert.match(first.instruction, /Main must not inspect the repository directly/);

    for (let index = 0; index < first.taskSpecs.length; index += 1) {
      const task = addTask(db, run.id, { id: `scout-${index + 1}`, ...first.taskSpecs[index] }, config);
      const claim = claimTask(db, run.id, task.id, "scout", config);
      finishTask(db, root, run.id, task.id, claim.leaseToken, {
        Status: "COMPLETED",
        Files: [],
        Summary: `Completed ${task.id}.`,
        Facts: [`fact-${index + 1}`],
        Unknowns: [],
        RelevantPaths: ["src"],
        Interfaces: [],
        Risks: [],
        EvidenceRefs: [],
        Blockers: []
      }, config);
    }
    const second = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(second.type, "CREATE_DISCOVERY_SYNTHESIS");
    assert.equal(second.taskSpecs[0].role, "synthesizer");
    assert.equal(second.taskSpecs[0].dependsOn.length, 3);
    assert.deepEqual(second.taskSpecs[0].constraints, [
      "ArtifactContent must use lowercase scope, knownFacts, and unknowns fields.",
      "Do not emit a duplicate discovery in ProducedArtifacts."
    ]);
    assert.ok(second.taskSpecs[0].acceptanceCriteria.includes("ArtifactContent.scope is a non-empty string array."));
    assert.ok(second.taskSpecs[0].acceptanceCriteria.includes("ArtifactContent.knownFacts is an array."));
    assert.ok(second.taskSpecs[0].acceptanceCriteria.includes("ArtifactContent.unknowns is an array."));
    assert.ok(second.taskSpecs[0].acceptanceCriteria.includes("ProducedArtifacts is empty; emit the canonical discovery only through ArtifactKind and ArtifactContent."));
    assert.match(second.instruction, /Main must not write the discovery artifact itself/);
  } finally {
    db.close();
  }
});

test("discovery synthesis contract rejects uppercase-only artifacts and accepts one canonical lowercase artifact", () => {
  const runCase = (artifactContent) => {
    const { root, db, config } = makeProject();
    const { run } = startTestRun(db, root, config, "Validate discovery artifact shape");
    forcePhase(db, root, config, run.id, "discover");
    const scout = addTask(db, run.id, {
      id: "shape-scout",
      ...boundedTask("shape-scout", { role: "scout", taskKind: "discovery", runPhase: "discover" })
    }, config);
    const scoutClaim = claimTask(db, run.id, scout.id, "scout", config);
    finishTask(db, root, run.id, scout.id, scoutClaim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Supplied discovery evidence.",
      Facts: ["The source is independently testable."],
      Unknowns: [],
      RelevantPaths: ["src/value.js"],
      Interfaces: [],
      Risks: [],
      EvidenceRefs: [],
      Blockers: []
    }, config);
    const synthesisAction = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(synthesisAction.type, "CREATE_DISCOVERY_SYNTHESIS");
    const synthesis = addTask(db, run.id, synthesisAction.taskSpecs[0], config);
    const synthesisClaim = claimTask(db, run.id, synthesis.id, "synthesizer", config);
    finishTask(db, root, run.id, synthesis.id, synthesisClaim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Produced the discovery artifact.",
      ArtifactKind: "discovery",
      ArtifactContent: artifactContent,
      ProducedArtifacts: [],
      EvidenceRefs: [],
      Blockers: []
    }, config);
    return { root, db, config, run };
  };

  const invalid = runCase({ Facts: ["legacy uppercase payload"], Unknowns: [] });
  try {
    const report = gateReport(invalid.db, invalid.root, invalid.run.id, "research");
    assert.equal(report.pass, false);
    assert.ok(report.failures.includes("Discovery must define scope."));
    assert.ok(report.failures.includes("Discovery must define knownFacts."));
  } finally {
    invalid.db.close();
  }

  const valid = runCase({ scope: ["src/value.js"], knownFacts: ["The source is independently testable."], unknowns: [] });
  try {
    const advanced = advancePhase(valid.db, valid.root, valid.run.id, "research");
    assert.equal(advanced.run.phase, "research");
    assert.equal(valid.db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind = 'discovery'").get(valid.run.id).count, 1);
  } finally {
    valid.db.close();
  }
});

test("planner output is ingested into frozen interfaces, milestones, task waves, and compiler tasks", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Plan a parallel feature");
    forcePhase(db, root, config, run.id, "plan");
    const planner = addTask(db, run.id, boundedTask("planner", {
      role: "planner",
      taskKind: "planning",
      runPhase: "plan",
      expectedOutputs: ["plan-draft"]
    }), config);
    const claim = claimTask(db, run.id, planner.id, "planner", config);
    finishTask(db, root, run.id, planner.id, claim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Created a bounded plan draft.",
      PlanDraft: {
        parallelism: {
          eligible: false,
          independentSlices: 1,
          desiredWidth: 1,
          minimumSameWaveImplementationTasks: 4,
          rationale: "The producer and verifier are intentionally coupled."
        },
        interfaces: [{
          id: "api-v1",
          name: "value-api",
          description: "Value API shared by producer and consumer.",
          schema: { value: "number" },
          requirementIds: ["REQ-001"]
        }],
        milestones: [{
          id: "m1",
          title: "Deliver value flow",
          objective: "A caller can read the verified value.",
          userVisibleOutcome: "A caller receives the expected value.",
          exitCriteria: ["REQ-001 is implemented and verified."],
          requirementIds: ["REQ-001"],
          dependsOn: []
        }],
        tasks: [
          {
            id: "producer",
            title: "Implement producer",
            goal: "Implement the bounded producer.",
            role: "worker",
            taskKind: "implementation",
            runPhase: "execute",
            wave: 1,
            milestoneId: "m1",
            readOnly: false,
            targetPaths: ["src/producer.js"],
            scope: ["src/producer.js"],
            nonGoals: [],
            constraints: [],
            acceptanceCriteria: ["Producer returns the frozen value shape."],
            requiredEvidence: ["test"],
            expectedOutputs: ["implementation"],
            requirementIds: ["REQ-001"],
            dependsOn: [],
            interfaceInputs: [],
            interfaceOutputs: ["api-v1"],
            allowInterfaceChange: false,
            risk: "high",
            effort: "large",
            complexity: "high"
          },
          {
            id: "verify-value",
            title: "Verify value flow",
            goal: "Verify the integrated value behavior.",
            role: "verifier",
            taskKind: "verification",
            runPhase: "verify",
            wave: 2,
            milestoneId: "m1",
            readOnly: true,
            targetPaths: [],
            scope: ["value flow"],
            nonGoals: [],
            constraints: [],
            acceptanceCriteria: ["The caller receives the expected value."],
            requiredEvidence: ["current command evidence"],
            expectedOutputs: ["verification"],
            requirementIds: ["REQ-001"],
            interfaceInputs: ["api-v1"],
            interfaceOutputs: [],
            dependsOn: ["producer"]
          }
        ]
      },
      EvidenceRefs: [],
      Blockers: []
    }, config);

    const receipt = ingestPlanDraft(db, root, run.id, planner.id, config);
    assert.deepEqual(receipt.milestoneIds, ["m1"]);
    assert.deepEqual(new Set(receipt.taskIds), new Set(["producer", "verify-value"]));
    assert.equal(getTask(db, "producer").contractStatus, "needs-compiler");
    assert.equal(receipt.compilerTaskIds.length, 1);
    assert.equal(getTask(db, "verify-value").interfaceContracts[0].name, "value-api");
  } finally {
    db.close();
  }
});

test("plan draft interfaces fail closed on missing description before materialization", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject an incomplete interface contract");
    forcePhase(db, root, config, run.id, "plan");
    const planner = addTask(db, run.id, boundedTask("missing-interface-description", {
      role: "planner",
      taskKind: "planning",
      runPhase: "plan",
      readOnly: true,
      scope: ["planner output"],
      expectedOutputs: ["plan-draft"]
    }), config);
    const claim = claimTask(db, run.id, planner.id, "planner", config);
    finishTask(db, root, run.id, planner.id, claim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Returned an incomplete interface draft.",
      PlanDraft: fourSlicePlanDraft({ description: "" }),
      EvidenceRefs: [],
      Blockers: []
    }, config);

    assert.throws(() => ingestPlanDraft(db, root, run.id, planner.id, config), (error) => error.code === "INTERFACE_FIELDS");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM interface_contracts WHERE run_id = ?").get(run.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM milestones WHERE run_id = ?").get(run.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id <> ?").get(run.id, planner.id).count, 0);
  } finally {
    db.close();
  }
});

test("plan draft interfaces reject wrong raw field types atomically", () => {
  const cases = [
    { label: "object description", code: "INTERFACE_FIELDS", mutate: (item) => { item.description = {}; } },
    { label: "numeric description", code: "INTERFACE_FIELDS", mutate: (item) => { item.description = 123; } },
    { label: "numeric id", code: "PLAN_DRAFT_INTERFACE", mutate: (item) => { item.id = 123; } },
    { label: "numeric name", code: "PLAN_DRAFT_INTERFACE", mutate: (item) => { item.name = 123; } },
    { label: "object requirement id", code: "INTERFACE_REQUIREMENTS", mutate: (item) => { item.requirementIds = [{}]; } },
    { label: "numeric requirement id", code: "INTERFACE_REQUIREMENTS", mutate: (item) => { item.requirementIds = [123]; } },
    { label: "array schema", code: "INTERFACE_SCHEMA", mutate: (item) => { item.schema = []; } }
  ];

  for (const testCase of cases) {
    const { root, db, config } = makeProject();
    try {
      const { run } = startTestRun(db, root, config, `Reject ${testCase.label} in an interface contract`);
      forcePhase(db, root, config, run.id, "plan");
      const planner = addTask(db, run.id, boundedTask(`invalid-${testCase.label.replaceAll(" ", "-")}`, {
        role: "planner",
        taskKind: "planning",
        runPhase: "plan",
        readOnly: true,
        scope: ["planner output"],
        expectedOutputs: ["plan-draft"]
      }), config);
      const claim = claimTask(db, run.id, planner.id, "planner", config);
      const draft = fourSlicePlanDraft();
      testCase.mutate(draft.interfaces[0]);
      finishTask(db, root, run.id, planner.id, claim.leaseToken, {
        Status: "COMPLETED",
        Files: [],
        Summary: `Returned a draft with a ${testCase.label}.`,
        PlanDraft: draft,
        EvidenceRefs: [],
        Blockers: []
      }, config);

      assert.throws(() => ingestPlanDraft(db, root, run.id, planner.id, config), (error) => error.code === testCase.code);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM interface_contracts WHERE run_id = ?").get(run.id).count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM milestones WHERE run_id = ?").get(run.id).count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id <> ?").get(run.id, planner.id).count, 0);
    } finally {
      db.close();
    }
  }
});

test("valid four-slice PlanDraft materializes exactly four same-wave implementation tasks", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Materialize four independent slices");
    forcePhase(db, root, config, run.id, "plan");
    const planner = addTask(db, run.id, boundedTask("four-slice-planner", {
      role: "planner",
      taskKind: "planning",
      runPhase: "plan",
      readOnly: true,
      scope: ["planner output"],
      expectedOutputs: ["plan-draft"]
    }), config);
    const claim = claimTask(db, run.id, planner.id, "planner", config);
    finishTask(db, root, run.id, planner.id, claim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Returned four independent source-slice tasks.",
      PlanDraft: fourSlicePlanDraft(),
      EvidenceRefs: [],
      Blockers: []
    }, config);

    const receipt = ingestPlanDraft(db, root, run.id, planner.id, config);
    const tasks = listTasks(db, run.id).filter((task) => task.phase === "execute" && task.role === "worker");
    assert.equal(receipt.taskIds.length, 4);
    assert.equal(tasks.length, 4);
    assert.deepEqual(new Set(tasks.map((task) => task.wave)), new Set([1]));
    assert.deepEqual(new Set(tasks.flatMap((task) => task.targetPaths)), new Set([
      "src/slice-1.js", "src/slice-2.js", "src/slice-3.js", "src/slice-4.js"
    ]));
  } finally {
    db.close();
  }
});

test("PlanDraft rejects measured unsupported independent-review task kind before materialization", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject unsupported reviewer task kind");
    forcePhase(db, root, config, run.id, "plan");
    const planner = addTask(db, run.id, boundedTask("unsupported-kind-planner", {
      role: "planner", taskKind: "planning", runPhase: "plan", readOnly: true,
      scope: ["planner output"], expectedOutputs: ["plan-draft"]
    }), config);
    const claim = claimTask(db, run.id, planner.id, "planner", config);
    const draft = fourSlicePlanDraft();
    draft.tasks.push({
      id: "task-independent-review", title: "Independently review the integrated change",
      goal: "Review the integrated change without modifying it.", role: "reviewer",
      taskKind: "independent-review", runPhase: "review", wave: 2, milestoneId: "m-slices",
      readOnly: true, targetPaths: [], scope: ["integrated change"], nonGoals: [], constraints: [],
      acceptanceCriteria: ["Return an evidence-backed review."], requiredEvidence: ["Current source evidence"],
      expectedOutputs: ["review"], requirementIds: ["REQ-001"], dependsOn: draft.tasks.map((task) => task.id),
      interfaceInputs: [], interfaceOutputs: []
    });
    finishTask(db, root, run.id, planner.id, claim.leaseToken, {
      Status: "COMPLETED", Files: [], Summary: "Returned the measured unsupported task kind.",
      PlanDraft: draft, EvidenceRefs: [], Blockers: []
    }, config);
    assert.throws(() => ingestPlanDraft(db, root, run.id, planner.id, config), (error) => {
      assert.equal(error.code, "TASK_KIND_INVALID");
      assert.match(error.message, /independent-review/);
      return true;
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id <> ?").get(run.id, planner.id).count, 0);
  } finally {
    db.close();
  }
});

test("canonical review task kinds ingest and seal the complete four-slice plan", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Ingest the complete four-slice plan");
    forcePhase(db, root, config, run.id, "plan");
    const planner = addTask(db, run.id, boundedTask("complete-plan-planner", {
      role: "planner", taskKind: "planning", runPhase: "plan", readOnly: true,
      scope: ["planner output"], expectedOutputs: ["plan-draft"]
    }), config);
    const claim = claimTask(db, run.id, planner.id, "planner", config);
    const draft = fourSlicePlanDraft();
    for (const task of draft.tasks) {
      task.milestoneId = null;
      task.interfaceInputs = ["slice-result-v1"];
    }
    const implementationIds = draft.tasks.map((task) => task.id);
    draft.tasks.push(
      {
        id: "task-integrate-slices", title: "Integrate all four completed slices",
        goal: "Integrate the four completed slices without changing their frozen contract.", role: "integrator", taskKind: "integration",
        runPhase: "execute", wave: 2, milestoneId: null, readOnly: true, targetPaths: [],
        scope: ["four completed slices"], nonGoals: [], constraints: [], acceptanceCriteria: ["All four slices are integrated."],
        requiredEvidence: ["Current integration evidence"], expectedOutputs: ["integration"], requirementIds: ["REQ-001"],
        dependsOn: implementationIds, interfaceInputs: ["slice-result-v1"], interfaceOutputs: []
      },
      {
        id: "task-independent-review", title: "Independently review the integrated change",
        goal: "Review the integrated change without modifying it.", role: "reviewer", taskKind: "review",
        runPhase: "review", wave: 3, milestoneId: null, readOnly: true, targetPaths: [],
        scope: ["integrated change"], nonGoals: [], constraints: [], acceptanceCriteria: ["Return an evidence-backed review."],
        requiredEvidence: ["Current source evidence"], expectedOutputs: ["review"], requirementIds: ["REQ-001"],
        dependsOn: ["task-integrate-slices"], interfaceInputs: ["slice-result-v1"], interfaceOutputs: []
      },
      {
        id: "task-adversarial-review", title: "Adversarially review the completion candidate",
        goal: "Challenge the completion candidate for hidden failures.", role: "adversarial-reviewer", taskKind: "review",
        runPhase: "verify", wave: 3, milestoneId: null, readOnly: true, targetPaths: [],
        scope: ["completion candidate"], nonGoals: [], constraints: [], acceptanceCriteria: ["Return an explicit adversarial verdict."],
        requiredEvidence: ["Current candidate evidence"], expectedOutputs: ["adversarial-review"], requirementIds: ["REQ-001"],
        dependsOn: ["task-independent-review"], interfaceInputs: ["slice-result-v1"], interfaceOutputs: []
      },
      {
        id: "task-final-verification", title: "Run final integrated verification",
        goal: "Verify all four slices and authorized changes.", role: "verifier", taskKind: "verification",
        runPhase: "verify", wave: 4, milestoneId: null, readOnly: true, targetPaths: [],
        scope: ["four-slice result"], nonGoals: [], constraints: [], acceptanceCriteria: ["All four slices pass verification."],
        requiredEvidence: ["Final verifier output"], expectedOutputs: ["verification"], requirementIds: ["REQ-001"],
        dependsOn: ["task-adversarial-review"], interfaceInputs: ["slice-result-v1"], interfaceOutputs: []
      },
      {
        id: "task-curate-evidence", title: "Curate completion evidence",
        goal: "Curate the final evidence without changing the repository.", role: "curator", taskKind: "curation",
        runPhase: "curate", wave: 5, milestoneId: null, readOnly: true, targetPaths: [],
        scope: ["completion evidence"], nonGoals: [], constraints: [], acceptanceCriteria: ["Completion evidence is current and complete."],
        requiredEvidence: ["Current completion evidence"], expectedOutputs: ["curation"], requirementIds: ["REQ-001"],
        dependsOn: ["task-final-verification"], interfaceInputs: ["slice-result-v1"], interfaceOutputs: []
      }
    );
    finishTask(db, root, run.id, planner.id, claim.leaseToken, {
      Status: "COMPLETED", Files: [], Summary: "Returned the canonical complete four-slice plan.",
      PlanDraft: draft, EvidenceRefs: [], Blockers: []
    }, config);

    const receipt = ingestPlanDraft(db, root, run.id, planner.id, config);
    const binding = currentPlanDraftBinding(db, root, run.id);
    assert.equal(binding.plannedGraphFingerprint, receipt.plannedGraphFingerprint);
    assert.equal(receipt.taskIds.length, 9);
    const materialized = listTasks(db, run.id).filter((task) => task.phase !== "plan");
    assert.equal(materialized.length, 9);
    assert.equal(materialized.filter((task) => task.phase === "execute" && task.wave === 1).length, 4);
    assert.equal(materialized.find((task) => task.id === "task-independent-review").taskKind, "review");
    assert.equal(materialized.find((task) => task.id === "task-adversarial-review").taskKind, "review");
    assert.equal(materialized.find((task) => task.id === "task-final-verification").taskKind, "verification");
    compileTaskPacket(db, root, "slice-1", config);
    assert.equal(currentPlanDraftBinding(db, root, run.id).plannedGraphFingerprint, receipt.plannedGraphFingerprint);
    const sealed = sealPlan(db, run.id, config);
    assert.equal(sealed.content.tasks.filter((task) => task.runPhase === "execute").length, 5);
    putArtifact(db, root, run.id, "plan", sealed.content, { status: "verified" });
    db.prepare("UPDATE tasks SET wave = 2 WHERE id = ?").run("slice-1");
    assert.throws(() => currentPlanDraftBinding(db, root, run.id), (error) => error.code === "PLAN_DRAFT_GRAPH_MISMATCH");
    db.prepare("UPDATE tasks SET wave = 1 WHERE id = ?").run("slice-1");
    const packetRefs = db.prepare(`
      SELECT task_id, packet_ref
      FROM task_packets
      WHERE task_id IN (?, ?) AND status = 'ready'
      ORDER BY task_id
    `).all("slice-1", "slice-2");
    const sliceOnePacketRef = packetRefs.find((row) => row.task_id === "slice-1").packet_ref;
    const sliceTwoPacketRef = packetRefs.find((row) => row.task_id === "slice-2").packet_ref;
    assert.notEqual(sliceOnePacketRef, sliceTwoPacketRef);
    db.prepare("UPDATE task_packets SET packet_ref = ? WHERE task_id = ? AND status = 'ready'")
      .run(sliceTwoPacketRef, "slice-1");
    assert.doesNotThrow(() => currentPlanDraftBinding(db, root, run.id));
    db.prepare("UPDATE task_packets SET packet_ref = ? WHERE task_id = ? AND status = 'ready'")
      .run(sliceOnePacketRef, "slice-1");
    const packet = db.prepare("SELECT packet_json FROM task_packets WHERE task_id = ? AND status = 'ready'").get("slice-1");
    const packetData = JSON.parse(packet.packet_json);
    packetData.Objective = "tampered packet objective";
    db.prepare("UPDATE task_packets SET packet_json = ? WHERE task_id = ? AND status = 'ready'").run(JSON.stringify(packetData), "slice-1");
    assert.doesNotThrow(() => currentPlanDraftBinding(db, root, run.id));
  } finally {
    db.close();
  }
});

test("planner action ingests the draft before sealing the exact four-task execution wave", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Drive the planner action into four workers");
    forcePhase(db, root, config, run.id, "plan");
    const planner = addTask(db, run.id, boundedTask("action-planner", {
      role: "planner", taskKind: "planning", runPhase: "plan", readOnly: true,
      scope: ["planner output"], expectedOutputs: ["plan-draft"]
    }), config);
    const claim = claimTask(db, run.id, planner.id, "planner", config);
    finishTask(db, root, run.id, planner.id, claim.leaseToken, {
      Status: "COMPLETED", Files: [], Summary: "Returned a canonical four-slice draft.",
      PlanDraft: fourSlicePlanDraft(), EvidenceRefs: [], Blockers: []
    }, config);

    const ingestAction = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(ingestAction.type, "INGEST_PLAN_DRAFT");
    assert.equal(ingestAction.command, `metis plan ingest ${planner.id} --pretty`);
    assert.match(ingestAction.instruction, /materialize/i);

    const receipt = ingestPlanDraft(db, root, run.id, planner.id, config);
    assert.ok(db.prepare("SELECT 1 FROM artifacts WHERE id = ? AND kind = ? AND status = 'verified'").get(receipt.artifactId, `plan-draft-ingested:${planner.id}`));
    const sealAction = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(sealAction.type, "SEAL_PLAN");
    const sealed = sealPlan(db, run.id, config);
    putArtifact(db, root, run.id, "plan", sealed.content, { status: "verified" });
    const workers = listTasks(db, run.id).filter((task) => task.phase === "execute" && task.role === "worker");
    assert.equal(workers.length, 4);
    assert.deepEqual(new Set(workers.map((task) => task.wave)), new Set([1]));
    assert.deepEqual(new Set(workers.flatMap((task) => task.targetPaths)), new Set([
      "src/slice-1.js", "src/slice-2.js", "src/slice-3.js", "src/slice-4.js"
    ]));
  } finally {
    db.close();
  }
});

test("PlanDraft rejects a review role scheduled in execute before materialization", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject a role-phase mismatch");
    forcePhase(db, root, config, run.id, "plan");
    const planner = addTask(db, run.id, boundedTask("role-phase-planner", {
      role: "planner", taskKind: "planning", runPhase: "plan", readOnly: true,
      scope: ["planner output"], expectedOutputs: ["plan-draft"]
    }), config);
    const claim = claimTask(db, run.id, planner.id, "planner", config);
    const draft = fourSlicePlanDraft();
    draft.tasks[0].role = "reviewer";
    draft.tasks[0].taskKind = "review";
    finishTask(db, root, run.id, planner.id, claim.leaseToken, {
      Status: "COMPLETED", Files: [], Summary: "Returned an invalid role-phase pairing.",
      PlanDraft: draft, EvidenceRefs: [], Blockers: []
    }, config);
    assert.throws(() => ingestPlanDraft(db, root, run.id, planner.id, config), (error) => error.code === "PLAN_DRAFT_TASK_PHASE");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id <> ?").get(run.id, planner.id).count, 0);
  } finally {
    db.close();
  }
});

test("PlanDraft rejects natural-language aliases and missing canonical fields before materialization", () => {
  const cases = [
    {
      label: "milestone name alias",
      code: "PLAN_DRAFT_ALIAS",
      mutate: (draft) => { draft.milestones[0].name = draft.milestones[0].title; delete draft.milestones[0].title; }
    },
    {
      label: "milestone description alias",
      code: "PLAN_DRAFT_ALIAS",
      mutate: (draft) => { draft.milestones[0].description = draft.milestones[0].objective; delete draft.milestones[0].objective; }
    },
    {
      label: "milestone wave alias",
      code: "PLAN_DRAFT_ALIAS",
      mutate: (draft) => { draft.milestones[0].wave = 1; }
    },
    {
      label: "task kind alias",
      code: "PLAN_DRAFT_ALIAS",
      mutate: (draft) => { draft.tasks[0].kind = draft.tasks[0].taskKind; delete draft.tasks[0].taskKind; }
    },
    {
      label: "task outcome alias",
      code: "PLAN_DRAFT_ALIAS",
      mutate: (draft) => { draft.tasks[0].outcome = draft.tasks[0].goal; delete draft.tasks[0].goal; }
    },
    {
      label: "task consumesInterfaceIds alias",
      code: "PLAN_DRAFT_ALIAS",
      mutate: (draft) => { draft.tasks[0].consumesInterfaceIds = ["slice-result-v1"]; }
    },
    {
      label: "missing task runPhase",
      code: "PLAN_DRAFT_FIELDS",
      mutate: (draft) => { delete draft.tasks[0].runPhase; }
    },
    {
      label: "missing milestone exitCriteria",
      code: "PLAN_DRAFT_FIELDS",
      mutate: (draft) => { delete draft.milestones[0].exitCriteria; }
    }
  ];

  for (const testCase of cases) {
    const { root, db, config } = makeProject();
    try {
      const { run } = startTestRun(db, root, config, `Reject ${testCase.label}`);
      forcePhase(db, root, config, run.id, "plan");
      const planner = addTask(db, run.id, boundedTask(`alias-${testCase.label.replaceAll(" ", "-")}`, {
        role: "planner", taskKind: "planning", runPhase: "plan", readOnly: true,
        scope: ["planner output"], expectedOutputs: ["plan-draft"]
      }), config);
      const claim = claimTask(db, run.id, planner.id, "planner", config);
      const draft = structuredClone(fourSlicePlanDraft());
      testCase.mutate(draft);
      finishTask(db, root, run.id, planner.id, claim.leaseToken, {
        Status: "COMPLETED", Files: [], Summary: `Returned ${testCase.label}.`, PlanDraft: draft,
        EvidenceRefs: [], Blockers: []
      }, config);

      assert.throws(() => ingestPlanDraft(db, root, run.id, planner.id, config), (error) => error.code === testCase.code);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM interface_contracts WHERE run_id = ?").get(run.id).count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM milestones WHERE run_id = ?").get(run.id).count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id <> ?").get(run.id, planner.id).count, 0);
    } finally {
      db.close();
    }
  }
});

test("plan draft ingestion is atomic when a later task is invalid", () => {
  const { root, db, config } = makeProject({ config: { delegation: { compilerPolicy: "deterministic" } } });
  try {
    const { run } = startTestRun(db, root, config, "Reject a partially valid plan draft");
    forcePhase(db, root, config, run.id, "plan");
    const planner = addTask(db, run.id, boundedTask("atomic-planner", {
      role: "planner",
      taskKind: "planning",
      runPhase: "plan",
      expectedOutputs: ["plan-draft"]
    }), config);
    const claim = claimTask(db, run.id, planner.id, "planner", config);
    finishTask(db, root, run.id, planner.id, claim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Created a draft whose second task is invalid.",
      PlanDraft: {
        parallelism: {
          eligible: true,
          independentSlices: 2,
          desiredWidth: 2,
          minimumSameWaveImplementationTasks: 2,
          rationale: "The first task is valid and the second must fail path validation."
        },
        interfaces: [{
          id: "atomic-api-v1",
          name: "atomic-api",
          description: "Interface created before the invalid task is reached.",
          schema: { value: "number" },
          requirementIds: ["REQ-001"]
        }],
        milestones: [{
          id: "atomic-m1",
          title: "Atomic milestone",
          objective: "Apply the complete plan or none of it.",
          userVisibleOutcome: "No partial task graph remains after failure.",
          exitCriteria: ["REQ-001 is implemented and verified."],
          requirementIds: ["REQ-001"],
          dependsOn: []
        }],
        tasks: [
          {
            id: "atomic-good-task",
            title: "Valid first task",
            goal: "Create state that must roll back if a later task fails.",
            role: "worker",
            taskKind: "implementation",
            runPhase: "execute",
            wave: 1,
            milestoneId: "atomic-m1",
            readOnly: false,
            targetPaths: ["src/atomic-good.js"],
            scope: ["src/atomic-good.js"],
            nonGoals: [],
            constraints: [],
            acceptanceCriteria: ["The valid task is independently verifiable."],
            requiredEvidence: ["Current test evidence"],
            expectedOutputs: ["implementation"],
            requirementIds: ["REQ-001"],
            dependsOn: [],
            interfaceInputs: [],
            interfaceOutputs: ["atomic-api-v1"]
          },
          {
            id: "atomic-invalid-task",
            title: "Invalid second task",
            goal: "This task must fail validation.",
            role: "worker",
            taskKind: "implementation",
            runPhase: "execute",
            wave: 1,
            milestoneId: "atomic-m1",
            readOnly: false,
            targetPaths: ["../outside.js"],
            scope: ["../outside.js"],
            nonGoals: [],
            constraints: [],
            acceptanceCriteria: ["This task must never be materialized."],
            requiredEvidence: ["Current test evidence"],
            expectedOutputs: ["implementation"],
            requirementIds: ["REQ-001"],
            dependsOn: [],
            interfaceInputs: [],
            interfaceOutputs: []
          }
        ]
      },
      EvidenceRefs: [],
      Blockers: []
    }, config);

    assert.throws(() => ingestPlanDraft(db, root, run.id, planner.id, config), (error) => error.code === "TASK_PATH_INVALID");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM interface_contracts WHERE id = 'atomic-api-v1'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM milestones WHERE id = 'atomic-m1'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id IN ('atomic-good-task','atomic-invalid-task')").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_packets WHERE task_id IN ('atomic-good-task','atomic-invalid-task')").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE kind = ?").get(`plan-draft-ingested:${planner.id}`).count, 0);
    assert.equal(getTask(db, planner.id).status, "completed");
  } finally {
    db.close();
  }
});

test("a failed child is routed to a diagnostician before retry", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Diagnose failed work");
    forcePhase(db, root, config, run.id, "plan");
    const task = addTask(db, run.id, boundedTask("failing-task", { runPhase: "execute" }), config);
    addTask(db, run.id, boundedTask("unrelated-sibling", { runPhase: "execute" }), config);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, task.id, "worker", config);
    finishTask(db, root, run.id, task.id, claim.leaseToken, {
      Status: "FAILED",
      Files: [],
      Summary: "The declared interface was not present.",
      EvidenceRefs: [],
      Blockers: []
    }, config);
    assert.equal(getTask(db, task.id).status, "blocked");
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(action.type, "CREATE_DIAGNOSIS_TASK");
    assert.equal(action.taskSpecs[0].role, "diagnostician");
    assert.equal(action.taskSpecs[0].readOnly, true);
    assert.equal(action.taskSpecs[0].wave, task.wave);
    assert.match(action.instruction, /Main must not guess the failure cause/);
  } finally {
    db.close();
  }
});

test("Main context keeps packet content outside the long-lived orchestration view", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Keep Main thin");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, boundedTask("thin-main-task"), config);
    compileTaskPacket(db, root, "thin-main-task", config, {
      overlay: { ExecutionSteps: ["UNIQUE_PACKET_DETAIL_71A9"] }
    });
    forcePhase(db, root, config, run.id, "execute");
    const context = buildMainContext(db, root, run.id, config, {
      action: { type: "SPAWN_BATCH", instruction: "Dispatch the ready task packet." }
    });
    assert.match(context.content, /Main is an orchestrator only/);
    assert.match(context.content, /thin-main-task/);
    assert.doesNotMatch(context.content, /UNIQUE_PACKET_DETAIL_71A9/);
  } finally {
    db.close();
  }
});
