import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { nextControllerAction } from "../src/core/controller.js";
import { freezeGoalContract } from "../src/core/contracts.js";
import { advancePhase, gateReport, materializeFastPathPrerequisites, fastPathEligibility, startRun } from "../src/core/state.js";
import { takeoverController } from "../src/core/ownership.js";
import { readObject } from "../src/core/objects.js";
import { lintPlan } from "../src/core/plan-review.js";
import { claimTask, getRunnableTasks, listTasks, releaseTaskClaim } from "../src/core/tasks.js";
import { makeProject } from "./helpers.js";

function fastContract(db, root, runId, overrides = {}) {
  return freezeGoalContract(db, root, runId, {
    objective: "Update the local parser",
    scope: overrides.scope ?? ["src/parser.js", "tests/parser.test.js"],
    nonGoals: ["Unrelated changes"],
    constraints: ["Preserve existing behavior"],
    successCriteria: ["The parser accepts the new local case."],
    complexity: "trivial",
    route: {
      lifecycleProfile: "fast",
      researchRequired: false,
      designRequired: false,
      specialistReviewRequired: false,
      documentationRequired: true,
      ...overrides.route
    },
    requirements: [{
      id: "REQ-001", title: "Accept the local parser case", description: "Accept the local parser case.",
      kind: "functional", priority: "must", acceptance: ["The local parser case is accepted."]
    }]
  });
}

function fastProject(options = {}) {
  return makeProject({ config: { orchestration: {
    requirePlanCritic: options.requirePlanCritic ?? true,
    specialistReviews: { enabled: true }
  } } });
}

test("fast path defaults off and only emits for an explicitly eligible contract", () => {
  const { root, db, config } = fastProject();
  try {
    const started = startRun(db, root, config, "Update the local parser");
    fastContract(db, root, started.run.id, { route: { lifecycleProfile: "balanced" } });
    db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
    assert.equal(fastPathEligibility(db, started.run.id, { isSafeRepoPath: () => true }).eligible, false);
    assert.equal(nextControllerAction(db, root, started.run.id, config, { sampleProgress: false }).type, "CREATE_DISCOVERY_WAVE");
  } finally { db.close(); }
});

test("eligible fast path materializes bounded canonical records and remains idempotent", () => {
  const { root, db, config } = fastProject();
  try {
    const started = startRun(db, root, config, "Update the local parser");
    fastContract(db, root, started.run.id);
    db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
    const action = nextControllerAction(db, root, started.run.id, config, { sampleProgress: false });
    assert.equal(action.type, "MATERIALIZE_FAST_PATH_PREREQUISITES");
    const eligibility = fastPathEligibility(db, started.run.id, { config });
    assert.equal(eligibility.eligible, true);
    assert.deepEqual(eligibility.capabilities, []);
    const result = materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config);
    assert.equal(result.run.phase, "plan");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND id LIKE 'fast-path-%'").get(started.run.id).count, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id LIKE 'fast-path-%'").get(started.run.id).count, 5);
    const repeated = materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config);
    assert.equal(repeated.taskId, result.taskId);
    assert.equal(nextControllerAction(db, root, started.run.id, config, { sampleProgress: false }).type, "ADVANCE_PHASE");
  } finally { db.close(); }
});

test("fast-path replay rejects a stale or drifted approved packet set", () => {
  const { root, db, config } = fastProject();
  try {
    const started = startRun(db, root, config, "Update the local parser");
    fastContract(db, root, started.run.id);
    db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
    const result = materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config);
    const binding = JSON.parse(readObject(db, root, db.prepare("SELECT content_ref FROM artifacts WHERE id = ?").get(result.artifactIds[4]).content_ref)).packetBindings[0];
    db.prepare("UPDATE task_packets SET packet_hash = ? WHERE id = ?").run("replay-drifted-packet-hash", binding.packetId);

    assert.throws(
      () => materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config),
      /FAST_PATH_PREREQUISITES_STALE|differs from the approved packet set/i
    );
  } finally { db.close(); }
});

