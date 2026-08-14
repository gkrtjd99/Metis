import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { registerCheck, runChecks } from "../src/core/checks.js";
import { cleanupExpiredLeases } from "../src/core/graph.js";
import { synchronizeKnowledge } from "../src/core/knowledge.js";
import { evaluateRun } from "../src/core/evaluation.js";
import { createVerificationCandidate } from "../src/core/verification.js";
import { plannedGraphFingerprint } from "../src/core/plan-ingest.js";
import { reconcileReview } from "../src/core/reviews.js";
import { repositoryCodeFingerprint } from "../src/core/repository.js";
import { advancePhase, gateReport, latestArtifact, putArtifact, startRun } from "../src/core/state.js";
import {
  addTask,
  claimTask,
  finishTask,
  getRunnableTasks,
  heartbeatTask,
  retryTask,
  sealPlan,
  waiveTask
} from "../src/core/tasks.js";
import { makeProject, nodeCommand, sealAndApprovePlan, startTestRun, forcePhase } from "./helpers.js";

const readOnlyTask = (id, role, goal) => ({
  id,
  title: goal,
  goal,
  role,
  readOnly: true,
  scope: ["src"],
  nonGoals: [],
  constraints: [],
  targetPaths: [],
  interfaces: [],
  acceptanceCriteria: ["Return evidence"],
  requiredEvidence: ["file reference"],
  dependsOn: []
});

test("mandatory reviewer and verifier evidence cannot be waived", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Require independent evidence");
    forcePhase(db, root, config, run.id, "review");
    addTask(db, run.id, { ...readOnlyTask("review-required", "reviewer", "Review the candidate"), reviewKind: "integration" }, config);
    addTask(db, run.id, readOnlyTask("verify-required", "verifier", "Verify the candidate"), config);

    assert.throws(() => waiveTask(db, run.id, "review-required", "skip"), (error) => error.code === "TASK_MANDATORY_EVIDENCE_WAIVER");
    assert.throws(() => waiveTask(db, run.id, "verify-required", "skip"), (error) => error.code === "TASK_MANDATORY_EVIDENCE_WAIVER");

    const codeFingerprint = repositoryCodeFingerprint(db);
    putArtifact(db, root, run.id, "integration-candidate", { codeFingerprint }, { metadata: { codeFingerprint, immutable: true } });
    db.prepare("UPDATE tasks SET status = 'waived' WHERE id = ?").run("review-required");
    assert.throws(
      () => reconcileReview(db, root, run.id, config, { reviewKind: "integration" }),
      (error) => error.code === "REVIEW_TASKS_INCOMPLETE"
    );

    forcePhase(db, root, config, run.id, "verify");
    db.prepare("UPDATE tasks SET status = 'waived' WHERE id = ?").run("verify-required");
    assert.throws(
      () => createVerificationCandidate(db, root, run.id, config),
      (error) => error.code === "VERIFICATION_TASKS_INCOMPLETE"
    );
  } finally {
    db.close();
  }
});

test("matching artifact fingerprints cannot replace completed independent review tasks", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject forged review approvals");
    const codeFingerprint = repositoryCodeFingerprint(db);
    forcePhase(db, root, config, run.id, "review");
    const integration = putArtifact(db, root, run.id, "integration-candidate", { codeFingerprint }, {
      metadata: { codeFingerprint, immutable: true }
    });
    putArtifact(db, root, run.id, "integration-review", {
      verdict: "APPROVED",
      fingerprint: { artifactId: integration.id, contentRef: integration.content_ref, codeFingerprint }
    });
    addTask(db, run.id, {
      ...readOnlyTask("forged-task-spec-review", "reviewer", "Review a task specification"),
      reviewKind: "task-spec:forged"
    }, config);
    db.prepare("UPDATE tasks SET status = 'completed', result_json = ? WHERE id = ?")
      .run(JSON.stringify({ Status: "COMPLETED", Verdict: "APPROVED" }), "forged-task-spec-review");
    putArtifact(db, root, run.id, "review-approval:task-spec:forged", {
      verdict: "APPROVED",
      reviewerTaskIds: ["forged-task-spec-review"],
      fingerprint: { artifactId: "stale-candidate", contentRef: "obj_stale", codeFingerprint: "stale" }
    });
    const verifyGate = gateReport(db, root, run.id, "verify");
    assert.equal(verifyGate.pass, false);
    assert.match(verifyGate.failures.join("\n"), /integration review is stale/i);
    assert.match(verifyGate.failures.join("\n"), /no authenticated reconciled approval/i);

    forcePhase(db, root, config, run.id, "verify");
    const candidate = putArtifact(db, root, run.id, "verification-candidate", { codeFingerprint });
    putArtifact(db, root, run.id, "completion-review", {
      verdict: "APPROVED",
      fingerprint: { artifactId: candidate.id, contentRef: candidate.content_ref }
    });
    const curateGate = gateReport(db, root, run.id, "curate");
    assert.equal(curateGate.pass, false);
    assert.match(curateGate.failures.join("\n"), /completion review is stale/i);
  } finally {
    db.close();
  }
});

