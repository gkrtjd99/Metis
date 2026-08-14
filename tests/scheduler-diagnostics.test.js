import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/cli.js";
import { nextControllerAction } from "../src/core/controller.js";
import { openDatabase } from "../src/core/db.js";
import {
  abortScheduleBatch,
  acknowledgeScheduleSpawn,
  claimSchedule,
  heartbeatScheduleBatch,
  proposeSchedule,
  refreshScheduleBatch,
  SCHEDULER_PREPARATION_CONCURRENCY
} from "../src/core/scheduler.js";
import { budgetStatus } from "../src/core/budget.js";
import { takeoverController } from "../src/core/ownership.js";
import { taskPacketStatus } from "../src/core/task-packets.js";
import { addTask, claimTask } from "../src/core/tasks.js";
import { forcePhase, jsonIo, makeProject, spawnReceipts, startTestRun } from "./helpers.js";

function addRunnableTask(db, run, config, id, wave = 1, options = {}) {
  return addTask(db, run.id, {
    id,
    title: id,
    goal: `Complete ${id}`,
    role: "worker",
    taskKind: "implementation",
    runPhase: "execute",
    wave,
    readOnly: options.readOnly ?? true,
    scope: [id],
    targetPaths: options.targetPaths ?? [],
    requirementIds: ["REQ-001"],
    acceptanceCriteria: ["The task is complete."],
    requiredEvidence: [],
    expectedOutputs: ["structured-result"],
    verificationModes: ["test"],
    dependsOn: []
  }, config);
}

test("batch preparation reports one serialized lane while preserving four- or eight-item host fanout", () => {
  assert.equal(SCHEDULER_PREPARATION_CONCURRENCY, 1);
  for (const maxConcurrent of [4, 8]) {
    const { root, db, config } = makeProject({
      config: {
        orchestration: { maxConcurrent },
        delegation: { requireReadyTaskPacket: false }
      }
    });
    try {
      const { run, controller } = startTestRun(db, root, config, `Bounded preparation ${maxConcurrent}`);
      forcePhase(db, root, config, run.id, "plan");
      for (let index = 0; index < maxConcurrent; index += 1) addRunnableTask(db, run, config, `prep-${maxConcurrent}-${index}`);
      forcePhase(db, root, config, run.id, "execute");

      const claimOptions = {
        owner: "preparation-test",
        controllerFencingToken: controller.fencingToken
      };
      const claimed = claimSchedule(db, root, run.id, config, claimOptions);
      assert.equal(claimed.batch.length, maxConcurrent);
      assert.equal(claimed.preparationConcurrency, 1);
      assert.deepEqual(claimed.preparation, { mode: "serialized", concurrency: 1, bounded: true });
      assert.equal(claimed.hostFanoutConcurrency, maxConcurrent);
      assert.equal(new Set(claimed.batch.map((item) => item.spawn.idempotency_key)).size, maxConcurrent);
      assert.ok(claimed.batch.every((item) => item.spawn.batch_id === claimed.batchId));
      const receipts = spawnReceipts(claimed.batch, null, "preparation-test");
      const ack = acknowledgeScheduleSpawn(db, run.id, claimed.batchId, null, "preparation-test", config, receipts);
      assert.equal(ack.acknowledgedTaskIds.length, maxConcurrent);
      assert.deepEqual(acknowledgeScheduleSpawn(db, run.id, claimed.batchId, null, "preparation-test", config, receipts).acknowledgedTaskIds, []);
    } finally {
      db.close();
    }
  }
});

