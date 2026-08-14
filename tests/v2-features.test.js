import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addFinding, getFinding } from "../src/core/evidence.js";
import { garbageCollect } from "../src/core/maintenance.js";
import { addMilestone, listMilestones } from "../src/core/milestones.js";
import { escalateModelRoute, selectModelRoute } from "../src/core/model-routing.js";
import { codexSpawnDescriptor } from "../src/adapters/spawn-descriptors.js";
import { storeObject } from "../src/core/objects.js";
import { evidenceRefIsCurrent } from "../src/core/provenance.js";
import { syncRepository } from "../src/core/repository.js";
import { advancePhase, putArtifact, startRun } from "../src/core/state.js";
import { addTask, claimTask, finishTask, getRunnableTasks, sealPlan } from "../src/core/tasks.js";
import { countTokens, estimateTokens, recordUsageSample } from "../src/core/tokens.js";
import { makeProject, startTestRun, forcePhase } from "./helpers.js";

test("typed source evidence records hashes and becomes stale after a source change", () => {
  const { root, config, db } = makeProject();
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/value.js"), "export const value = 1;\n");
    syncRepository(db, root, config, null);
    const { run } = startTestRun(db, root, config, "Track typed evidence");
    const finding = addFinding(db, root, run.id, {
      id: "finding_value",
      claim: "The exported value is one.",
      sources: [{ type: "source", path: "src/value.js", startLine: 1, endLine: 1 }]
    });
    assert.equal(finding.sources[0].type, "source");
    assert.match(finding.sources[0].fileSha256, /^[a-f0-9]{64}$/u);
    assert.match(finding.sources[0].sliceSha256, /^[a-f0-9]{64}$/u);
    assert.equal(evidenceRefIsCurrent(db, root, finding.sources[0]), true);

    writeFileSync(path.join(root, "src/value.js"), "export const value = 2;\n");
    assert.equal(evidenceRefIsCurrent(db, root, finding.sources[0]), false);
    syncRepository(db, root, config, run.id);
    assert.equal(getFinding(db, "finding_value").status, "stale");
  } finally {
    db.close();
  }
});

test("garbage collection preserves objects referenced through typed evidence", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Preserve evidence objects");
    const ref = storeObject(db, root, "test-evidence", "important evidence");
    addFinding(db, root, run.id, {
      claim: "An externalized object supports this fact.",
      sources: [{ type: "object", ref }]
    });
    garbageCollect(db, root, { keepContexts: 1 });
    const hash = ref.replace(/^obj_/u, "");
    assert.ok(db.prepare("SELECT hash FROM objects WHERE hash = ?").get(hash));
  } finally {
    db.close();
  }
});

test("observed usage calibrates token estimates and model routing escalates hard work", () => {
  const { root, config, db } = makeProject();
  try {
    const content = "한국어와 TypeScript 코드 const answer = 42;";
    const estimate = estimateTokens(content);
    assert.ok(estimate > 0);
    for (let index = 0; index < 3; index += 1) {
      recordUsageSample(db, null, {
        role: "main",
        model: "test-model",
        content,
        estimatedTokens: estimate,
        observedInputTokens: estimate * 2,
        observedOutputTokens: 10,
        source: "test"
      });
    }
    const measured = countTokens(db, content, { config, model: "test-model" });
    assert.equal(measured.method, "calibrated-estimate");
    assert.equal(measured.calibrationFactor, 2);

    const hardWorker = selectModelRoute(config, "worker", { complexity: "high" });
    assert.equal(hardWorker.tier, "strong");
    assert.equal(hardWorker.reasoningEffort, "high");
    const escalated = escalateModelRoute(config, {
      role: "worker",
      model_tier: "worker",
      selected_model: null,
      reasoning_effort: "high",
      escalation_level: 0
    }, "reasoning");
    assert.equal(escalated.tier, "worker");
    assert.equal(escalated.requestedEffort, "xhigh");
    assert.equal(escalated.escalationLevel, 1);
    const spawn = codexSpawnDescriptor({
      id: "task_x",
      role: "worker",
      selected_model: "test-model",
      requested_effort: "high",
      effective_effort: "high",
      capability_status: "known",
      supported_efforts: ["high"]
    }, { content: "bounded contract" });
    assert.equal(spawn.fork_turns, "none");
    assert.equal(spawn.agent_type, "metis-worker");
  } finally {
    db.close();
  }
});

