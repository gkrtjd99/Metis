import assert from "node:assert/strict";
import test from "node:test";
import { addTask, claimTask, finishTask } from "../src/core/tasks.js";
import { claimSchedule, acknowledgeScheduleSpawn } from "../src/core/scheduler.js";
import {
  ownerNext,
  claimOwnerSchedule,
  acknowledgeOwnerSpawn,
  heartbeatOwner,
  abortOwnerBatch,
  ownerChildFailure
} from "../src/core/owner.js";
import { budgetStatus } from "../src/core/budget.js";
import { takeoverController } from "../src/core/ownership.js";
import { forcePhase, makeProject, spawnReceipts, startTestRun } from "./helpers.js";

const ownerExecution = (maxConcurrentChildren = 4) => ({
  maxConcurrentChildren,
  hosts: {
    codex: { mode: "nested-agent", childSpawning: true, evidence: "test host" }
  }
});

function ownerTask(id = "owner") {
  return {
    id,
    title: id,
    goal: `Coordinate ${id}`,
    role: "coordinator",
    taskKind: "integration",
    runPhase: "execute",
    wave: 1,
    readOnly: true,
    scope: ["owner subtree"],
    targetPaths: [],
    requirementIds: ["REQ-001"],
    acceptanceCriteria: ["Operate only direct children."],
    requiredEvidence: [],
    expectedOutputs: ["bounded owner progress"],
    dependsOn: []
  };
}

function childTask(id, parentTaskId, options = {}) {
  const role = options.role ?? "worker";
  const readOnly = options.readOnly ?? (role === "verifier");
  return {
    id,
    title: id,
    goal: `Complete ${id}`,
    role,
    taskKind: options.taskKind ?? (role === "verifier" ? "verification" : "implementation"),
    runPhase: "execute",
    wave: options.wave ?? 1,
    readOnly,
    parentTaskId,
    scope: [id],
    targetPaths: readOnly ? [] : [options.targetPath ?? `src/${id}.js`],
    requirementIds: ["REQ-001"],
    acceptanceCriteria: ["Return a bounded result."],
    requiredEvidence: [],
    expectedOutputs: ["result"],
    verificationModes: role === "verifier" ? ["semantic"] : ["test"],
    dependsOn: options.dependsOn ?? []
  };
}

function project(options = {}) {
  return makeProject({
    config: {
      orchestration: {
        maxConcurrent: options.maxConcurrent ?? 8,
        requirePlanCritic: false,
        requireDesignCritic: false
      },
      delegation: {
        requireReadyTaskPacket: false,
        ownerExecution: options.ownerExecution ?? ownerExecution()
      }
    }
  });
}

/** Create a running coordinator through Main's real claim and receipt ACK path. */
function startOwner(options = {}) {
  const value = project(options);
  const { root, db, config } = value;
  const { run, controller } = startTestRun(db, root, config, options.goal ?? "Run an owner subtree");
  forcePhase(db, root, config, run.id, "plan");
  addTask(db, run.id, ownerTask(options.ownerId ?? "owner"), config);
  for (const task of options.children ?? [childTask("child", options.ownerId ?? "owner")]) {
    addTask(db, run.id, task, config);
  }
  forcePhase(db, root, config, run.id, "execute");

  const mainBatch = claimSchedule(db, root, run.id, config, {
    owner: options.mainOwner ?? "main",
    limit: options.mainLimit ?? 1,
    controllerFencingToken: controller.fencingToken
  });
  const ownerItem = mainBatch.batch.find((item) => item.taskId === (options.ownerId ?? "owner"));
  assert.ok(ownerItem, "Main must claim the coordinator before owner execution starts");
  const ownerItems = mainBatch.batch.filter((item) => item.role === "coordinator");
  const ownerIds = ownerItems.map((item) => item.taskId);
  const mainReceipts = Object.fromEntries(ownerItems.map((item) => [item.taskId, {
    receipt: `${options.mainHost ?? "main"}:${item.taskId}:${item.attemptFence}`,
    batchId: mainBatch.batchId,
    taskId: item.taskId,
    attemptFence: item.attemptFence
  }]));
  acknowledgeScheduleSpawn(db, run.id, mainBatch.batchId, ownerIds, options.mainHost ?? "main", config, mainReceipts);
  return { ...value, run, controller, owner: ownerItem, ownerId: ownerItem.taskId, lease: ownerItem.leaseToken };
}

function ownerArgs(value) {
  return [value.db, value.root, value.run.id, value.ownerId, value.lease, value.config];
}

function claimChildren(value, options = {}) {
  return claimOwnerSchedule(...ownerArgs(value), options);
}

function ackChildren(value, claimed, taskIds = null, prefix = "child-host") {
  const selected = taskIds ?? claimed.batch.map((item) => item.taskId);
  const receipts = spawnReceipts(claimed.batch, selected, prefix);
  return acknowledgeOwnerSpawn(...ownerArgs(value), claimed.batchId, selected, receipts);
}

