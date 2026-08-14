import assert from "node:assert/strict";
import test from "node:test";
import { performanceReport } from "../src/core/report.js";
import { putArtifact, recordEvent } from "../src/core/state.js";
import { registerCheck } from "../src/core/checks.js";
import { addTask, finalizeTaskAttempt, getTask, markTaskAttemptSpawnAccepted, startTaskAttempt } from "../src/core/tasks.js";
import { forcePhase, makeProject, nodeCommand, startTestRun } from "./helpers.js";

function markRunCompleted(db, runId) {
  db.prepare("UPDATE runs SET phase = 'complete', status = 'completed', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), runId);
}

function putVerificationEvidence(db, root, runId) {
  putArtifact(db, root, runId, "verification", { verified: true });
  putArtifact(db, root, runId, "verification-candidate", { verified: true });
}

test("performance report reconstructs durable effort, concurrency, retry, and timing evidence", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 8 } } });
  try {
    const { run } = startTestRun(db, root, config, "Reconstruct performance evidence");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "performance-worker", title: "Performance worker", goal: "Produce durable timing evidence",
      role: "worker", taskKind: "implementation", runPhase: "execute", wave: 1, readOnly: false,
      targetPaths: ["src/performance.js"], scope: ["src/performance.js"],
      acceptanceCriteria: ["Performance evidence is reconstructable."], requiredEvidence: ["Current evidence"],
      expectedOutputs: ["implementation"], requirementIds: ["REQ-001"], complexity: "low", risk: "low", effort: "small"
    }, config);
    const task = getTask(db, "performance-worker");
    db.prepare("UPDATE tasks SET phase = 'review' WHERE id = ?").run(task.id);
    startTaskAttempt(db, run, task, 1, { attemptNumber: 1, startAt: "2026-01-01T00:00:00.000Z" });
    markTaskAttemptSpawnAccepted(db, task.id, 1, "2026-01-01T00:00:01.000Z");
    finalizeTaskAttempt(db, task.id, 1, "failed", {
      failureClass: "reasoning", failureCause: "bounded failure", terminalAt: "2026-01-01T00:00:02.000Z"
    });
    recordEvent(db, run.id, "performance.repository-sync", "info", {
      operationId: "sync-test", durationMs: 12, cached: true, reason: "cache-hit", discoveredFiles: 10
    });

    const report = performanceReport(db, run.id);
    assert.ok(report.events >= 1);
    assert.ok(report.timings["repository-sync"].totalMs >= 12);
    assert.equal(report.concurrency.totalAgentAttempts, 1);
    assert.equal(report.concurrency.max, 1);
    assert.equal(report.concurrency.availableSlots, 8);
    assert.equal(report.requestedEffortCounts.high, 1);
    assert.equal(report.effectiveEffortCounts.high, 1);
    assert.equal(report.verifiedCompletionTimeMs, null);
    assert.equal(report.criticalPath.kind, "attempt-duration approximation");
    assert.equal(report.hostSpawnAcceptanceTimeMs.medianMs, 1000);
    assert.equal(report.childExecutionTimeMs.medianMs, 1000);
    assert.equal(report.reviewTimeMs.medianMs, 1000);
    assert.equal(report.controllerWaitTimeMs, 2000);
    assert.equal(report.timeToFirstSpawnMs, 0); // fixture dates precede the run clock
  } finally {
    db.close();
  }
});

test("performance report recognizes a completed verifier-only run", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Report verifier-only completion");
    putVerificationEvidence(db, root, run.id);
    markRunCompleted(db, run.id);

    const report = performanceReport(db, run.id);
    assert.equal(report.verifiedCompletion, true);
    assert.ok(Number.isFinite(report.verifiedCompletionTimeMs));
  } finally {
    db.close();
  }
});

test("performance report rejects completed runs with a failed required check", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Report failed required check");
    const check = registerCheck(db, run.id, {
      name: "required-check",
      command: nodeCommand(["-e", "process.exit(0)"]),
      required: true
    });
    db.prepare("UPDATE checks SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), check.id);
    putVerificationEvidence(db, root, run.id);
    markRunCompleted(db, run.id);

    const report = performanceReport(db, run.id);
    assert.equal(report.verifiedCompletion, false);
    assert.equal(report.verifiedCompletionTimeMs, null);

    db.prepare("UPDATE checks SET status = 'stale', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), check.id);
    const staleReport = performanceReport(db, run.id);
    assert.equal(staleReport.verifiedCompletion, false);
    assert.equal(staleReport.verifiedCompletionTimeMs, null);
  } finally {
    db.close();
  }
});

test("performance report stays incomplete when verification evidence is missing", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Report missing verification evidence");
    markRunCompleted(db, run.id);

    const report = performanceReport(db, run.id);
    assert.equal(report.verifiedCompletion, false);
    assert.equal(report.verifiedCompletionTimeMs, null);
  } finally {
    db.close();
  }
});

test("performance report recognizes normal completion with a passed required check", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Report normal checked completion");
    const check = registerCheck(db, run.id, {
      name: "required-check",
      command: nodeCommand(["-e", "process.exit(0)"]),
      required: true
    });
    db.prepare("UPDATE checks SET status = 'passed', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), check.id);
    putVerificationEvidence(db, root, run.id);
    markRunCompleted(db, run.id);

    const report = performanceReport(db, run.id);
    assert.equal(report.verifiedCompletion, true);
    assert.equal(report.verification.passed, true);
    assert.ok(Number.isFinite(report.verifiedCompletionTimeMs));
  } finally {
    db.close();
  }
});