test("aborting a partially accepted mutable batch accounts for accepted and rejected work and removes worktrees", () => {
  const { root, db, config } = makeProject({
    config: {
      orchestration: { maxConcurrent: 4 },
      delegation: { requireReadyTaskPacket: false }
    }
  });
  try {
    const { run, controller } = startTestRun(db, root, config, "Accepted and rejected preparation");
    forcePhase(db, root, config, run.id, "plan");
    for (let index = 0; index < 4; index += 1) {
      addRunnableTask(db, run, config, `rollback-${index}`, 1, {
        readOnly: false,
        targetPaths: [`src/rollback-${index}.js`]
      });
    }
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, {
      owner: "rollback-test",
      controllerFencingToken: controller.fencingToken
    });
    const acceptedTaskIds = claimed.batch.slice(0, 2).map((item) => item.taskId);
    acknowledgeScheduleSpawn(db, run.id, claimed.batchId, acceptedTaskIds, "rollback-test", config, spawnReceipts(claimed.batch, acceptedTaskIds, "rollback-test"));

    const aborted = abortScheduleBatch(db, root, run.id, claimed.batchId, "host rejected remaining descriptors");
    assert.deepEqual(aborted.acceptedTaskIds, acceptedTaskIds);
    assert.deepEqual(aborted.rejectedTaskIds, claimed.batch.slice(2).map((item) => item.taskId));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'pending'").get(run.id).count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'running'").get(run.id).count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM worktrees WHERE run_id = ? AND status = 'active'").get(run.id).count, 2);
    assert.deepEqual(abortScheduleBatch(db, root, run.id, claimed.batchId, "idempotent abort").acceptedTaskIds, acceptedTaskIds);
  } finally {
    db.close();
  }
});

test("proposal diagnostics explain deterministic four- and eight-slot selection", () => {
  for (const maxConcurrent of [4, 8]) {
    const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent } } });
    try {
      const { run, controller } = startTestRun(db, root, config, `Diagnostics ${maxConcurrent}`);
      forcePhase(db, root, config, run.id, "plan");
      for (let index = 0; index < 8; index += 1) addRunnableTask(db, run, config, `same-wave-${index}`);
      forcePhase(db, root, config, run.id, "execute");

      const proposal = proposeSchedule(db, root, run.id, config);
      assert.deepEqual(proposal.diagnostics, {
        runnable: 8,
        subjectReady: 8,
        earliestWave: 8,
        packetReady: 8,
        afterConflicts: 8,
        selected: maxConcurrent,
        freeSlots: maxConcurrent,
        requestedLimit: maxConcurrent
      });

      const claimed = claimSchedule(db, root, run.id, config, {
        owner: "diagnostics",
        controllerFencingToken: controller.fencingToken
      });
      assert.equal(claimed.batch.length, maxConcurrent);
      assert.equal(new Set(claimed.batch.map((item) => item.spawn.task_name)).size, maxConcurrent);
      const batch = db.prepare("SELECT id FROM scheduler_batches WHERE run_id = ?").get(run.id);
      const batchItems = JSON.parse(db.prepare("SELECT batch_json FROM scheduler_batches WHERE id = ?").get(batch.id).batch_json);
      const receipts = spawnReceipts(batchItems, null, "diagnostics");
      const firstAck = acknowledgeScheduleSpawn(db, run.id, batch.id, null, "diagnostics", config, receipts);
      const secondAck = acknowledgeScheduleSpawn(db, run.id, batch.id, null, "diagnostics", config, receipts);
      assert.equal(firstAck.acknowledgedTaskIds.length, maxConcurrent);
      assert.equal(secondAck.acknowledgedTaskIds.length, 0);
    } finally {
      db.close();
    }
  }
});

test("strict wave diagnostics expose an earlier running wave without dispatching later work", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 4 } } });
  try {
    const { run } = startTestRun(db, root, config, "Strict wave diagnostics");
    forcePhase(db, root, config, run.id, "plan");
    addRunnableTask(db, run, config, "wave-one-running", 1);
    addRunnableTask(db, run, config, "wave-two-ready", 2);
    forcePhase(db, root, config, run.id, "execute");
    claimTask(db, run.id, "wave-one-running", "diagnostics", config);

    const proposal = proposeSchedule(db, root, run.id, config);
    assert.equal(proposal.wave, 1);
    assert.equal(proposal.diagnostics.runnable, 1);
    assert.equal(proposal.diagnostics.earliestWave, 0);
    assert.equal(proposal.diagnostics.selected, 0);
    assert.deepEqual(proposal.batch, []);
  } finally {
    db.close();
  }
});