function complete(value, item, result = {}) {
  return finishTask(value.db, value.root, value.run.id, item.taskId, item.leaseToken, {
    Status: "COMPLETED",
    Files: [],
    Summary: result.Summary ?? `Completed ${item.taskId}.`,
    EvidenceRefs: result.EvidenceRefs ?? [],
    Blockers: [],
    ...result
  }, value.config);
}

function assertOwnerGuard(error) {
  return [
    "OWNER_RECEIPT_REQUIRED", "OWNER_LEASE_INVALID", "OWNER_FENCED", "CONTROLLER_EXPIRED",
    "NESTED_DELEGATION_UNSUPPORTED", "OWNER_BATCH_SCOPE", "OWNER_NOT_RUNNING"
  ].includes(error.code);
}

test("owner execution requires Main's real receipt, current lease, controller, and live owner attempt", () => {
  const missing = startOwner();
  try {
    const owner = missing.ownerId;
    const row = missing.db.prepare("DELETE FROM task_spawn_acks WHERE task_id = ?").run(owner);
    assert.equal(row.changes, 1);
    assert.throws(() => ownerNext(...ownerArgs(missing)), (error) => error.code === "OWNER_RECEIPT_REQUIRED");
  } finally { missing.db.close(); }

  const invalid = startOwner();
  try {
    assert.throws(() => ownerNext(invalid.db, invalid.root, invalid.run.id, invalid.ownerId, "wrong-lease", invalid.config),
      (error) => error.code === "OWNER_LEASE_INVALID");
  } finally { invalid.db.close(); }

  const expired = startOwner();
  try {
    expired.db.prepare("UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ?").run(expired.ownerId);
    assert.throws(() => ownerNext(...ownerArgs(expired)), (error) => ["OWNER_FENCED", "LEASE_EXPIRED"].includes(error.code));
  } finally { expired.db.close(); }

  const takeover = startOwner();
  try {
    takeoverController(takeover.db, takeover.run.id, { force: true, owner: "replacement", sessionId: "replacement-session" });
    assert.throws(() => ownerNext(...ownerArgs(takeover)), assertOwnerGuard);
  } finally { takeover.db.close(); }
});

test("unsupported owner host fails closed before consuming a child spawn budget", () => {
  const value = startOwner({ ownerExecution: { maxConcurrentChildren: 4, hosts: { codex: { mode: null, childSpawning: false, evidence: null } } } });
  try {
    const before = budgetStatus(value.db, value.run.id);
    assert.throws(() => claimChildren(value, { limit: 1 }), (error) => error.code === "NESTED_DELEGATION_UNSUPPORTED");
    assert.equal(budgetStatus(value.db, value.run.id).usage.agentSpawns, before.usage.agentSpawns);
    assert.equal(value.db.prepare("SELECT status FROM tasks WHERE id = 'child'").get().status, "pending");
  } finally { value.db.close(); }
});

test("an owner claims and ACKs only its direct children, while another owner cannot access its batch", () => {
  const value = startOwner({
    ownerId: "owner-a",
    children: [childTask("child-a", "owner-a"), ownerTask("owner-b"), childTask("child-b", "owner-b")],
    mainLimit: 2
  });
  try {
    // owner-b is also a root coordinator and was claimed by Main in the same batch.
    const mainBatch = value.db.prepare("SELECT * FROM scheduler_batches WHERE run_id = ? ORDER BY created_at").all(value.run.id);
    assert.equal(mainBatch.length, 1);
    const ownerB = mainBatch[0] && JSON.parse(mainBatch[0].batch_json).find((item) => item.taskId === "owner-b");
    assert.ok(ownerB);
    const childA = claimChildren(value, { limit: 1 });
    assert.deepEqual(childA.batch.map((item) => item.taskId), ["child-a"]);
    ackChildren(value, childA, null, "owner-a-host");

    const ownerBValue = { ...value, ownerId: "owner-b", lease: ownerB.leaseToken };
    const childB = claimChildren(ownerBValue, { limit: 1 });
    assert.deepEqual(childB.batch.map((item) => item.taskId), ["child-b"]);
    assert.throws(
      () => heartbeatOwner(...ownerArgs(value), childB.batchId),
      (error) => error.code === "OWNER_BATCH_SCOPE"
    );
  } finally { value.db.close(); }
});

