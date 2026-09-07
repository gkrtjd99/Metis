import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { claudeSpawnDescriptor } from "../src/adapters/spawn-descriptors.js";
import { main } from "../src/cli.js";
import { nextControllerAction } from "../src/core/controller.js";
import { addTask } from "../src/core/tasks.js";
import { acknowledgeScheduleSpawn, claimSchedule } from "../src/core/scheduler.js";
import { forcePhase, jsonIo, makeProject, spawnReceipts, startTestRun } from "./helpers.js";

test("Claude의 bounded verifier는 역할을 유지하면서 worker 기본 모델을 사용한다", () => {
  const profile = readFileSync(new URL("../adapters/claude/agents/worker.md", import.meta.url), "utf8");
  const workerModel = profile.match(/^model: (.+)$/m)[1];
  const task = { id: "verify", role: "verifier", parent_task_id: "owner", model_tier: "worker", selected_model: null };
  const contract = { content: "독립 검증" };
  const descriptor = claudeSpawnDescriptor(task, contract);
  assert.equal(descriptor.agent_type, "metis-verifier");
  assert.equal(descriptor.model, workerModel);
  assert.equal(descriptor.model_tier, "worker");
  assert.equal(claudeSpawnDescriptor({ ...task, selected_model: "explicit-model" }, contract).model, "explicit-model");
  assert.equal(claudeSpawnDescriptor({ ...task, parent_task_id: null, model_tier: "strong" }, contract).model, undefined);
});

test("owner CLI는 controller credentials 없이 자신의 subtree만 운영한다", async () => {
  const { root, db, config } = makeProject({ config: { delegation: { ownerExecution: {
    hosts: { codex: { mode: "nested-agent", childSpawning: true, evidence: "fixture host session" } }
  } } } });
  try {
    const { run, controller } = startTestRun(db, root, config, "Owner CLI");
    forcePhase(db, root, config, run.id, "plan");
    const base = {
      runPhase: "execute", readOnly: true, requirementIds: ["REQ-001"],
      scope: ["package.json"], acceptanceCriteria: ["Inspect the bounded input."], requiredEvidence: []
    };
    addTask(db, run.id, { ...base, id: "owner", title: "Owner", role: "coordinator" }, config);
    addTask(db, run.id, { ...base, id: "leaf", title: "Leaf", role: "worker", parentTaskId: "owner" }, config);
    forcePhase(db, root, config, run.id, "execute");
    const claimed = claimSchedule(db, root, run.id, config, { controllerFencingToken: controller.fencingToken });
    acknowledgeScheduleSpawn(db, run.id, claimed.batchId, null, "main", config, spawnReceipts(claimed.batch));
    const owner = claimed.batch[0];
    assert.equal(owner.spawn.owner_execution.supported, true);
    assert.match(owner.spawn.owner_execution.next_command, /owner next/);

    async function invoke(operation, flags = []) {
      const io = jsonIo();
      const code = await main(["--root", root, "owner", operation, "owner", "--lease", owner.leaseToken, ...flags], io);
      assert.equal(code, 0, io.stderrText);
      return JSON.parse(io.stdoutText);
    }
    assert.equal((await invoke("next")).type, "SPAWN_BATCH");
    const children = await invoke("claim");
    assert.equal(children.batch.length, 1);
    assert.equal(children.batch[0].spawn.completion_owner, "owner");
    assert.match(children.batch[0].spawn.message, /Parent owner owner owns/);
    assert.doesNotMatch(children.batch[0].spawn.message, /Main owns the subsequent next\/action loop/);
    await invoke("ack", ["--batch", children.batchId, "--receipts", JSON.stringify(spawnReceipts(children.batch))]);
    assert.equal((await invoke("next")).type, "WAIT_FOR_CHILDREN");
    await invoke("heartbeat", ["--batch", children.batchId]);

    const action = nextControllerAction(db, root, run.id, config, { sampleProgress: false });
    assert.equal(action.type, "WAIT_FOR_AGENTS");
    assert.deepEqual(action.taskIds, ["owner"]);
    assert.equal(action.ownerManagedChildren, 1);
    assert.ok(!action.schedulerBatchIds.includes(children.batchId));

    const denied = jsonIo();
    assert.notEqual(await main(["--root", root, "owner", "next", "owner", "--lease", "wrong"], denied), 0);
    assert.match(denied.stderrText, /OWNER_LEASE_INVALID/);
    await invoke("child-failure", ["--batch", children.batchId, "--task", "leaf", "--data", JSON.stringify({ code: "server_overloaded" })]);
    assert.equal((await invoke("next")).type, "SPAWN_BATCH");
  } finally { db.close(); }
});
