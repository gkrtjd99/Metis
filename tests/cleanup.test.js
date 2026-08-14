import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { installAdapters, uninstallAdapters } from "../src/adapters/install.js";
import { cleanRuntime, resetRuntime } from "../src/core/maintenance.js";
import { makeProject } from "./helpers.js";

test("cache cleanup removes only disposable runtime data", () => {
  const { root, db } = makeProject();
  try {
    for (const name of ["cache", "tmp", "logs", "worktrees"]) {
      const directory = path.join(root, ".metis", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "file"), "temporary");
    }
    writeFileSync(path.join(root, ".metis", "generated", "index.json"), "{}\n");
    writeFileSync(path.join(root, ".metis", "benchmarks", "benchmark.json"), "{}\n");

    const result = cleanRuntime(db, root, {
      scopes: ["cache"],
      keepContexts: 5,
      worktreeMaxAgeMinutes: 0
    });

    assert.deepEqual(new Set(result.removedDirectories), new Set(["cache", "tmp", "logs"]));
    assert.ok(existsSync(path.join(root, ".metis", "state", "state.db")));
    assert.ok(existsSync(path.join(root, ".metis", "generated", "index.json")));
    assert.ok(existsSync(path.join(root, ".metis", "benchmarks", "benchmark.json")));
    assert.equal(existsSync(path.join(root, ".metis", "worktrees", "file")), false);
  } finally {
    db.close();
  }
});

test("cleanup dry-run reports candidates without changing files", () => {
  const { root, db } = makeProject();
  try {
    const cacheFile = path.join(root, ".metis", "cache", "entry");
    writeFileSync(cacheFile, "cache");
    const result = cleanRuntime(db, root, { scopes: ["all"], dryRun: true, worktreeMaxAgeMinutes: 0 });
    assert.equal(result.dryRun, true);
    assert.ok(result.areas.some((area) => area.area === "cache" && area.candidateFiles === 1));
    assert.equal(readFileSync(cacheFile, "utf8"), "cache");
  } finally {
    db.close();
  }
});

test("uninstall removes owned assets but preserves shared user configuration", () => {
  const { root, db } = makeProject();
  try {
    const marketplaceFile = path.join(root, ".agents", "plugins", "marketplace.json");
    mkdirSync(path.dirname(marketplaceFile), { recursive: true });
    writeFileSync(marketplaceFile, JSON.stringify({
      name: "existing",
      plugins: [{ name: "other", source: { source: "local", path: "./other" } }]
    }, null, 2));
    const exclude = path.join(root, ".git", "info", "exclude");
    writeFileSync(exclude, "user-pattern\n");

    installAdapters(root, ["codex"], false);
    assert.ok(existsSync(path.join(root, ".agents", "metis", "install-manifest.json")));
    assert.ok(existsSync(path.join(root, "plugins", "metis")));

    const result = uninstallAdapters(root, ["all"]);
    assert.equal(result.statePreserved, true);
    assert.equal(result.applied, true);
    assert.equal(existsSync(path.join(root, "plugins", "metis")), false);
    assert.equal(existsSync(path.join(root, ".agents", "skills", "metis")), false);
    assert.equal(existsSync(path.join(root, ".agents", "metis")), false);
    assert.equal(existsSync(path.join(root, ".codex", "config.toml")), false);

    const marketplace = JSON.parse(readFileSync(marketplaceFile, "utf8"));
    assert.deepEqual(marketplace.plugins.map((item) => item.name), ["other"]);
    const excludeText = readFileSync(exclude, "utf8");
    assert.match(excludeText, /user-pattern/);
    assert.doesNotMatch(excludeText, /metis/);
  } finally {
    db.close();
  }
  const reset = resetRuntime(root);
  assert.deepEqual(reset.removed, [".metis/"]);
  assert.equal(existsSync(path.join(root, ".metis")), false);
});

test("partial uninstall preserves common runtime for remaining hosts", () => {
  const { root, db } = makeProject();
  try {
    installAdapters(root, ["codex", "claude"], false);
    uninstallAdapters(root, ["codex"]);
    assert.ok(existsSync(path.join(root, ".agents", "metis", "install-manifest.json")));
    assert.ok(existsSync(path.join(root, ".claude", "skills", "metis", "SKILL.md")));
    assert.equal(existsSync(path.join(root, "plugins", "metis")), false);
    const manifest = JSON.parse(readFileSync(path.join(root, ".agents", "metis", "install-manifest.json"), "utf8"));
    assert.deepEqual(manifest.hosts, ["claude"]);
  } finally {
    db.close();
  }
});