test("claimed batches remain visible and recoverable without becoming spawned", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 4 } } });
  try {
    const { run, controller } = startTestRun(db, root, config, "Claimed batch recovery");
    forcePhase(db, root, config, run.id, "plan");
    addRunnableTask(db, run, config, "claimed-task");
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, {
      owner: "diagnostics",
      controllerFencingToken: controller.fencingToken
    });
    db.prepare("UPDATE scheduler_batches SET status = 'claimed' WHERE id = ?").run(claimed.batchId);

    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(action.type, "WAIT_FOR_AGENTS");
    assert.equal(action.schedulerBatches.length, 1);
    assert.deepEqual({
      id: action.schedulerBatches[0].id,
      status: action.schedulerBatches[0].status,
      spawnedTaskIds: action.schedulerBatches[0].spawnedTaskIds,
      stalePreparation: action.schedulerBatches[0].stalePreparation
    }, { id: claimed.batchId, status: "claimed", spawnedTaskIds: [], stalePreparation: false });
    assert.ok(action.schedulerBatches[0].preparationAgeSeconds >= 0);
    assert.equal(typeof action.schedulerBatches[0].observedUpdatedAt, "string");
    assert.equal(action.schedulerBatches[0].controllerFencingToken, controller.fencingToken);
    assert.match(action.instruction, /must not be spawned or acknowledged until preparation completes/u);

    const beforeHeartbeat = db.prepare("SELECT updated_at FROM scheduler_batches WHERE id = ?").get(claimed.batchId).updated_at;
    const heartbeat = heartbeatScheduleBatch(db, run.id, claimed.batchId, config);
    assert.equal(heartbeat.status, "claimed");
    assert.equal(heartbeat.preparationPending, true);
    assert.equal(heartbeat.heartbeats.length, 0);
    const afterHeartbeat = db.prepare("SELECT updated_at FROM scheduler_batches WHERE id = ?").get(claimed.batchId).updated_at;
    assert.ok(Date.parse(afterHeartbeat) >= Date.parse(beforeHeartbeat));
    assert.equal(db.prepare("SELECT status FROM scheduler_batches WHERE id = ?").get(claimed.batchId).status, "claimed");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_spawn_acks WHERE batch_id = ?").get(claimed.batchId).count, 0);
  } finally {
    db.close();
  }
});

test("takeover diagnostics preserve the scheduler batch controller fence", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 1 } } });
  try {
    const { run, controller } = startTestRun(db, root, config, "Takeover diagnostics fencing");
    forcePhase(db, root, config, run.id, "plan");
    addRunnableTask(db, run, config, "takeover-diagnostics-task");
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, {
      owner: "original-controller",
      controllerFencingToken: controller.fencingToken
    });
    const replacement = takeoverController(db, run.id, {
      force: true,
      owner: "replacement-controller",
      sessionId: "replacement-session"
    });
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    const batch = action.schedulerBatches.find((item) => item.id === claimed.batchId);
    assert.equal(batch.controllerFencingToken, controller.fencingToken);
    assert.notEqual(batch.controllerFencingToken, replacement.fencingToken);
  } finally {
    db.close();
  }
});

