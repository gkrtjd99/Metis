import assert from "node:assert/strict";
import test from "node:test";
import { addTask, finalizeTaskAttempt, getTask, startTaskAttempt, taskAttemptHistory } from "../src/core/tasks.js";
import { forcePhase, makeProject, startTestRun } from "./helpers.js";

function implementationTask() {
  return {
    id: "attempt-worker",
    title: "Attempt worker",
    goal: "Exercise durable attempt provenance",
    role: "worker",
    taskKind: "implementation",
    runPhase: "execute",
    wave: 1,
    readOnly: false,
    targetPaths: ["src/attempt.js"],
    scope: ["src/attempt.js"],
    acceptanceCriteria: ["Attempt provenance remains append-only."],
    requiredEvidence: ["Current source evidence"],
    expectedOutputs: ["implementation"],
    requirementIds: ["REQ-001"],
    complexity: "low",
    risk: "low",
    effort: "small"
  };
}

test("attempt provenance is append-only and fenced across retries", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Attempt provenance");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, implementationTask(), config);
    forcePhase(db, root, config, run.id, "execute");
    const task = getTask(db, "attempt-worker");

    startTaskAttempt(db, run, task, 1, { attemptNumber: 1, spawnBatchId: null, startAt: "2026-01-01T00:00:00.000Z" });
    finalizeTaskAttempt(db, task.id, 1, "failed", {
      failureClass: "reasoning",
      failureCause: "The first bounded attempt missed an invariant.",
      terminalAt: "2026-01-01T00:00:01.000Z"
    });
    db.prepare("UPDATE tasks SET attempt_fence = 2, attempts = 2, requested_effort = 'xhigh', effective_effort = 'xhigh', reasoning_effort = 'xhigh', escalation_level = 1 WHERE id = ?").run(task.id);
    const retried = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
    startTaskAttempt(db, run, retried, 2, { attemptNumber: 2, startAt: "2026-01-01T00:00:02.000Z" });

    const history = taskAttemptHistory(db, task.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].effectiveEffort, "high");
    assert.equal(history[0].failureClass, "reasoning");
    assert.equal(history[1].effectiveEffort, "xhigh");
    assert.equal(history[1].status, "running");
    assert.throws(() => finalizeTaskAttempt(db, task.id, 1, "completed"), /stale or already terminal/u);
  } finally {
    db.close();
  }
});