test("milestone dependencies keep later lanes blocked until predecessors complete", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Execute milestone order");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["repository"], nonGoals: [], constraints: [], successCriteria: ["ordered"], designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addMilestone(db, run.id, { id: "m1", title: "Foundation", objective: "Finish foundation", sequence: 1, acceptanceCriteria: ["Foundation is complete"] });
    addMilestone(db, run.id, { id: "m2", title: "Follow-up", objective: "Finish follow-up", sequence: 2, dependsOn: ["m1"], acceptanceCriteria: ["Follow-up is complete"] });
    for (const [id, milestoneId] of [["coord_1", "m1"], ["coord_2", "m2"]]) {
      addTask(db, run.id, {
        id,
        milestoneId,
        title: id,
        goal: id,
        role: "coordinator",
        runPhase: "execute",
        readOnly: true,
        scope: [milestoneId],
        acceptanceCriteria: ["Synthesis complete"],
        requiredEvidence: ["Current plan"],
        dependsOn: []
      }, config);
    }
    const sealed = sealPlan(db, run.id, config);
    const plan = putArtifact(db, root, run.id, "plan", sealed.content);
    forcePhase(db, root, config, run.id, "execute");
    assert.deepEqual(getRunnableTasks(db, run.id, 8).map((task) => task.id), ["coord_1"]);

    const claim = claimTask(db, run.id, "coord_1", "coordinator", config);
    finishTask(db, root, run.id, "coord_1", claim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Foundation synthesis completed.",
      EvidenceRefs: [plan.id],
      Blockers: []
    }, config);
    assert.deepEqual(getRunnableTasks(db, run.id, 8).map((task) => task.id), ["coord_2"]);
    assert.equal(listMilestones(db, run.id).find((item) => item.id === "m1").status, "completed");
  } finally {
    db.close();
  }
});

test("mutable workers use isolated Git worktrees and reject main-workspace races", () => {
  const { root, config, db } = makeProject();
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/shared.js"), "export const value = 1;\n");
    execFileSync("git", ["add", "src/shared.js"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: root });
    syncRepository(db, root, config, null);

    const { run } = startTestRun(db, root, config, "Change shared file safely");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["src/shared.js"], nonGoals: [], constraints: [], successCriteria: ["safe"], designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "race_task",
      title: "Update shared file",
      goal: "Update shared file",
      role: "worker",
      targetPaths: ["src/shared.js"],
      acceptanceCriteria: ["Value changes"],
      requiredEvidence: ["Source"],
      dependsOn: []
    }, config);
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id, config).content);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, "race_task", "worker", config);
    assert.equal(claim.workspaceMode, "git-worktree");
    assert.notEqual(claim.workspacePath, root);

    writeFileSync(path.join(claim.workspacePath, "src/shared.js"), "export const value = 2;\n");
    writeFileSync(path.join(root, "src/shared.js"), "export const value = 3;\n");
    assert.throws(() => finishTask(db, root, run.id, "race_task", claim.leaseToken, {
      Status: "COMPLETED",
      Files: ["src/shared.js"],
      Summary: "Updated value.",
      EvidenceRefs: ["src/shared.js:1"],
      Blockers: []
    }, config), /main workspace changed after task claim/i);
  } finally {
    db.close();
  }
});

test("repository synchronization emits a bounded symbol index", () => {
  const { root, config, db } = makeProject();
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/api.js"), "export function greet(name) { return `Hello ${name}`; }\nexport class Greeter {}\n");
    syncRepository(db, root, config, null);
    const symbolFile = path.join(root, ".metis", "generated", "symbol-index.json");
    assert.ok(existsSync(symbolFile));
    const index = JSON.parse(readFileSync(symbolFile, "utf8"));
    assert.ok(index.symbols.some((item) => item.name === "greet"));
    assert.ok(index.symbols.some((item) => item.name === "Greeter"));
  } finally {
    db.close();
  }
});