test("discovery tasks use recoverable leases and block the phase gate", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Inspect the repository");
    forcePhase(db, root, config, run.id, "discover");
    addTask(db, run.id, readOnlyTask("scout_auth", "scout", "Inspect auth"), config);
    assert.deepEqual(getRunnableTasks(db, run.id, 10).map((task) => task.id), ["scout_auth"]);
    assert.equal(gateReport(db, root, run.id, "research").pass, false);

    const first = claimTask(db, run.id, "scout_auth", "scout-1", config);
    assert.match(db.prepare("SELECT resource FROM leases WHERE task_id = ?").get("scout_auth").resource, /^@task:/);
    const heartbeat = heartbeatTask(db, run.id, "scout_auth", first.leaseToken, config, 45);
    assert.ok(Date.parse(heartbeat.expiresAt) > Date.now());

    db.prepare("UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ?").run("scout_auth");
    assert.equal(cleanupExpiredLeases(db), 1);
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = ?").get("scout_auth").status, "blocked");
    assert.ok(db.prepare("SELECT 1 FROM leases WHERE task_id = ?").get("scout_auth"));
    assert.throws(() => finishTask(db, root, run.id, "scout_auth", first.leaseToken, { Status: "COMPLETED", Files: [], Summary: "late" }, config));
    retryTask(db, run.id, "scout_auth", "Recover after expired worker", config, "transient");

    const second = claimTask(db, run.id, "scout_auth", "scout-2", config);
    finishTask(db, root, run.id, "scout_auth", second.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Signatures: [],
      Breaking: [],
      Decisions: [],
      Summary: "The repository package metadata is present.",
      EvidenceRefs: ["package.json:1"],
      Blockers: []
    });
    putArtifact(db, root, run.id, "discovery", {
      scope: ["src/auth"],
      knownFacts: ["Auth is under src/auth."],
      unknowns: [],
      constraints: [],
      nonGoals: [],
      successCriteria: ["Auth inspected"],
      designRequired: true
    });
    assert.equal(gateReport(db, root, run.id, "research").pass, true);
  } finally {
    db.close();
  }
});

