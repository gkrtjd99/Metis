import assert from "node:assert/strict";
import test from "node:test";
import { escalateModelRoute } from "../src/core/model-routing.js";
import { acknowledgeScheduleSpawn, claimSchedule, proposeSchedule } from "../src/core/scheduler.js";
import { addTask, getTask } from "../src/core/tasks.js";
import { forcePhase, makeProject, spawnReceipts, startTestRun } from "./helpers.js";
import { pathsOverlap } from "../src/core/util.js";

const WORKER_MODEL = "gpt-5.6-luna";
const STRONG_MODEL = "gpt-5.6";

function parallelConfig(overrides = {}) {
  return {
    models: {
      defaults: { codex: { worker: WORKER_MODEL } },
      routes: {
        worker: { tier: "worker", model: null, reasoningEffort: "medium" },
        diagnostician: { tier: "strong", model: STRONG_MODEL, reasoningEffort: "high" },
        reviewer: { tier: "strong", model: STRONG_MODEL, reasoningEffort: "high" }
      },
      routes: { planner: { tier: "strong", model: STRONG_MODEL, reasoningEffort: "high" } }
    },
    orchestration: { maxConcurrent: 8, requirePlanCritic: false },
    delegation: { compilerPolicy: "deterministic", requireReadyTaskPacket: true, scheduleByWave: true },
    ...overrides
  };
}

function worker(id, index, options = {}) {
  return {
    id,
    title: `Parallel worker ${index}`,
    goal: `Complete disjoint work item ${index}`,
    role: "worker",
    taskKind: "implementation",
    runPhase: "execute",
    wave: options.wave ?? 1,
    readOnly: false,
    targetPaths: [`src/parallel/${index}.js`],
    scope: [`src/parallel/${index}.js`],
    nonGoals: ["Do not modify another worker's path."],
    constraints: ["Preserve the frozen task contract."],
    acceptanceCriteria: [`Worker ${index} returns a terminal result.`],
    requiredEvidence: ["Current task evidence"],
    expectedOutputs: ["implementation"],
    requirementIds: ["REQ-001"],
    complexity: "low",
    risk: "low",
    effort: "small",
    dependsOn: []
  };
}

function seedRun({ count = 8, limit = 8, extraTasks = [] } = {}) {
  const { root, db, config } = makeProject({ config: parallelConfig() });
  const { run } = startTestRun(db, root, config, `Parallel orchestration ${count}`);
  forcePhase(db, root, config, run.id, "plan");
  for (let index = 1; index <= count; index += 1) {
    addTask(db, run.id, worker(`parallel-${index}`, index), config);
  }
  for (const task of extraTasks) addTask(db, run.id, task, config);
  forcePhase(db, root, config, run.id, "execute");
  return { root, db, config, run, limit };
}

function operationCounts(db, runId) {
  return {
    running: db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'running'").get(runId).count,
    pending: db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'pending'").get(runId).count,
    leases: db.prepare("SELECT COUNT(*) AS count FROM leases l JOIN tasks t ON t.id = l.task_id WHERE t.run_id = ?").get(runId).count,
    batches: db.prepare("SELECT COUNT(*) AS count FROM scheduler_batches WHERE run_id = ?").get(runId).count,
    acknowledged: db.prepare("SELECT COUNT(*) AS count FROM task_spawn_acks a JOIN tasks t ON t.id = a.task_id WHERE t.run_id = ?").get(runId).count
  };
}

function assertNoOverlap(tasks) {
  const paths = tasks.flatMap((task) => task.targetPaths);
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      assert.equal(pathsOverlap(paths[left], paths[right]), false, `${paths[left]} overlaps ${paths[right]}`);
    }
  }
}

test("decomposable parallel work claims four with limit four, ACKs exactly four, and has no overlap", () => {
  const { root, db, config, run } = seedRun({ limit: 4 });
  try {
    const tasks = Array.from({ length: 8 }, (_, index) => getTask(db, `parallel-${index + 1}`));
    assert.equal(tasks.length, 8);
    assert.ok(tasks.every((task) => task.role === "worker" && task.wave === 1 && task.dependsOn.length === 0));
    assertNoOverlap(tasks);

    const scheduled = claimSchedule(db, root, run.id, config, { owner: "parallel-main", limit: 4 });
    assert.equal(scheduled.wave, 1);
    assert.equal(scheduled.batch.length, 4);
    assert.equal(scheduled.deferred.length, 4);
    assert.equal(scheduled.batch.filter((item) => item.spawn?.agent_type === "metis-worker").length, 4);
    assert.ok(scheduled.batch.every((item) => item.spawn.model === WORKER_MODEL));
    assert.deepEqual(operationCounts(db, run.id), { running: 4, pending: 4, leases: 4, batches: 1, acknowledged: 0 });

    const receipts = spawnReceipts(scheduled.batch, null, "parallel-main");
    const ack = acknowledgeScheduleSpawn(db, run.id, scheduled.batchId, null, "parallel-main", config, receipts);
    assert.equal(ack.acknowledgedTaskIds.length, 4);
    assert.equal(ack.spawnedTaskIds.length, 4);
    assert.equal(operationCounts(db, run.id).acknowledged, 4);

    const repeated = acknowledgeScheduleSpawn(db, run.id, scheduled.batchId, null, "parallel-main", config, receipts);
    assert.deepEqual(repeated.acknowledgedTaskIds, []);
    assert.equal(operationCounts(db, run.id).acknowledged, 4);
  } finally {
    db.close();
  }
});

