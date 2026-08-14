import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { openDatabase } from "../src/core/db.js";
import { runnableTasks } from "../src/core/graph.js";
import { addMilestone } from "../src/core/milestones.js";
import { sampleProgress } from "../src/core/progress.js";
import { acknowledgeScheduleSpawn } from "../src/core/scheduler.js";
import { addTask, claimTask, finishTask, getTask, retryTask } from "../src/core/tasks.js";
import { acquireIntegrationLock } from "../src/core/worktrees.js";
import { forcePhase, makeProject, spawnReceipts, startTestRun } from "./helpers.js";

const url = (relative) => pathToFileURL(path.resolve(relative)).href;

function runChild(code, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => {
      const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
      try { resolve({ status, stderr, result: JSON.parse(line ?? "{}") }); }
      catch (error) { reject(new Error(`Invalid child output (${status}): ${stdout}\n${stderr}`, { cause: error })); }
    });
  });
}

const startCode = `
const [dbUrl, configUrl, stateUrl, root, goal, session] = process.argv.slice(1);
const { openDatabase } = await import(dbUrl);
const { loadConfig } = await import(configUrl);
const { startRun } = await import(stateUrl);
const db = openDatabase(root);
try {
  const value = startRun(db, root, loadConfig(root), goal, { controllerSessionId: session, controllerOwner: session });
  console.log(JSON.stringify({ ok: true, runId: value.run.id }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code ?? null, message: error.message }));
} finally { db.close(); }
`;

test("two Main processes cannot acquire the same repository control plane", async () => {
  const { root, db } = makeProject();
  db.close();
  const args = [url("src/core/db.js"), url("src/core/config.js"), url("src/core/state.js"), root, "Concurrent goal"];
  const results = await Promise.all([
    runChild(startCode, [...args, "main-a"]),
    runChild(startCode, [...args, "main-b"])
  ]);
  assert.equal(results.filter((item) => item.result.ok).length, 1);
  const rejected = results.find((item) => !item.result.ok)?.result;
  assert.ok(["ACTIVE_RUN_RACE", "RUN_ALREADY_CONTROLLED"].includes(rejected.code), JSON.stringify(results));
});

test("scheduler batch claim is atomic across eight OS processes and spawn budget waits for ACK", async () => {
  const { root, config, db } = makeProject({ config: { orchestration: { maxConcurrent: 8 } } });
  const { run, controller } = startTestRun(db, root, config, "Claim an atomic batch");
  forcePhase(db, root, config, run.id, "plan");
  addMilestone(db, run.id, {
    id: "m-batch", title: "Atomic batch", objective: "Prepare eight independent work items",
    userVisibleOutcome: "Eight independent checks are ready.", exitCriteria: ["All eight tasks reach a terminal state"],
    requirementIds: ["REQ-001"]
  });
  for (let index = 0; index < 8; index += 1) {
    addTask(db, run.id, {
      id: `batch-${index}`, title: `Batch ${index}`, goal: `Complete independent item ${index}`,
      role: "worker", runPhase: "execute", readOnly: true, milestoneId: "m-batch",
      requirementIds: ["REQ-001"], acceptanceCriteria: ["The item is checked"],
      requiredEvidence: ["A structured result"], verificationModes: ["test"],
      scope: ["read-only fixture"], targetPaths: [], dependsOn: []
    }, config);
  }
  forcePhase(db, root, config, run.id, "execute");

  const code = `
const [dbUrl, configUrl, schedulerUrl, root, runId, fence, owner] = process.argv.slice(1);
const { openDatabase } = await import(dbUrl);
const { loadConfig } = await import(configUrl);
const { claimSchedule } = await import(schedulerUrl);
const db = openDatabase(root);
try {
  const value = claimSchedule(db, root, runId, loadConfig(root), { owner, controllerFencingToken: Number(fence) });
  console.log(JSON.stringify({ ok: true, batchId: value.batchId, count: value.batch.length }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code ?? null, message: error.message }));
} finally { db.close(); }
`;
  const args = [url("src/core/db.js"), url("src/core/config.js"), url("src/core/scheduler.js"), root, run.id, String(controller.fencingToken)];
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => runChild(code, [...args, `scheduler-${index}`])));
  const batches = db.prepare("SELECT * FROM scheduler_batches WHERE run_id = ?").all(run.id);
  assert.equal(batches.length, 1, JSON.stringify(results));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'running'").get(run.id).count), 8);
  assert.equal(Number(db.prepare("SELECT agent_spawns FROM budget_state WHERE run_id = ?").get(run.id).agent_spawns), 0);

  const batchItems = JSON.parse(batches[0].batch_json);
  const receipts = spawnReceipts(batchItems, null, "metis-main");
  const first = acknowledgeScheduleSpawn(db, run.id, batches[0].id, null, "metis-main", config, receipts);
  const second = acknowledgeScheduleSpawn(db, run.id, batches[0].id, null, "metis-main", config, receipts);
  assert.equal(first.acknowledgedTaskIds.length, 8);
  assert.equal(second.acknowledgedTaskIds.length, 0);
  assert.equal(Number(db.prepare("SELECT agent_spawns FROM budget_state WHERE run_id = ?").get(run.id).agent_spawns), 8);
});