test("takeover stale preparation recovery uses the replacement fence and remains CLI-compatible", async () => {
  const { root, db, config } = makeProject({
    config: { orchestration: { maxConcurrent: 1 }, delegation: { requireReadyTaskPacket: false } }
  });
  const { run, controller } = startTestRun(db, root, config, "Takeover stale preparation recovery");
  forcePhase(db, root, config, run.id, "plan");
  addRunnableTask(db, run, config, "takeover-stale-preparation");
  forcePhase(db, root, config, run.id, "execute");
  const claimed = claimSchedule(db, root, run.id, config, {
    owner: "original-controller",
    controllerFencingToken: controller.fencingToken
  });
  db.prepare("UPDATE scheduler_batches SET status = ?, updated_at = ? WHERE id = ?")
    .run("claimed", "2000-01-01T00:00:00.000Z", claimed.batchId);
  const replacement = takeoverController(db, run.id, {
    force: true,
    owner: "replacement-controller",
    sessionId: "replacement-session"
  });
  const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
  const batch = action.schedulerBatches.find((item) => item.id === claimed.batchId);
  assert.equal(batch.stalePreparation, true);
  assert.equal(batch.controllerFencingToken, controller.fencingToken);
  const recovery = action.recoveryCommands.find((command) => command.includes(claimed.batchId));
  assert.ok(recovery);
  assert.match(recovery, new RegExp(`--expected-status ${batch.status}`, "u"));
  assert.match(recovery, new RegExp(`--expected-updated-at ${batch.observedUpdatedAt}`, "u"));
  assert.match(recovery, new RegExp(`--expected-controller-fence ${replacement.fencingToken}`, "u"));
  assert.doesNotMatch(recovery, new RegExp(`--expected-controller-fence ${controller.fencingToken}(?:\\s|$)`, "u"));
  db.close();

  const io = jsonIo();
  const code = await main([
    "schedule", "abort", claimed.batchId, "stale batch preparation",
    "--root", root,
    "--expected-status", batch.status,
    "--expected-updated-at", batch.observedUpdatedAt,
    "--expected-controller-fence", String(replacement.fencingToken),
    "--controller-session", replacement.sessionId,
    "--controller-owner", replacement.owner,
    "--controller-token", replacement.token,
    "--controller-fence", String(replacement.fencingToken)
  ], io);
  assert.equal(code, 0, io.stderrText);
  const reopened = openDatabase(root);
  try {
    assert.equal(reopened.prepare("SELECT status FROM scheduler_batches WHERE id = ?").get(claimed.batchId).status, "aborted");
    assert.equal(reopened.prepare("SELECT status FROM tasks WHERE id = ?").get("takeover-stale-preparation").status, "pending");
  } finally {
    reopened.close();
  }
});

test("parent-scoped diagnostics use one scoped subject and global-wave funnel without compiling later packets", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 4 } } });
  try {
    const { run } = startTestRun(db, root, config, "Scoped scheduler diagnostics");
    forcePhase(db, root, config, run.id, "plan");
    for (const id of ["coordinator-a", "coordinator-b"]) {
      addTask(db, run.id, {
        id, title: id, goal: id, role: "coordinator", runPhase: "execute", wave: 1,
        readOnly: true, scope: [id], targetPaths: [], requirementIds: ["REQ-001"],
        acceptanceCriteria: ["Coordinate children."], requiredEvidence: [], expectedOutputs: ["result"], dependsOn: []
      }, config);
    }
    for (const [id, wave, parentTaskId] of [
      ["a-wave-one", 1, "coordinator-a"],
      ["a-wave-two", 2, "coordinator-a"],
      ["b-wave-one", 1, "coordinator-b"]
    ]) {
      addTask(db, run.id, {
        id, title: id, goal: id, role: "worker", runPhase: "execute", wave, parentTaskId,
        readOnly: true, scope: [id], targetPaths: [], requirementIds: ["REQ-001"],
        acceptanceCriteria: ["The task is complete."], requiredEvidence: [], expectedOutputs: ["structured-result"], dependsOn: []
      }, config);
    }
    forcePhase(db, root, config, run.id, "execute");
    claimTask(db, run.id, "coordinator-a", "coordinator-a", config);
    claimTask(db, run.id, "coordinator-b", "coordinator-b", config);
    db.prepare("DELETE FROM task_packets WHERE task_id IN ('a-wave-one','a-wave-two','b-wave-one')").run();

    const proposal = proposeSchedule(db, root, run.id, config, { parentTaskId: "coordinator-a" });
    assert.deepEqual(proposal.batch.map((item) => item.taskId), ["a-wave-one"]);
    assert.deepEqual(proposal.diagnostics, {
      runnable: 2,
      subjectReady: 2,
      earliestWave: 1,
      packetReady: 1,
      afterConflicts: 2,
      selected: 1,
      freeSlots: 2,
      requestedLimit: 4
    });
    assert.equal(taskPacketStatus(db, "a-wave-one", config).current, true);
    assert.equal(taskPacketStatus(db, "a-wave-two", config).current, false);
    assert.equal(taskPacketStatus(db, "b-wave-one", config).current, false);
  } finally {
    db.close();
  }
});

