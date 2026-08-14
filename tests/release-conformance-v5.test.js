import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { transaction } from "../src/core/db.js";
import {
  CONFIG_VERSION,
  PHASES,
  ROLES,
  RUNTIME_LAYOUT_VERSION,
  SCHEMA_VERSION
} from "../src/core/metadata.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(readFileSync(path.join(root, relative), "utf8"));
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
function filesBelow(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesBelow(item));
    else if (entry.isFile()) output.push(item);
  }
  return output;
}

test("generated reference and structural validation stay current", () => {
  execFileSync(process.execPath, ["scripts/generate-reference.mjs", "--check"], { cwd: root, stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/validate.mjs"], { cwd: root, stdio: "pipe" });
});

test("release manifests use the canonical 1.0.0 metadata", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.author, "Austin");
  assert.equal(pkg.engines.node, ">=22.16.0");
  assert.deepEqual(pkg.os, ["darwin", "linux"]);
  assert.deepEqual(pkg.bin, { metis: "src/cli.js" });
  assert.equal(pkg.repository.url, "git+https://github.com/gkrtjd99/Metis.git");
  assert.equal(pkg.bugs.url, "https://github.com/gkrtjd99/Metis/issues");
  assert.equal(pkg.homepage, "https://github.com/gkrtjd99/Metis#readme");
  assert.equal(pkg.scripts.prepublishOnly, "npm run check");
  assert.match(read("CHANGELOG.md"), /^## 1\.0\.0 - 2026-08-14$/m);
  assert.equal(readJson(".codex-plugin/plugin.json").version, pkg.version);
  assert.equal(readJson(".claude-plugin/plugin.json").version, pkg.version);
  assert.equal(readJson("adapters/claude/.claude-plugin/plugin.json").version, pkg.version);
  assert.equal(readJson(".codex-plugin/plugin.json").author.name, pkg.author);
  assert.equal(readJson(".claude-plugin/plugin.json").author.name, pkg.author);
  assert.equal(readJson("adapters/claude/.claude-plugin/plugin.json").author.name, pkg.author);
  assert.equal(SCHEMA_VERSION, 11);
  assert.equal(CONFIG_VERSION, 6);
  assert.equal(RUNTIME_LAYOUT_VERSION, 4);
  assert.equal(PHASES.length, 10);
  assert.equal(ROLES.length, 21);
});

test("nested transactions use a savepoint and preserve the outer transaction", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE values_log (value TEXT NOT NULL)");
  try {
    transaction(db, () => {
      db.prepare("INSERT INTO values_log VALUES (?)").run("outer-before");
      assert.throws(() => transaction(db, () => {
        db.prepare("INSERT INTO values_log VALUES (?)").run("inner-rolled-back");
        throw new Error("rollback nested transaction");
      }), /rollback nested transaction/u);
      db.prepare("INSERT INTO values_log VALUES (?)").run("outer-after");
    });
    assert.deepEqual(db.prepare("SELECT value FROM values_log ORDER BY rowid").all().map((row) => ({ ...row })), [
      { value: "outer-before" },
      { value: "outer-after" }
    ]);
  } finally {
    db.close();
  }
});

test("each host surface self-attaches with a concrete supported host", () => {
  const surfaces = [
    "commands/metis.md",
    "skills/metis/SKILL.md",
    "adapters/claude/commands/metis.md",
    "adapters/claude/skills/metis/SKILL.md",
    "adapters/opencode/.opencode/commands/metis.md",
    "adapters/opencode/.opencode/skills/metis/SKILL.md"
  ];
  for (const file of surfaces) {
    const content = read(file);
    for (const host of ["codex", "claude", "opencode"]) {
      assert.match(content, new RegExp(`attach --host ${host}\\b`, "u"), file);
    }
    assert.doesNotMatch(content, /current-host/u, file);
  }
});

test("managed-goal capabilities stay internal while model configuration has its own skill", () => {
  const discoverable = filesBelow(path.join(root, "skills/metis"))
    .filter((file) => path.basename(file) === "SKILL.md")
    .map((file) => path.relative(root, file))
    .sort();
  assert.deepEqual(discoverable, ["skills/metis/SKILL.md"]);
  assert.match(read("skills/model/SKILL.md"), /\$metis:model/);
  assert.match(read("skills/model/SKILL.md"), /Do not estimate or display cost/);
});

test("packed archive contains the 1.0.0 orchestration and runs public entrypoint and CLI smoke", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "metis-release-"));
  try {
    const output = execFileSync("npm", ["pack", "--json", "--pack-destination", tempRoot], {
      cwd: root,
      env: { ...process.env, npm_config_cache: path.join(tempRoot, "npm-cache"), npm_config_dry_run: "false" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const [result] = JSON.parse(output);
    const archive = path.join(tempRoot, result.filename);
    assert.ok(existsSync(archive), `npm pack did not create ${result.filename}`);

    const extractedRoot = path.join(tempRoot, "extracted");
    mkdirSync(extractedRoot);
    execFileSync("tar", ["-xzf", archive, "-C", extractedRoot], { stdio: "pipe" });
    const packedRoot = path.join(extractedRoot, "package");
    assert.ok(existsSync(path.join(packedRoot, "src/index.js")), "Packed archive is missing the public entrypoint");
    const files = new Set(result.files.map((item) => item.path));
    for (const expected of [
      "CHANGELOG.md",
      "docs/REFERENCE.md",
      "scripts/chromium-browser-verifier.mjs",
      "skills/metis/capabilities/browser-testing/CAPABILITY.md",
      "skills/model/SKILL.md",
      "skills/model/agents/openai.yaml",
      "src/core/browser.js",
      "src/core/ownership.js",
      "src/core/task-packets.js",
      "src/core/prompt-protocols.js",
      "src/core/interfaces.js",
      "src/core/plan-ingest.js",
      "agents/metis-task-compiler.toml",
      "agents/metis-synthesizer.toml",
      "agents/metis-diagnostician.toml"
    ]) assert.ok(files.has(expected), `Packed archive is missing ${expected}`);
    assert.equal([...files].some((file) => file.startsWith("tests/")), false, "Packed archive includes development tests");
    for (const excluded of [
      "docs/PERFORMANCE_OPTIMIZATION_PROMPT.md",
      "docs/VERIFICATION.md",
      "release/README.md",
      "scripts/generate-reference.mjs",
      "scripts/validate.mjs"
    ]) assert.equal(files.has(excluded), false, `Packed archive includes development file ${excluded}`);

    const publicEntrySmoke = "const entry = await import('./package/src/index.js'); if (typeof entry.init !== 'function') throw new Error('public init export missing');";
    execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", publicEntrySmoke], {
      cwd: extractedRoot,
      stdio: "pipe"
    });
    const help = execFileSync(process.execPath, [path.join(packedRoot, "src/cli.js"), "--help"], {
      cwd: extractedRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    assert.match(help, /Metis CLI/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("release documentation has one cleanup, layout, phase, and role truth", () => {
  const documentation = ["README.md", "docs/README.ko.md", "docs/ARCHITECTURE.md", "docs/OPERATIONS.md", "docs/VERIFICATION.md"]
    .map(read)
    .join("\n");
  assert.doesNotMatch(documentation, /metis-api-reviewer|metis-operations-reviewer/u);
  assert.doesNotMatch(documentation, /\.metis\/state\.db\b/u);
  assert.doesNotMatch(documentation, /metis clean[^\n]*--apply/u);
  assert.match(documentation, /\.metis\/state\/state\.db/u);
  assert.match(documentation, /ten phases|10개 phase/i);
});
