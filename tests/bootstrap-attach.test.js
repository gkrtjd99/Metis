import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { init } from "../src/index.js";
import { main } from "../src/cli.js";
import { routeLifecycle } from "../src/core/project-bootstrap.js";
import { resolveProjectRoot } from "../src/core/project-bootstrap.js";
import { startRun } from "../src/core/state.js";
import { jsonIo, makeProject } from "./helpers.js";

function nonGitProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-attach-nongit-"));
  writeFileSync(path.join(root, "package.json"), "{}\n");
  return root;
}

test("mutable attachment rejects a non-Git root before creating runtime or host files", async () => {
  const root = nonGitProject();

  await assert.rejects(() => init({ root, host: "codex" }), (error) => error?.code === "GIT_REQUIRED");
  assert.equal(existsSync(path.join(root, ".metis")), false);
  assert.equal(existsSync(path.join(root, ".codex")), false);

  const io = jsonIo();
  const code = await main(["init", "--root", root], io);
  assert.equal(code, 1);
  assert.match(`${io.stdoutText}${io.stderrText}`, /GIT_REQUIRED/u);
  assert.equal(existsSync(path.join(root, ".metis")), false);
});

test("malformed config fails before attachment mutation", async () => {
  const root = nonGitProject();
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(path.join(root, "package.json"), "{}\n");
  mkdirSync(path.join(root, ".metis"), { recursive: true });
  writeFileSync(path.join(root, ".metis", "config.json"), "{ malformed\n");

  await assert.rejects(() => init({ root, host: "codex" }));
  assert.equal(existsSync(path.join(root, ".codex")), false);
  assert.equal(existsSync(path.join(root, ".agents")), false);
  assert.equal(existsSync(path.join(root, ".metis", "state")), false);
});

test("lifecycle preflight fails before attachment mutation", async () => {
  const root = nonGitProject();
  execFileSync("git", ["init", "-q"], { cwd: root });
  const state = path.join(root, ".metis", "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "state.db"), "not a sqlite database\n");

  await assert.rejects(() => init({ root, host: "codex" }));
  assert.equal(existsSync(path.join(root, ".codex")), false);
  assert.equal(existsSync(path.join(root, ".agents")), false);
});

test("automatic attach keeps force disabled", async () => {
  const { root, db } = makeProject();
  try {
    await init({ root, host: "codex" });
    const role = path.join(root, ".codex", "agents", "metis-worker.toml");
    const custom = "name = \"project-owned-worker\"\n";
    writeFileSync(role, custom);

    const io = jsonIo();
    const code = await main(["attach", "--root", root, "--host", "codex"], io);
    assert.equal(code, 0, io.stderrText);
    assert.equal(readFileSync(role, "utf8"), custom);
  } finally {
    db.close();
  }
});

test("CLI init --force replaces a modified managed host file", async () => {
  const { root, db } = makeProject();
  try {
    await init({ root, host: "codex" });
    const role = path.join(root, ".codex", "agents", "metis-worker.toml");
    writeFileSync(role, "name = \"project-owned-worker\"\n");

    const io = jsonIo();
    const code = await main(["init", "--root", root, "--host", "codex", "--force"], io);
    assert.equal(code, 0, io.stderrText);
    assert.notEqual(readFileSync(role, "utf8"), "name = \"project-owned-worker\"\n");
  } finally {
    db.close();
  }
});

test("attachment installs missing adapters without replacing modified managed files", async () => {
  const { root, db } = makeProject();
  try {
    const role = path.join(root, ".codex", "agents", "metis-worker.toml");
    const custom = "name = \"metis-worker\"\ndescription = \"project-owned override\"\n";
    const result = await init({ root, host: "codex" });

    assert.equal(result.installed.preserved.some((item) => item.path === ".codex/agents/metis-worker.toml"), false);
    writeFileSync(role, custom);
    const second = await init({ root, host: "codex" });
    assert.equal(readFileSync(role, "utf8"), custom);
    assert.ok(second.installed.preserved.some((item) => item.path === ".codex/agents/metis-worker.toml"));
    assert.equal(existsSync(path.join(root, "plugins/metis/commands/metis.md")), true);
  } finally {
    db.close();
  }
});

test("repeated attachment is idempotent until managed install state changes", async () => {
  const { root, db } = makeProject();
  try {
    await init({ root, host: "codex" });
    const manifestPath = path.join(root, ".agents/metis/install-manifest.json");
    const firstManifest = readFileSync(manifestPath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 10));

    await init({ root, host: "codex" });
    assert.equal(readFileSync(manifestPath, "utf8"), firstManifest);

    rmSync(path.join(root, "plugins/metis/commands/metis.md"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await init({ root, host: "codex" });
    assert.notEqual(readFileSync(manifestPath, "utf8"), firstManifest);
    assert.equal(existsSync(path.join(root, "plugins/metis/commands/metis.md")), true);
  } finally {
    db.close();
  }
});

test("lifecycle routing reports every controller lane without automatic takeover", () => {
  const { root, config, db } = makeProject();
  try {
    assert.equal(routeLifecycle({ projectRoot: root, db }).route, "no-run");
    const started = startRun(db, root, config, "Attach lifecycle routing");
    assert.equal(routeLifecycle({ projectRoot: root, db }).route, "active-live-controller");

    db.prepare("UPDATE runs SET controller_expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", started.run.id);
    const expired = routeLifecycle({ projectRoot: root, db });
    assert.equal(expired.route, "active-expired-controller");
    assert.equal(expired.automaticTakeover, false);
    assert.equal(expired.takeoverRequired, true);

    db.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(started.run.id);
    assert.equal(routeLifecycle({ projectRoot: root, db }).route, "paused");
    db.prepare("UPDATE runs SET status = 'completed', phase = 'complete' WHERE id = ?").run(started.run.id);
    assert.equal(routeLifecycle({ projectRoot: root, db }).route, "completed");
  } finally {
    db.close();
  }
});

test("enclosing Git top-level is selected for an implicit root", () => {
  const { root, db } = makeProject();
  db.close();
  const nested = path.join(root, "nested");
  mkdirSync(nested);
  assert.equal(realpathSync(resolveProjectRoot({ cwd: nested }).projectRoot), realpathSync(root));
});