test("the earliest-wave barrier is phase-global across parent scopes", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 4 }, delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run, controller } = startTestRun(db, root, config, "Global parent wave barrier");
    forcePhase(db, root, config, run.id, "plan");
    for (const id of ["coordinator-a", "coordinator-b"]) {
      addTask(db, run.id, {
        id, title: id, goal: id, role: "coordinator", runPhase: "execute", wave: 1,
        readOnly: true, scope: [id], targetPaths: [], requirementIds: ["REQ-001"],
        acceptanceCriteria: ["Coordinate children."], requiredEvidence: [], expectedOutputs: ["result"], dependsOn: []
      }, config);
    }
    addTask(db, run.id, {
      id: "open-wave-one", title: "open-wave-one", goal: "open-wave-one", role: "worker", runPhase: "execute", wave: 1,
      parentTaskId: "coordinator-a", readOnly: true, scope: ["one"], targetPaths: [], requirementIds: ["REQ-001"],
      acceptanceCriteria: ["done"], requiredEvidence: [], expectedOutputs: ["result"], dependsOn: []
    }, config);
    addTask(db, run.id, {
      id: "later-wave-two", title: "later-wave-two", goal: "later-wave-two", role: "worker", runPhase: "execute", wave: 2,
      parentTaskId: "coordinator-b", readOnly: true, scope: ["two"], targetPaths: [], requirementIds: ["REQ-001"],
      acceptanceCriteria: ["done"], requiredEvidence: [], expectedOutputs: ["result"], dependsOn: []
    }, config);
    forcePhase(db, root, config, run.id, "execute");
    claimTask(db, run.id, "coordinator-a", "a", config);
    claimTask(db, run.id, "coordinator-b", "b", config);

    const blocked = claimSchedule(db, root, run.id, config, {
      owner: "b", parentTaskId: "coordinator-b", controllerFencingToken: controller.fencingToken
    });
    assert.equal(blocked.wave, 1);
    assert.deepEqual(blocked.batch, []);
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'later-wave-two'").get().status, "pending");
  } finally {
    db.close();
  }
});

test("running coordinator ancestry does not block its own later child wave", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 4 }, delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run } = startTestRun(db, root, config, "Coordinator ancestry wave progression");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "root-coordinator", title: "root-coordinator", goal: "root-coordinator", role: "coordinator", runPhase: "execute", wave: 1,
      readOnly: true, scope: ["root"], targetPaths: [], requirementIds: ["REQ-001"],
      acceptanceCriteria: ["Coordinate nested work."], requiredEvidence: [], expectedOutputs: ["result"], dependsOn: []
    }, config);
    addTask(db, run.id, {
      id: "nested-coordinator", title: "nested-coordinator", goal: "nested-coordinator", role: "coordinator", runPhase: "execute", wave: 1,
      parentTaskId: "root-coordinator", readOnly: true, scope: ["nested"], targetPaths: [], requirementIds: ["REQ-001"],
      acceptanceCriteria: ["Coordinate leaf work."], requiredEvidence: [], expectedOutputs: ["result"], dependsOn: []
    }, config);
    addTask(db, run.id, {
      id: "nested-wave-two", title: "nested-wave-two", goal: "nested-wave-two", role: "worker", runPhase: "execute", wave: 2,
      parentTaskId: "nested-coordinator", readOnly: true, scope: ["leaf"], targetPaths: [], requirementIds: ["REQ-001"],
      acceptanceCriteria: ["Complete the nested leaf."], requiredEvidence: [], expectedOutputs: ["result"], dependsOn: []
    }, config);
    forcePhase(db, root, config, run.id, "execute");
    claimTask(db, run.id, "root-coordinator", "root", config);
    claimTask(db, run.id, "nested-coordinator", "nested", config);

    const proposal = proposeSchedule(db, root, run.id, config, { parentTaskId: "nested-coordinator" });
    assert.equal(proposal.wave, 2);
    assert.deepEqual(proposal.batch.map((item) => item.taskId), ["nested-wave-two"]);
  } finally {
    db.close();
  }
});

