import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { consumeBudget } from "../src/core/budget.js";
import { amendGoalContract, freezeGoalContract, getGoalContract } from "../src/core/contracts.js";
import { nextControllerAction } from "../src/core/controller.js";
import { buildMainContext } from "../src/core/context.js";
import {
  addAssumption,
  addInvariant,
  addRisk,
  governanceReport,
  setAssumptionStatus,
  setInvariantStatus,
  setRiskStatus
} from "../src/core/governance.js";
import { replayJournal } from "../src/core/journal.js";
import { sampleProgress } from "../src/core/progress.js";
import { repositoryCodeFingerprint } from "../src/core/repository.js";
import { reconcileReview, requiredSpecialistRoles } from "../src/core/reviews.js";
import { claimSchedule } from "../src/core/scheduler.js";
import { putArtifact, recordEvent, startRun } from "../src/core/state.js";
import { addTask, claimTask, finishTask, getTask, sealPlan } from "../src/core/tasks.js";
import { forcePhase, makeProject, startTestRun } from "./helpers.js";

function task(id, options = {}) {
  return {
    id,
    title: options.title ?? id,
    goal: options.goal ?? id,
    role: options.role ?? "worker",
    runPhase: options.runPhase ?? "execute",
    readOnly: options.readOnly ?? true,
    priority: options.priority ?? 50,
    complexity: options.complexity ?? "medium",
    scope: options.scope ?? ["repository"],
    nonGoals: [],
    constraints: [],
    targetPaths: options.targetPaths ?? [],
    interfaces: [],
    acceptanceCriteria: options.acceptanceCriteria ?? ["Return a terminal result"],
    requiredEvidence: options.requiredEvidence ?? ["Current evidence"],
    requirementIds: options.requirementIds ?? ["REQ-001"],
    dependsOn: options.dependsOn ?? [],
    reviewKind: options.reviewKind
  };
}

test("Codex integration is explicit opt-in through $metis", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const skill = readFileSync(path.join(root, "skills/metis/SKILL.md"), "utf8");
  const metadata = readFileSync(path.join(root, "skills/metis/agents/openai.yaml"), "utf8");
  const command = readFileSync(path.join(root, "commands/metis.md"), "utf8");
  assert.match(skill, /^name: metis$/m);
  assert.match(skill, /\/goal \$metis/);
  assert.match(metadata, /allow_implicit_invocation:\s*false/);
  assert.match(command, /\$metis/);
  assert.equal(existsSync(path.join(root, "commands/goal.md")), false);
  assert.equal(existsSync(path.join(root, "skills/goal")), false);
});

test("material Goal Contract amendments require approval and invalidate downstream state", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startRun(db, root, config, "Implement feature A");
    freezeGoalContract(db, root, run.id, {
      objective: "Implement feature A",
      scope: ["src"],
      nonGoals: ["Unrelated work"],
      constraints: ["Keep behavior deterministic"],
      successCriteria: ["Feature A is verified"],
      complexity: "standard",
      route: { lifecycleProfile: "balanced", researchRequired: false, designRequired: false, specialistReviewRequired: false, documentationRequired: false },
      requirements: [{ id: "REQ-A", title: "Feature A", description: "Implement A", kind: "functional", priority: "must", acceptance: ["A is implemented"] }]
    });
    forcePhase(db, root, config, run.id, "design");
    const discovery = putArtifact(db, root, run.id, "discovery", { knownFacts: ["A"] });
    const candidate = putArtifact(db, root, run.id, "integration-candidate", { contractVersion: 1 });
    assert.throws(() => amendGoalContract(db, root, run.id, {
      reason: "User expanded the objective",
      objective: "Implement feature A and B"
    }), /requires approvedByUser/i);
    const amended = amendGoalContract(db, root, run.id, {
      reason: "User expanded the objective",
      approvedByUser: true,
      objective: "Implement feature A and B",
      successCriteria: ["Features A and B are verified"],
      requirements: [
        { id: "REQ-A", title: "Feature A", description: "Implement A", kind: "functional", priority: "must", acceptance: ["A is implemented"] },
        { id: "REQ-B", title: "Feature B", description: "Implement B", kind: "functional", priority: "must", acceptance: ["B is implemented"] }
      ]
    });
    assert.equal(amended.contract.version, 2);
    assert.equal(getGoalContract(db, run.id).objective, "Implement feature A and B");
    assert.equal(db.prepare("SELECT phase FROM runs WHERE id = ?").get(run.id).phase, "discover");
    assert.equal(db.prepare("SELECT status FROM artifacts WHERE id = ?").get(discovery.id).status, "stale");
    assert.equal(db.prepare("SELECT status FROM artifacts WHERE id = ?").get(candidate.id).status, "stale");
  } finally {
    db.close();
  }
});

