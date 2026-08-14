import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { budgetStatus } from "../src/core/budget.js";
import { nextControllerAction } from "../src/core/controller.js";
import { abortScheduleBatch, acknowledgeScheduleSpawn, claimSchedule, heartbeatScheduleBatch, refreshScheduleBatch } from "../src/core/scheduler.js";
import { addTask, claimTask } from "../src/core/tasks.js";
import { takeoverController } from "../src/core/ownership.js";
import { forcePhase, makeProject, spawnReceipts, startTestRun } from "./helpers.js";

const url = (relative) => pathToFileURL(path.resolve(relative)).href;

const claimCode = `
const [dbUrl, configUrl, schedulerUrl, root, runId, fence, parentTaskId, owner] = process.argv.slice(1);
let db;
try {
  const { openDatabase } = await import(dbUrl);
  const { loadConfig } = await import(configUrl);
  const { claimSchedule } = await import(schedulerUrl);
  db = openDatabase(root);
  const value = claimSchedule(db, root, runId, loadConfig(root), {
    owner, parentTaskId: parentTaskId || null, controllerFencingToken: Number(fence), limit: 8
  });
  console.log(JSON.stringify({ ok: true, batchId: value.batchId, count: value.batch.length }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code ?? null, message: error.message }));
} finally { db?.close(); }
`;

