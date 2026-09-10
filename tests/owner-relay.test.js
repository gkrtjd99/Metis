import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { budgetStatus } from "../src/core/budget.js";
import { nextControllerAction } from "../src/core/controller.js";
import { abortOwnerBatch, claimOwnerSchedule, ownerChildFailure, ownerNext } from "../src/core/owner.js";
import { ownerRelayRequests, readOwnerRelayBatch } from "../src/core/owner-relay.js";
import { takeoverController } from "../src/core/ownership.js";
import { acknowledgeScheduleSpawn, claimSchedule } from "../src/core/scheduler.js";
import { addTask } from "../src/core/tasks.js";
import { forcePhase, jsonIo, makeProject, spawnReceipts, startTestRun } from "./helpers.js";

function fixture(host, options = {}) {
  const value = makeProject({ config: {
    host,
    delegation: { ownerExecution: { hosts: {
      [host]: { mode: "host-relay", childSpawning: true, evidence: "테스트 최상위 host의 별도 session 지원" }
    } } }
  } });
  const { db, root, config } = value;
  const { run, controller } = startTestRun(db, root, config, "공통 owner relay", { host });
  forcePhase(db, root, config, run.id, "plan");
  const base = {
    runPhase: "execute", requirementIds: ["REQ-001"], scope: ["package.json"],
    readOnly: true, acceptanceCriteria: ["Return a bounded result."], requiredEvidence: []
  };
  addTask(db, run.id, { ...base, id: "owner", title: "Owner", role: "coordinator" }, config);
  addTask(db, run.id, { ...base, id: "worker", title: "비공개 작업 계약", role: "worker", parentTaskId: "owner",
    readOnly: false, scope: ["src/probe.js"], targetPaths: ["src/probe.js"] }, config);
  if (options.parallel) addTask(db, run.id, { ...base, id: "peer", title: "별도 읽기 작업", role: "worker", parentTaskId: "owner" }, config);
  addTask(db, run.id, { ...base, id: "verifier", title: "비공개 검증 계약", role: "verifier", parentTaskId: "owner", dependsOn: ["worker"] }, config);
  forcePhase(db, root, config, run.id, "execute");
  const batch = claimSchedule(db, root, run.id, config, { controllerFencingToken: controller.fencingToken });
  acknowledgeScheduleSpawn(db, run.id, batch.batchId, null, "main", config, spawnReceipts(batch.batch));
  const owner = batch.batch[0];
  return { ...value, run, controller, owner, args: [db, root, run.id, "owner", owner.leaseToken, config] };
}

function finishInProcess(item) {
  const handoff = item.spawn.terminal_handoff;
  mkdirSync(path.dirname(handoff.result_file), { recursive: true });
  const mutable = item.taskId === "worker";
  if (mutable) {
    mkdirSync(path.join(item.workspacePath, "src"), { recursive: true });
    writeFileSync(path.join(item.workspacePath, "src/probe.js"), "export const relayWorks = true;\n");
  }
  writeFileSync(handoff.result_file, JSON.stringify({
    Status: "COMPLETED", Files: mutable ? ["src/probe.js"] : [], Summary: "독립 테스트 세션의 완료",
    EvidenceRefs: [{ type: "source", path: "src/probe.js", startLine: 1, endLine: 1 }],
    AcceptanceResults: [{
      criterion: "Return a bounded result.",
      status: "passed",
      EvidenceRefs: [{ type: "source", path: "src/probe.js", startLine: 1, endLine: 1 }]
    }],
    Blockers: []
  }), { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("METIS_CONTROLLER_")));
  const result = execFileSync(handoff.invocation.executable, handoff.invocation.args, {
    cwd: handoff.invocation.cwd, env, encoding: "utf8", timeout: 20_000
  });
  assert.equal(JSON.parse(result).status, "completed");
}