test("material contract amendments reopen completed fast-path task routes", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reopen amended fast-path work");
    forcePhase(db, root, config, run.id, "execute");
    const oldFastTask = addTask(db, run.id, task(`fast-path-${run.id}-implementation`), config);
    db.prepare("UPDATE tasks SET status = 'completed', result_json = ?, contract_status = 'ready' WHERE id = ?")
      .run(JSON.stringify({ Status: "COMPLETED", Summary: "Old contract result" }), oldFastTask.id);

    amendGoalContract(db, root, run.id, {
      reason: "Amend the objective after the bounded implementation completed",
      approvedByUser: true,
      objective: "Reopen the amended bounded implementation"
    });

    const reopened = db.prepare("SELECT status, result_json, contract_status FROM tasks WHERE id = ?").get(oldFastTask.id);
    assert.equal(reopened.status, "pending");
    assert.equal(reopened.result_json, null);
    assert.equal(reopened.contract_status, "stale");
  } finally {
    db.close();
  }
});

test("scope and constraint Goal Contract amendments require approval", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Bound contract amendments");
    assert.throws(() => amendGoalContract(db, root, run.id, {
      reason: "Expand the implementation boundary",
      scope: ["src", "tests"]
    }), (error) => error.code === "CONTRACT_AMEND_APPROVAL");
    assert.throws(() => amendGoalContract(db, root, run.id, {
      reason: "Add a delivery constraint",
      constraints: ["Preserve the public API"]
    }), (error) => error.code === "CONTRACT_AMEND_APPROVAL");

    const amended = amendGoalContract(db, root, run.id, {
      reason: "User approved the expanded boundary and constraint",
      approvedByUser: true,
      scope: ["src", "tests"],
      constraints: ["Preserve the public API"]
    });
    assert.deepEqual(amended.contract.scope, ["src", "tests"]);
    assert.deepEqual(amended.contract.constraints, ["Preserve the public API"]);
  } finally {
    db.close();
  }
});

test("contract amendment waits for an in-flight claim before checking running tasks", async () => {
  const { root, db, config } = makeProject();
  const claimUrl = pathToFileURL(path.resolve("src/core/db.js")).href;
  let child;
  try {
    const { run } = startTestRun(db, root, config, "Serialize contract amendments and claims");
    forcePhase(db, root, config, run.id, "execute");
    addTask(db, run.id, task("claim-before-amend"), config);

    const claimCode = `
const [dbUrl, root, runId, taskId] = process.argv.slice(1);
const { openDatabase } = await import(dbUrl);
const db = openDatabase(root);
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE tasks SET status = 'running', owner = 'claim-worker', updated_at = ? WHERE id = ? AND run_id = ? AND status = 'pending'")
  .run(new Date().toISOString(), taskId, runId);
console.log("ready");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, 250);
`;
    child = spawn(process.execPath, ["--input-type=module", "-e", claimCode, claimUrl, root, run.id, "claim-before-amend"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    await new Promise((resolve, reject) => {
      let output = "";
      let error = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("ready")) resolve();
      });
      child.stderr.on("data", (chunk) => { error += chunk; });
      child.on("error", reject);
      child.on("exit", (status) => {
        if (status !== null && !output.includes("ready")) reject(new Error(error || `Claim helper exited with ${status}.`));
      });
    });

    assert.throws(() => amendGoalContract(db, root, run.id, {
      reason: "Amend while a claim is committing",
      approvedByUser: true,
      objective: "A changed objective"
    }), (error) => error.code === "CONTRACT_AMEND_RUNNING_TASKS");
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = ?").get("claim-before-amend").status, "running");
    await new Promise((resolve, reject) => child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(`Claim helper exited with ${status}.`))));
  } finally {
    if (child && child.exitCode === null) child.kill();
    db.close();
  }
});