function startClaim(root, runId, fence, parentTaskId, owner) {
  const args = [
    url("src/core/db.js"),
    url("src/core/config.js"),
    url("src/core/scheduler.js"),
    root,
    runId,
    String(fence),
    parentTaskId,
    owner
  ];
  const child = spawn(process.execPath, ["--input-type=module", "-e", claimCode, ...args], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const done = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => {
      try {
        resolve({ status, stderr, result: JSON.parse(stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? "{}") });
      } catch (error) {
        reject(new Error(`Invalid child output (${status}): ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
  return { child, done };
}

function runClaim(root, runId, fence, parentTaskId, owner) {
  return startClaim(root, runId, fence, parentTaskId, owner).done;
}

function staleAbortObservation(db, root, runId, config, batchId) {
  db.prepare("UPDATE scheduler_batches SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(batchId);
  const action = nextControllerAction(db, root, runId, config, { sampleProgress: false });
  const batch = action.schedulerBatches.find((item) => item.id === batchId);
  assert.equal(batch?.stalePreparation, true);
  assert.ok(action.recoveryCommands.some((command) => command.includes(batchId)));
  return {
    expectedStatus: batch.status,
    expectedUpdatedAt: batch.observedUpdatedAt,
    expectedControllerFencingToken: batch.controllerFencingToken
  };
}

function pauseChildAfterDatabaseQuiescence(db, child) {
  // A claimed child may still be between filesystem preparation steps.  Take
  // the write lock before stopping it so SIGSTOP cannot freeze an in-flight
  // SQLite transaction and leave the observer with a spurious SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 30000");
  try {
    db.exec("BEGIN IMMEDIATE");
    child.kill("SIGSTOP");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.exec("PRAGMA busy_timeout = 5000");
  }
}

function task(id, role, parentTaskId = null) {
  return {
    id,
    title: id,
    goal: id,
    role,
    runPhase: "execute",
    wave: 1,
    readOnly: true,
    scope: [id],
    targetPaths: [],
    requirementIds: ["REQ-001"],
    acceptanceCriteria: ["done"],
    requiredEvidence: [],
    expectedOutputs: ["result"],
    dependsOn: [],
    ...(parentTaskId ? { parentTaskId } : {})
  };
}

function parentRaceProject(configOverrides = {}) {
  const { root, db, config } = makeProject({
    config: {
      delegation: { requireReadyTaskPacket: false },
      ...configOverrides
    }
  });
  const started = startTestRun(db, root, config, "Concurrent parent scheduler claims");
  forcePhase(db, root, config, started.run.id, "plan");
  for (const parent of ["coordinator-a", "coordinator-b"]) {
    addTask(db, started.run.id, task(parent, "coordinator"), config);
    for (let index = 1; index <= 2; index += 1) {
      addTask(db, started.run.id, task(`${parent}-child-${index}`, "worker", parent), config);
    }
  }
  forcePhase(db, root, config, started.run.id, "execute");
  claimTask(db, started.run.id, "coordinator-a", "coordinator-a", config);
  claimTask(db, started.run.id, "coordinator-b", "coordinator-b", config);
  return { root, db, config, ...started };
}

test("concurrent parent claims atomically enforce the global concurrency limit", async () => {
  const { root, db, run, controller } = parentRaceProject({ orchestration: { maxConcurrent: 4 } });
  try {
    const results = await Promise.all([
      runClaim(root, run.id, controller.fencingToken, "coordinator-a", "scheduler-a"),
      runClaim(root, run.id, controller.fencingToken, "coordinator-b", "scheduler-b")
    ]);
    const claimed = results.filter((item) => item.result.ok).reduce((sum, item) => sum + item.result.count, 0);
    assert.equal(claimed, 2, JSON.stringify(results));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'running'").get(run.id).count, 4);
    assert.ok(results.every((item) => item.result.ok || ["CONCURRENCY_LIMIT", "SCHEDULER_CLAIM_RACE"].includes(item.result.code)), JSON.stringify(results));
  } finally {
    db.close();
  }
});

test("concurrent parent claims reserve spawn budget and ACK confirms it once", async () => {
  const { root, db, config, run, controller } = parentRaceProject({
    orchestration: { maxConcurrent: 8 },
    budgets: { run: { agentSpawns: 4 } }
  });
  try {
    assert.equal(budgetStatus(db, run.id).usage.agentSpawns, 2);
    const results = await Promise.all([
      runClaim(root, run.id, controller.fencingToken, "coordinator-a", "scheduler-a"),
      runClaim(root, run.id, controller.fencingToken, "coordinator-b", "scheduler-b")
    ]);
    const successful = results.filter((item) => item.result.ok && item.result.count > 0);
    assert.equal(successful.reduce((sum, item) => sum + item.result.count, 0), 2, JSON.stringify(results));
    assert.equal(budgetStatus(db, run.id).usage.agentSpawns, 2);
    assert.equal(budgetStatus(db, run.id).reservations.agentSpawns, 2);
    assert.ok(results.every((item) => item.result.ok || item.result.code === "BUDGET_EXCEEDED"), JSON.stringify(results));

    const batchId = successful[0].result.batchId;
    const batch = JSON.parse(db.prepare("SELECT batch_json FROM scheduler_batches WHERE id = ?").get(batchId).batch_json);
    const receipts = spawnReceipts(batch, null, "main");
    const first = acknowledgeScheduleSpawn(db, run.id, batchId, null, "main", config, receipts);
    const repeated = acknowledgeScheduleSpawn(db, run.id, batchId, null, "main", config, receipts);
    assert.equal(first.acknowledgedTaskIds.length, 2);
    assert.deepEqual(repeated.acknowledgedTaskIds, []);
    assert.equal(budgetStatus(db, run.id).usage.agentSpawns, 4);
    assert.equal(budgetStatus(db, run.id).reservations.agentSpawns, 0);
  } finally {
    db.close();
  }
});

test("concurrent stale abort cannot resurrect a prepared batch or return descriptors", async () => {
  const { root, db, config } = makeProject({
    config: {
      orchestration: { maxConcurrent: 8 },
      delegation: { requireReadyTaskPacket: false }
    }
  });
  const { run, controller } = startTestRun(db, root, config, "Concurrent preparation abort");
  let child = null;
  try {
    forcePhase(db, root, config, run.id, "plan");
    for (let index = 1; index <= 8; index += 1) {
      addTask(db, run.id, {
        ...task(`preparation-race-${index}`, "worker"),
        readOnly: false,
        targetPaths: [`src/preparation-race-${index}.js`],
        scope: [`src/preparation-race-${index}.js`]
      }, config);
    }
    forcePhase(db, root, config, run.id, "execute");
    const started = startClaim(root, run.id, controller.fencingToken, "", "race-child");
    child = started.child;

    let batch = null;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      batch = db.prepare("SELECT id, status FROM scheduler_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(run.id);
      if (batch?.status === "claimed") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(batch?.status, "claimed", "child claim did not expose the claimed preparation state");
    pauseChildAfterDatabaseQuiescence(db, child);
    assert.equal(db.prepare("SELECT status FROM scheduler_batches WHERE id = ?").get(batch.id).status, "claimed");

    const observation = staleAbortObservation(db, root, run.id, config, batch.id);
    abortScheduleBatch(db, root, run.id, batch.id, "simulated stale preparation recovery", observation);
    child.kill("SIGCONT");
    const completed = await started.done;
    child = null;

    assert.equal(completed.result.ok, false, JSON.stringify(completed));
    assert.equal(completed.result.code, "SCHEDULER_PREPARATION_STALE", JSON.stringify(completed));
    assert.equal(db.prepare("SELECT status FROM scheduler_batches WHERE id = ?").get(batch.id).status, "aborted");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id LIKE 'preparation-race-%' AND status = 'pending'").get(run.id).count, 8);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM worktrees WHERE run_id = ? AND status = 'active'").get(run.id).count, 0);
    assert.deepEqual(budgetStatus(db, run.id).reservations, { agentSpawns: 0, researchCalls: 0 });
  } finally {
    if (child) {
      try { child.kill("SIGCONT"); } catch {}
      try { child.kill("SIGTERM"); } catch {}
    }
    db.close();
  }
});

test("delayed fenced stale abort cannot roll back a preparation winner", async () => {
  const { root, db, config } = makeProject({
    config: {
      orchestration: { maxConcurrent: 8 },
      delegation: { requireReadyTaskPacket: false }
    }
  });
  const { run, controller } = startTestRun(db, root, config, "Delayed stale preparation abort");
  let child = null;
  try {
    forcePhase(db, root, config, run.id, "plan");
    for (let index = 1; index <= 8; index += 1) {
      addTask(db, run.id, {
        ...task(`delayed-abort-${index}`, "worker"),
        readOnly: false,
        targetPaths: [`src/delayed-abort-${index}.js`],
        scope: [`src/delayed-abort-${index}.js`]
      }, config);
    }
    forcePhase(db, root, config, run.id, "execute");
    const started = startClaim(root, run.id, controller.fencingToken, "", "race-child");
    child = started.child;

    let batch = null;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      batch = db.prepare("SELECT id, status FROM scheduler_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(run.id);
      if (batch?.status === "claimed") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(batch?.status, "claimed", "child claim did not expose the claimed preparation state");
    pauseChildAfterDatabaseQuiescence(db, child);
    const observation = staleAbortObservation(db, root, run.id, config, batch.id);

    child.kill("SIGCONT");
    const completed = await started.done;
    child = null;
    assert.equal(completed.result.ok, true, JSON.stringify(completed));
    assert.equal(completed.result.count, 8);
    assert.equal(db.prepare("SELECT status FROM scheduler_batches WHERE id = ?").get(batch.id).status, "prepared");

    assert.throws(
      () => abortScheduleBatch(db, root, run.id, batch.id, "delayed stale recovery", observation),
      (error) => error.code === "SCHEDULER_ABORT_FENCED"
    );
    assert.equal(db.prepare("SELECT status FROM scheduler_batches WHERE id = ?").get(batch.id).status, "prepared");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id LIKE 'delayed-abort-%' AND status = 'running'").get(run.id).count, 8);
    assert.deepEqual(budgetStatus(db, run.id).reservations, { agentSpawns: 8, researchCalls: 0 });

    abortScheduleBatch(db, root, run.id, batch.id, "explicit operator cleanup");
    assert.equal(db.prepare("SELECT status FROM scheduler_batches WHERE id = ?").get(batch.id).status, "aborted");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id LIKE 'delayed-abort-%' AND status = 'pending'").get(run.id).count, 8);
  } finally {
    if (child) {
      try { child.kill("SIGCONT"); } catch {}
      try { child.kill("SIGTERM"); } catch {}
    }
    db.close();
  }
});

test("controller takeover during preparation failure cleans materialized workspaces without an unfenced abort", async () => {
  const { root, db, config } = makeProject({
    config: {
      orchestration: { maxConcurrent: 8 },
      delegation: { requireReadyTaskPacket: false }
    }
  });
  const { run, controller } = startTestRun(db, root, config, "Takeover during preparation failure");
  let child = null;
  try {
    forcePhase(db, root, config, run.id, "plan");
    for (let index = 1; index <= 8; index += 1) {
      addTask(db, run.id, {
        ...task(`takeover-cleanup-${index}`, "worker"),
        readOnly: false,
        targetPaths: [`src/takeover-cleanup-${index}.js`],
        scope: [`src/takeover-cleanup-${index}.js`]
      }, config);
    }
    forcePhase(db, root, config, run.id, "execute");
    const started = startClaim(root, run.id, controller.fencingToken, "", "old-controller");
    child = started.child;

    let batch = null;
    let materialized = 0;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      batch = db.prepare("SELECT id, status FROM scheduler_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(run.id);
      materialized = db.prepare("SELECT COUNT(*) AS count FROM worktrees WHERE run_id = ? AND status = 'active'").get(run.id).count;
      if (batch?.status === "claimed" && materialized > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(batch?.status, "claimed", "child claim did not expose claimed preparation state");
    assert.ok(materialized > 0, "child did not materialize a workspace before takeover");

    // Synchronize after any repository-sync transaction has released its
    // write lock, then stop the child before it can observe the takeover.
    db.exec("BEGIN IMMEDIATE");
    child.kill("SIGSTOP");
    db.exec("ROLLBACK");
    const replacement = takeoverController(db, run.id, {
      force: true,
      owner: "replacement-controller",
      sessionId: "replacement-session"
    });
    assert.notEqual(replacement.fencingToken, controller.fencingToken);
    const materializedBeforeCleanup = db.prepare("SELECT COUNT(*) AS count FROM worktrees WHERE run_id = ? AND status = 'active'").get(run.id).count;

    child.kill("SIGCONT");
    const completed = await started.done;
    child = null;
    assert.equal(completed.result.ok, false, JSON.stringify(completed));
    assert.ok(["CONTROLLER_FENCED", "SCHEDULER_PREPARATION_STALE"].includes(completed.result.code), JSON.stringify(completed));
    assert.equal(db.prepare("SELECT status FROM scheduler_batches WHERE id = ?").get(batch.id).status, "claimed");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM worktrees WHERE run_id = ? AND status = 'active'").get(run.id).count,
      0
    );
    const stalePreparations = db.prepare("SELECT COUNT(*) AS count FROM worktrees WHERE run_id = ? AND status = 'scheduler-stale-preparation'").get(run.id).count;
    const allPreparedWorktrees = db.prepare("SELECT COUNT(*) AS count FROM worktrees WHERE run_id = ?").get(run.id).count;
    // SIGSTOP delivery can race with one more worktree registration after the
    // pre-cleanup observation. Every workspace that became durable must still
    // be fenced and classified as stale; none may remain active.
    assert.ok(stalePreparations >= materializedBeforeCleanup);
    assert.equal(stalePreparations, allPreparedWorktrees);
  } finally {
    if (child) {
      try { child.kill("SIGCONT"); } catch {}
      try { child.kill("SIGTERM"); } catch {}
    }
    db.close();
  }
});

test("refresh keeps aborted batches aborted and is idempotent after completion", () => {
  const { root, db, config } = makeProject({
    config: { delegation: { requireReadyTaskPacket: false } }
  });
  try {
    const { run, controller } = startTestRun(db, root, config, "Refresh scheduler batch state");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, task("refresh-terminal-fence", "worker"), config);
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, {
      owner: "refresh-test",
      controllerFencingToken: controller.fencingToken
    });

    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run("refresh-terminal-fence");
    const completed = refreshScheduleBatch(db, claimed.batchId);
    assert.equal(completed.status, "completed");
    const completedUpdatedAt = completed.updated_at;
    assert.equal(refreshScheduleBatch(db, claimed.batchId).updated_at, completedUpdatedAt);

    abortScheduleBatch(db, root, run.id, claimed.batchId, "test aborted terminal state");
    const abortedBeforeRefresh = db.prepare("SELECT status, updated_at FROM scheduler_batches WHERE id = ?").get(claimed.batchId);
    const aborted = refreshScheduleBatch(db, claimed.batchId);
    assert.equal(aborted.status, abortedBeforeRefresh.status);
    assert.equal(aborted.updated_at, abortedBeforeRefresh.updated_at);
    assert.deepEqual(refreshScheduleBatch(db, claimed.batchId), aborted);
  } finally {
    db.close();
  }
});

test("controller takeover fences old ACK and heartbeat but can recover its prepared batch", () => {
  const { root, db, config } = makeProject({
    config: { delegation: { requireReadyTaskPacket: false } }
  });
  try {
    const { run, controller } = startTestRun(db, root, config, "Controller takeover scheduler fencing");
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, task("takeover-fenced-task", "worker"), config);
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, {
      owner: "old-controller",
      controllerFencingToken: controller.fencingToken
    });
    addTask(db, run.id, task("takeover-spawned-task", "worker"), config);
    const spawned = claimSchedule(db, root, run.id, config, {
      owner: "old-controller",
      controllerFencingToken: controller.fencingToken
    });
    acknowledgeScheduleSpawn(db, run.id, spawned.batchId, null, "old-controller", config, spawnReceipts(spawned.batch, null, "old-controller"));
    abortScheduleBatch(db, root, run.id, spawned.batchId, "accepted work remains live");
    const beforeTakeover = db.prepare("SELECT status, updated_at, controller_fencing_token FROM scheduler_batches WHERE id = ?")
      .get(claimed.batchId);
    const replacement = takeoverController(db, run.id, {
      force: true,
      owner: "replacement-controller",
      sessionId: "replacement-session"
    });

    assert.throws(
      () => acknowledgeScheduleSpawn(db, run.id, claimed.batchId, null, "old-controller", config, spawnReceipts(claimed.batch, null, "old-controller")),
      (error) => error.code === "CONTROLLER_FENCED"
    );
    assert.throws(
      () => heartbeatScheduleBatch(db, run.id, claimed.batchId, config),
      (error) => error.code === "CONTROLLER_FENCED"
    );
    assert.throws(
      () => heartbeatScheduleBatch(db, run.id, spawned.batchId, config),
      (error) => error.code === "CONTROLLER_FENCED"
    );
    assert.throws(
      () => heartbeatScheduleBatch(db, run.id, spawned.batchId, config, { controllerFencingToken: controller.fencingToken }),
      (error) => error.code === "CONTROLLER_FENCED"
    );
    const recoveredSpawned = heartbeatScheduleBatch(db, run.id, spawned.batchId, config, {
      controllerFencingToken: replacement.fencingToken
    });
    assert.equal(recoveredSpawned.status, "aborted");
    assert.equal(recoveredSpawned.heartbeats.length, 1);
    assert.throws(
      () => abortScheduleBatch(db, root, run.id, claimed.batchId, "stale recovery without current controller fence"),
      (error) => error.code === "CONTROLLER_FENCED"
    );

    const recovered = abortScheduleBatch(db, root, run.id, claimed.batchId, "replacement recovered stale prepared batch", {
      expectedStatus: beforeTakeover.status,
      expectedUpdatedAt: beforeTakeover.updated_at,
      expectedControllerFencingToken: replacement.fencingToken
    });
    assert.equal(recovered.status, "aborted");
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = ?").get("takeover-fenced-task").status, "pending");
  } finally {
    db.close();
  }
});
