import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { attachProject, routeLifecycle } from "../src/core/project-bootstrap.js";
import { pauseRun, startRun } from "../src/core/state.js";
import { makeProject } from "./helpers.js";

function gitProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-bootstrap-"));
  writeFileSync(path.join(root, "package.json"), "{\"name\":\"bootstrap-fixture\"}\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "package.json"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd: root });
  return root;
}

test("attachment resolves an enclosing Git top-level and does not create DB state", () => {
  const root = gitProject();
  const nested = path.join(root, "nested");
  mkdirSync(nested);
  const result = attachProject({ cwd: nested, host: "codex" });

  assert.equal(result.projectRoot, realpathSync(root));
  assert.equal(result.rootSource, "git-top-level");
  assert.equal(result.lifecycle.route, "no-run");
  assert.equal(existsSync(path.join(root, ".metis", "state", "state.db")), false);
});

test("non-Git attachment fails before runtime or adapter mutation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-non-git-"));

  assert.throws(() => attachProject({ root, host: "codex" }), (error) => error?.code === "GIT_REQUIRED");
  assert.equal(existsSync(path.join(root, ".metis")), false);
  assert.equal(existsSync(path.join(root, ".agents")), false);
  assert.equal(existsSync(path.join(root, ".codex")), false);
});

test("CLI self-attach rejects a non-Git root before mutation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-cli-non-git-"));
  let stdout = "";
  let stderr = "";
  const status = await main(["init", "--root", root, "--host", "codex"], {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });

  assert.equal(status, 1);
  assert.match(`${stdout}${stderr}`, /GIT_REQUIRED/u);
  assert.equal(existsSync(path.join(root, ".metis")), false);
  assert.equal(existsSync(path.join(root, ".codex")), false);
});

test("forced attachment replaces modified managed host files", () => {
  const root = gitProject();
  attachProject({ root, host: "codex" });
  const role = path.join(root, ".codex", "agents", "metis-worker.toml");
  const modified = "name = \"project-owned-worker\"\n";
  writeFileSync(role, modified);

  const result = attachProject({ root, host: "codex", force: true });

  assert.notEqual(readFileSync(role, "utf8"), modified);
  assert.ok(result.installed.updated.some((item) => item === ".codex/agents/metis-worker.toml"));
});

test("lifecycle routing distinguishes no run, paused, completed, and controller lease state", () => {
  const empty = makeProject();
  assert.equal(routeLifecycle({ projectRoot: empty.root, db: empty.db }).route, "no-run");
  empty.db.close();

  const live = makeProject();
  const started = startRun(live.db, live.root, live.config, "live route");
  assert.ok(Date.parse(started.controller.expiresAt) - Date.now() >= 590_000, "controller lease must cover a normal multi-minute child turn");
  assert.equal(routeLifecycle({ projectRoot: live.root, db: live.db }).route, "active-live-controller");
  live.db.prepare("UPDATE runs SET controller_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(started.run.id);
  const expired = routeLifecycle({ projectRoot: live.root, db: live.db });
  assert.equal(expired.route, "active-expired-controller");
  assert.equal(expired.automaticTakeover, false);
  live.db.close();

  const paused = makeProject();
  const pausedRun = startRun(paused.db, paused.root, paused.config, "paused route");
  pauseRun(paused.db, pausedRun.run.id, "pause for routing");
  assert.equal(routeLifecycle({ projectRoot: paused.root, db: paused.db }).route, "paused");
  paused.db.close();

  const completed = makeProject();
  const completedRun = startRun(completed.db, completed.root, completed.config, "completed route");
  completed.db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(completedRun.run.id);
  assert.equal(routeLifecycle({ projectRoot: completed.root, db: completed.db }).route, "completed");
  completed.db.close();
});