test("research reservations are selected at claim and confirmed or released by ACK and abort", () => {
  const { root, db, config } = makeProject({
    config: {
      budgets: { run: { agentSpawns: 10, researchCalls: 2 } },
      delegation: { requireReadyTaskPacket: false }
    }
  });
  try {
    const { run, controller } = startTestRun(db, root, config, "Research reservation lifecycle");
    forcePhase(db, root, config, run.id, "research");
    for (const id of ["research-a", "research-b"]) {
      addTask(db, run.id, {
        id, title: id, goal: id, role: "researcher", runPhase: "research", wave: 1,
        readOnly: true, scope: [id], targetPaths: [], requirementIds: ["REQ-001"],
        acceptanceCriteria: ["Return bounded research."], requiredEvidence: [], expectedOutputs: ["result"], dependsOn: []
      }, config);
    }
    const claimed = claimSchedule(db, root, run.id, config, { owner: "main", controllerFencingToken: controller.fencingToken });
    assert.equal(claimed.batch.length, 2);
    assert.deepEqual(budgetStatus(db, run.id).reservations, { agentSpawns: 2, researchCalls: 2 });

    acknowledgeScheduleSpawn(db, run.id, claimed.batchId, [claimed.batch[0].taskId], "main", config, spawnReceipts(claimed.batch, [claimed.batch[0].taskId], "main"));
    assert.equal(budgetStatus(db, run.id).usage.researchCalls, 1);
    assert.deepEqual(budgetStatus(db, run.id).reservations, { agentSpawns: 1, researchCalls: 1 });

    abortScheduleBatch(db, root, run.id, claimed.batchId, "host rejected remaining research spawn");
    assert.equal(budgetStatus(db, run.id).usage.researchCalls, 1);
    assert.deepEqual(budgetStatus(db, run.id).reservations, { agentSpawns: 0, researchCalls: 0 });
  } finally {
    db.close();
  }
});

test("research claim never over-reserves the remaining research-call budget", () => {
  const { root, db, config } = makeProject({
    config: {
      budgets: { run: { agentSpawns: 10, researchCalls: 1 } },
      delegation: { requireReadyTaskPacket: false }
    }
  });
  try {
    const { run, controller } = startTestRun(db, root, config, "Bounded research reservation");
    forcePhase(db, root, config, run.id, "research");
    for (const id of ["bounded-research-a", "bounded-research-b"]) {
      addTask(db, run.id, {
        id, title: id, goal: id, role: "researcher", runPhase: "research", wave: 1,
        readOnly: true, scope: [id], targetPaths: [], requirementIds: ["REQ-001"],
        acceptanceCriteria: ["Return bounded research."], requiredEvidence: [], expectedOutputs: ["result"], dependsOn: []
      }, config);
    }
    const claimed = claimSchedule(db, root, run.id, config, { owner: "main", controllerFencingToken: controller.fencingToken });
    assert.equal(claimed.batch.length, 1);
    assert.equal(claimed.deferred.length, 1);
    assert.equal(claimed.deferred[0].reason, "research call budget exhausted");
    assert.deepEqual(budgetStatus(db, run.id).reservations, { agentSpawns: 1, researchCalls: 1 });
    const acknowledged = acknowledgeScheduleSpawn(db, run.id, claimed.batchId, null, "main", config, spawnReceipts(claimed.batch, null, "main"));
    assert.equal(acknowledged.acknowledgedTaskIds.length, 1);
    assert.equal(budgetStatus(db, run.id).usage.researchCalls, 1);
    assert.deepEqual(budgetStatus(db, run.id).reservations, { agentSpawns: 0, researchCalls: 0 });
  } finally {
    db.close();
  }
});

