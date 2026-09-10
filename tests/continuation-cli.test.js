import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { jsonIo, makeProject } from "./helpers.js";

function gitProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-continuation-cli-"));
  writeFileSync(path.join(root, "package.json"), "{}\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "package.json"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd: root });
  return root;
}

async function runCli(root, args, expectedCode = 0) {
  const io = jsonIo();
  const code = await main([...args, "--root", root, "--pretty"], io);
  const text = io.stdoutText.trim() || io.stderrText.trim();
  const value = text ? JSON.parse(text) : null;
  assert.equal(code, expectedCode, JSON.stringify(value));
  return { code, value, io };
}

async function initializedRun() {
  const project = makeProject();
  project.db.close();
  await runCli(project.root, ["init", "--host", "claude"]);
  const started = await runCli(project.root, [
    "start", "Continue a native host session", "--host", "claude",
    "--controller-session", "controller-session-1", "--controller-owner", "test-owner"
  ]);
  return { root: project.root, controller: started.value.controller, run: started.value.run };
}

function projectWithSpacePath() {
  const project = makeProject();
  project.db.close();
  const root = `${project.root} with spaces`;
  renameSync(project.root, root);
  return { ...project, root };
}

function controllerFlags(controller, token = controller.token) {
  return [
    "--controller-session", controller.sessionId,
    "--controller-owner", controller.owner,
    "--controller-token", token,
    "--controller-fence", String(controller.fencingToken)
  ];
}

test("continuation inspect with no binding does not initialize runtime state", async () => {
  const root = gitProject();
  assert.equal(existsSync(path.join(root, ".metis")), false);

  const result = await runCli(root, [
    "continuation", "inspect", "--host", "claude", "--session-id", "native-session-1"
  ]);

  assert.deepEqual(result.value, {
    protocol: "metis.continuation.v1",
    decision: "DETACHED",
    reasonCode: "NO_BINDING",
    runId: null,
    bindingId: null,
    revision: null
  });
  assert.equal(existsSync(path.join(root, ".metis")), false);
});

test("invalid continuation command fails without initialization", async () => {
  const root = gitProject();
  const result = await runCli(root, ["continuation", "not-a-command", "--host", "claude"], 1);

  assert.equal(result.value.error.code, "CONTINUATION_COMMAND");
  assert.equal(existsSync(path.join(root, ".metis")), false);
});

test("CLI continuation bind authenticates a distinct native session and requires explicit inactive evidence", async () => {
  const { root, controller, run } = await initializedRun();
  const nativeSessionId = "native-session-1";
  assert.notEqual(nativeSessionId, controller.sessionId);

  const missingInactive = await runCli(root, [
    "continuation", "bind", "--host", "claude", "--session-id", "native-session-without-confirmation",
    "--evidence", "native goal is explicitly inactive",
    ...controllerFlags(controller)
  ], 1);
  assert.equal(missingInactive.value.error.code, "CONTINUATION_NATIVE_GOAL_ACTIVE");

  const inactive = await runCli(root, [
    "continuation", "bind", "--host", "claude", "--session-id", nativeSessionId,
    "--native-goal-inactive", "--evidence", "native goal is explicitly inactive",
    ...controllerFlags(controller)
  ]);
  assert.equal(inactive.value.runId, run.id);
  assert.equal(inactive.value.host, "claude");
  assert.equal(inactive.value.sessionId, nativeSessionId);
  assert.equal(inactive.value.controllerSessionId, controller.sessionId);

  const inspected = await runCli(root, [
    "continuation", "inspect", "--host", "claude", "--session-id", nativeSessionId
  ]);
  assert.equal(inspected.value.decision, "CONTINUE");
  assert.equal(inspected.value.runId, run.id);
  assert.equal(JSON.stringify(inspected.value).includes(controller.token), false);

  const wrongAuth = await runCli(root, [
    "continuation", "bind", "--host", "claude", "--session-id", "unauthenticated-session",
    "--native-goal-inactive", "--evidence", "native goal is explicitly inactive",
    ...controllerFlags(controller, "wrong-token")
  ], 1);
  assert.equal(wrongAuth.value.error.code, "CONTROLLER_FENCED");
});

