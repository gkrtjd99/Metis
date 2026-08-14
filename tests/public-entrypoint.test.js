import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { init } from "../src/index.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

function emptyProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-public-entrypoint-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "public-entrypoint-fixture" }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "package.json"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd: root });
  return root;
}

test("public init initializes the explicitly supplied project root", async () => {
  const root = emptyProject();

  const result = await init({ root, host: "codex" });

  assert.equal(realpathSync(result.projectRoot), realpathSync(root));
  assert.ok(result.installed.installed.codex);
  assert.equal(result.config.host, "codex");
  assert.equal(existsSync(path.join(root, ".codex", "agents", "metis-scout.toml")), true);
});

test("public init discovers an enclosing Git top-level from cwd", async () => {
  const root = emptyProject();
  const nested = path.join(root, "nested");
  mkdirSync(nested);

  const result = await init({ cwd: nested, host: "codex" });

  assert.equal(realpathSync(result.projectRoot), realpathSync(root));
  assert.equal(result.rootSource, "git-top-level");
});

test("public init reports a missing root with the typed ROOT_REQUIRED error", async () => {
  await assert.rejects(
    () => init({ host: "codex", root: "" }),
    (error) => error?.code === "ROOT_REQUIRED"
  );
});

test("public init installs every host while keeping the config host as codex", async () => {
  const root = emptyProject();

  const result = await init({ root, host: "all" });

  assert.deepEqual(Object.keys(result.installed.installed).sort(), ["claude", "codex", "opencode"]);
  assert.equal(existsSync(path.join(root, ".claude", "commands", "metis.md")), true);
  assert.equal(existsSync(path.join(root, ".claude", "agents", "metis-scout.md")), true);
  assert.equal(existsSync(path.join(root, ".opencode", "commands", "metis.md")), true);
  assert.equal(existsSync(path.join(root, ".opencode", "agents", "metis-scout.md")), true);
  const config = JSON.parse(readFileSync(path.join(root, ".metis", "config.json"), "utf8"));
  assert.equal(config.host, "codex");
});

test("package main resolves to the public init facade", async () => {
  const packageJson = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));

  assert.equal(path.normalize(packageJson.main), path.join("src", "index.js"));
  assert.deepEqual(packageJson.exports, {
    ".": "./src/index.js",
    "./package.json": "./package.json"
  });
  const publicApi = await import(pathToFileURL(path.resolve(PACKAGE_ROOT, packageJson.main)).href);
  assert.equal(typeof publicApi.init, "function");
  assert.deepEqual(Object.keys(publicApi).sort(), ["assertSupportedNodeVersion", "attach", "init"]);
});

test("package exports reject unsupported internal module imports", async () => {
  await assert.rejects(
    import("metis-orchestrator/src/core/tasks.js"),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );
});

test("public facade keeps runtime loading lazy until init is called", () => {
  const source = readFileSync(path.join(PACKAGE_ROOT, "src/index.js"), "utf8");
  assert.doesNotMatch(source, /from ["']\.\/core\//u);
  assert.match(source, /await import\(["']\.\/core\/project-bootstrap\.js["']\)/u);
});

test("public init does not create database state or scan the repository", async () => {
  const root = emptyProject();

  await init({ root, host: "codex" });

  assert.equal(existsSync(path.join(root, ".metis", "state", "state.db")), false);
  assert.equal(existsSync(path.join(root, ".metis", "state.db")), false);
  assert.equal(existsSync(path.join(root, ".metis", "generated", "repository")), false);
});