test("generated fast-path plan passes lint and preserves every later lifecycle task", () => {
  const { root, db, config } = fastProject({ requirePlanCritic: false });
  try {
    const started = startRun(db, root, config, "Update the local parser");
    fastContract(db, root, started.run.id);
    db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
    materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config);

    const lint = lintPlan(db, started.run.id, config, root);
    assert.equal(lint.verdict, "APPROVED", JSON.stringify(lint.findings));
    const result = materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config);
    const [implementationId, integrationReviewId, verificationId, adversarialReviewId, curationId] = result.taskIds;
    const tasks = listTasks(db, started.run.id);
    const reviewRow = db.prepare("SELECT content_ref FROM artifacts WHERE id = ?").get(result.artifactIds[4]);
    const deterministicReview = JSON.parse(reviewRow.content_ref ? readObject(db, root, reviewRow.content_ref) : "{}");
    assert.equal(deterministicReview.source, "bounded-fast-path");
    assert.equal(deterministicReview.deterministic, true);
    assert.equal(deterministicReview.verdict, "APPROVED");
    assert.equal(deterministicReview.packetBindings.length, result.taskIds.length);
    assert.deepEqual(deterministicReview.packetBindings.map((binding) => binding.taskId).sort(), [...result.taskIds].sort());
    assert.ok(deterministicReview.packetBindings.every((binding) => (
      binding.packetId && binding.packetHash && binding.packetBlueprintHash && binding.blueprintHash
    )));
    const reviewMetadata = JSON.parse(db.prepare("SELECT metadata_json FROM artifacts WHERE id = ?").get(result.artifactIds[4]).metadata_json);
    assert.deepEqual(reviewMetadata.packetBindings, deterministicReview.packetBindings);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND role = 'plan-critic'").get(started.run.id).count, 0);
    assert.equal(tasks.some((task) => task.role === "plan-critic"), false);
    assert.ok(db.prepare("SELECT capabilities_json FROM tasks WHERE run_id = ?").all(started.run.id)
      .every((row) => Array.isArray(JSON.parse(row.capabilities_json))));
    assert.deepEqual(tasks.map((task) => [task.id, task.role, task.phase, task.readOnly, task.dependsOn]), [
      [implementationId, "worker", "execute", false, []],
      [integrationReviewId, "reviewer", "review", true, [implementationId]],
      [verificationId, "verifier", "review", true, [implementationId]],
      [adversarialReviewId, "adversarial-reviewer", "verify", true, [integrationReviewId, verificationId]],
      [curationId, "curator", "curate", true, [adversarialReviewId]]
    ]);

    const mandatory = new Map([
      [integrationReviewId, "NO_INTEGRATION_REVIEW"],
      [verificationId, "NO_VERIFIER_TASK"],
      [adversarialReviewId, "NO_ADVERSARIAL_REVIEW"],
      [curationId, "NO_CURATOR_TASK"]
    ]);
    for (const [taskId, findingCode] of mandatory) {
      db.exec("SAVEPOINT fast_path_required");
      db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
      assert.ok(lintPlan(db, started.run.id, config).findings.some((finding) => finding.code === findingCode));
      db.exec("ROLLBACK TO fast_path_required");
      db.exec("RELEASE fast_path_required");
    }

    advancePhase(db, root, started.run.id, "execute");
    assert.deepEqual(getRunnableTasks(db, started.run.id, 10).map((task) => task.id), [implementationId]);
    const reviewGate = gateReport(db, root, started.run.id, "review");
    assert.equal(reviewGate.pass, false);
    assert.match(reviewGate.failures.join("\n"), new RegExp(`${implementationId}:pending`));
    assert.ok(listTasks(db, started.run.id).filter((task) => ["review", "verify", "curate"].includes(task.phase)).every((task) => task.status === "pending"));
    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(implementationId);
    advancePhase(db, root, started.run.id, "review");
    assert.deepEqual(
      getRunnableTasks(db, started.run.id, 10).map((task) => task.id).sort(),
      [integrationReviewId, verificationId].sort()
    );
  } finally { db.close(); }
});

