import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { claudeSpawnDescriptor, codexSpawnDescriptor } from "../src/adapters/spawn-descriptors.js";

const hosts = [
  ["codex", codexSpawnDescriptor],
  ["claude", claudeSpawnDescriptor]
];

function task(overrides = {}) {
  return {
    id: "child-task",
    run_id: "run-123",
    role: "worker",
    parent_task_id: "owner-123",
    model_tier: "worker",
    selected_model: "explicit-model",
    ...overrides
  };
}

function options(overrides = {}) {
  return {
    batchId: "batch-123",
    attemptFence: 7,
    leaseToken: "example-lease-token",
    parentRoot: "/repo/main",
    workspacePath: "/repo/worktree",
    workspaceMode: "git-worktree",
    ...overrides
  };
}

test("Claude and Codex expose the same versioned spawn ABI", () => {
  const descriptors = hosts.map(([host, render]) => render(task(), { content: "bounded contract" }, options()));
  for (const [index, descriptor] of descriptors.entries()) {
    assert.equal(descriptor.protocol, "metis.spawn.v1");
    assert.equal(descriptor.host, hosts[index][0]);
    assert.equal(descriptor.run_id, "run-123");
    assert.equal(descriptor.task_name, "child-task");
    assert.equal(descriptor.parent_task_id, "owner-123");
    assert.equal(descriptor.workspace_path, "/repo/worktree");
    assert.equal(descriptor.workspace_mode, "git-worktree");
    assert.equal(descriptor.batch_id, "batch-123");
    assert.equal(descriptor.attempt_fence, 7);
    assert.equal(descriptor.completion_owner, "owner-123");
    assert.equal(descriptor.terminal_handoff.task_id, "child-task");
    assert.equal(descriptor.terminal_handoff.lease, "example-lease-token");
  }
  const commonFields = (descriptor) => ({
    protocol: descriptor.protocol,
    run_id: descriptor.run_id,
    task_name: descriptor.task_name,
    parent_task_id: descriptor.parent_task_id,
    workspace_path: descriptor.workspace_path,
    workspace_mode: descriptor.workspace_mode,
    batch_id: descriptor.batch_id,
    attempt_fence: descriptor.attempt_fence,
    completion_owner: descriptor.completion_owner,
    terminal_handoff: {
      task_id: descriptor.terminal_handoff.task_id,
      lease: descriptor.terminal_handoff.lease,
      result_file: descriptor.terminal_handoff.result_file
    }
  });
  assert.deepEqual(commonFields(descriptors[0]), commonFields(descriptors[1]));
  assert.notEqual(descriptors[0].host, descriptors[1].host);
});

test("both host adapters preserve hostile values in structured terminal argv", () => {
  const hostileTask = "task';$(touch /tmp/metis-spawn-pwned);--";
  const hostileLease = "lease' && rm -rf /;$(id)";
  const hostileRoot = "/repo/parent dir/'quoted'";
  for (const [host, render] of hosts) {
    const descriptor = render(task({ id: hostileTask }), { content: "bounded" }, options({
      leaseToken: hostileLease,
      parentRoot: hostileRoot,
      workspacePath: "/repo/worktree/'child'"
    }));
    const handoff = descriptor.terminal_handoff;
    const invocation = handoff.invocation;
    assert.equal(descriptor.host, host);
    assert.equal(invocation.executable, process.execPath);
    assert.equal(invocation.cwd, path.resolve(hostileRoot));
    assert.equal(invocation.args[0], "--no-warnings");
    assert.match(invocation.args[1], /(?:^|[\\/])src[\\/]cli\.js$/u);
    assert.deepEqual(invocation.args.slice(-8), [
      "task", "finish", hostileTask, "--lease", hostileLease,
      "--file", handoff.result_file, "--pretty"
    ]);
    assert.ok(handoff.command.includes("'\"'\"'"));
    assert.ok(handoff.command.includes("$(touch /tmp/metis-spawn-pwned)"));
    assert.ok(handoff.command.includes("$(id)"));
  }
});

test("host-relay owner delivery tells the owner not to perform nested spawn", () => {
  const descriptor = claudeSpawnDescriptor(task({
    id: "owner-123",
    role: "coordinator",
    parent_task_id: null,
    run_id: "run-123"
  }), { content: "owner contract" }, options({
    ownerCapability: {
      supported: true,
      mode: "host-relay",
      evidence: "fixture relay handshake"
    }
  }));
  assert.equal(descriptor.owner_execution.required, true);
  assert.equal(descriptor.owner_execution.delivery, "host-relay");
  assert.equal(descriptor.owner_execution.mode, "host-relay");
  assert.match(descriptor.message, /owner claim.*Main host.*batch ID.*relay/iu);
  assert.match(descriptor.message, /직접 중첩 spawn 하지 않음/iu);
  assert.match(descriptor.message, /결정\/완료는 owner 유지/iu);
  assert.doesNotMatch(descriptor.message, /실행과 검증에는 별도 host agent\/receipt/u);
});

test("non-relay owner delivery remains direct and keeps existing owner instructions", () => {
  const descriptor = codexSpawnDescriptor(task({
    id: "owner-123",
    role: "coordinator",
    parent_task_id: null,
    run_id: "run-123"
  }), { content: "owner contract" }, options({
    ownerCapability: {
      supported: true,
      mode: "nested-agent",
      evidence: "fixture native support"
    }
  }));
  assert.equal(descriptor.owner_execution.delivery, "direct");
  assert.match(descriptor.message, /실행과 검증에는 별도 host agent\/receipt/u);
  assert.doesNotMatch(descriptor.message, /직접 중첩 spawn 하지 않음/u);
});
