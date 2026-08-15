import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveModelCapabilities } from "../src/adapters/model-capabilities.js";
import { claudeSpawnDescriptor, codexSpawnDescriptor } from "../src/adapters/spawn-descriptors.js";

const task = {
  id: "T-1", role: "worker", selected_model: "gpt-5.6", requested_effort: "max", effective_effort: "max",
  capability_status: "known", supported_efforts: ["low", "medium", "high", "xhigh", "max"]
};
const contract = { content: "bounded contract" };

function runShellCommand(command, cwd, env) {
  return spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    cwd,
    env,
    shell: false
  });
}

test("runtime capability evidence wins over installed and configured evidence", () => {
  const result = resolveModelCapabilities({
    host: "codex", model: "gpt-5.6", requestedEffort: "max",
    runtime: { supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
    installed: { supportedEfforts: ["low"] }, configured: { supportedEfforts: ["medium"] }
  });
  assert.equal(result.effective, "max");
  assert.equal(result.source, "runtime");
  assert.equal(result.host, "codex");
  assert.equal(result.model, "gpt-5.6");
});

test("unknown capability fails closed", () => {
  const result = resolveModelCapabilities({ host: "claude", model: "unknown", requestedEffort: "high" });
  assert.equal(result.effective, null);
  assert.equal(result.source, "unknown");
  assert.deepEqual(result.supported, []);
});

test("host-wide evidence does not make an unknown model look supported", () => {
  const result = resolveModelCapabilities({
    host: "codex", model: "unknown", requestedEffort: "high",
    configured: { hosts: { codex: { supportedEfforts: ["low", "medium", "high"] } } }
  });
  assert.equal(result.effective, null);
  assert.equal(result.capabilityStatus, "unknown");
});

test("Codex renders the negotiated effort as reasoning_effort", () => {
  const descriptor = codexSpawnDescriptor(task, contract);
  assert.equal(descriptor.reasoning_effort, "max");
  assert.equal(descriptor.effective_effort, "max");
  assert.equal(descriptor.args, undefined);
});

test("spawn descriptors make the fenced terminal self-finish unavoidable", () => {
  for (const role of ["planner", "plan-critic"]) {
    const taskId = `${role}-terminal`;
    const lease = `lease_${role}`;
    const descriptor = codexSpawnDescriptor({ ...task, id: taskId, role }, contract, { leaseToken: lease, parentRoot: "/repo" });
    assert.deepEqual(descriptor.terminal_handoff, {
      task_id: taskId,
      lease,
      result_file: descriptor.terminal_handoff.result_file,
      command: `cd '/repo' && $METIS --root '/repo' task finish '${taskId}' --lease '${lease}' --file '${descriptor.terminal_handoff.result_file}' --pretty`
    });
    assert.match(descriptor.message, /MANDATORY TERMINAL HANDOFF/u);
    assert.match(descriptor.message, /The file is the durable completion input/u);
    assert.match(descriptor.message, /Main owns the subsequent next\/action loop/u);
    assert.doesNotMatch(descriptor.message, /structured terminal result JSON>/u);
  }
});

test("plan critics receive a read-only controller fence and bounded failure protocol", () => {
  const protocolLease = ["lease", "plan", "critic", "protocol"].join("-");
  const descriptor = codexSpawnDescriptor({ ...task, id: "plan-critic-protocol", role: "plan-critic" }, contract, {
    leaseToken: protocolLease, parentRoot: "/repo"
  });
  assert.match(descriptor.message, /strictly read-only/u);
  assert.match(descriptor.message, /authenticated sealed PlanDraft/u);
  assert.match(descriptor.message, /object-load commands only/u);
  assert.match(descriptor.message, /Do not re-inspect the repository/u);
  assert.match(descriptor.message, /durable handoff is the only completion path/u);
  for (const command of ["plan review", "plan ingest", "plan seal", "next", "drive"]) {
    assert.match(descriptor.message, new RegExp(command.split(" ").join("\\s+"), "u"), command);
  }
  assert.match(descriptor.message, /CONTROLLER_REQUIRED/u);
  assert.match(descriptor.message, /immediately.*structured result/isu);
  assert.match(descriptor.message, /exact task-scoped file/u);
  assert.match(descriptor.message, /task finish/u);
});

test("terminal handoff quotes hostile task and lease values before shell rendering", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "metis-handoff-"));
  const marker = path.join(directory, "injected");
  try {
    const hostileSuffix = ["; touch ", marker, "; #"].join("");
    const taskId = "x" + hostileSuffix;
    const lease = "lease'" + hostileSuffix;
    const descriptor = codexSpawnDescriptor({ ...task, id: taskId }, contract, { leaseToken: lease, parentRoot: directory });
    const resultPath = descriptor.terminal_handoff.result_file;
    mkdirSync(path.dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ Summary: "'" + hostileSuffix }));
    const result = runShellCommand(descriptor.terminal_handoff.command, directory, { ...process.env, METIS: ":" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false);
    assert.match(descriptor.terminal_handoff.command, /cd '[^']+' && \$METIS --root '[^']+' task finish/u);
    assert.match(descriptor.terminal_handoff.command, /--file '\/[^']+\/\.metis\/task-results\/terminal-[0-9a-f]{64}\.json'/u);
    assert.doesNotMatch(descriptor.terminal_handoff.command, /--data/u);
    assert.doesNotMatch(descriptor.message, /structured terminal result JSON>/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude renders --effort and only enables minimal startup flags with explicit inputs", () => {
  const plain = claudeSpawnDescriptor(task, contract);
  assert.deepEqual(plain.args, ["--effort", "max"]);
  const explicit = claudeSpawnDescriptor(task, contract, {
    startup: { requiredInputs: [], tools: [], permissions: [], cwd: "/repo" }
  });
  assert.deepEqual(explicit.args, [
    "--effort", "max", "--bare", "--exclude-dynamic-system-prompt-sections", "--strict-mcp-config"
  ]);
});

test("providers defer an effort that was not negotiated", () => {
  const descriptor = codexSpawnDescriptor({
    ...task, selected_model: "unknown", capability_status: "unknown", supported_efforts: []
  }, contract);
  assert.equal(descriptor.reasoning_effort, undefined);
  assert.equal(descriptor.effective_effort, undefined);
  assert.equal(descriptor.effort_deferred, true);
});
