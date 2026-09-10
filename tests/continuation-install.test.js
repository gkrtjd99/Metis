import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  installAdapters,
  installContinuationHooks,
  uninstallAdapters,
  uninstallContinuationHooks
} from "../src/adapters/install.js";
import { makeProject } from "./helpers.js";

function installBase(root, host) {
  installAdapters(root, [host]);
  const runner = path.join(root, ".agents/metis/runtime/src/adapters/continuation-hook.js");
  mkdirSync(path.dirname(runner), { recursive: true });
  writeFileSync(runner, "#!/usr/bin/env node\n", { mode: 0o755 });
}

function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}

test("Claude continuation installation merges settings and preserves unknown hooks", () => {
  const { root, db } = makeProject();
  try {
    installBase(root, "claude");
    const settingsPath = path.join(root, ".claude/settings.json");
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      customSetting: { keep: true },
      hooks: {
        Stop: [{ matcher: "manual", hooks: [{ type: "command", command: "user-stop" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-prompt" }] }]
      }
    }, null, 2));

    const result = installContinuationHooks(root, { host: "claude" });
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.installed.length, 4);
    const settings = readJson(root, ".claude/settings.json");
    assert.deepEqual(settings.customSetting, { keep: true });
    assert.equal(settings.hooks.Stop.length, 2);
    assert.equal(settings.hooks.Stop[0].matcher, "manual");
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, "user-prompt");
    assert.match(settings.hooks.Stop[1].hooks[0].command, /--host 'claude'/);
    assert.match(settings.hooks.SessionStart[0].hooks[0].command, /continuation-hook\.js/);

    const duplicate = installContinuationHooks(root, { host: "claude" });
    assert.equal(duplicate.installed.length, 0);
    assert.equal(duplicate.conflicts.length, 0);
    assert.equal(duplicate.preserved.length, 4);
    assert.equal(readJson(root, ".claude/settings.json").hooks.Stop.length, 2);
  } finally {
    db.close();
  }
});