test("Goal Contract amendments cannot replace the basis of running work", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Fence running work from contract amendments");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, task("running-contract-work", {
      requiredEvidence: [],
      requirementIds: ["REQ-001"]
    }), config);
    forcePhase(db, root, config, run.id, "execute");
    claimTask(db, run.id, "running-contract-work", "contract-worker", config);

    assert.throws(() => amendGoalContract(db, root, run.id, {
      reason: "Replace the objective while old work is running",
      approvedByUser: true,
      objective: "A different objective"
    }), (error) => error.code === "CONTRACT_AMEND_RUNNING_TASKS");
  } finally {
    db.close();
  }
});

test("deterministic scheduler prioritizes critical work and emits isolated Codex spawns", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 2 }, delegation: { compilerPolicy: "deterministic" } } });
  try {
    const { run } = startTestRun(db, root, config, "Schedule bounded work", { contract: { complexity: "trivial" } });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, task("low-priority", { priority: 10 }), config);
    addTask(db, run.id, task("high-priority", { priority: 90, complexity: "high" }), config);
    const sealed = sealPlan(db, run.id, config);
    putArtifact(db, root, run.id, "plan", sealed.content, { metadata: { planHash: sealed.planHash, version: sealed.content.version } });
    forcePhase(db, root, config, run.id, "execute");
    const scheduled = claimSchedule(db, root, run.id, config, { owner: "main" });
    assert.equal(scheduled.batch.length, 2);
    assert.equal(scheduled.batch[0].taskId, "high-priority");
    for (const item of scheduled.batch) {
      assert.equal(item.spawn.fork_turns, "none");
      assert.equal(item.spawn.task_name, item.taskId);
      assert.equal(item.spawn.agent_type, "metis-worker");
      assert.ok(item.contract.estimatedTokens <= config.budgets.taskPacketTokens * 1.1);
    }
  } finally {
    db.close();
  }
});

test("blocking review findings become repair tasks in a closed loop", () => {
  const { root, db, config } = makeProject({
    config: { orchestration: { autoCreateRepairTasks: true, specialistReviews: { enabled: false } } }
  });
  try {
    const { run } = startTestRun(db, root, config, "Review an authentication change", {
      contract: { lifecycleProfile: "balanced", complexity: "standard" }
    });
    forcePhase(db, root, config, run.id, "review");
    const codeFingerprint = repositoryCodeFingerprint(db);
    const candidate = putArtifact(db, root, run.id, "integration-candidate", {
      version: 1,
      runId: run.id,
      contractVersion: 1,
      codeFingerprint,
      source: "test-post-integration"
    }, { status: "verified", metadata: { codeFingerprint, immutable: true } });
    addTask(db, run.id, task("review-auth", {
      role: "reviewer",
      runPhase: "review",
      scope: ["src/auth.js"],
      reviewKind: "integration"
    }), config);
    const claim = claimTask(db, run.id, "review-auth", "reviewer", config);
    finishTask(db, root, run.id, "review-auth", claim.leaseToken, {
      Status: "COMPLETED",
      Verdict: "REJECTED",
      Files: [],
      Findings: [{
        Id: "RF-AUTH-RACE",
        Title: "Session update race",
        Description: "The integrated authentication path can lose an invalidation update.",
        Severity: "error",
        TargetPaths: ["src/auth.js"],
        RequirementIds: ["REQ-001"],
        SuggestedFix: "Serialize the session invalidation update."
      }],
      Summary: "One blocking correctness defect remains.",
      EvidenceRefs: [
        "package.json:1",
        { type: "artifact", id: candidate.id, contentRef: candidate.content_ref },
        { type: "note", text: "Independent integrated-code review." }
      ],
      Blockers: []
    }, config);
    const result = reconcileReview(db, root, run.id, config, { reviewKind: "integration" });
    assert.equal(result.status, "FIXES_SCHEDULED");
    assert.equal(result.repairTasks.length, 1);
    const repair = getTask(db, result.repairTasks[0].id);
    assert.equal(repair.autoGenerated, true);
    assert.deepEqual(repair.targetPaths, ["src/auth.js"]);
    assert.equal(db.prepare("SELECT status FROM review_findings WHERE id = 'RF-AUTH-RACE'").get().status, "fixing");
    assert.equal(db.prepare("SELECT phase FROM runs WHERE id = ?").get(run.id).phase, "execute");
  } finally {
    db.close();
  }
});