test("paused inspect with a null revision still reaches a visible safe hook response", async () => {
  const { root, controller } = await initializedRun();
  const sessionId = "native-session-invalid-state";
  await runCli(root, [
    "continuation", "bind", "--host", "claude", "--session-id", sessionId,
    "--native-goal-inactive", "--evidence", "native goal is explicitly inactive",
    ...controllerFlags(controller)
  ]);

  writeFileSync(path.join(root, ".metis/config.json"), "not-json\n");
  const inspected = await runCli(root, [
    "continuation", "inspect", "--host", "claude", "--session-id", sessionId
  ]);
  assert.equal(inspected.value.decision, "PAUSE");
  assert.equal(inspected.value.reasonCode, "STATE_UNREADABLE");
  assert.equal(inspected.value.revision, null);
  assert.equal(JSON.stringify(inspected.value).includes(controller.token), false);

  const runtimeHook = path.join(root, ".agents/metis/runtime/src/adapters/continuation-hook.js");
  const hookOutput = execFileSync(process.execPath, ["--no-warnings", runtimeHook, "--host", "claude"], {
    cwd: root,
    input: `${JSON.stringify({
      hook_event_name: "Stop",
      session_id: sessionId,
      cwd: root,
      stop_hook_active: false
    })}\n`,
    encoding: "utf8"
  });
  const response = JSON.parse(hookOutput);
  assert.notDeepEqual(response, {});
  assert.equal(typeof response.systemMessage, "string");
  assert.ok(response.systemMessage.length > 0);
  assert.equal(JSON.stringify(response).includes(controller.token), false);
});

test("CLI rebind rotates binding identity and detach removes the authenticated session", async () => {
  const { root, controller } = await initializedRun();
  const args = [
    "continuation", "bind", "--host", "claude", "--session-id", "native-session-2",
    "--native-goal-inactive", "--evidence", "native goal is explicitly inactive",
    ...controllerFlags(controller)
  ];
  const first = await runCli(root, args);
  const second = await runCli(root, [...args, "--rebind"]);
  assert.notEqual(second.value.bindingId, first.value.bindingId);

  const detached = await runCli(root, [
    "continuation", "detach", "--host", "claude", "--session-id", "native-session-2",
    ...controllerFlags(controller)
  ]);
  assert.equal(detached.value.detached, true);
  assert.equal(detached.value.bindingId, second.value.bindingId);
  const inspected = await runCli(root, [
    "continuation", "inspect", "--host", "claude", "--session-id", "native-session-2"
  ]);
  assert.equal(inspected.value.decision, "DETACHED");
  assert.equal(inspected.value.reasonCode, "NO_BINDING");
});

test("CLI continuation install/uninstall uses copied runtime and the installed hook executes", async () => {
  const project = projectWithSpacePath();
  const { root } = project;
  await runCli(root, ["init", "--host", "claude"]);

  const installed = await runCli(root, ["continuation", "install", "--host", "claude"]);
  assert.equal(installed.value.conflicts.length, 0);
  assert.equal(installed.value.installed.length, 4);
  const runtimeHook = path.join(root, ".agents/metis/runtime/src/adapters/continuation-hook.js");
  assert.equal(existsSync(runtimeHook), true);
  const settingsPath = path.join(root, ".claude/settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const hookCommand = settings.hooks.Stop[0].hooks[0].command;
  assert.match(hookCommand, /continuation-hook\.js/u);
  assert.match(hookCommand, /--host 'claude'/u);

  const hookOutput = execFileSync("/bin/sh", ["-c", hookCommand], {
    cwd: root,
    input: `${JSON.stringify({
      hook_event_name: "Stop",
      session_id: "unbound-native-session",
      cwd: root,
      stop_hook_active: false
    })}\n`,
    encoding: "utf8"
  });
  assert.deepEqual(JSON.parse(hookOutput), {});

  const uninstalled = await runCli(root, ["continuation", "uninstall", "--host", "claude"]);
  assert.equal(uninstalled.value.conflicts.length, 0);
  assert.equal(uninstalled.value.installed.length, 4);
  if (existsSync(settingsPath)) assert.doesNotMatch(readFileSync(settingsPath, "utf8"), /continuation-hook\.js/u);
});