test("partial abort releases only unspawned reservations and preserves spawned heartbeats", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 2 }, delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run, controller } = startTestRun(db, root, config, "Partial batch abort");
    forcePhase(db, root, config, run.id, "plan");
    addRunnableTask(db, run, config, "partial-a");
    addRunnableTask(db, run, config, "partial-b");
    forcePhase(db, root, config, run.id, "execute");
    const first = claimSchedule(db, root, run.id, config, { owner: "main", controllerFencingToken: controller.fencingToken });
    const spawnedTaskId = first.batch[0].taskId;
    const unspawnedTaskId = first.batch[1].taskId;
    acknowledgeScheduleSpawn(db, run.id, first.batchId, [spawnedTaskId], "main", config, spawnReceipts(first.batch, [spawnedTaskId], "main"));
    abortScheduleBatch(db, root, run.id, first.batchId, "partial host rejection");
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = ?").get(spawnedTaskId).status, "running");
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = ?").get(unspawnedTaskId).status, "pending");
    assert.deepEqual(budgetStatus(db, run.id).reservations, { agentSpawns: 0, researchCalls: 0 });

    const second = claimSchedule(db, root, run.id, config, { owner: "main", controllerFencingToken: controller.fencingToken });
    acknowledgeScheduleSpawn(db, run.id, second.batchId, null, "main", config, spawnReceipts(second.batch, null, "main"));
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(action.type, "WAIT_FOR_AGENTS");
    assert.deepEqual(new Set(action.schedulerBatchIds), new Set([first.batchId, second.batchId]));
    assert.ok(action.heartbeatCommands.some((command) => command.includes(first.batchId)));
    assert.equal(heartbeatScheduleBatch(db, run.id, first.batchId, config).heartbeats.length, 1);
  } finally {
    db.close();
  }
});

test("stale claimed batches expose age-based abort recovery and release reservations", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 1 }, delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run, controller } = startTestRun(db, root, config, "Claimed preparation crash");
    forcePhase(db, root, config, run.id, "plan");
    addRunnableTask(db, run, config, "crashed-claim");
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, { owner: "main", controllerFencingToken: controller.fencingToken });
    db.prepare("UPDATE scheduler_batches SET status = 'claimed', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(claimed.batchId);
    assert.equal(budgetStatus(db, run.id).reservations.agentSpawns, 1);

    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    const batch = action.schedulerBatches.find((item) => item.id === claimed.batchId);
    assert.equal(batch.stalePreparation, true);
    assert.ok(batch.preparationAgeSeconds > 0);
    assert.ok(!action.heartbeatCommands.some((command) => command.includes(claimed.batchId)));
    const recovery = action.recoveryCommands.find((command) => command.includes(claimed.batchId));
    assert.match(recovery, /--expected-status claimed/u);
    assert.match(recovery, new RegExp(`--expected-updated-at ${batch.observedUpdatedAt}`, "u"));
    assert.match(recovery, new RegExp(`--expected-controller-fence ${batch.controllerFencingToken}`, "u"));

    abortScheduleBatch(db, root, run.id, claimed.batchId, "simulated preparation crash", {
      expectedStatus: batch.status,
      expectedUpdatedAt: batch.observedUpdatedAt,
      expectedControllerFencingToken: batch.controllerFencingToken
    });
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'crashed-claim'").get().status, "pending");
    assert.equal(budgetStatus(db, run.id).reservations.agentSpawns, 0);
  } finally {
    db.close();
  }
});

test("preparation staleness never fires before the task lease even when heartbeat cadence is longer", () => {
  const { root, db, config } = makeProject({
    config: {
      orchestration: { maxConcurrent: 1, leaseMinutes: 1, leaseHeartbeatSeconds: 300 },
      delegation: { requireReadyTaskPacket: false }
    }
  });
  try {
    const { run, controller } = startTestRun(db, root, config, "Preparation lease threshold");
    forcePhase(db, root, config, run.id, "plan");
    addRunnableTask(db, run, config, "lease-threshold-task");
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, { owner: "main", controllerFencingToken: controller.fencingToken });
    const oldEnoughForHeartbeatCadence = new Date(Date.now() - 120_000).toISOString();
    db.prepare("UPDATE scheduler_batches SET status = 'claimed', updated_at = ? WHERE id = ?")
      .run(oldEnoughForHeartbeatCadence, claimed.batchId);

    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    const batch = action.schedulerBatches.find((item) => item.id === claimed.batchId);
    assert.equal(batch.staleAfterSeconds, 600);
    assert.equal(batch.stalePreparation, false);
  } finally {
    db.close();
  }
});

