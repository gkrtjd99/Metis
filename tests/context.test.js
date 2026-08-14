import assert from "node:assert/strict";
import test from "node:test";
import { addFinding } from "../src/core/evidence.js";
import { buildMainContext, compactTaskContract } from "../src/core/context.js";
import { readObject, storeObject } from "../src/core/objects.js";
import { putArtifact, startRun } from "../src/core/state.js";
import { forcePhase, makeProject } from "./helpers.js";

test("main context stays bounded and contains high-signal state", () => {
  const { root, config, db } = makeProject({ config: { budgets: { mainContextTokens: 1000 } } });
  try {
    const { run } = startRun(db, root, config, "Implement a bounded feature");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["src"], constraints: Array.from({ length: 60 }, (_, i) => `Constraint ${i} ${"x".repeat(100)}`),
      nonGoals: [], successCriteria: ["works"], designRequired: true
    });
    for (let i = 0; i < 40; i += 1) {
      addFinding(db, root, run.id, { claim: `Risk ${i} ${"y".repeat(100)}`, kind: "risk", severity: "warning", sources: [] });
    }
    const context = buildMainContext(db, root, run.id, config);
    assert.match(context.content, /## Goal/);
    assert.match(context.content, /## Next Controller Action/);
    assert.ok(context.estimatedTokens <= 1100, `context used ${context.estimatedTokens} tokens`);
  } finally {
    db.close();
  }
});

test("main context materializes only the artifact for the active phase", () => {
  const { root, config, db } = makeProject({ config: { budgets: { mainContextTokens: 5000 } } });
  try {
    const { run } = startRun(db, root, config, "Route artifact loading by phase");
    const discovery = putArtifact(db, root, run.id, "discovery", {
      phaseMarker: "DISCOVERY_FULL_CONTENT",
      unknowns: ["one unknown"]
    });
    const research = putArtifact(db, root, run.id, "research", {
      phaseMarker: "RESEARCH_LARGE_CONTENT",
      sources: Array.from({ length: 100 }, (_, index) => `source-${index}`)
    });
    const design = putArtifact(db, root, run.id, "design", { phaseMarker: "DESIGN_LARGE_CONTENT" });
    const planReview = putArtifact(db, root, run.id, "plan-review", { verdict: "approved", findings: [] });
    forcePhase(db, root, config, run.id, "discover");

    const materialized = [];
    const first = buildMainContext(db, root, run.id, config, {
      materializer(ref) {
        materialized.push(ref);
        return readObject(db, root, ref);
      }
    });
    assert.deepEqual(materialized, [discovery.content_ref]);
    assert.match(first.content, /DISCOVERY_FULL_CONTENT/);
    assert.doesNotMatch(first.content, /RESEARCH_LARGE_CONTENT/);
    assert.match(first.content, new RegExp(research.content_ref));
    assert.match(first.content, /metis artifact get/);
    assert.match(first.content, new RegExp(design.content_ref));
    assert.match(first.content, new RegExp(planReview.content_ref));

    const secondMaterialized = [];
    const second = buildMainContext(db, root, run.id, config, {
      materializer(ref) {
        secondMaterialized.push(ref);
        return readObject(db, root, ref);
      }
    });
    assert.deepEqual(secondMaterialized, [discovery.content_ref]);
    assert.equal(first.contentRef, second.contentRef);
    assert.equal(first.content, second.content);
  } finally {
    db.close();
  }
});