test("verifier and curator tasks are first-class phase work", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Add a verified module and documentation");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["src/value.js", "docs/value.md"],
      constraints: [],
      nonGoals: [],
      successCriteria: ["Module and docs exist"],
      designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "implement_value",
      title: "Implement value module",
      goal: "Create src/value.js",
      role: "worker",
      readOnly: false,
      scope: ["src/value.js"],
      nonGoals: [],
      constraints: [],
      targetPaths: ["src/value.js"],
      interfaces: ["value: number"],
      acceptanceCriteria: ["Exports value"],
      requiredEvidence: ["syntax check"],
      dependsOn: []
    }, config);
    addTask(db, run.id, {
      ...readOnlyTask("review_value", "reviewer", "Review the integrated value export"),
      reviewKind: "integration",
      dependsOn: ["implement_value"]
    }, config);
    addTask(db, run.id, {
      ...readOnlyTask("verify_value", "verifier", "Verify value export"),
      dependsOn: ["implement_value"]
    }, config);
    addTask(db, run.id, {
      ...readOnlyTask("adversarial_value", "adversarial-reviewer", "Challenge the completion candidate"),
      reviewKind: "completion",
      requiredEvidence: ["Current verification-candidate artifact"],
      dependsOn: ["review_value", "verify_value"]
    }, config);
    addTask(db, run.id, {
      id: "curate_value_docs",
      title: "Document value module",
      goal: "Create docs/value.md",
      role: "curator",
      readOnly: false,
      scope: ["docs/value.md"],
      nonGoals: [],
      constraints: [],
      targetPaths: ["docs/value.md"],
      interfaces: [],
      acceptanceCriteria: ["Documentation matches final source"],
      requiredEvidence: ["docs/value.md"],
      dependsOn: ["adversarial_value"]
    }, config);
    const approvedPlan = sealAndApprovePlan(db, root, run.id, config);
    forcePhase(db, root, config, run.id, "execute");

    const work = claimTask(db, run.id, "implement_value", "worker", config);
    mkdirSync(path.join(work.workspacePath, "src"), { recursive: true });
    writeFileSync(path.join(work.workspacePath, "src/value.js"), "export const value = 1;\n");
    finishTask(db, root, run.id, "implement_value", work.leaseToken, {
      Status: "COMPLETED",
      Files: ["src/value.js"],
      Summary: "Added value export.",
      EvidenceRefs: ["src/value.js:1"]
    }, config);
    advancePhase(db, root, run.id, "review");
    const integrationCandidate = latestArtifact(db, root, run.id, "integration-candidate", ["verified"]);
    const review = claimTask(db, run.id, "review_value", "reviewer", config);
    finishTask(db, root, run.id, "review_value", review.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Verdict: "APPROVED",
      Findings: [],
      Summary: "The integrated value export is correct.",
      EvidenceRefs: [{ type: "artifact", id: integrationCandidate.id, contentRef: integrationCandidate.content_ref }],
      Blockers: []
    }, config);
    assert.equal(reconcileReview(db, root, run.id, config, { reviewKind: "integration" }).status, "APPROVED");
    advancePhase(db, root, run.id, "verify");

    registerCheck(db, run.id, {
      name: "syntax",
      command: nodeCommand(["--check", "src/value.js"]),
      required: true,
      requirementIds: ["REQ-001"]
    });
    assert.equal(runChecks(db, root, run.id, config)[0].status, "passed");
    assert.equal(gateReport(db, root, run.id, "curate").pass, false);
    const verify = claimTask(db, run.id, "verify_value", "verifier", config);
    finishTask(db, root, run.id, "verify_value", verify.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Final source exports value.",
      EvidenceRefs: ["src/value.js:1"]
    }, config);
    const currentGraph = plannedGraphFingerprint(db, run.id);
    assert.equal(currentGraph.hash, approvedPlan.draft.graph.hash, JSON.stringify({
      planned: approvedPlan.draft.graph,
      current: currentGraph
    }));
    const candidate = createVerificationCandidate(db, root, run.id, config);
    const adversarial = claimTask(db, run.id, "adversarial_value", "adversarial-reviewer", config);
    finishTask(db, root, run.id, "adversarial_value", adversarial.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Verdict: "APPROVED",
      Findings: [],
      Summary: "No credible completion defect remains.",
      EvidenceRefs: [{ type: "artifact", id: candidate.artifact.id, contentRef: candidate.artifact.content_ref }],
      Blockers: []
    }, config);
    assert.equal(reconcileReview(db, root, run.id, config, { reviewKind: "completion" }).status, "APPROVED");
    advancePhase(db, root, run.id, "curate");

    assert.equal(gateReport(db, root, run.id, "complete").pass, false);
    const curate = claimTask(db, run.id, "curate_value_docs", "curator", config);
    mkdirSync(path.join(curate.workspacePath, "docs"), { recursive: true });
    writeFileSync(path.join(curate.workspacePath, "docs/value.md"), "# Value\n\nExports `value`.\n");
    finishTask(db, root, run.id, "curate_value_docs", curate.leaseToken, {
      Status: "COMPLETED",
      Files: ["docs/value.md"],
      Summary: "Documented the module.",
      EvidenceRefs: ["docs/value.md:1"]
    }, config);
    const knowledge = synchronizeKnowledge(db, root, run.id, config);
    assert.equal(knowledge.clean, true);
    evaluateRun(db, root, run.id, config);
    const completion = gateReport(db, root, run.id, "complete");
    assert.equal(completion.pass, true, JSON.stringify(completion.failures));
  } finally {
    db.close();
  }
});

