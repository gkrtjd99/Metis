import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DECISIONS,
  MAX_INPUT_BYTES,
  hostResponse,
  processHookEvent,
  resolveEnclosingGitRoot,
  runCli
} from "../src/adapters/continuation-hook.js";

function project() {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-hook-test-"));
  writeFileSync(path.join(root, "package.json"), "{}\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "package.json"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd: root });
  return root;
}

function bind(root, overrides = {}) {
  const directory = path.join(root, ".metis", "continuation");
  mkdirSync(directory, { recursive: true });
  const sessionId = overrides.sessionId ?? "session-1";
  const canonical = resolveEnclosingGitRoot(root);
  const binding = {
    protocol: "metis.continuation.v1",
    version: 1,
    bindingId: "binding-1",
    projectIdentity: createHash("sha256").update(canonical).digest("hex"),
    runId: "run-1",
    sessionId,
    host: "claude",
    controllerSessionId: "controller-1",
    controllerFencingToken: "1",
    nativeGoalInactive: true,
    evidence: "explicit test binding",
    ...overrides
  };
  const bindingKey = `${binding.host}:${sessionId}`;
  writeFileSync(path.join(directory, `${createHash("sha256").update(bindingKey).digest("hex")}.json`), `${JSON.stringify(binding)}\n`);
}

const snapshot = (decision, overrides = {}) => ({
  protocol: "metis.continuation.v1",
  decision,
  reasonCode: "READY",
  runId: "run-1",
  bindingId: "binding-1",
  revision: 1,
  ...overrides
});

function event(root, overrides = {}) {
  return {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: root,
    stop_hook_active: false,
    ...overrides
  };
}

test("pure host response maps every ABI decision without an evaluator", () => {
  assert.deepEqual(hostResponse(snapshot("CONTINUE"), { host: "claude" }), {
    decision: "block",
    reason: "Metis has more work in the same run. Use the resolved Metis launcher (`$METIS next`); existing runtime gates still apply."
  });
  assert.deepEqual(hostResponse(snapshot("WAIT"), { host: "claude", hasBackgroundTasks: true }), {});
  assert.match(hostResponse(snapshot("WAIT"), { host: "claude" }).systemMessage, /paused continuation/i);
  assert.match(hostResponse(snapshot("PAUSE"), { host: "codex" }).systemMessage, /paused continuation/i);
  assert.deepEqual(hostResponse(snapshot("COMPLETE"), { host: "claude" }), {});
  assert.deepEqual(hostResponse({ protocol: "metis.continuation.v1", decision: "DETACHED", reasonCode: "NO_BINDING" }, { host: "claude" }), {});
  assert.deepEqual(DECISIONS, new Set(["CONTINUE", "WAIT", "PAUSE", "COMPLETE", "DETACHED"]));
});

test("root resolution is enclosing git only and missing projects are silent", () => {
  const root = project();
  const nested = path.join(root, "nested");
  mkdirSync(nested);
  assert.equal(resolveEnclosingGitRoot(nested), resolveEnclosingGitRoot(root));
  const nonGit = mkdtempSync(path.join(os.tmpdir(), "metis-no-git-"));
  assert.equal(resolveEnclosingGitRoot(nonGit), null);
});

test("unbound and unauthenticated stops do not create files", async () => {
  const root = project();
  const detached = () => ({ protocol: "metis.continuation.v1", decision: "DETACHED", reasonCode: "NO_BINDING" });
  const response = await processHookEvent(event(root), { host: "claude", inspect: detached });
  assert.deepEqual(response, {});
  assert.equal(existsSync(path.join(root, ".metis")), false);
  assert.deepEqual(await processHookEvent(event(root), { host: "claude", inspect: detached }), {});
  assert.equal(existsSync(path.join(root, ".metis", "continuation-delivery")), false);
});

test("bound stop invokes the injected core projection and writes only delivery metadata", async () => {
  const root = project();
  bind(root);
  let calls = 0;
  const response = await processHookEvent(event(root), {
    host: "claude",
    inspect: (actualRoot, options) => {
      calls += 1;
      assert.equal(actualRoot, resolveEnclosingGitRoot(root));
      assert.deepEqual(options, { host: "claude", sessionId: "session-1" });
      return snapshot("CONTINUE");
    }
  });
  assert.equal(calls, 1);
  assert.equal(response.decision, "block");
  const delivery = path.join(root, ".metis", "continuation-delivery");
  assert.equal(existsSync(delivery), true);
  const files = readFileSync(path.join(delivery, (await import("node:fs")).readdirSync(delivery)[0]), "utf8");
  assert.match(files, /"bindingId":"binding-1"/u);
  assert.doesNotMatch(files, /last_assistant_message|secret|token/u);
});

test("Codex repeats same turn through bounded no-progress instead of silent success", async () => {
  const root = project();
  bind(root, { host: "codex" });
  let calls = 0;
  const inspect = () => { calls += 1; return snapshot("CONTINUE"); };
  const base = event(root, { host: "codex", turn_id: "turn-1" });
  assert.equal((await processHookEvent(base, { host: "codex", inspect })).decision, "block");
  assert.equal((await processHookEvent(base, { host: "codex", inspect })).decision, "block");
  assert.match((await processHookEvent(base, { host: "codex", inspect })).systemMessage, /paused continuation/i);
  assert.deepEqual(await processHookEvent({ ...base, turn_id: "turn-2" }, { host: "codex", inspect }), {});
  assert.equal(calls, 4);
});

test("Codex same turn with changed state remains deliverable", async () => {
  const root = project();
  bind(root, { host: "codex" });
  let revision = 0;
  const inspect = () => snapshot("CONTINUE", { revision: ++revision, stateFingerprint: `state-${revision}` });
  const base = event(root, { host: "codex", turn_id: "turn-1" });
  assert.equal((await processHookEvent(base, { host: "codex", inspect })).decision, "block");
  assert.equal((await processHookEvent(base, { host: "codex", inspect })).decision, "block");
});

test("StopFailure and SessionEnd suppress later delivery until binding rebind", async () => {
  const root = project();
  bind(root);
  const inspect = () => snapshot("CONTINUE");
  assert.deepEqual(await processHookEvent(event(root, { hook_event_name: "StopFailure" }), { host: "claude", inspect }), {});
  assert.deepEqual(await processHookEvent(event(root), { host: "claude", inspect }), {});
  bind(root, { bindingId: "binding-2" });
  assert.equal((await processHookEvent(event(root), { host: "claude", inspect: () => snapshot("CONTINUE", { bindingId: "binding-2" }) })).decision, "block");
});

test("same revision reaches bounded PAUSE instead of an unbounded block loop", async () => {
  const root = project();
  bind(root);
  const inspect = () => snapshot("CONTINUE");
  const responses = [];
  for (let i = 0; i < 4; i += 1) responses.push(await processHookEvent(event(root, { turn_id: `turn-${i}` }), { host: "claude", inspect }));
  assert.equal(responses[0].decision, "block");
  assert.equal(responses[1].decision, "block");
  assert.match(responses[2].systemMessage, /paused continuation/i);
  assert.deepEqual(responses[3], {});
});

test("malformed and oversized stdin are silent no-ops", async () => {
  const output = { value: "", write(value) { this.value += value; } };
  await runCli({ input: { async *[Symbol.asyncIterator]() { yield "x".repeat(MAX_INPUT_BYTES + 1); } }, output, host: "claude" });
  assert.equal(output.value, "{}\n");
  const malformed = { value: "", write(value) { this.value += value; } };
  await runCli({ input: { async *[Symbol.asyncIterator]() { yield "not-json"; } }, output: malformed, host: "claude" });
  assert.equal(malformed.value, "{}\n");
});

test("SessionStart context discloses only safe host/session activation context", async () => {
  const root = project();
  const response = await processHookEvent({
    hook_event_name: "SessionStart",
    session_id: "session-1",
    cwd: root
  }, { host: "claude", sessionStartContext: true });
  assert.equal(response.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(response.hookSpecificOutput.additionalContext, /session-1/u);
  assert.doesNotMatch(JSON.stringify(response), /last_assistant_message|controller_token/u);
});