test("continuation install is transactional when a later event is malformed", () => {
  const { root, db } = makeProject();
  try {
    installBase(root, "claude");
    const settingsPath = path.join(root, ".claude/settings.json");
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify({ hooks: { SessionStart: { malformed: true } } }, null, 2)}\n`);
    const beforeSettings = readFileSync(settingsPath, "utf8");
    const beforeManifest = readFileSync(path.join(root, ".agents/metis/install-manifest.json"), "utf8");
    const result = installContinuationHooks(root, { host: "claude" });
    assert.equal(result.installed.length, 0);
    assert.ok(result.conflicts.some((item) => item.event === "SessionStart"));
    assert.equal(readFileSync(settingsPath, "utf8"), beforeSettings);
    assert.equal(readFileSync(path.join(root, ".agents/metis/install-manifest.json"), "utf8"), beforeManifest);
  } finally {
    db.close();
  }
});

test("normal adapter reinstall retains continuation ownership", () => {
  const { root, db } = makeProject();
  try {
    installBase(root, "claude");
    installContinuationHooks(root, { host: "claude" });
    installAdapters(root, ["claude"]);
    const removed = uninstallContinuationHooks(root, { host: "claude" });
    assert.equal(removed.conflicts.length, 0);
    assert.equal(removed.installed.length, 4);
  } finally {
    db.close();
  }
});

test("uninstall removes a settings file created solely for continuation hooks", () => {
  const { root, db } = makeProject();
  try {
    installBase(root, "claude");
    installContinuationHooks(root, { host: "claude" });
    const result = uninstallContinuationHooks(root, { host: "claude" });
    assert.equal(result.conflicts.length, 0);
    assert.equal(existsSync(path.join(root, ".claude/settings.json")), false);
  } finally {
    db.close();
  }
});

test("Codex continuation installation uses the 0.153.4 native JSON hook shape", () => {
  const { root, db } = makeProject();
  try {
    installBase(root, "codex");
    const hooksPath = path.join(root, ".codex/hooks.json");
    mkdirSync(path.dirname(hooksPath), { recursive: true });
    writeFileSync(hooksPath, JSON.stringify({
      description: "keep this",
      hooks: {
        Stop: [{ matcher: "existing", hooks: [{ type: "command", command: "user-stop", extra: true }] }]
      }
    }, null, 2));
    const result = installContinuationHooks(root, { host: "codex" });
    assert.equal(result.conflicts.length, 0);
    const hooks = readJson(root, ".codex/hooks.json");
    assert.equal(hooks.description, "keep this");
    assert.equal(hooks.hooks.Stop.length, 2);
    assert.equal(hooks.hooks.Stop[0].hooks[0].extra, true);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].type, "command");
    assert.match(hooks.hooks.Stop[1].hooks[0].command, /--no-warnings/);
    assert.match(hooks.hooks.Stop[1].hooks[0].command, /--host 'codex'/);
  } finally {
    db.close();
  }
});

test("modified later managed event aborts continuation install transaction", () => {
  const { root, db } = makeProject();
  try {
    installBase(root, "claude");
    installContinuationHooks(root, { host: "claude" });
    const settingsPath = path.join(root, ".claude/settings.json");
    const manifestPath = path.join(root, ".agents/metis/install-manifest.json");
    const settings = readJson(root, ".claude/settings.json");
    settings.hooks.SessionEnd[0].hooks[0].command = "user-modified-session-end";
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const beforeSettings = readFileSync(settingsPath, "utf8");
    const beforeManifest = readFileSync(manifestPath, "utf8");
    const result = installContinuationHooks(root, { host: "claude", force: true });
    assert.equal(result.installed.length, 0);
    assert.ok(result.conflicts.some((item) => item.event === "SessionEnd"));
    assert.equal(readFileSync(settingsPath, "utf8"), beforeSettings);
    assert.equal(readFileSync(manifestPath, "utf8"), beforeManifest);
  } finally {
    db.close();
  }
});

test("modified managed commands are preserved and uninstall removes only exact owned hooks", () => {
  const { root, db } = makeProject();
  try {
    installBase(root, "claude");
    const first = installContinuationHooks(root, { host: "claude" });
    assert.equal(first.conflicts.length, 0);
    const settingsPath = path.join(root, ".claude/settings.json");
    const settings = readJson(root, ".claude/settings.json");
    const managedStop = settings.hooks.Stop[0];
    managedStop.hooks[0].command = "user-modified-command";
    managedStop.hooks.push({ type: "command", command: "user-added-to-managed-group" });
    settings.unrelated = { survive: true };
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    const reinstall = installContinuationHooks(root, { host: "claude", force: true });
    assert.ok(reinstall.conflicts.some((item) => item.event === "Stop"));
    assert.equal(readJson(root, ".claude/settings.json").hooks.Stop[0].hooks[0].command, "user-modified-command");

    const removed = uninstallContinuationHooks(root, { host: "claude" });
    assert.ok(removed.conflicts.some((item) => item.event === "Stop"));
    const afterConflict = readJson(root, ".claude/settings.json");
    assert.equal(afterConflict.unrelated.survive, true);
    assert.equal(afterConflict.hooks.Stop[0].hooks[0].command, "user-modified-command");
    assert.equal(afterConflict.hooks.SessionStart.length, 1);
    assert.match(afterConflict.hooks.SessionStart[0].hooks[0].command, /continuation-hook\.js/);
  } finally {
    db.close();
  }
});

test("uninstall removes exact owned fragments while retaining user hooks and settings", () => {
  const { root, db } = makeProject();
  try {
    installBase(root, "codex");
    installContinuationHooks(root, { host: "codex" });
    const hooksPath = path.join(root, ".codex/hooks.json");
    const hooks = readJson(root, ".codex/hooks.json");
    hooks.hooks.Stop[0].custom = { preserved: true };
    hooks.hooks.Stop[0].hooks.push({ type: "command", command: "user-stop" });
    writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);

    const result = uninstallContinuationHooks(root, { host: "codex" });
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.installed.length, 2);
    const after = readJson(root, ".codex/hooks.json");
    assert.deepEqual(after.hooks.Stop[0].custom, { preserved: true });
    assert.equal(after.hooks.Stop.length, 1);
    assert.equal(after.hooks.Stop[0].hooks.length, 1);
    assert.equal(after.hooks.Stop[0].hooks[0].command, "user-stop");
    assert.equal(after.hooks.SessionStart, undefined);
  } finally {
    db.close();
  }
});

test("normal adapter uninstall refuses while continuation ownership is active", () => {
  const { root, db } = makeProject();
  try {
    installBase(root, "claude");
    installContinuationHooks(root, { host: "claude" });
    const result = uninstallAdapters(root, ["all"], { dryRun: true });
    assert.equal(result.applied, false);
    assert.ok(result.conflicts.some((item) => item.host === "claude"));
    assert.equal(readJson(root, ".claude/settings.json").hooks.Stop.length, 1);
  } finally {
    db.close();
  }
});