test("deterministic fast plan approval blocks execute when a bound packet drifts or becomes stale", () => {
  for (const drift of ["hash", "blueprint"]) {
    const { root, db, config } = fastProject();
    try {
      const started = startRun(db, root, config, "Update the local parser");
      fastContract(db, root, started.run.id);
      db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
      const result = materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config);
      const review = JSON.parse(readObject(db, root, db.prepare("SELECT content_ref FROM artifacts WHERE id = ?").get(result.artifactIds[4]).content_ref));
      const binding = review.packetBindings[0];
      if (drift === "hash") {
        db.prepare("UPDATE task_packets SET packet_hash = ? WHERE id = ?").run("drifted-packet-hash", binding.packetId);
      } else {
        db.prepare("UPDATE tasks SET target_paths_json = ? WHERE id = ?").run(JSON.stringify(["src/parser.js", "tests/parser.test.js", "drifted.js"]), binding.taskId);
      }
      const gate = gateReport(db, root, started.run.id, "execute");
      assert.equal(gate.pass, false, drift);
      assert.match(gate.failures.join("\n"), /deterministic plan task packet .* (differs|missing|stale)/i);
    } finally { db.close(); }
  }
});

test("parallel fast review tasks are bound to one immutable integration candidate", () => {
  const { root, db, config } = fastProject({ requirePlanCritic: false });
  let reviewerClaim = null;
  try {
    const started = startRun(db, root, config, "Update the local parser");
    fastContract(db, root, started.run.id, { scope: ["src/parser.js"] });
    db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
    const result = materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config);
    const [implementationId, integrationReviewId, verificationId] = result.taskIds;
    advancePhase(db, root, started.run.id, "execute");
    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(implementationId);
    advancePhase(db, root, started.run.id, "review");

    reviewerClaim = claimTask(db, started.run.id, integrationReviewId, "reviewer", config);
    assert.equal(reviewerClaim.contract.SubjectArtifact.kind, "integration-candidate");
    const candidate = reviewerClaim.contract.SubjectArtifact;
    const verifierCandidate = db.prepare("SELECT id, content_ref FROM artifacts WHERE run_id = ? AND kind = 'integration-candidate' AND status = 'verified'").get(started.run.id);
    assert.deepEqual([candidate.id, candidate.contentRef], [verifierCandidate.id, verifierCandidate.content_ref]);

    mkdirSync(`${root}/src`, { recursive: true });
    writeFileSync(`${root}/src/parser.js`, "export const parser = 'changed-after-freeze';\n");
    assert.throws(
      () => claimTask(db, started.run.id, verificationId, "verifier", config),
      /integration[- ]candidate|TASK_SUBJECT_ARTIFACT_REQUIRED|TASK_INTEGRATION_CANDIDATE_STALE/i
    );
    assert.equal(db.prepare("SELECT status FROM artifacts WHERE id = ?").get(candidate.id).status, "stale");
  } finally {
    if (reviewerClaim) releaseTaskClaim(db, root, reviewerClaim.task.id, reviewerClaim.attemptFence, "test-cleanup");
    db.close();
  }
});

test("fast path rejects unsafe scope and preserves ordinary discovery", () => {
  const { root, db, config } = fastProject();
  try {
    const started = startRun(db, root, config, "Update the local parser");
    fastContract(db, root, started.run.id, { route: { lifecycleProfile: "fast" } });
    db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
    db.prepare("UPDATE goal_contracts SET scope_json = ? WHERE run_id = ? AND status = 'active'").run(JSON.stringify(["../secrets.txt"]), started.run.id);
    assert.equal(fastPathEligibility(db, started.run.id, { isSafeRepoPath: (value) => !value.includes("..") }).eligible, false);
    assert.equal(nextControllerAction(db, root, started.run.id, config, { sampleProgress: false }).type, "CREATE_DISCOVERY_WAVE");
  } finally { db.close(); }
});