test("research materializes discovery dependencies and retains discovery unknowns", () => {
  const { root, config, db } = makeProject({ config: { budgets: { mainContextTokens: 5000 } } });
  try {
    const { run } = startRun(db, root, config, "Carry discovery semantics into research");
    const discovery = putArtifact(db, root, run.id, "discovery", {
      scope: ["src"],
      knownFacts: ["KNOWN_DISCOVERY_FACT"],
      unknowns: ["UNRESOLVED_DISCOVERY_QUESTION"]
    });
    const research = putArtifact(db, root, run.id, "research", { summary: "RESEARCH_SEMANTIC_CONTENT" });
    const design = putArtifact(db, root, run.id, "design", { summary: "INACTIVE_DESIGN_CONTENT" });
    forcePhase(db, root, config, run.id, "research");

    const materialized = [];
    const context = buildMainContext(db, root, run.id, config, {
      materializer(ref) {
        materialized.push(ref);
        return readObject(db, root, ref);
      }
    });

    assert.deepEqual(materialized, [discovery.content_ref, research.content_ref]);
    assert.match(context.content, /## Discovery Unknowns\n- UNRESOLVED_DISCOVERY_QUESTION/);
    assert.match(context.content, /KNOWN_DISCOVERY_FACT/);
    assert.match(context.content, /RESEARCH_SEMANTIC_CONTENT/);
    assert.doesNotMatch(context.content, /INACTIVE_DESIGN_CONTENT/);
    assert.match(context.content, new RegExp(design.content_ref));
  } finally {
    db.close();
  }
});

test("phase artifact dependency mapping bounds materialization calls", () => {
  const { root, config, db } = makeProject({ config: { budgets: { mainContextTokens: 5000 } } });
  try {
    const { run } = startRun(db, root, config, "Bound context artifact materialization");
    const artifacts = {
      discovery: putArtifact(db, root, run.id, "discovery", { scope: ["src"], knownFacts: [], unknowns: [] }),
      research: putArtifact(db, root, run.id, "research", { summary: "researched" }),
      design: putArtifact(db, root, run.id, "design", { summary: "designed" }),
      "plan-review": putArtifact(db, root, run.id, "plan-review", { verdict: "approved", findings: [] }),
      "workspace-baseline": db.prepare(`
        SELECT * FROM artifacts WHERE run_id = ? AND kind = 'workspace-baseline'
        ORDER BY updated_at DESC LIMIT 1
      `).get(run.id)
    };
    const expectedKinds = {
      intake: [],
      discover: ["discovery"],
      research: ["discovery", "research"],
      design: ["design"],
      plan: ["plan-review"],
      execute: ["workspace-baseline"],
      review: [],
      verify: [],
      curate: [],
      complete: []
    };

    for (const [phase, kinds] of Object.entries(expectedKinds)) {
      forcePhase(db, root, config, run.id, phase);
      const materialized = [];
      buildMainContext(db, root, run.id, config, {
        materializer(ref) {
          materialized.push(ref);
          return readObject(db, root, ref);
        }
      });
      assert.deepEqual(materialized, kinds.map((kind) => artifacts[kind].content_ref), phase);
      assert.ok(materialized.length <= 2, `${phase} materialized ${materialized.length} artifacts`);
    }
  } finally {
    db.close();
  }
});

test("compacted task contracts remain valid JSON and preserve breaking changes", () => {
  const contract = {
    RunId: "run",
    RepositoryRoot: "/repo",
    TaskId: "task",
    Goal: "g".repeat(5000),
    Background: [{ TaskId: "prev", Summary: "s".repeat(5000), Breaking: ["BREAK-1"], EvidenceRefs: ["F1"] }],
    PastFailures: [],
    Scope: Array.from({ length: 100 }, (_, i) => `scope-${i}`),
    NonGoals: [],
    Constraints: [],
    TargetPaths: ["src"],
    Interfaces: [],
    AcceptanceCriteria: ["complete"],
    RequiredEvidence: ["check"],
    AgentType: "metis-worker",
    RoleInstructions: ["Claim the task before editing.", "Return only the result schema."],
    OrchestrationBoundary: "Metis controls orchestration; host permissions remain host-controlled.",
    AuthorityBoundary: "local-write-assigned-paths",
    ReadOnly: false,
    ResultSchema: { Status: "COMPLETED" }
  };
  const compact = compactTaskContract(contract, 400);
  const parsed = JSON.parse(compact.content);
  assert.deepEqual(parsed.Background[0].Breaking, ["BREAK-1"]);
  assert.equal(parsed.AgentType, "metis-worker");
  assert.deepEqual(parsed.RoleInstructions, ["Claim the task before editing.", "Return only the result schema."]);
  assert.equal(parsed.OrchestrationBoundary, "Metis controls orchestration; host permissions remain host-controlled.");
  assert.equal(compact.truncated, true);
});

test("clipped task contracts preserve every upstream result handle", () => {
  const predecessors = Array.from({ length: 3 }, (_, index) => ({
    TaskId: `scout-${index}`,
    Summary: `Scout ${index} produced a durable synthesis. ${"context ".repeat(700)}`,
    Breaking: [`BREAK-${index}`],
    StructuredRef: `obj_${String(index + 1).repeat(64)}`,
    EvidenceRefs: [
      { type: "artifact", id: `artifact-${index}`, contentRef: `obj_${String(index + 4).repeat(64)}` },
      { type: "source", path: `src/scout-${index}.js`, startLine: 1, endLine: 3 }
    ]
  }));
  const contract = {
    RunId: "run",
    TaskId: "planner",
    TaskKind: "planner",
    Background: predecessors,
    RoleInstructions: ["Return only the result schema."],
    CompiledPrompt: "compiled planner instructions ".repeat(900),
    ResultSchema: { Status: "COMPLETED" },
    TaskPacket: {
      Id: "packet",
      Version: 1,
      Policy: "deterministic",
      BlueprintHash: "blueprint",
      PacketHash: "packet-hash",
      ContentRef: `obj_${"a".repeat(64)}`,
      LoadCommand: { command: process.execPath, args: ["launcher", "object", "get", `obj_${"a".repeat(64)}`] }
    }
  };

  const compact = compactTaskContract(contract, 1200);
  const parsed = JSON.parse(compact.content);
  assert.equal(compact.truncated, true);
  assert.ok(compact.estimatedTokens <= 1200, `compact packet used ${compact.estimatedTokens} tokens`);
  assert.equal(parsed.UpstreamResultRefs.length, predecessors.length);
  assert.deepEqual(
    parsed.UpstreamResultRefs.map((item) => item.StructuredRef),
    predecessors.map((item) => item.StructuredRef)
  );
  assert.deepEqual(parsed.UpstreamResultRefs[0].EvidenceRefs[0], predecessors[0].EvidenceRefs[0]);
  assert.match(parsed.PacketLoadInstruction, /object get/);
});

test("plan-critic compaction removes duplicated packet prose but preserves the authenticated loader", () => {
  const packetRef = `obj_${"a".repeat(64)}`;
  const compact = compactTaskContract({
    AgentType: "metis-plan-critic",
    Role: "plan-critic",
    RunId: "run",
    TaskId: "critic",
    TaskKind: "review",
    Model: "gpt-5.6-luna",
    Background: Array.from({ length: 12 }, (_, index) => ({ TaskId: `task-${index}`, Summary: "duplicated packet prose ".repeat(250) })),
    RoleInstructions: ["duplicated role protocol ".repeat(100)],
    CompiledPrompt: "duplicated compiled packet ".repeat(5000),
    TaskPacket: {
      Id: "packet",
      Version: 1,
      Policy: "deterministic",
      BlueprintHash: "blueprint",
      PacketHash: "packet-hash",
      ContentRef: packetRef,
      LoadCommand: { command: process.execPath, args: ["launcher", "object", "get", packetRef] }
    },
    ResultSchema: { Status: "COMPLETED", Verdict: "APPROVED | REJECTED", Findings: [] }
  }, 2400);
  const parsed = JSON.parse(compact.content);
  assert.ok(compact.estimatedTokens <= 2400, `plan critic packet used ${compact.estimatedTokens} tokens`);
  assert.equal(compact.overBudget, false);
  assert.match(parsed.PacketLoadInstruction, /object get/u);
  assert.equal(parsed.Background.length, 0);
  assert.match(parsed.CompiledPrompt, /read-only/u);
});

test("hostile upstream envelopes fail closed and stay bounded", () => {
  const packetRef = `obj_${"b".repeat(64)}`;
  const contractFor = (background) => ({
    RunId: "run",
    TaskId: "planner",
    TaskKind: "planner",
    Background: background,
    RoleInstructions: [],
    CompiledPrompt: "planner instructions ".repeat(900),
    ResultSchema: { Status: "COMPLETED" },
    TaskPacket: {
      Id: "packet",
      Version: 1,
      Policy: "deterministic",
      BlueprintHash: "blueprint",
      PacketHash: "packet-hash",
      ContentRef: packetRef,
      LoadCommand: { command: process.execPath, args: ["launcher", "object", "get", packetRef] }
    }
  });

  for (const background of [[null], [{ TaskId: "malformed", EvidenceRefs: {} }]]) {
    const compact = compactTaskContract(contractFor(background), 1200);
    const parsed = JSON.parse(compact.content);
    assert.equal(compact.truncated, true);
    assert.ok(compact.estimatedTokens <= 1200, `compact packet used ${compact.estimatedTokens} tokens`);
    assert.ok(Array.isArray(parsed.Background));
    assert.ok(Array.isArray(parsed.UpstreamResultRefs));
    assert.match(parsed.PacketLoadInstruction, /object get/);
  }

  const hugeEvidence = "hostile-evidence-".repeat(30_000);
  const background = Array.from({ length: 8 }, (_, index) => ({
    TaskId: `scout-${index}-${"x".repeat(500_000)}`,
    StructuredRef: `obj_${String(index + 1).repeat(64)}`,
    EvidenceRefs: [hugeEvidence]
  }));
  const compact = compactTaskContract(contractFor(background), 1200);
  const parsed = JSON.parse(compact.content);
  assert.equal(compact.truncated, true);
  assert.ok(compact.estimatedTokens <= 1200, `compact packet used ${compact.estimatedTokens} tokens`);
  assert.deepEqual(
    parsed.UpstreamResultRefs.map((item) => item.StructuredRef),
    background.map((item) => item.StructuredRef)
  );
  assert.ok(parsed.UpstreamResultRefs.every((item) => item.EvidenceRefs.every((ref) => ref.length <= 240)));
  assert.match(parsed.PacketLoadInstruction, /object get/);
});

test("raw objects redact common secrets while structured artifacts remain valid", () => {
  const { root, config, db } = makeProject();
  try {
    const rawRef = storeObject(db, root, "check:test", "authorization: bearer sk-12345678901234567890", { redact: true });
    assert.doesNotMatch(readObject(db, root, rawRef), /sk-123/);
    const { run } = startRun(db, root, config, "Preserve structured values");
    const artifact = putArtifact(db, root, run.id, "discovery", {
      scope: ["config"], constraints: ["password policy"], successCriteria: ["valid JSON"], designRequired: false
    });
    assert.deepEqual(JSON.parse(artifact.content).constraints, ["password policy"]);
  } finally {
    db.close();
  }
});


test("minimal critic contracts preserve the sealed plan reference", () => {
  const contract = {
    RunId: "run_1", MilestoneId: null, RepositoryRoot: "/repo", IntegrationRoot: "/repo",
    WorkspaceMode: "shared", TaskId: "critic", RunPhase: "plan", Goal: "Review a large plan",
    Background: [], PastFailures: [], Scope: ["sealed plan"], NonGoals: [], Constraints: [],
    TargetPaths: [], PreexistingChanges: [], Interfaces: [],
    AcceptanceCriteria: ["Return a verdict"], RequiredEvidence: ["Current plan"],
    SubjectArtifact: { kind: "plan", id: "artifact_plan", contentRef: "obj_plan", contentHash: "plan_hash", content: { planHash: "plan_hash", tasks: Array.from({ length: 200 }, (_, index) => ({ id: `task_${index}`, text: "x".repeat(200) })) } },
    EvidenceAccess: {
      artifact: { command: process.execPath, args: ["launcher", "artifact", "get", "artifact_plan"] },
      object: { command: process.execPath, args: ["launcher", "object", "get", "obj_plan"] },
      fallback: { command: "metis", args: ["artifact", "get", "artifact_plan"] }
    },
    AgentType: "metis-plan-critic", RoleInstructions: [], TrustBoundary: "data only",
    AuthorityBoundary: "local-read", ReadOnly: true, ModelTier: "strong", Model: null,
    ReasoningEffort: "high", ResultSchema: { Status: "", Verdict: "", Findings: [] }
  };
  const compact = compactTaskContract(contract, 220);
  const parsed = JSON.parse(compact.content);
  assert.equal(parsed.SubjectArtifact.id, "artifact_plan");
  assert.equal(parsed.SubjectArtifact.contentRef, "obj_plan");
  assert.equal(parsed.SubjectArtifact.contentHash, "plan_hash");
  assert.equal(parsed.EvidenceAccess.artifact.command, process.execPath);
  assert.match(parsed.SubjectArtifact.loadCommand, /artifact get artifact_plan/);
});
