import assert from "node:assert/strict";
import test from "node:test";
import { nextControllerAction } from "../src/core/controller.js";
import { registerCheck, runChecks } from "../src/core/checks.js";
import { progressStatus, sampleProgress } from "../src/core/progress.js";
import { advancePhase, latestArtifact, putArtifact, reopenPhase, startRun } from "../src/core/state.js";
import { addTask, claimTask, finishTask, sealPlan } from "../src/core/tasks.js";
import { makeProject, nodeCommand, startTestRun, forcePhase } from "./helpers.js";

const futureTask = (id, role, runPhase, dependsOn = []) => ({
  id,
  title: id,
  goal: id,
  role,
  runPhase,
  readOnly: true,
  targetPaths: [],
  acceptanceCriteria: ["done"],
  requiredEvidence: ["evidence"],
  dependsOn
});

test("reopening execution invalidates downstream evidence and reschedules future agents", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Exercise controlled rollback");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["package.json"], constraints: [], nonGoals: [], successCriteria: ["verified"], designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "execute_noop",
      title: "Execute no-op",
      goal: "Record existing package state",
      role: "worker",
      readOnly: false,
      targetPaths: ["package.json"],
      acceptanceCriteria: ["package exists"],
      requiredEvidence: ["package.json"],
      dependsOn: []
    }, config);
    addTask(db, run.id, futureTask("verify_noop", "verifier", "verify", ["execute_noop"]), config);
    addTask(db, run.id, futureTask("curate_noop", "curator", "curate", ["verify_noop"]), config);
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id).content);
    forcePhase(db, root, config, run.id, "execute");
    const worker = claimTask(db, run.id, "execute_noop", "worker", config);
    finishTask(db, root, run.id, "execute_noop", worker.leaseToken, {
      Status: "COMPLETED", Files: [], Summary: "No source change required.", EvidenceRefs: ["package.json"]
    }, config);
    forcePhase(db, root, config, run.id, "verify");
    const verifier = claimTask(db, run.id, "verify_noop", "verifier", config);
    finishTask(db, root, run.id, "verify_noop", verifier.leaseToken, {
      Status: "COMPLETED", Files: [], Summary: "Verified.", EvidenceRefs: ["package.json"]
    }, config);
    registerCheck(db, run.id, { name: "package-json", command: nodeCommand(["-e", "JSON.parse(require('fs').readFileSync('package.json'))"]), required: true });
    assert.equal(runChecks(db, root, run.id, config)[0].status, "passed");
    putArtifact(db, root, run.id, "verification", { verified: true });
    forcePhase(db, root, config, run.id, "curate");
    const curator = claimTask(db, run.id, "curate_noop", "curator", config);
    finishTask(db, root, run.id, "curate_noop", curator.leaseToken, {
      Status: "COMPLETED", Files: [], Summary: "No documentation change.", EvidenceRefs: ["package.json"]
    }, config);
    putArtifact(db, root, run.id, "knowledge-sync", { clean: true });

    const reopened = reopenPhase(db, run.id, "execute", "Verification exposed an implementation issue");
    assert.equal(reopened.phase, "execute");
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'execute_noop'").get().status, "completed");
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'verify_noop'").get().status, "pending");
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'curate_noop'").get().status, "pending");
    assert.equal(db.prepare("SELECT status FROM checks WHERE name = 'package-json'").get().status, "stale");
    assert.equal(latestArtifact(db, root, run.id, "verification"), null);
    assert.equal(latestArtifact(db, root, run.id, "knowledge-sync"), null);
    assert.ok(latestArtifact(db, root, run.id, "plan"));
  } finally {
    db.close();
  }
});

test("reopening a phase resets its watchdog baseline without masking a later true stall", () => {
  const { root, config, db } = makeProject({ config: { orchestration: { progressStallThreshold: 2 } } });
  try {
    const { run } = startTestRun(db, root, config, "Recover a stalled phase");
    forcePhase(db, root, config, run.id, "plan");
    sampleProgress(db, run.id, config);
    db.prepare("UPDATE runs SET revision = revision + 1 WHERE id = ?").run(run.id);
    sampleProgress(db, run.id, config);
    db.prepare("UPDATE runs SET revision = revision + 1 WHERE id = ?").run(run.id);
    assert.equal(sampleProgress(db, run.id, config).stalled, true);

    db.prepare("UPDATE runs SET phase = 'execute', revision = revision + 1 WHERE id = ?").run(run.id);
    const reason = "Return to discovery after the watchdog stall";
    reopenPhase(db, run.id, "discover", reason);
    assert.equal(progressStatus(db, run.id, config), null);
    forcePhase(db, root, config, run.id, "plan");
    assert.equal(progressStatus(db, run.id, config), null);
    const baseline = sampleProgress(db, run.id, config);
    assert.equal(baseline.progressed, true);
    assert.equal(baseline.stallCount, 0);
    assert.equal(baseline.stalled, false);
    assert.notEqual(nextControllerAction(db, root, run.id, config, { sampleProgress: false }).type, "STALLED_REPLAN");

    db.prepare("UPDATE runs SET revision = revision + 1 WHERE id = ?").run(run.id);
    sampleProgress(db, run.id, config);
    db.prepare("UPDATE runs SET revision = revision + 1 WHERE id = ?").run(run.id);
    assert.equal(sampleProgress(db, run.id, config).stalled, true);
    assert.equal(nextControllerAction(db, root, run.id, config, { sampleProgress: false }).type, "STALLED_REPLAN");
  } finally {
    db.close();
  }
});

test("identical reopen is rejected when no durable evidence follows recovery", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject duplicate recovery");
    forcePhase(db, root, config, run.id, "execute");
    const reason = "Reopen discovery for new evidence";
    reopenPhase(db, run.id, "discover", reason);
    // Test-only phase positioning does not create evidence, so repeating the
    // same recovery action must fail closed.
    db.prepare("UPDATE runs SET phase = 'execute', revision = revision + 1 WHERE id = ?").run(run.id);
    assert.throws(
      () => reopenPhase(db, run.id, "discover", reason),
      (error) => error.code === "REOPEN_DUPLICATE"
    );
  } finally {
    db.close();
  }
});
