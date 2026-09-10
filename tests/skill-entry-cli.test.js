import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { installAdapters } from "../src/adapters/install.js";
import { jsonIo, makeProject } from "./helpers.js";

async function resolve(root, input) {
  const io = jsonIo();
  const code = await main(["entry", "resolve", `--input=${input}`, "--root", root], io);
  return { code, value: JSON.parse(io.stdoutText || io.stderrText) };
}

test("entry resolve works outside Git and never initializes project state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-entry-"));
  for (const [input, expected] of [
    ["", { mode: "status", objective: null, documentPath: null }],
    ['prd "새 검색 기능"', { mode: "prd", objective: "새 검색 기능", documentPath: null }],
    ['plan @"docs/my prd.md"', { mode: "plan", objective: null, documentPath: "docs/my prd.md" }],
    ["run", { mode: "run", objective: null, documentPath: null }],
    ["resume", { mode: "resume", objective: null, documentPath: null }],
    ['"plan"', { mode: "execute", objective: "plan", documentPath: null }]
  ]) {
    const result = await resolve(root, input);
    assert.equal(result.code, 0, JSON.stringify(result.value));
    assert.deepEqual(result.value, expected);
    assert.deepEqual(readdirSync(root), []);
  }
});

test("invalid entry syntax and flags fail before initialization", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-entry-invalid-"));
  for (const args of [
    ["entry", "resolve"],
    ["entry", "run", "--input=run"],
    ["entry", "resolve", "extra", "--input=run"],
    ["entry", "resolve", "--input=run", "--force"],
    ["entry", "resolve", "--input=run extra"],
    ["entry", "resolve", '--input=plan "unfinished']
  ]) {
    const io = jsonIo();
    assert.equal(await main([...args, "--root", root], io), 1);
    assert.ok(JSON.parse(io.stderrText).error.code);
    assert.deepEqual(readdirSync(root), []);
  }
});

test("entry resolve treats shell substitutions as text", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-entry-literal-"));
  const input = "검색 수정 $(touch should-not-exist); `whoami`";
  const result = await resolve(root, input);
  assert.equal(result.code, 0);
  assert.equal(result.value.objective, input);
  assert.deepEqual(readdirSync(root), []);
});

test("installed launchers include entry routing references and templates for all hosts", () => {
  const { root, db } = makeProject();
  try {
    const installed = installAdapters(root, ["codex", "claude", "opencode"], false);
    for (const tree of [
      ".agents/skills/metis", "plugins/metis/skills/metis",
      ".claude/skills/metis", ".opencode/skills/metis",
      ".agents/metis/runtime/skills/metis"
    ]) {
      for (const file of ["references/entrypoints.md", "references/prd.md", "references/planning.md", "templates/prd.md", "templates/plan.md", "templates/decision.md"]) {
        assert.ok(readFileSync(path.join(root, tree, file), "utf8").length > 0);
      }
    }
    const result = JSON.parse(execFileSync(process.execPath, [
      "--no-warnings", installed.runtime.launcher, "entry", "resolve", "--input=resume"
    ], { cwd: root, encoding: "utf8" }));
    assert.deepEqual(result, { mode: "resume", objective: null, documentPath: null });
    const documents = JSON.parse(execFileSync(process.execPath, [
      "--no-warnings", installed.runtime.launcher, "goal", "prd", "--title", "Installed document fixture",
      "--file", path.join(root, ".agents/skills/metis/templates/prd.md")
    ], { cwd: root, encoding: "utf8" }));
    assert.match(documents.prd, /^docs\/metis\/installed-document-fixture-[0-9a-f]{12}\/prd\.md$/u);
    assert.match(readFileSync(path.join(root, documents.prd), "utf8"), /TEMPLATE NOT COMPLETE/);
    assert.equal(documents.runCreated, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 0);
  } finally {
    db.close();
  }
});