test("a fresh decomposable run claims all eight with limit eight and preserves the earliest-wave barrier", () => {
  const { root, db, config, run } = seedRun({
    limit: 8,
    extraTasks: [worker("later-wave", 9, { wave: 2 })]
  });
  try {
    const scheduled = claimSchedule(db, root, run.id, config, { owner: "parallel-main", limit: 8 });
    assert.equal(scheduled.wave, 1);
    assert.equal(scheduled.batch.length, 8);
    assert.equal(scheduled.deferred.length, 0);
    assert.ok(scheduled.batch.every((item) => item.wave === 1));
    assert.deepEqual(operationCounts(db, run.id), { running: 8, pending: 1, leases: 8, batches: 1, acknowledged: 0 });

    const receipts = spawnReceipts(scheduled.batch, null, "parallel-main");
    const ack = acknowledgeScheduleSpawn(db, run.id, scheduled.batchId, null, "parallel-main", config, receipts);
    assert.equal(ack.acknowledgedTaskIds.length, 8);
    assert.equal(ack.spawnedTaskIds.length, 8);
    assert.equal(operationCounts(db, run.id).acknowledged, 8);

    const repeated = acknowledgeScheduleSpawn(db, run.id, scheduled.batchId, null, "parallel-main", config, receipts);
    assert.deepEqual(repeated.acknowledgedTaskIds, []);
    assert.equal(operationCounts(db, run.id).acknowledged, 8);
  } finally {
    db.close();
  }
});

test("an atomic goal remains one task and one claimed descriptor", () => {
  const { root, db, config, run } = seedRun({ count: 0, limit: 8 });
  try {
    addTask(db, run.id, worker("atomic-worker", 1), config);
    const scheduled = claimSchedule(db, root, run.id, config, { owner: "atomic-main", limit: 8 });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND role = 'worker'").get(run.id).count, 1);
    assert.equal(scheduled.batch.length, 1);
    assert.equal(scheduled.deferred.length, 0);
    assert.equal(scheduled.batch[0].spawn.model, WORKER_MODEL);
    assert.deepEqual(operationCounts(db, run.id), { running: 1, pending: 0, leases: 1, batches: 1, acknowledged: 0 });
  } finally {
    db.close();
  }
});

test("Codex routing keeps Luna through the reasoning effort ladder and strong diagnostics off Luna", () => {
  const { root, db, config, run } = seedRun({ count: 0 });
  try {
    addTask(db, run.id, worker("routing-worker", 1), config);
    const scheduled = claimSchedule(db, root, run.id, config, { owner: "routing-main", limit: 1 });
    assert.equal(scheduled.batch[0].spawn.agent_type, "metis-worker");
    assert.equal(scheduled.batch[0].spawn.model, WORKER_MODEL);

    const escalated = escalateModelRoute(config, {
      role: "worker",
      model_tier: "worker",
      selected_model: WORKER_MODEL,
      model_source: "host-default",
      reasoning_effort: "high",
      escalation_level: 0
    }, "reasoning");
    assert.equal(escalated.tier, "worker");
    assert.equal(escalated.model, WORKER_MODEL);
    assert.equal(escalated.requestedEffort, "xhigh");

    const diagnostician = {
      id: "diagnostic-worker",
      role: "diagnostician",
      selected_model: STRONG_MODEL,
      reasoning_effort: "high"
    };
    assert.equal(getTask(db, "routing-worker").selected_model, WORKER_MODEL);
    assert.equal(diagnostician.role, "diagnostician");
    assert.notEqual(diagnostician.selected_model, WORKER_MODEL);
    assert.equal(diagnostician.reasoning_effort, "high");
  } finally {
    db.close();
  }
});

test("scheduler diagnostics expose the expected wave, deferred count, and ownership evidence", () => {
  const { root, db, config, run } = seedRun({ limit: 4 });
  try {
    const proposal = proposeSchedule(db, root, run.id, config, { limit: 4 });
    assert.deepEqual({
      wave: proposal.wave,
      slots: proposal.slots,
      batch: proposal.batch.length,
      deferred: proposal.deferred.length,
      action: proposal.action
    }, { wave: 1, slots: 8, batch: 4, deferred: 4, action: "SPAWN_BATCH" });
    assertNoOverlap(Array.from({ length: 8 }, (_, index) => getTask(db, `parallel-${index + 1}`)));
  } finally {
    db.close();
  }
});