test("stale prepared batches with no spawned tasks expose fenced abort recovery and release reservations", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 1 }, delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run, controller } = startTestRun(db, root, config, "Prepared zero-spawn recovery");
    forcePhase(db, root, config, run.id, "plan");
    addRunnableTask(db, run, config, "prepared-without-spawn");
    forcePhase(db, root, config, run.id, "execute");
    const prepared = claimSchedule(db, root, run.id, config, { owner: "main", controllerFencingToken: controller.fencingToken });
    db.prepare("UPDATE scheduler_batches SET status = 'prepared', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(prepared.batchId);

    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    const batch = action.schedulerBatches.find((item) => item.id === prepared.batchId);
    assert.equal(batch.status, "prepared");
    assert.deepEqual(batch.spawnedTaskIds, []);
    assert.equal(batch.stalePreparation, true);
    assert.ok(!action.heartbeatCommands.some((command) => command.includes(prepared.batchId)));
    const recovery = action.recoveryCommands.find((command) => command.includes(prepared.batchId));
    assert.match(recovery, /--expected-status prepared/u);
    assert.match(recovery, new RegExp(`--expected-updated-at ${batch.observedUpdatedAt}`, "u"));
    assert.match(recovery, new RegExp(`--expected-controller-fence ${batch.controllerFencingToken}`, "u"));

    abortScheduleBatch(db, root, run.id, prepared.batchId, "simulated zero-spawn preparation crash", {
      expectedStatus: batch.status,
      expectedUpdatedAt: batch.observedUpdatedAt,
      expectedControllerFencingToken: batch.controllerFencingToken
    });
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'prepared-without-spawn'").get().status, "pending");
    assert.equal(budgetStatus(db, run.id).reservations.agentSpawns, 0);
  } finally {
    db.close();
  }
});

test("CLI executes a controller-issued fenced stale abort observation", async () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 1 }, delegation: { requireReadyTaskPacket: false } } });
  const { run, controller } = startTestRun(db, root, config, "CLI fenced stale abort");
  forcePhase(db, root, config, run.id, "plan");
  addRunnableTask(db, run, config, "cli-stale-claim");
  forcePhase(db, root, config, run.id, "execute");
  const claimed = claimSchedule(db, root, run.id, config, { owner: "main", controllerFencingToken: controller.fencingToken });
  db.prepare("UPDATE scheduler_batches SET status = 'claimed', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(claimed.batchId);
  const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
  const batch = action.schedulerBatches.find((item) => item.id === claimed.batchId);
  db.close();

  const io = jsonIo();
  const code = await main([
    "schedule", "abort", claimed.batchId, "stale batch preparation",
    "--root", root,
    "--expected-status", batch.status,
    "--expected-updated-at", batch.observedUpdatedAt,
    "--expected-controller-fence", String(batch.controllerFencingToken),
    "--controller-session", controller.sessionId,
    "--controller-owner", controller.owner,
    "--controller-token", controller.token,
    "--controller-fence", String(controller.fencingToken)
  ], io);
  assert.equal(code, 0, io.stderrText);
  const reopened = openDatabase(root);
  try {
    assert.equal(reopened.prepare("SELECT status FROM scheduler_batches WHERE id = ?").get(claimed.batchId).status, "aborted");
    assert.equal(reopened.prepare("SELECT status FROM tasks WHERE id = 'cli-stale-claim'").get().status, "pending");
  } finally {
    reopened.close();
  }
});

test("scheduler descriptors expose stable batch-task-attempt idempotency keys", () => {
  const { root, db, config } = makeProject({ config: { delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run, controller } = startTestRun(db, root, config, "Descriptor deduplication");
    forcePhase(db, root, config, run.id, "plan");
    addRunnableTask(db, run, config, "dedupe-task");
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, { owner: "main", controllerFencingToken: controller.fencingToken });
    const descriptor = claimed.batch[0].spawn;
    assert.equal(descriptor.batch_id, claimed.batchId);
    assert.equal(descriptor.attempt_fence, claimed.batch[0].attemptFence);
    assert.equal(descriptor.idempotency_key, `scheduler:${claimed.batchId}:dedupe-task:${claimed.batch[0].attemptFence}`);
    assert.equal(refreshScheduleBatch(db, claimed.batchId).batch[0].spawn.idempotency_key, descriptor.idempotency_key);
  } finally {
    db.close();
  }
});