test("repository synchronization can use an explicit Universal Ctags provider", () => {
  const { root, config, db } = makeProject();
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/api.js"), "export const value = 1;\n");
    const fakeCtags = path.join(root, "fake-ctags.mjs");
    writeFileSync(fakeCtags, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => console.log(JSON.stringify({_type:'tag',name:'ctags_only',path:'src/api.js',line:1,kindName:'variable'})));\n`);
    chmodSync(fakeCtags, 0o755);
    config.index.symbolProvider = "ctags";
    config.index.ctagsCommand = fakeCtags;
    syncRepository(db, root, config, null);
    const index = JSON.parse(readFileSync(path.join(root, ".metis/generated/symbol-index.json"), "utf8"));
    assert.equal(index.provider, "universal-ctags");
    assert.ok(index.symbols.some((item) => item.name === "ctags_only"));
  } finally {
    db.close();
  }
});

test("repository synchronization resolves local dependency edges and reverse consumers", () => {
  const { root, config, db } = makeProject();
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/value.js"), "export const value = 1;\n");
    writeFileSync(path.join(root, "src/main.js"), "import { value } from './value.js';\nconsole.log(value);\n");
    syncRepository(db, root, config, null);
    const dependencyFile = path.join(root, ".metis", "generated", "dependency-index.json");
    assert.ok(existsSync(dependencyFile));
    const index = JSON.parse(readFileSync(dependencyFile, "utf8"));
    assert.ok(index.edges.some((edge) => edge.from === "src/main.js" && edge.to === "src/value.js" && edge.kind === "internal"));
    assert.deepEqual(index.consumers["src/value.js"], ["src/main.js"]);
  } finally {
    db.close();
  }
});

test("source evidence rejects symbolic links that escape the repository", () => {
  const { root, config, db } = makeProject();
  const outside = mkdtempSync(path.join(os.tmpdir(), "metis-evidence-outside-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escaped.txt"));
    const { run } = startTestRun(db, root, config, "Reject escaped evidence");
    assert.throws(() => addFinding(db, root, run.id, {
      claim: "The linked file is valid evidence.",
      sources: [{ type: "source", path: "escaped.txt", startLine: 1, endLine: 1 }]
    }), /escapes the repository/i);
  } finally {
    db.close();
  }
});

test("large files use content hashes instead of size metadata", () => {
  const { root, config, db } = makeProject();
  try {
    const file = path.join(root, "large.bin");
    writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 0x41));
    syncRepository(db, root, config, null);
    const first = db.prepare("SELECT sha256 FROM files WHERE path = 'large.bin'").get().sha256;
    writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 0x42));
    const result = syncRepository(db, root, config, null);
    const second = db.prepare("SELECT sha256 FROM files WHERE path = 'large.bin'").get().sha256;
    assert.notEqual(second, first);
    assert.ok(result.modified.includes("large.bin"));
  } finally {
    db.close();
  }
});


test("mutable ownership rejects paths that cross symbolic links", () => {
  const { root, config, db } = makeProject();
  try {
    mkdirSync(path.join(root, "real-src"), { recursive: true });
    symlinkSync("real-src", path.join(root, "linked-src"), "dir");
    const { run } = startTestRun(db, root, config, "Reject unsafe mutable ownership");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["linked-src/value.js"], nonGoals: [], constraints: [], successCriteria: ["safe"], designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    assert.throws(() => addTask(db, run.id, {
      id: "unsafe_symlink_task",
      title: "Write through symlink",
      goal: "Write through symlink",
      role: "worker",
      targetPaths: ["linked-src/value.js"],
      acceptanceCriteria: ["File exists"],
      requiredEvidence: ["Source"]
    }, config), /crosses a symbolic link/i);
  } finally {
    db.close();
  }
});


test("mutable workers cannot integrate newly created symbolic links", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject worker-created symlinks");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["src/link.js"], nonGoals: [], constraints: [], successCriteria: ["safe"], designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "create_symlink", title: "Create link", goal: "Create link", role: "worker",
      targetPaths: ["src/link.js"], acceptanceCriteria: ["Link exists"], requiredEvidence: ["Source"]
    }, config);
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id, config).content);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, "create_symlink", "worker", config);
    mkdirSync(path.join(claim.workspacePath, "src"), { recursive: true });
    symlinkSync("../package.json", path.join(claim.workspacePath, "src", "link.js"));
    assert.throws(() => finishTask(db, root, run.id, "create_symlink", claim.leaseToken, {
      Status: "COMPLETED", Files: ["src/link.js"], Summary: "Created link.",
      EvidenceRefs: ["src/link.js:1"], Blockers: []
    }, config), /created or changed symbolic links/i);
    assert.equal(existsSync(path.join(root, "src", "link.js")), false);
  } finally {
    db.close();
  }
});