test("uninstall preserves modified managed files until force is explicit", () => {
  const { root, db } = makeProject();
  try {
    installAdapters(root, ["codex"], false);
    const managed = path.join(root, ".agents", "skills", "metis", "SKILL.md");
    writeFileSync(managed, "user-modified skill\n");

    const blocked = uninstallAdapters(root, ["all"]);
    assert.equal(blocked.applied, false);
    assert.equal(blocked.preflight, true);
    assert.ok(blocked.conflicts.some((item) => item.path === ".agents/skills/metis/SKILL.md"));
    assert.equal(readFileSync(managed, "utf8"), "user-modified skill\n");
    assert.ok(existsSync(path.join(root, ".agents", "metis", "install-manifest.json")));

    const forced = uninstallAdapters(root, ["all"], { forceModified: true });
    assert.equal(forced.applied, true);
    const backup = forced.backups.find((item) => item.path === ".agents/skills/metis/SKILL.md");
    assert.ok(backup);
    assert.equal(readFileSync(path.join(root, backup.backupPath), "utf8"), "user-modified skill\n");
    assert.equal(existsSync(managed), false);
  } finally {
    db.close();
  }
});

test("uninstall dry-run does not change installed files", () => {
  const { root, db } = makeProject();
  try {
    installAdapters(root, ["codex"], false);
    const managed = path.join(root, ".agents", "skills", "metis", "SKILL.md");
    const before = readFileSync(managed, "utf8");
    const result = uninstallAdapters(root, ["all"], { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.applied, false);
    assert.equal(existsSync(managed), true);
    assert.equal(readFileSync(managed, "utf8"), before);
  } finally {
    db.close();
  }
});

test("benchmark cleanup removes benchmark rows and their unreferenced objects", () => {
  const { root, db } = makeProject();
  try {
    const objectDir = path.join(root, ".metis", "objects", "aa");
    mkdirSync(objectDir, { recursive: true });
    const objectFile = path.join(objectDir, "result.json.gz");
    writeFileSync(objectFile, "compressed-result");
    db.prepare(`
      INSERT INTO objects(hash, kind, path, bytes, compressed_bytes, created_at)
      VALUES('aaaaaaaa', 'benchmark:test', 'objects/aa/result.json.gz', 100, 17, '2026-01-01T00:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO benchmark_runs(
        id, name, variant, scenario, status, duration_ms, verification_status,
        changed_files, input_tokens, output_tokens, result_ref, created_at
      ) VALUES('bench_cleanup', 'cleanup', 'candidate', 'case', 'completed', 1, 'passed', 0, 1, 1, 'obj_aaaaaaaa', '2026-01-01T00:00:00.000Z')
    `).run();
    writeFileSync(path.join(root, ".metis", "benchmarks", "report.json"), "{}\n");

    const result = cleanRuntime(db, root, { scopes: ["benchmarks"] });
    assert.equal(result.benchmarkRuns.removed, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM benchmark_runs").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM objects WHERE hash = 'aaaaaaaa'").get().count, 0);
    assert.equal(existsSync(objectFile), false);
    assert.equal(existsSync(path.join(root, ".metis", "benchmarks", "report.json")), false);
  } finally {
    db.close();
  }
});


test("reset removes registered runtime Git worktrees before deleting state", () => {
  const { root, db } = makeProject();
  const worktree = path.join(root, ".metis", "worktrees", "manual");
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: root, stdio: "ignore" });
    assert.ok(existsSync(worktree));
    const preview = resetRuntime(root, { dryRun: true });
    assert.ok(preview.worktreeCandidates.includes(worktree));
    assert.ok(existsSync(worktree));
  } finally {
    db.close();
  }
  const result = resetRuntime(root);
  assert.ok(result.removedWorktrees.includes(worktree));
  assert.equal(existsSync(path.join(root, ".metis")), false);
  const listing = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
  assert.doesNotMatch(listing, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("reset preserves runtime state when Git refuses a locked worktree", () => {
  const { root, db } = makeProject();
  const worktree = path.join(root, ".metis", "worktrees", "locked");
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["worktree", "lock", worktree], { cwd: root, stdio: "ignore" });
    assert.throws(() => resetRuntime(root), (error) => error.code === "WORKTREE_REMOVE_FAILED");
    assert.ok(existsSync(path.join(root, ".metis")));
    assert.ok(existsSync(worktree));
  } finally {
    db.close();
    execFileSync("git", ["worktree", "unlock", worktree], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "ignore" });
  }
});