test("expired worker attempts fail closed and a stale result cannot finish the next attempt", () => {
  const { root, config, db } = makeProject();
  const { run } = startTestRun(db, root, config, "Fence expired work");
  forcePhase(db, root, config, run.id, "plan");
  addMilestone(db, run.id, {
    id: "m-fence", title: "Fence attempts", objective: "Apply one bounded change",
    userVisibleOutcome: "The bounded change is isolated.", exitCriteria: ["The task has one current attempt"],
    requirementIds: ["REQ-001"]
  });
  addTask(db, run.id, {
    id: "mutable", title: "Mutable task", goal: "Change one file", role: "worker", runPhase: "execute",
    milestoneId: "m-fence", requirementIds: ["REQ-001"], targetPaths: ["src/feature.js"],
    acceptanceCriteria: ["The file is updated"], requiredEvidence: ["Current patch"], verificationModes: ["test"]
  }, config);
  forcePhase(db, root, config, run.id, "execute");
  const first = claimTask(db, run.id, "mutable", "worker-a", config);
  db.prepare("UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE task_id = 'mutable'").run();
  runnableTasks(db, run.id, 20);
  assert.equal(getTask(db, "mutable").status, "blocked");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM leases WHERE task_id = 'mutable'").get().count), 1);

  retryTask(db, run.id, "mutable", "Recover after the expired worker", config, "transient");
  const second = claimTask(db, run.id, "mutable", "worker-b", config);
  assert.ok(second.attemptFence > first.attemptFence);
  assert.notEqual(second.workspacePath, first.workspacePath);
  assert.throws(() => finishTask(db, root, run.id, "mutable", first.leaseToken, {
    Status: "COMPLETED", Files: [], Summary: "stale", EvidenceRefs: [], Blockers: []
  }, config), (error) => ["LEASE_INVALID", "LEASE_TOKEN_INVALID", "LEASE_TOKEN", "TASK_FENCED", "LEASE_EXPIRED"].includes(error.code));
});

test("concurrent retries have one state transition and one budget charge", async () => {
  const { root, config, db } = makeProject({ config: { budgets: { run: { retries: 1 } } } });
  const { run } = startTestRun(db, root, config, "Retry one failed task atomically");
  forcePhase(db, root, config, run.id, "plan");
  addTask(db, run.id, {
    id: "retry-race",
    title: "Retry race",
    goal: "Exercise concurrent retry state transitions",
    role: "worker",
    runPhase: "execute",
    readOnly: true,
    targetPaths: [],
    acceptanceCriteria: ["The retry state is applied once"],
    requiredEvidence: ["The retry budget event"],
    dependsOn: []
  }, config);
  forcePhase(db, root, config, run.id, "execute");
  claimTask(db, run.id, "retry-race", "retry-worker", config);
  db.prepare("UPDATE tasks SET status = 'blocked', owner = NULL WHERE id = ?").run("retry-race");
  db.close();

  const code = `
const [dbUrl, configUrl, tasksUrl, root, runId] = process.argv.slice(1);
const { openDatabase } = await import(dbUrl);
const { loadConfig } = await import(configUrl);
const { retryTask } = await import(tasksUrl);
const db = openDatabase(root);
try {
  retryTask(db, runId, "retry-race", "Retry after a concurrent failure", loadConfig(root), "transient");
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code ?? null }));
} finally { db.close(); }
`;
  const args = [url("src/core/db.js"), url("src/core/config.js"), url("src/core/tasks.js"), root, run.id];
  const results = await Promise.all([runChild(code, args), runChild(code, args)]);
  const reopened = openDatabase(root);
  try {
    assert.equal(results.filter((item) => item.result.ok).length, 1, JSON.stringify(results));
    assert.equal(reopened.prepare("SELECT status FROM tasks WHERE id = ?").get("retry-race").status, "pending");
    assert.equal(Number(reopened.prepare("SELECT retries FROM budget_state WHERE run_id = ?").get(run.id).retries), 1);
  } finally {
    reopened.close();
  }
});

test("integration ownership cannot be stolen after the old stale-lock interval", () => {
  const { root, config, db } = makeProject();
  const { run } = startTestRun(db, root, config, "Serialize integration");
  const secondDb = openDatabase(root);
  const first = acquireIntegrationLock(db, run.id, 1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
  assert.throws(() => acquireIntegrationLock(secondDb, run.id, 1), (error) => /locked/u.test(String(error.message)));
  first.release();
  const next = acquireIntegrationLock(secondDb, run.id, 1);
  next.release();
  secondDb.close();
});

test("concurrent progress sampling is idempotent", async () => {
  const { root, config, db } = makeProject();
  const { run } = startTestRun(db, root, config, "Sample one revision");
  sampleProgress(db, run.id, config);
  db.prepare("DELETE FROM progress_samples WHERE run_id = ?").run(run.id);
  const code = `
const [dbUrl, configUrl, progressUrl, root, runId] = process.argv.slice(1);
const { openDatabase } = await import(dbUrl);
const { loadConfig } = await import(configUrl);
const { sampleProgress } = await import(progressUrl);
const db = openDatabase(root);
try { const value = sampleProgress(db, runId, loadConfig(root)); console.log(JSON.stringify({ ok: true, id: value.id })); }
catch (error) { console.log(JSON.stringify({ ok: false, code: error.code ?? null, message: error.message })); }
finally { db.close(); }
`;
  const args = [url("src/core/db.js"), url("src/core/config.js"), url("src/core/progress.js"), root, run.id];
  const results = await Promise.all(Array.from({ length: 8 }, () => runChild(code, args)));
  assert.equal(results.every((item) => item.result.ok), true, JSON.stringify(results));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM progress_samples WHERE run_id = ?").get(run.id).count), 1);
});
