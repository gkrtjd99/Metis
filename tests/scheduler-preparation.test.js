import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEDULER_PREPARATION_CONCURRENCY,
  abortScheduleBatch,
  acknowledgeScheduleSpawn,
  claimSchedule,
  handleChildTerminal,
  heartbeatScheduleBatch
} from "../src/core/scheduler.js";
import { nextControllerAction } from "../src/core/controller.js";
import { budgetStatus } from "../src/core/budget.js";
import { openDatabase } from "../src/core/db.js";
import { takeoverController } from "../src/core/ownership.js";
import { addTask, finishTask } from "../src/core/tasks.js";
import { forcePhase, makeProject, spawnReceipts, startTestRun } from "./helpers.js";

function task(id) {
  return {
    id,
    title: id,
    goal: `Complete ${id}`,
    role: "worker",
    taskKind: "implementation",
    runPhase: "execute",
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

test("scheduler preparation is serialized while host fanout stays bounded at four or eight", () => {
  assert.equal(SCHEDULER_PREPARATION_CONCURRENCY, 1);

  for (const maxConcurrent of [4, 8]) {
    const { root, db, config } = makeProject({
      config: {
        orchestration: { maxConcurrent },
        delegation: { requireReadyTaskPacket: false }
      }
    });
    try {
      const { run, controller } = startTestRun(db, root, config, `Scheduler preparation ${maxConcurrent}`);
      forcePhase(db, root, config, run.id, "plan");
      for (let index = 1; index <= 8; index += 1) addTask(db, run.id, task(`prep-${maxConcurrent}-${index}`), config);
      forcePhase(db, root, config, run.id, "execute");

      const claimed = claimSchedule(db, root, run.id, config, {
        owner: `prep-${maxConcurrent}`,
        controllerFencingToken: controller.fencingToken
      });
      assert.equal(claimed.batch.length, maxConcurrent);
      assert.equal(claimed.preparationConcurrency, 1);
      assert.deepEqual(claimed.preparation, { mode: "serialized", concurrency: 1, bounded: true });
      assert.equal(claimed.hostFanoutConcurrency, maxConcurrent);
      assert.equal(new Set(claimed.batch.map((item) => item.spawn.task_name)).size, maxConcurrent);
      assert.equal(new Set(claimed.batch.map((item) => item.spawn.idempotency_key)).size, maxConcurrent);
      assert.ok(claimed.batch.every((item) => item.spawn.batch_id === claimed.batchId));
      assert.ok(claimed.batch.every((item) => item.spawn.terminal_handoff?.task_id === item.taskId));
      assert.ok(claimed.batch.every((item) => item.spawn.terminal_handoff?.lease === item.leaseToken));
      assert.ok(claimed.batch.every((item) => item.workspacePath === root && item.workspaceMode === "shared"));

      const accepted = claimed.batch.slice(0, Math.max(1, Math.floor(maxConcurrent / 2))).map((item) => item.taskId);
      const acknowledged = acknowledgeScheduleSpawn(db, run.id, claimed.batchId, accepted, `prep-${maxConcurrent}`, config, spawnReceipts(claimed.batch, accepted, `prep-${maxConcurrent}`));
      assert.deepEqual(new Set(acknowledged.acknowledgedTaskIds), new Set(accepted));
      assert.equal(acknowledgeScheduleSpawn(db, run.id, claimed.batchId, accepted, `prep-${maxConcurrent}`, config, spawnReceipts(claimed.batch, accepted, `prep-${maxConcurrent}`)).acknowledgedTaskIds.length, 0);

      const aborted = abortScheduleBatch(db, root, run.id, claimed.batchId, "reject unaccepted descriptors");
      assert.deepEqual(new Set(aborted.acceptedTaskIds), new Set(accepted));
      assert.deepEqual(
        new Set(aborted.rejectedTaskIds),
        new Set(claimed.batch.map((item) => item.taskId).filter((taskId) => !accepted.includes(taskId)))
      );
      const acceptedRows = db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'running' AND id IN (${accepted.map(() => "?").join(",")})`)
        .get(run.id, ...accepted);
      assert.equal(acceptedRows.count, accepted.length);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'pending'").get(run.id).count, 8 - maxConcurrent + (maxConcurrent - accepted.length));
      assert.equal(budgetStatus(db, run.id).reservations.agentSpawns, 0);
      assert.equal(budgetStatus(db, run.id).usage.agentSpawns, accepted.length);
    } finally {
      db.close();
    }
  }
});

test("preparation heartbeat stays read-only while another SQLite writer holds a lock", () => {
  const { root, db, config } = makeProject({
    config: { orchestration: { maxConcurrent: 1 }, delegation: { requireReadyTaskPacket: false } }
  });
  const lockedDb = openDatabase(root);
  try {
    const { run, controller } = startTestRun(db, root, config, "Read-only preparation heartbeat");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, task("locked-preparation"), config);
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, {
      owner: "main",
      controllerFencingToken: controller.fencingToken
    });
    db.prepare("UPDATE scheduler_batches SET status = ? WHERE id = ?")
      .run("claimed", claimed.batchId);

    const beforeBatch = db.prepare("SELECT updated_at FROM scheduler_batches WHERE id = ?").get(claimed.batchId);
    const beforeLeases = db.prepare(`
      SELECT l.resource, l.task_id, l.token, l.fencing_token, l.owner, l.expires_at, l.created_at
      FROM leases l JOIN tasks t ON t.id = l.task_id
      WHERE t.run_id = ? ORDER BY l.resource, l.task_id
    `).all(run.id);
    const beforeEvents = db.prepare(`
      SELECT type, severity, payload_json, count, created_at, updated_at
      FROM events WHERE run_id = ? ORDER BY created_at, type
    `).all(run.id);

    lockedDb.exec("BEGIN IMMEDIATE");
    db.exec("PRAGMA busy_timeout = 100");
    const startedAt = Date.now();
    const heartbeat = heartbeatScheduleBatch(db, run.id, claimed.batchId, config, { preparation: true });

    assert.ok(Date.now() - startedAt < 500, "preparation heartbeat should not wait on a SQLite writer");
    assert.equal(heartbeat.status, "claimed");
    assert.equal(heartbeat.preparationPending, true);
    assert.equal(heartbeat.recoveryRequired, true);
    assert.deepEqual(heartbeat.missingReceiptTaskIds, ["locked-preparation"]);
    assert.deepEqual(heartbeat.heartbeats, []);
    assert.deepEqual(
      db.prepare("SELECT updated_at FROM scheduler_batches WHERE id = ?").get(claimed.batchId),
      beforeBatch
    );
    assert.deepEqual(
      db.prepare(`
        SELECT l.resource, l.task_id, l.token, l.fencing_token, l.owner, l.expires_at, l.created_at
        FROM leases l JOIN tasks t ON t.id = l.task_id
        WHERE t.run_id = ? ORDER BY l.resource, l.task_id
      `).all(run.id),
      beforeLeases
    );
    assert.deepEqual(
      db.prepare(`
        SELECT type, severity, payload_json, count, created_at, updated_at
        FROM events WHERE run_id = ? ORDER BY created_at, type
      `).all(run.id),
      beforeEvents
    );
    assert.equal(lockedDb.isTransaction, true);
  } finally {
    try { if (lockedDb.isTransaction) lockedDb.exec("ROLLBACK"); } catch {}
    lockedDb.close();
    db.close();
  }
});

test("preparation heartbeat rejects a controller takeover fence", () => {
  const { root, db, config } = makeProject({ config: { delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run, controller } = startTestRun(db, root, config, "Preparation heartbeat takeover fence");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, task("takeover-preparation"), config);
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, {
      owner: "old-controller",
      controllerFencingToken: controller.fencingToken
    });
    db.prepare("UPDATE scheduler_batches SET status = ? WHERE id = ?")
      .run("claimed", claimed.batchId);
    const replacement = takeoverController(db, run.id, {
      force: true,
      owner: "replacement-controller",
      sessionId: "replacement-session"
    });

    assert.throws(
      () => heartbeatScheduleBatch(db, run.id, claimed.batchId, config, {
        preparation: true,
        controllerFencingToken: controller.fencingToken
      }),
      (error) => error.code === "CONTROLLER_FENCED"
    );
    assert.notEqual(replacement.fencingToken, controller.fencingToken);
  } finally {
    db.close();
  }
});

test("scheduler spawn ACKs require and persist an exact host receipt, then self-finish", () => {
  const { root, db, config } = makeProject({ config: { delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run, controller } = startTestRun(db, root, config, "Receipt-bound scheduler spawn");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, task("receipt-bound"), config);
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, { owner: "main", controllerFencingToken: controller.fencingToken });
    assert.throws(
      () => acknowledgeScheduleSpawn(db, run.id, claimed.batchId, null, "main", config),
      (error) => error.code === "SCHEDULER_RECEIPT_REQUIRED"
    );
    const item = claimed.batch[0];
    assert.throws(
      () => acknowledgeScheduleSpawn(db, run.id, claimed.batchId, null, "main", config, {
        [item.taskId]: { receipt: "child-session", batchId: claimed.batchId, taskId: item.taskId, attemptFence: Number(item.attemptFence) + 1 }
      }),
      (error) => error.code === "SCHEDULER_RECEIPT_FENCE"
    );
    assert.throws(
      () => acknowledgeScheduleSpawn(db, run.id, claimed.batchId, null, "main", config, {
        [item.taskId]: { receipt: "child-session", batchId: "other-batch", taskId: item.taskId, attemptFence: Number(item.attemptFence) }
      }),
      (error) => error.code === "SCHEDULER_RECEIPT_FENCE"
    );
    const receipts = spawnReceipts(claimed.batch, null, "main");
    const acknowledged = acknowledgeScheduleSpawn(db, run.id, claimed.batchId, null, "main", config, receipts);
    assert.equal(acknowledged.receipts[0].host_receipt, receipts[item.taskId].receipt);
    assert.equal(db.prepare("SELECT host_receipt FROM task_spawn_acks WHERE task_id = ? AND attempt_fence = ?").get(item.taskId, item.attemptFence).host_receipt, receipts[item.taskId].receipt);
    const diagnostic = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(diagnostic.schedulerBatches.find((batch) => batch.id === claimed.batchId).spawnReceipts[0].hostReceipt, receipts[item.taskId].receipt);
    const finished = finishTask(db, root, run.id, item.taskId, item.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "The receipt-bound child completed.",
      EvidenceRefs: [],
      Blockers: []
    }, config);
    assert.equal(finished.status, "completed");
  } finally {
    db.close();
  }
});

test("a Luna host transient terminal requeues only the acknowledged attempt immediately", () => {
  const { root, db, config } = makeProject({ config: { delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run } = startTestRun(db, root, config, "Recover a transient child provider failure");
    forcePhase(db, root, config, run.id, "execute");
    addTask(db, run.id, task("transient-child"), config);
    const claimed = claimSchedule(db, root, run.id, config, { owner: "main", limit: 1, controllerFencingToken: run.controller_fencing_token });
    const receipt = spawnReceipts(claimed.batch, null, "luna-host");
    acknowledgeScheduleSpawn(db, run.id, claimed.batchId, null, "main", config, receipt);

    const outcome = handleChildTerminal(db, root, run.id, claimed.batchId, "transient-child", {
      code: "server_overloaded",
      message: "Selected model is at capacity."
    }, config);
    assert.equal(outcome.classification, "transient");
    assert.equal(outcome.action, "requeued");
    assert.equal(outcome.status, "pending");
    assert.equal(db.prepare("SELECT status, failure_class FROM tasks WHERE id = ?").get("transient-child").status, "pending");
    assert.equal(db.prepare("SELECT failure_class, status FROM task_attempts WHERE task_id = ?").get("transient-child").status, "aborted");
    assert.equal(budgetStatus(db, run.id).usage.retries, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND type = 'scheduler.child-terminal'").get(run.id).count, 1);
  } finally { db.close(); }
});

test("permanent/auth child terminal failures fail closed and require a new decision", () => {
  const { root, db, config } = makeProject({ config: { delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run } = startTestRun(db, root, config, "Reject an authenticated child failure");
    forcePhase(db, root, config, run.id, "execute");
    addTask(db, run.id, task("auth-child"), config);
    const claimed = claimSchedule(db, root, run.id, config, { owner: "main", limit: 1, controllerFencingToken: run.controller_fencing_token });
    acknowledgeScheduleSpawn(db, run.id, claimed.batchId, null, "main", config, spawnReceipts(claimed.batch, null, "luna-host"));
    const outcome = handleChildTerminal(db, root, run.id, claimed.batchId, "auth-child", { code: "invalid_api_key" }, config);
    assert.equal(outcome.classification, "permanent");
    assert.equal(outcome.action, "failed-closed");
    assert.equal(outcome.status, "blocked");
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = ?").get("auth-child").status, "blocked");
    assert.equal(db.prepare("SELECT status, failure_class FROM task_attempts WHERE task_id = ?").get("auth-child").status, "failed");
    assert.equal(budgetStatus(db, run.id).usage.retries, 0);
  } finally { db.close(); }
});

test("child terminal failures require a durable spawn receipt", () => {
  const { root, db, config } = makeProject({ config: { delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run } = startTestRun(db, root, config, "Reject an unacknowledged child failure");
    forcePhase(db, root, config, run.id, "execute");
    addTask(db, run.id, task("unacknowledged-child"), config);
    const claimed = claimSchedule(db, root, run.id, config, { owner: "main", limit: 1, controllerFencingToken: run.controller_fencing_token });
    assert.throws(
      () => handleChildTerminal(db, root, run.id, claimed.batchId, "unacknowledged-child", { code: "server_overloaded" }, config),
      (error) => error.code === "SCHEDULER_CHILD_RECEIPT"
    );
  } finally { db.close(); }
});

test("receipt-less prepared batches stop heartbeats and expose bounded recovery", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 1 }, delegation: { requireReadyTaskPacket: false } } });
  try {
    const { run, controller } = startTestRun(db, root, config, "Recover missing spawn receipt");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, task("missing-receipt"), config);
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, { owner: "main", controllerFencingToken: controller.fencingToken });
    db.prepare("UPDATE scheduler_batches SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(claimed.batchId);
    const heartbeat = heartbeatScheduleBatch(db, run.id, claimed.batchId, config);
    assert.equal(heartbeat.recoveryRequired, true);
    assert.deepEqual(heartbeat.missingReceiptTaskIds, ["missing-receipt"]);
    const batch = db.prepare("SELECT updated_at FROM scheduler_batches WHERE id = ?").get(claimed.batchId);
    assert.equal(batch.updated_at, "2000-01-01T00:00:00.000Z");
    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(action.schedulerBatches.find((item) => item.id === claimed.batchId).stalePreparation, true);
    assert.ok(action.recoveryCommands.some((command) => command.includes(claimed.batchId)));
  } finally {
    db.close();
  }
});
