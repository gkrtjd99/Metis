import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { createGoalPrd, goalSlug, inspectGoalDocuments } from "../src/core/goal-documents.js";
import { restoreGoalContext } from "../src/core/goal-recovery.js";
import { freezeGoalContract } from "../src/core/contracts.js";
import { putArtifact, startRun } from "../src/core/state.js";
import { openDatabase } from "../src/core/db.js";
import { jsonIo, makeProject } from "./helpers.js";

function bareRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-goal-docs-"));
  execFileSync("git", ["init", "-q", root]);
  return root;
}

function fixture(sourcePath = null) {
  const f = makeProject();
  const documents = createGoalPrd(f.root, "Original goal", "# Original PRD\nREQ-001\n");
  const { run } = startRun(f.db, f.root, f.config, "Do not derive a folder from this", { planOnly: true });
  const source = putArtifact(f.db, f.root, run.id, "prd", "# Original PRD\nREQ-001\n", { path: sourcePath ?? documents.prd });
  freezeGoalContract(f.db, f.root, run.id, {
    objective: "Bound goal", scope: ["src/local.js"], successCriteria: ["Preserve folder binding"],
    requirements: [{ title: "Restore folder", acceptance: ["Preserve folder binding"] }],
    route: { sourceDocument: { artifactId: source.id, contentRef: source.content_ref } }
  });
  return { ...f, documents, run, source };
}

test("goal slug is deterministic, Unicode-aware, bounded, and never a path", () => {
  assert.equal(goalSlug("  Café\nfeature  "), goalSlug("Café feature"));
  assert.notEqual(goalSlug("a/b"), goalSlug("a b"));
  assert.notEqual(goalSlug("목표 하나"), goalSlug("목표 둘"));
  for (const title of ["../../escape", "/tmp/out", "$(touch bad); `whoami`", "목표", "a".repeat(1000)]) {
    assert.match(goalSlug(title), /^[a-z0-9][a-z0-9-]{0,60}$/u);
  }
  assert.throws(() => goalSlug("  "), { code: "GOAL_DOCUMENT_TITLE" });
});