test("canonical capability routing rejects specialist auth, database, and cache or queue paths", () => {
  const cases = [
    { paths: ["src/auth/handler.js"], capability: "security" },
    { paths: ["db/schema.js"], capability: "database" },
    { paths: ["src/cache/queue.js"], capability: "performance" }
  ];
  for (const item of cases) {
    const { root, db, config } = fastProject();
    try {
      const started = startRun(db, root, config, "Update the local parser");
      fastContract(db, root, started.run.id, { scope: item.paths, route: { lifecycleProfile: "balanced" } });
      db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
      const eligibility = fastPathEligibility(db, started.run.id, { config });
      assert.equal(eligibility.eligible, false, item.paths[0]);
      assert.ok(eligibility.capabilities.some((capability) => capability.name === item.capability), item.paths[0]);
      assert.ok(eligibility.specialistRoles.length > 0, item.paths[0]);
      assert.equal(nextControllerAction(db, root, started.run.id, config, { sampleProgress: false }).type, "CREATE_PREDESIGN_WAVE");
      assert.throws(
        () => materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config),
        /FAST_PATH_INELIGIBLE|resolves a specialist/
      );
    } finally { db.close(); }
  }
});

test("fast path rejects mutable paths that cross a symlink ancestor", () => {
  const { root, db, config } = fastProject();
  try {
    mkdirSync(`${root}/actual`, { recursive: true });
    symlinkSync("actual", `${root}/linked`);
    const started = startRun(db, root, config, "Update the local parser");
    fastContract(db, root, started.run.id);
    db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
    db.prepare("UPDATE goal_contracts SET scope_json = ? WHERE run_id = ? AND status = 'active'").run(JSON.stringify(["linked/parser.js"]), started.run.id);
    const eligibility = fastPathEligibility(db, started.run.id, { config });
    assert.equal(eligibility.eligible, false);
    assert.ok(eligibility.reasons.includes("scope contains an unsafe mutable ownership path"));
    assert.equal(nextControllerAction(db, root, started.run.id, config, { sampleProgress: false }).type, "CREATE_DISCOVERY_WAVE");
  } finally { db.close(); }
});

test("fast path materialization is fenced against a stale controller", () => {
  const { root, db, config } = fastProject();
  try {
    const started = startRun(db, root, config, "Update the local parser");
    fastContract(db, root, started.run.id);
    db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
    takeoverController(db, started.run.id, { force: true, owner: "replacement", sessionId: "replacement-session" });
    assert.throws(() => materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config), /Another controller session owns this run/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND id LIKE 'fast-path-%'").get(started.run.id).count, 0);
  } finally { db.close(); }
});

test("fast path rejects a stale eligibility basis before writing prerequisites", () => {
  const { root, db, config } = fastProject();
  try {
    const started = startRun(db, root, config, "Update the local parser");
    fastContract(db, root, started.run.id);
    db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
    const eligibility = fastPathEligibility(db, started.run.id, { config });
    assert.equal(eligibility.eligible, true);

    // An amendment resets the run to discover but changes every materialization
    // basis field. Passing the old basis must fail before any fast-path row is written.
    db.prepare("UPDATE goal_contracts SET contract_hash = ? WHERE run_id = ? AND status = 'active'")
      .run("drifted-contract-hash", started.run.id);
    db.prepare("UPDATE runs SET revision = revision + 1 WHERE id = ?").run(started.run.id);
    assert.throws(
      () => materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config, { expectedBasis: eligibility.basis }),
      /FAST_PATH_BASIS_STALE|eligibility basis is stale/
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND id LIKE 'fast-path-%'").get(started.run.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id LIKE 'fast-path-%'").get(started.run.id).count, 0);
  } finally { db.close(); }
});
