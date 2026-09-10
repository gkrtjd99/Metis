import assert from "node:assert/strict";
import test from "node:test";

import { materializeFastPathPrerequisites, startRun } from "../src/core/state.js";
import { freezeGoalContract } from "../src/core/contracts.js";
import {
  acknowledgeScheduleSpawn,
  claimSchedule,
  handleChildTerminal
} from "../src/core/scheduler.js";
import { addTask } from "../src/core/tasks.js";
import { readObject, storeObject } from "../src/core/objects.js";
import { forcePhase, makeProject, spawnReceipts } from "./helpers.js";

function approvedFixture(options = {}) {
  const model = options.model ?? "fixture-approved-model";
  const requestedEffort = options.requestedEffort ?? "high";
  const { root, db, config } = makeProject({
    config: {
      host: options.host ?? "claude",
      models: {
        capabilities: {
          [options.host ?? "claude"]: { models: { [model]: ["low", "medium", "high"] } }
        }
      },
      ...(options.config ?? {})
    }
  });
  const started = startRun(db, root, config, options.goal ?? "Exercise approved execution scheduling");
  freezeGoalContract(db, root, started.run.id, {
    objective: options.goal ?? "Exercise approved execution scheduling",
    scope: ["src/parser.js"],
    nonGoals: ["Unrelated changes"],
    constraints: ["Keep the scheduler boundary deterministic"],
    successCriteria: ["The scheduler preserves the approved route."],
    complexity: "trivial",
    route: { lifecycleProfile: "fast", researchRequired: false, designRequired: false, specialistReviewRequired: false, documentationRequired: false },
    requirements: [{
      id: "REQ-001",
      title: "Preserve the approved route",
      acceptance: ["The scheduler preserves the approved route."]
    }]
  });
  forcePhase(db, root, config, started.run.id, "discover");
  const materialized = materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config, {
    executionSettings: {
      model,
      requestedEffort,
      confirmed: true,
      evidence: "Unit fixture user approval"
    }
  });
  return { root, db, config, started, materialized, model, requestedEffort };
}

function simpleTask(id, role = "worker") {
  return {
    id,
    title: id,
    goal: `Complete ${id}`,
    role,
    taskKind: role === "plan-critic" ? "review" : "implementation",
    runPhase: role === "plan-critic" ? "plan" : "execute",
    wave: 1,
    readOnly: true,
    scope: [id],
    targetPaths: [],
    requirementIds: ["REQ-001"],
    acceptanceCriteria: ["Return a bounded result."],
    requiredEvidence: [],
    expectedOutputs: ["result"],
    dependsOn: []
  };
}

function stateCounts(db, runId, taskId) {
  return {
    task: db.prepare("SELECT status, attempts, attempt_fence FROM tasks WHERE id = ? AND run_id = ?").get(taskId, runId),
    leases: db.prepare("SELECT COUNT(*) AS count FROM leases WHERE task_id = ?").get(taskId).count,
    batches: db.prepare("SELECT COUNT(*) AS count FROM scheduler_batches WHERE run_id = ?").get(runId).count
  };
}

test("flag omission still dispatches the approved Claude model and effort as strict CLI argv", () => {
  const fixture = approvedFixture();
  try {
    forcePhase(fixture.db, fixture.root, fixture.config, fixture.started.run.id, "execute");
    const claimed = claimSchedule(fixture.db, fixture.root, fixture.started.run.id, fixture.config, {
      owner: "approved-route-host",
      controllerFencingToken: fixture.started.controller.fencingToken
    });
    assert.equal(claimed.batch.length, 1);
    const descriptor = claimed.batch[0].spawn;
    assert.deepEqual(descriptor.args.slice(0, 4), ["--model", fixture.model, "--effort", fixture.requestedEffort]);
    assert.equal(descriptor.model, fixture.model);
    assert.equal(descriptor.requested_effort, fixture.requestedEffort);
    assert.equal(descriptor.effective_effort, fixture.requestedEffort);
    assert.equal(descriptor.effort_exact_required, true);
    assert.equal(descriptor.effort_launch_ready, true);
  } finally {
    fixture.db.close();
  }
});

test("approved model/effort drift is blocked before preclaim state changes", () => {
  const fixture = approvedFixture();
  try {
    const taskId = fixture.materialized.taskIds[0];
    forcePhase(fixture.db, fixture.root, fixture.config, fixture.started.run.id, "execute");
    fixture.db.prepare("UPDATE tasks SET selected_model = ?, requested_effort = ?, effective_effort = ?, reasoning_effort = ? WHERE id = ?")
      .run("drifted-model", "medium", "medium", "medium", taskId);
    const before = stateCounts(fixture.db, fixture.started.run.id, taskId);
    assert.throws(
      () => claimSchedule(fixture.db, fixture.root, fixture.started.run.id, fixture.config, {
        owner: "drift-check",
        controllerFencingToken: fixture.started.controller.fencingToken
      }),
      (error) => error.code === "PLAN_EXECUTION_SETTINGS_REAPPROVAL"
    );
    assert.deepEqual(stateCounts(fixture.db, fixture.started.run.id, taskId), before);
  } finally {
    fixture.db.close();
  }
});