test("goal prd CLI creates exactly one PRD without DB/config/installation/run bootstrap", async () => {
  const root = bareRoot();
  try {
    const input = path.join(root, "input.md");
    writeFileSync(input, "# Approved draft\n");
    const io = jsonIo();
    assert.equal(await main(["goal", "prd", "--root", root, "--title", "../A goal", "--file", input], io), 0, io.stderrText);
    const result = JSON.parse(io.stdoutText);
    assert.equal(result.runCreated, false);
    assert.equal(readFileSync(path.join(root, result.prd), "utf8"), "# Approved draft\n");
    assert.deepEqual(readdirSync(path.join(root, result.directory)), ["prd.md"]);
    assert.deepEqual(readdirSync(root).sort(), [".git", "docs", "input.md"]);
    const duplicate = jsonIo();
    assert.equal(await main(["goal", "prd", "--root", root, "--title", "../A goal", "--file", input], duplicate), 1);
    assert.equal(JSON.parse(duplicate.stderrText).error.code, "GOAL_DOCUMENT_EXISTS");
    assert.equal(readdirSync(path.join(root, "docs/metis")).length, 1);
    assert.equal(existsSync(path.join(root, ".metis")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI rejects unsupported paths/flags, missing input/title and non-Git roots without bootstrap", async () => {
  const root = bareRoot();
  const outside = mkdtempSync(path.join(os.tmpdir(), "metis-goal-no-git-"));
  try {
    const input = path.join(root, "input.md");
    writeFileSync(input, "# Draft");
    for (const args of [
      ["--file", input], ["--title", "Goal"],
      ["--title", "Goal", "--file", input, "--path", "../escape"],
      ["--title", "Goal", "--file", input, "--force"],
      ["extra", "--title", "Goal", "--file", input]
    ]) {
      const io = jsonIo();
      assert.equal(await main(["goal", "prd", "--root", root, ...args], io), 1);
      assert.equal(existsSync(path.join(root, "docs")), false);
    }
    const io = jsonIo();
    assert.equal(await main(["goal", "prd", "--root", outside, "--title", "Goal", "--file", input], io), 1);
    assert.deepEqual(readdirSync(outside), []);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("occupied directory and existing PRD are preserved without automatic suffix", () => {
  const root = bareRoot();
  try {
    const directory = path.join(root, "docs/metis", goalSlug("Same"));
    mkdirSync(directory, { recursive: true });
    assert.throws(() => createGoalPrd(root, "Same", "new"), { code: "GOAL_DOCUMENT_EXISTS" });
    writeFileSync(path.join(directory, "prd.md"), "user content");
    assert.throws(() => createGoalPrd(root, "Same", "new"), { code: "GOAL_DOCUMENT_EXISTS" });
    assert.equal(readFileSync(path.join(directory, "prd.md"), "utf8"), "user content");
    assert.deepEqual(readdirSync(path.join(root, "docs/metis")), [goalSlug("Same")]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all descendant symlinks, including dangling links, and wrong file kinds fail closed", () => {
  for (const relative of ["docs", "docs/metis", `docs/metis/${goalSlug("Goal")}`, ...["prd.md", "plan.md", "decisions.md"].map((name) => `docs/metis/${goalSlug("Goal")}/${name}`)]) {
    for (const dangling of [false, true]) {
      const root = bareRoot();
      const outside = mkdtempSync(path.join(os.tmpdir(), "metis-goal-link-"));
      try {
        const target = path.join(root, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        symlinkSync(dangling ? path.join(outside, "missing") : outside, target);
        assert.throws(() => createGoalPrd(root, "Goal", "body"), { code: "GOAL_DOCUMENT_UNSAFE_PATH" });
        assert.deepEqual(readdirSync(outside), []);
      } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
    }
  }
  const root = bareRoot();
  try {
    writeFileSync(path.join(root, "docs"), "not a directory");
    assert.throws(() => createGoalPrd(root, "Goal", "body"), { code: "GOAL_DOCUMENT_UNSAFE_PATH" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("document inspection rejects traversal, absolute paths, backslashes, and hardlinks", () => {
  const root = bareRoot();
  try {
    for (const relative of ["../prd.md", "/docs/metis/a/prd.md", "docs/metis/../prd.md", "docs\\metis\\a\\prd.md", "docs/metis/a/plan.md"]) {
      assert.throws(() => inspectGoalDocuments(root, relative), { code: "GOAL_DOCUMENT_PATH" });
    }
    const docs = createGoalPrd(root, "Goal", "body");
    linkSync(path.join(root, docs.prd), path.join(root, docs.plan));
    assert.throws(() => inspectGoalDocuments(root, docs.prd), { code: "GOAL_DOCUMENT_UNSAFE_PATH" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("DB reopen restores the same bound folder without reading edited/deleted PRD or creating summaries", () => {
  const f = fixture();
  let db = f.db;
  try {
    writeFileSync(path.join(f.root, f.documents.prd), "different mutable source");
    let restored = restoreGoalContext(db, f.root, f.run.id, f.config);
    assert.equal(restored.documents.prd, f.documents.prd);
    assert.equal(restored.documents.status, "bound");
    unlinkSync(path.join(f.root, f.documents.prd));
    db.close(); db = openDatabase(f.root);
    restored = restoreGoalContext(db, f.root, f.run.id, f.config);
    assert.equal(restored.documents.directory, f.documents.directory);
    assert.equal(restored.documents.existing.prd, false);
    assert.equal(restored.documents.existing.plan, false);
    assert.equal(restored.documents.existing.decisions, false);
    assert.equal(restored.originalRequest.sourceDocument.contentRef, f.source.content_ref);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 1);
    assert.deepEqual(readdirSync(path.join(f.root, f.documents.directory)), []);
    rmSync(path.join(f.root, f.documents.directory), { recursive: true });
    assert.equal(restoreGoalContext(db, f.root, f.run.id, f.config).documents.existing.directory, false);
    assert.equal(existsSync(path.join(f.root, f.documents.directory)), false);
  } finally { db.close(); }
});

test("legacy/external source and source-free run remain unbound without guessing folders", () => {
  for (const sourcePath of ["docs/legacy.md", "/tmp/external-prd.md", "docs/metis/../escape/prd.md"]) {
    const f = fixture(sourcePath);
    try {
      assert.deepEqual(restoreGoalContext(f.db, f.root, f.run.id, f.config).documents, { status: "unbound", reason: "legacy-or-external-source-path" });
    } finally { f.db.close(); }
  }
  const f = makeProject();
  try {
    const { run } = startRun(f.db, f.root, f.config, "Small goal");
    assert.deepEqual(restoreGoalContext(f.db, f.root, run.id, f.config).documents, { status: "unbound", reason: "no-source-document" });
    assert.equal(existsSync(path.join(f.root, "docs/metis")), false);
  } finally { f.db.close(); }
});

test("bound source artifact path cannot be rewritten in place", () => {
  const f = fixture();
  try {
    assert.throws(() => putArtifact(f.db, f.root, f.run.id, "prd", "same", { id: f.source.id, path: "docs/metis/other/prd.md" }), { code: "GOAL_SOURCE_PATH_IMMUTABLE" });
    assert.equal(restoreGoalContext(f.db, f.root, f.run.id, f.config).documents.prd, f.documents.prd);
  } finally { f.db.close(); }
});

test("unsafe bound folder stops restore without creating a new run or reading the link", () => {
  const f = fixture();
  try {
    symlinkSync("/nonexistent/metis-private", path.join(f.root, f.documents.plan));
    assert.throws(() => restoreGoalContext(f.db, f.root, f.run.id, f.config), { code: "GOAL_DOCUMENT_UNSAFE_PATH" });
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM context_snapshots").get().n, 0);
  } finally { f.db.close(); }
});