for (const host of ["claude", "codex"]) {
  test(`${host}: owner 배정·Main relay·별도 프로세스 완료가 같은 계약으로 동작한다`, () => {
    const value = fixture(host);
    try {
      const { db, root, run, config, controller } = value;
      assert.equal(value.owner.spawn.owner_execution.delivery, "host-relay");
      assert.equal(ownerNext(...value.args).delivery, "host-relay");
      for (const taskId of ["worker", "verifier"]) {
        const claimed = claimOwnerSchedule(...value.args);
        assert.equal(claimed.action, "RELAY_BATCH");
        assert.equal(claimed.batch[0].spawn, undefined);
        const usage = budgetStatus(db, run.id).usage.agentSpawns;
        const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
        assert.equal(action.type, "WAIT_FOR_AGENTS");
        assert.deepEqual(action.taskIds, ["owner"]);
        assert.deepEqual(action.ownerRelay.requests, [{ batchId: claimed.batchId, ownerTaskId: "owner", pendingCount: 1, status: "ready" }]);
        assert.doesNotMatch(JSON.stringify(action.ownerRelay), /비공개|lease|terminal_handoff|message/);
        const relay = readOwnerRelayBatch(db, run.id, claimed.batchId, controller, config);
        assert.equal(relay.protocol, "metis.owner-relay.v1");
        assert.equal(relay.host, host);
        assert.equal(relay.ownerHostReceipt, `host:owner:${value.owner.attemptFence}`);
        assert.equal(relay.batch.length, 1);
        const item = relay.batch[0];
        assert.equal(item.taskId, taskId);
        assert.equal(item.spawn.protocol, "metis.spawn.v1");
        assert.equal(item.spawn.host, host);
        assert.equal(item.spawn.completion_owner, "owner");
        assert.equal(item.spawn.workspace_path, item.workspacePath);
        assert.ok(!JSON.stringify(relay).includes(controller.token));
        assert.deepEqual(readOwnerRelayBatch(db, run.id, claimed.batchId, controller, config), relay);
        assert.equal(budgetStatus(db, run.id).usage.agentSpawns, usage);
        const receipts = spawnReceipts(relay.batch.map((entry) => ({ ...entry, batchId: relay.batchId })), null, `${host}-test-session`);
        acknowledgeScheduleSpawn(db, run.id, relay.batchId, null, "main-relay", config, receipts);
        assert.equal(readOwnerRelayBatch(db, run.id, relay.batchId, controller, config).action, "NO_PENDING_SPAWNS");
        assert.deepEqual(ownerRelayRequests(db, run.id, config).requests, []);
        finishInProcess(item);
      }
      assert.equal(ownerNext(...value.args).type, "OWNER_READY_TO_FINISH");
    } finally { value.db.close(); }
  });

  test(`${host}: 부분 ACK 후 미생성 task만 전달하고 ACK 시 owner fence를 재검증한다`, () => {
    const value = fixture(host, { parallel: true });
    try {
      const { db, run, config, controller } = value;
      const claimed = claimOwnerSchedule(...value.args);
      const relay = readOwnerRelayBatch(db, run.id, claimed.batchId, controller, config);
      assert.equal(relay.batch.length, 2);
      const receipts = spawnReceipts(relay.batch.map((item) => ({ ...item, batchId: relay.batchId })), null, "partial-session");
      db.prepare("UPDATE tasks SET attempt_fence = attempt_fence + 1 WHERE id = 'owner'").run();
      assert.throws(() => acknowledgeScheduleSpawn(db, run.id, relay.batchId, ["worker"], "main", config, { worker: receipts.worker }), { code: "OWNER_FENCED" });
      db.prepare("UPDATE tasks SET attempt_fence = attempt_fence - 1 WHERE id = 'owner'").run();
      acknowledgeScheduleSpawn(db, run.id, relay.batchId, ["worker"], "main", config, { worker: receipts.worker });
      const remaining = readOwnerRelayBatch(db, run.id, relay.batchId, controller, config);
      assert.deepEqual(remaining.batch.map((item) => item.taskId), ["peer"]);
      assert.deepEqual(remaining.batch[0], relay.batch.find((item) => item.taskId === "peer"));
      const used = { peer: { ...receipts.peer, receipt: receipts.worker.receipt } };
      assert.throws(() => acknowledgeScheduleSpawn(db, run.id, relay.batchId, ["peer"], "main", config, used), { code: "OWNER_INDEPENDENCE" });
      acknowledgeScheduleSpawn(db, run.id, relay.batchId, ["peer"], "main", config, { peer: receipts.peer });
      assert.equal(readOwnerRelayBatch(db, run.id, relay.batchId, controller, config).batch.length, 0);
    } finally { value.db.close(); }
  });

  test(`${host}: relay 조회는 Main 권한과 현재 owner·child fence를 요구한다`, async () => {
    const value = fixture(host);
    try {
      const { db, root, run, config, controller } = value;
      const claimed = claimOwnerSchedule(...value.args);
      const usage = budgetStatus(db, run.id).usage.agentSpawns;
      assert.throws(() => readOwnerRelayBatch(db, run.id, claimed.batchId, null, config), { code: "CONTROLLER_REQUIRED" });
      const denied = jsonIo();
      assert.notEqual(await main(["--root", root, "relay", "read", claimed.batchId], denied), 0);
      assert.match(denied.stderrText, /CONTROLLER_REQUIRED/);
      const io = jsonIo();
      assert.equal(await main(["--root", root, "relay", "read", claimed.batchId,
        "--controller-session", controller.sessionId, "--controller-owner", controller.owner,
        "--controller-token", controller.token, "--controller-fence", String(controller.fencingToken)], io), 0, io.stderrText);
      assert.equal(JSON.parse(io.stdoutText).batch[0].taskId, "worker");
      assert.throws(() => readOwnerRelayBatch(db, run.id, "unknown", controller, config), { code: "OWNER_RELAY_SCOPE" });
      db.prepare("UPDATE scheduler_batches SET status = 'claimed' WHERE id = ?").run(claimed.batchId);
      assert.throws(() => readOwnerRelayBatch(db, run.id, claimed.batchId, controller, config), { code: "OWNER_RELAY_STATUS" });
      db.prepare("UPDATE scheduler_batches SET status = 'prepared' WHERE id = ?").run(claimed.batchId);
      const originalBatch = db.prepare("SELECT batch_json FROM scheduler_batches WHERE id = ?").get(claimed.batchId).batch_json;
      const tampered = JSON.parse(originalBatch);
      tampered[0].spawn.host = host === "claude" ? "codex" : "claude";
      db.prepare("UPDATE scheduler_batches SET batch_json = ? WHERE id = ?").run(JSON.stringify(tampered), claimed.batchId);
      assert.throws(() => readOwnerRelayBatch(db, run.id, claimed.batchId, controller, config), { code: "OWNER_RELAY_CONTRACT" });
      db.prepare("UPDATE scheduler_batches SET batch_json = ? WHERE id = ?").run(originalBatch, claimed.batchId);
      const oldExpiry = db.prepare("SELECT expires_at FROM leases WHERE task_id = 'worker'").get().expires_at;
      db.prepare("UPDATE leases SET expires_at = ? WHERE task_id = 'worker'").run("2000-01-01T00:00:00.000Z");
      assert.throws(() => readOwnerRelayBatch(db, run.id, claimed.batchId, controller, config), { code: "OWNER_RELAY_FENCED" });
      assert.equal(ownerRelayRequests(db, run.id, config).requests[0].code, "OWNER_RELAY_FENCED");
      db.prepare("UPDATE leases SET expires_at = ? WHERE task_id = 'worker'").run(oldExpiry);
      const replacement = takeoverController(db, run.id, { force: true, owner: "replacement", sessionId: "replacement" });
      assert.throws(() => readOwnerRelayBatch(db, run.id, claimed.batchId, controller, config), { code: "CONTROLLER_FENCED" });
      assert.throws(() => readOwnerRelayBatch(db, run.id, claimed.batchId, replacement, config), { code: "OWNER_FENCED" });
      assert.equal(budgetStatus(db, run.id).usage.agentSpawns, usage);
    } finally { value.db.close(); }
  });

  test(`${host}: relay는 미지원 설정·receipt 재사용을 거부하고 owner가 재시도를 담당한다`, () => {
    const value = fixture(host);
    try {
      const { db, root, run, config, controller } = value;
      const claimed = claimOwnerSchedule(...value.args);
      const relay = readOwnerRelayBatch(db, run.id, claimed.batchId, controller, config);
      const receipts = spawnReceipts(relay.batch.map((item) => ({ ...item, batchId: relay.batchId })), null, "test-session");
      const sameOwner = { worker: { ...receipts.worker, receipt: `host:owner:${value.owner.attemptFence}` } };
      assert.throws(() => acknowledgeScheduleSpawn(db, run.id, relay.batchId, null, "main", config, sameOwner), { code: "OWNER_INDEPENDENCE" });
      config.delegation.ownerExecution.hosts[host].childSpawning = false;
      assert.throws(() => readOwnerRelayBatch(db, run.id, claimed.batchId, controller, config), { code: "NESTED_DELEGATION_UNSUPPORTED" });
      config.delegation.ownerExecution.hosts[host].childSpawning = true;
      acknowledgeScheduleSpawn(db, run.id, relay.batchId, null, "main-relay", config, receipts);
      ownerChildFailure(...value.args, relay.batchId, "worker", { code: "server_overloaded" });
      const retry = claimOwnerSchedule(...value.args);
      const retryRelay = readOwnerRelayBatch(db, run.id, retry.batchId, controller, config);
      assert.ok(retryRelay.batch[0].attemptFence > relay.batch[0].attemptFence);
      assert.equal(readOwnerRelayBatch(db, run.id, relay.batchId, controller, config).batch.length, 0);
      abortOwnerBatch(...value.args, retry.batchId, "테스트 host가 생성하지 않은 batch 정리");
      assert.throws(() => readOwnerRelayBatch(db, run.id, retry.batchId, controller, config), { code: "OWNER_RELAY_STATUS" });
    } finally { value.db.close(); }
  });
}