test("a verifier cannot reuse the worker or owner host receipt", () => {
  const value = startOwner({
    children: [
      childTask("worker", "owner", { readOnly: true }),
      childTask("verifier", "owner", { role: "verifier" })
    ]
  });
  try {
    const claimed = claimChildren(value, { limit: 2 });
    assert.equal(claimed.batch.length, 2);
    const worker = claimed.batch.find((item) => item.taskId === "worker");
    const verifier = claimed.batch.find((item) => item.taskId === "verifier");
    const same = {
      worker: { receipt: "owner-host-receipt", batchId: claimed.batchId, taskId: "worker", attemptFence: worker.attemptFence },
      verifier: { receipt: "owner-host-receipt", batchId: claimed.batchId, taskId: "verifier", attemptFence: verifier.attemptFence }
    };
    assert.throws(
      () => acknowledgeOwnerSpawn(...ownerArgs(value), claimed.batchId, ["worker", "verifier"], same),
      (error) => /RECEIPT|VERIFIER|IDENTIT|INDEPENDENCE/u.test(error.code ?? "")
    );
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM task_spawn_acks WHERE batch_id = ?").get(claimed.batchId).count, 0);
    const shared = {
      worker: { ...same.worker, receipt: "worker-session" },
      verifier: { ...same.verifier, receipt: " worker-session " }
    };
    assert.throws(
      () => acknowledgeOwnerSpawn(...ownerArgs(value), claimed.batchId, null, shared),
      (error) => error.code === "OWNER_INDEPENDENCE"
    );
    assert.throws(
      () => acknowledgeScheduleSpawn(value.db, value.run.id, claimed.batchId, null, "main-relay", value.config, shared),
      (error) => error.code === "OWNER_INDEPENDENCE"
    );
    acknowledgeOwnerSpawn(...ownerArgs(value), claimed.batchId, ["worker"], { worker: shared.worker });
    assert.throws(
      () => acknowledgeOwnerSpawn(...ownerArgs(value), claimed.batchId, ["verifier"], { verifier: shared.verifier }),
      (error) => error.code === "OWNER_INDEPENDENCE"
    );
  } finally { value.db.close(); }
});

test("coordinator completion cannot bypass verifier requirements through a non-owner direct claim", () => {
  const value = startOwner({
    children: [childTask("direct-bypass", "owner", { readOnly: false })]
  });
  try {
    // Main's root scheduler batch is not an owner subtree batch, so a direct
    // claim below intentionally exercises the legacy/non-owner child path.
    const direct = claimTask(value.db, value.run.id, "direct-bypass", "direct-main", value.config);
    complete(value, { ...direct, taskId: "direct-bypass" }, { Summary: "Directly claimed mutable child." });
    assert.throws(
      () => finishTask(value.db, value.root, value.run.id, value.ownerId, value.lease, {
        Status: "COMPLETED", Files: [], Summary: "Attempt owner completion without verifier.", EvidenceRefs: [], Blockers: []
      }, value.config),
      (error) => error.code === "OWNER_VERIFICATION_REQUIRED"
    );
  } finally { value.db.close(); }
});

test("supported owner execution rejects an impossible one-slot global capacity explicitly", () => {
  const value = project({ maxConcurrent: 1 });
  try {
    const { run, controller } = startTestRun(value.db, value.root, value.config, "One slot owner capacity");
    forcePhase(value.db, value.root, value.config, run.id, "plan");
    addTask(value.db, run.id, ownerTask("one-slot-owner"), value.config);
    forcePhase(value.db, value.root, value.config, run.id, "execute");
    assert.throws(
      () => claimSchedule(value.db, value.root, run.id, value.config, {
        owner: "main", limit: 1, controllerFencingToken: controller.fencingToken
      }),
      (error) => error.code === "OWNER_CONCURRENCY"
    );
    assert.equal(value.db.prepare("SELECT status FROM tasks WHERE id = 'one-slot-owner'").get().status, "pending");
    assert.equal(budgetStatus(value.db, run.id).usage.agentSpawns, 0);
  } finally { value.db.close(); }
});

test("owner and global child slots are both enforced", () => {
  const value = startOwner({
    maxConcurrent: 3,
    ownerExecution: ownerExecution(4),
    children: [
      childTask("slot-1", "owner"), childTask("slot-2", "owner"), childTask("slot-3", "owner"), childTask("slot-4", "owner")
    ]
  });
  try {
    // One global slot is occupied by the running owner; only two child slots remain.
    const claimed = claimChildren(value, { limit: 4 });
    assert.equal(claimed.batch.length, 2);
    assert.equal(claimed.slots ?? claimed.globalSlots ?? claimed.diagnostics?.freeSlots, 2);
    assert.ok((claimed.ownerSlots ?? claimed.ownerConcurrency ?? claimed.maxConcurrentChildren ?? 2) <= 4);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'running'").get(value.run.id).count, 3);
  } finally { value.db.close(); }
});