test("legacy plans without execution settings remain schedulable when the strict flag is omitted", () => {
  const { root, db, config } = makeProject({ config: { delegation: { requireReadyTaskPacket: false } } });
  try {
    const started = startRun(db, root, config, "Legacy scheduler compatibility");
    freezeGoalContract(db, root, started.run.id, {
      objective: "Legacy scheduler compatibility", scope: ["repository"], nonGoals: [], constraints: [],
      successCriteria: ["The legacy task remains schedulable."], complexity: "trivial",
      route: { lifecycleProfile: "fast" }, requirements: [{ id: "REQ-001", title: "legacy", acceptance: ["done"] }]
    });
    forcePhase(db, root, config, started.run.id, "plan");
    addTask(db, started.run.id, simpleTask("legacy-scheduler-task"), config);
    forcePhase(db, root, config, started.run.id, "execute");
    const claimed = claimSchedule(db, root, started.run.id, config, {
      owner: "legacy-host",
      controllerFencingToken: started.controller.fencingToken
    });
    assert.deepEqual(claimed.batch.map((item) => item.taskId), ["legacy-scheduler-task"]);
    assert.equal(claimed.batch[0].spawn.effort_exact_required, false);
  } finally {
    db.close();
  }
});

test("plan critic remains outside approved execution model/effort enforcement", () => {
  const fixture = approvedFixture();
  try {
    // 계획 검토 역할에는 실행 설정 승인 항목이 없어도 된다.
    addTask(fixture.db, fixture.started.run.id, simpleTask("plan-critic-outside-execution", "plan-critic"), fixture.config);
    forcePhase(fixture.db, fixture.root, fixture.config, fixture.started.run.id, "plan");
    const claimed = claimSchedule(fixture.db, fixture.root, fixture.started.run.id, fixture.config, {
      owner: "critic-host",
      controllerFencingToken: fixture.started.controller.fencingToken
    });
    assert.deepEqual(claimed.batch.map((item) => item.taskId), ["plan-critic-outside-execution"]);
    assert.equal(claimed.batch[0].spawn.effort_exact_required, false);
  } finally {
    fixture.db.close();
  }
});

test("unit fixture ACK followed by transient retry preserves the approved model and effort", () => {
  const fixture = approvedFixture();
  try {
    const runId = fixture.started.run.id;
    const taskId = fixture.materialized.taskIds[0];
    forcePhase(fixture.db, fixture.root, fixture.config, runId, "execute");
    const first = claimSchedule(fixture.db, fixture.root, runId, fixture.config, {
      owner: "retry-host",
      controllerFencingToken: fixture.started.controller.fencingToken
    });
    const item = first.batch.find((candidate) => candidate.taskId === taskId);
    // unit fixture receipt는 native 실행 증거가 아니다.
    acknowledgeScheduleSpawn(fixture.db, runId, first.batchId, [taskId], "retry-host", fixture.config,
      spawnReceipts(first.batch, [taskId], "unit-fixture-receipt"));
    const retried = handleChildTerminal(fixture.db, fixture.root, runId, first.batchId, taskId, {
      code: "timeout",
      message: "unit fixture transient provider timeout"
    }, fixture.config);
    assert.equal(retried.action, "requeued");
    const afterRetry = fixture.db.prepare(`SELECT status, selected_model, requested_effort, effective_effort,
      reasoning_effort, escalation_level, transient_retry_count FROM tasks WHERE id = ?`).get(taskId);
    assert.equal(afterRetry.status, "pending");
    assert.equal(afterRetry.selected_model, fixture.model);
    assert.equal(afterRetry.requested_effort, fixture.requestedEffort);
    assert.equal(afterRetry.effective_effort, fixture.requestedEffort);
    assert.equal(afterRetry.reasoning_effort, fixture.requestedEffort);
    assert.equal(afterRetry.escalation_level, 0);
    assert.equal(afterRetry.transient_retry_count, 1);
    const second = claimSchedule(fixture.db, fixture.root, runId, fixture.config, {
      owner: "retry-host-2",
      controllerFencingToken: fixture.started.controller.fencingToken
    });
    const secondItem = second.batch.find((candidate) => candidate.taskId === taskId);
    assert.equal(secondItem.spawn.model, fixture.model);
    assert.equal(secondItem.spawn.requested_effort, fixture.requestedEffort);
    assert.equal(secondItem.spawn.effective_effort, fixture.requestedEffort);
    assert.equal(secondItem.spawn.effort_launch_ready, true);
    assert.equal(item.spawn.model, secondItem.spawn.model);
  } finally {
    fixture.db.close();
  }
});

test("malformed execution binding fails closed before claiming a task", () => {
  const fixture = approvedFixture();
  try {
    const runId = fixture.started.run.id;
    const taskId = fixture.materialized.taskIds[0];
    const planRow = fixture.db.prepare("SELECT id, content_ref FROM artifacts WHERE run_id = ? AND kind = 'plan' AND status = 'verified' ORDER BY updated_at DESC LIMIT 1").get(runId);
    const plan = JSON.parse(readObject(fixture.db, fixture.root, planRow.content_ref));
    plan.executionSettings.entries[0].taskId = "not-a-plan-task";
    const malformedRef = storeObject(fixture.db, fixture.root, "artifact:plan", JSON.stringify(plan));
    fixture.db.prepare("UPDATE artifacts SET content_ref = ? WHERE id = ?").run(malformedRef, planRow.id);
    forcePhase(fixture.db, fixture.root, fixture.config, runId, "execute");
    const before = stateCounts(fixture.db, runId, taskId);
    assert.throws(
      () => claimSchedule(fixture.db, fixture.root, runId, fixture.config, {
        owner: "malformed-binding",
        controllerFencingToken: fixture.started.controller.fencingToken
      }),
      (error) => error.code === "PLAN_EXECUTION_SETTINGS_REAPPROVAL"
    );
    assert.deepEqual(stateCounts(fixture.db, runId, taskId), before);
  } finally {
    fixture.db.close();
  }
});