test("assumptions, invariants, and critical risks are deterministic execution and completion gates", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Preserve a security invariant");
    const assumption = addAssumption(db, root, run.id, {
      id: "ASM-1", statement: "The caller always supplies a stable identity", confidence: 0.4, impact: "high"
    });
    const invariant = addInvariant(db, root, run.id, {
      id: "INV-1", title: "No plaintext secrets", description: "Secrets must remain encrypted", severity: "critical", requirementIds: ["REQ-001"]
    });
    const risk = addRisk(db, root, run.id, {
      id: "RISK-1", title: "Credential exposure", description: "A malformed path could expose a secret", severity: "critical", likelihood: "possible", requirementIds: ["REQ-001"]
    });
    let report = governanceReport(db, run.id, config);
    assert.equal(report.passForExecution, false);
    assert.equal(report.passForCompletion, false);
    const evidence = putArtifact(db, root, run.id, "governance-evidence", { checked: true });
    setAssumptionStatus(db, root, run.id, assumption.id, "validated", { evidenceRefs: [evidence.id] });
    setInvariantStatus(db, root, run.id, invariant.id, "verified", { verificationRefs: [evidence.id] });
    setRiskStatus(db, root, run.id, risk.id, "accepted", { disposition: "User accepted the documented residual risk." });
    report = governanceReport(db, run.id, config);
    assert.equal(report.passForExecution, true);
    assert.equal(report.passForCompletion, true);
  } finally {
    db.close();
  }
});

test("controller stops on exhausted budget and on repeated no-progress revisions", () => {
  const { root, db, config } = makeProject({
    config: { budgets: { run: { toolCalls: 1 } }, orchestration: { progressStallThreshold: 2 } }
  });
  try {
    const { run } = startTestRun(db, root, config, "Bound autonomous execution");
    consumeBudget(db, run.id, { toolCalls: 2 });
    assert.equal(nextControllerAction(db, root, run.id, config, { sampleProgress: false }).type, "BUDGET_DECISION_REQUIRED");

    // Restore only the test budget, then create two revisions without durable progress.
    db.prepare("UPDATE budget_state SET tool_calls = 0 WHERE run_id = ?").run(run.id);
    forcePhase(db, root, config, run.id, "discover");
    sampleProgress(db, run.id, config);
    db.prepare("UPDATE runs SET revision = revision + 1 WHERE id = ?").run(run.id);
    sampleProgress(db, run.id, config);
    db.prepare("UPDATE runs SET revision = revision + 1 WHERE id = ?").run(run.id);
    const stalled = sampleProgress(db, run.id, config);
    assert.equal(stalled.stalled, true);
    assert.equal(nextControllerAction(db, root, run.id, config, { sampleProgress: false }).type, "STALLED_REPLAN");
  } finally {
    db.close();
  }
});

test("journal replay and semantic context preserve the managed control plane", () => {
  const { root, db, config } = makeProject({ config: { budgets: { mainContextTokens: 900 } } });
  try {
    const { run } = startTestRun(db, root, config, "Maintain traceable state", {
      contract: { objective: "Maintain traceable state", successCriteria: ["State is traceable"] }
    });
    forcePhase(db, root, config, run.id, "discover");
    recordEvent(db, run.id, "phase.changed", "info", { from: "intake", to: "discover" });
    putArtifact(db, root, run.id, "discovery", { knownFacts: ["The project is a small ES module repository"], unknowns: [] });
    const context = buildMainContext(db, root, run.id, config, { action: { type: "ADVANCE_PHASE", targetPhase: "design" } });
    assert.equal(context.quality.coverage, 1);
    assert.match(context.content, /METIS_MANAGED_V5/);
    assert.match(context.content, /Goal Contract/);
    assert.match(context.content, /Requirements/);
    assert.match(context.content, /Next Controller Action/);
    const replay = replayJournal(db, run.id);
    assert.ok(replay.entryCount > 0);
    assert.equal(replay.run.status, "active");
    assert.equal(replay.run.phase, "discover");
    assert.ok(replay.currentStateHash);
  } finally {
    db.close();
  }
});

test("specialist review routing is conditional on the change surface", () => {
  const { config } = makeProject({ config: { orchestration: { specialistReviews: { enabled: true } } } });
  const roles = requiredSpecialistRoles([
    { capabilities: ["security", "database", "migration"] }
  ], config);
  assert.deepEqual(roles, ["database-reviewer", "migration-reviewer", "security-reviewer"]);
});