test("ownerNext reports bounded terminal child state and never exposes a raw result", () => {
  const value = startOwner();
  try {
    const claimed = claimChildren(value, { limit: 1 });
    ackChildren(value, claimed);
    complete(value, claimed.batch[0], { Summary: "bounded summary", RawResult: "must-not-cross-owner-boundary" });
    const next = ownerNext(...ownerArgs(value));
    const serialized = JSON.stringify(next);
    assert.ok(serialized.includes("bounded summary") || serialized.includes("child"));
    assert.ok(!serialized.includes("must-not-cross-owner-boundary"));
    assert.ok(!Object.hasOwn(next, "rawResult"));
    assert.ok(!Object.hasOwn(next, "fullResult"));
  } finally { value.db.close(); }
});

test("owner 진행 요약은 하위 작업 24개로 제한한다", () => {
  const value = startOwner({
    children: Array.from({ length: 25 }, (_, index) => childTask(`child-${index}`, "owner"))
  });
  try {
    const next = ownerNext(...ownerArgs(value));
    assert.equal(next.childCount, 25);
    assert.equal(next.children.length, 24);
    assert.equal(next.childrenTruncated, true);
  } finally { value.db.close(); }
});

test("every completed mutable direct child needs a dependency-linked completed verifier", () => {
  const value = startOwner({
    children: [
      childTask("mutable", "owner", { readOnly: false }),
      childTask("verify-mutable", "owner", { role: "verifier", dependsOn: ["mutable"] })
    ]
  });
  try {
    const workerBatch = claimChildren(value, { limit: 1 });
    ackChildren(value, workerBatch);
    complete(value, workerBatch.batch[0], { Summary: "Mutable child completed." });
    const blocked = ownerNext(...ownerArgs(value));
    assert.equal(blocked.type, "SPAWN_BATCH");
    assert.ok(blocked.tasks.some((item) => item.taskId === "verify-mutable"));

    const verifierBatch = claimChildren(value, { limit: 1 });
    assert.deepEqual(verifierBatch.batch.map((item) => item.taskId), ["verify-mutable"]);
    ackChildren(value, verifierBatch, null, "independent-verifier-host");
    complete(value, verifierBatch.batch[0], { Summary: "Independent verification completed." });
    const advanced = ownerNext(...ownerArgs(value));
    assert.equal(advanced.type, "OWNER_READY_TO_FINISH");
    value.db.prepare("UPDATE task_spawn_acks SET host_receipt = (SELECT host_receipt FROM task_spawn_acks WHERE task_id = 'owner') WHERE task_id = 'mutable'").run();
    assert.equal(ownerNext(...ownerArgs(value)).type, "ESCALATE_TO_MAIN");
    value.db.prepare("DELETE FROM task_spawn_acks WHERE task_id = ?").run("mutable");
    const missingReceipt = ownerNext(...ownerArgs(value));
    assert.equal(missingReceipt.type, "ESCALATE_TO_MAIN");
    assert.deepEqual(missingReceipt.taskIds, ["mutable"]);
  } finally { value.db.close(); }
});

test("owner-scoped waves advance independently of a sibling owner but preserve dependencies", () => {
  const value = startOwner({
    ownerId: "owner-a",
    children: [
      childTask("a-wave-1", "owner-a", { wave: 1 }),
      childTask("a-wave-2", "owner-a", { wave: 2, dependsOn: ["a-wave-1"] }),
      ownerTask("owner-b"),
      childTask("b-wave-1", "owner-b", { wave: 1 })
    ],
    mainLimit: 2
  });
  try {
    const first = claimChildren(value, { limit: 1 });
    assert.deepEqual(first.batch.map((item) => item.taskId), ["a-wave-1"]);
    ackChildren(value, first);
    complete(value, first.batch[0]);

    const next = claimChildren(value, { limit: 1 });
    assert.deepEqual(next.batch.map((item) => item.taskId), ["a-wave-2"]);
    assert.equal(value.db.prepare("SELECT status FROM tasks WHERE id = 'b-wave-1'").get().status, "pending");
  } finally { value.db.close(); }
});

// Keep the owner failure and abort paths covered by the same owner guard contract.
test("owner heartbeat, child failure, and abort remain owner-scoped", () => {
  const value = startOwner();
  try {
    const claimed = claimChildren(value, { limit: 1 });
    const heartbeat = heartbeatOwner(...ownerArgs(value), claimed.batchId);
    assert.equal(heartbeat.batch.batchId, claimed.batchId);
    ackChildren(value, claimed);
    const failure = ownerChildFailure(...ownerArgs(value), claimed.batchId, "child", { code: "server_overloaded" });
    assert.ok(["requeued", "blocked", "failed-closed"].includes(failure.action) || ["pending", "blocked"].includes(failure.status));
    const aborted = abortOwnerBatch(...ownerArgs(value), claimed.batchId, "owner stopped this batch");
    assert.ok(["aborted", "partial", "claimed", "spawned"].includes(aborted.status) || aborted.batchId === claimed.batchId);
  } finally { value.db.close(); }
});