test("a planned coordinator shields Main from worker detail and future phases do not run early", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Build and synthesize one domain lane");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["src/domain.js"],
      constraints: [],
      nonGoals: [],
      successCriteria: ["Domain lane is implemented and verified"],
      designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "domain_worker",
      title: "Implement domain lane",
      goal: "Create src/domain.js",
      role: "worker",
      readOnly: false,
      targetPaths: ["src/domain.js"],
      acceptanceCriteria: ["Module exists"],
      requiredEvidence: ["src/domain.js"],
      dependsOn: []
    }, config);
    addTask(db, run.id, {
      id: "domain_coordinator",
      title: "Synthesize domain lane",
      goal: "Reconcile domain worker evidence",
      role: "coordinator",
      readOnly: true,
      targetPaths: [],
      acceptanceCriteria: ["Return compact synthesis"],
      requiredEvidence: ["worker evidence references"],
      dependsOn: ["domain_worker"]
    }, config);
    addTask(db, run.id, {
      id: "domain_verifier",
      title: "Verify domain lane",
      goal: "Verify the final module",
      role: "verifier",
      readOnly: true,
      targetPaths: [],
      acceptanceCriteria: ["Verify current source"],
      requiredEvidence: ["current source reference"],
      dependsOn: ["domain_coordinator"]
    }, config);
    addTask(db, run.id, {
      id: "domain_curator",
      title: "Curate domain knowledge",
      goal: "Review documentation impact",
      role: "curator",
      readOnly: true,
      targetPaths: [],
      acceptanceCriteria: ["Resolve documentation impact"],
      requiredEvidence: ["curation disposition"],
      dependsOn: ["domain_verifier"]
    }, config);

    assert.equal(db.prepare("SELECT phase FROM tasks WHERE id = 'domain_worker'").get().phase, "execute");
    assert.equal(db.prepare("SELECT phase FROM tasks WHERE id = 'domain_verifier'").get().phase, "verify");
    assert.equal(db.prepare("SELECT phase FROM tasks WHERE id = 'domain_curator'").get().phase, "curate");
    assert.deepEqual(getRunnableTasks(db, run.id, 10), []);

    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id).content);
    forcePhase(db, root, config, run.id, "execute");
    assert.deepEqual(getRunnableTasks(db, run.id, 10).map((task) => task.id), ["domain_worker"]);

    const work = claimTask(db, run.id, "domain_worker", "worker", config);
    mkdirSync(path.join(work.workspacePath, "src"), { recursive: true });
    writeFileSync(path.join(work.workspacePath, "src/domain.js"), "export const domain = true;\n");
    finishTask(db, root, run.id, "domain_worker", work.leaseToken, {
      Status: "COMPLETED",
      Files: ["src/domain.js"],
      Summary: "Implemented the domain lane.",
      EvidenceRefs: ["src/domain.js:1"]
    });
    assert.deepEqual(getRunnableTasks(db, run.id, 10).map((task) => task.id), ["domain_coordinator"]);
    const coordinator = claimTask(db, run.id, "domain_coordinator", "coordinator", config);
    assert.equal(coordinator.contract.Background[0].TaskId, "domain_worker");
    finishTask(db, root, run.id, "domain_coordinator", coordinator.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Domain evidence is consistent.",
      EvidenceRefs: ["src/domain.js:1"]
    });
    forcePhase(db, root, config, run.id, "verify");
    assert.deepEqual(getRunnableTasks(db, run.id, 10).map((task) => task.id), ["domain_verifier"]);
  } finally {
    db.close();
  }
});
