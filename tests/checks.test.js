import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { listChecks, registerCheck, registerDetectedChecks, runChecks } from "../src/core/checks.js";
import { freezeGoalContract } from "../src/core/contracts.js";
import { addInvariant, getInvariant } from "../src/core/governance.js";
import { startRun } from "../src/core/state.js";
import { makeProject, nodeCommand } from "./helpers.js";

test("detect without a name registers all detected checks with their existing defaults", () => {
  const { root, config, db } = makeProject();
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "node --test", build: "tsc" } }));
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = 'fixture'\n");
    const { run } = startRun(db, root, config, "Detect all checks");
    const checks = registerDetectedChecks(db, root, run.id);
    assert.deepEqual(checks.map(({ name, required }) => ({ name, required })), [
      { name: "lint", required: true },
      { name: "test", required: true },
      { name: "build", required: true },
      { name: "cargo-test", required: true },
      { name: "cargo-clippy", required: false }
    ]);
    assert.equal(listChecks(db, run.id).length, 5);
  } finally {
    db.close();
  }
});

test("named detection preserves unrelated checks and never downgrades an existing required check", () => {
  const { root, config, db } = makeProject();
  try {
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = 'fixture'\n");
    const { run } = startRun(db, root, config, "Detect one check");
    const unrelated = registerCheck(db, run.id, { name: "cargo-test", command: nodeCommand(["-e", "process.exit(0)"]) });
    const custom = registerCheck(db, run.id, { name: "custom-required", command: nodeCommand(["-e", "process.exit(0)"]) });
    const selected = registerDetectedChecks(db, root, run.id, { name: "cargo-clippy" });
    assert.deepEqual(selected.map(({ name, required }) => ({ name, required })), [{ name: "cargo-clippy", required: false }]);
    registerCheck(db, run.id, { name: "cargo-clippy", command: selected[0].command, required: true });
    const repeated = registerDetectedChecks(db, root, run.id, { name: "cargo-clippy" });
    assert.equal(repeated[0].required, true);
    assert.equal(repeated[0].id, selected[0].id);
    const checks = listChecks(db, run.id);
    assert.equal(checks.length, 3);
    assert.deepEqual(checks.find((check) => check.name === unrelated.name), unrelated);
    assert.deepEqual(checks.find((check) => check.name === custom.name), custom);
  } finally {
    db.close();
  }
});

test("선택 재탐지는 요구사항·불변식 연결과 실행 후 검증 증거를 보존한다", () => {
  const { root, config, db } = makeProject();
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const { run } = startRun(db, root, config, "선택 재탐지의 계약 연결 보존");
    freezeGoalContract(db, root, run.id, {
      objective: "선택 재탐지의 계약 연결 보존",
      scope: ["package.json"],
      constraints: ["기존 검증 연결을 유지한다"],
      successCriteria: ["선택한 check의 성공 결과가 연결된 계약에 반영된다"],
      complexity: "standard",
      requirements: [{
        id: "REQ-CHECK-LINKS",
        title: "검증 연결 유지",
        description: "선택 재탐지 후에도 check가 요구사항 검증 증거를 생성한다.",
        kind: "functional",
        priority: "must",
        acceptance: ["선택한 check의 성공 결과가 연결된 계약에 반영된다"]
      }]
    });
    const invariant = addInvariant(db, root, run.id, {
      title: "선택 재탐지 후 불변식 검증 유지",
      requirementIds: ["REQ-CHECK-LINKS"]
    });
    const [detected] = registerDetectedChecks(db, root, run.id, { name: "test" });
    const linked = registerCheck(db, run.id, {
      name: detected.name,
      command: detected.command,
      requirementIds: ["REQ-CHECK-LINKS"],
      invariantIds: [invariant.id]
    });
    const [repeated] = registerDetectedChecks(db, root, run.id, { name: "test" });
    assert.equal(repeated.id, linked.id);
    assert.deepEqual(repeated.requirementIds, linked.requirementIds);
    assert.deepEqual(repeated.invariantIds, linked.invariantIds);
    const [result] = runChecks(db, root, run.id, config, { name: "test" });
    assert.equal(result.status, "passed", result.preview);
    const trace = db.prepare(`
      SELECT status, evidence_refs_json FROM trace_links
      WHERE run_id = ? AND requirement_id = ? AND target_type = 'check'
        AND target_id = ? AND relation = 'verified-by'
    `).get(run.id, "REQ-CHECK-LINKS", linked.id);
    assert.equal(trace?.status, "current");
    assert.equal(JSON.parse(trace.evidence_refs_json)[0].checkId, linked.id);
    const verified = getInvariant(db, invariant.id);
    assert.equal(verified.status, "verified");
    assert.equal(verified.verificationRefs[0].checkId, linked.id);
  } finally {
    db.close();
  }
});

test("unknown, inexact, and empty detection names fail without mutating checks or the run", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startRun(db, root, config, "Reject invalid check names");
    registerCheck(db, run.id, { name: "custom-required", command: nodeCommand(["-e", "process.exit(0)"]) });
    const beforeChecks = listChecks(db, run.id);
    const beforeRun = db.prepare("SELECT * FROM runs WHERE id = ?").get(run.id);
    for (const name of ["unknown", "TEST", " test", "test ", "", "  ", true, null]) {
      const code = typeof name === "string" && name.trim() ? "CHECK_NOT_FOUND" : "CHECK_NAME";
      assert.throws(() => registerDetectedChecks(db, root, run.id, { name }), (error) => error.code === code);
      assert.deepEqual(listChecks(db, run.id), beforeChecks);
      assert.deepEqual(db.prepare("SELECT * FROM runs WHERE id = ?").get(run.id), beforeRun);
    }
  } finally {
    db.close();
  }
});

test("a verification command that mutates source-of-truth files does not pass", () => {
  const { root, config, db } = makeProject();
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    const { run } = startRun(db, root, config, "Detect mutating verification");
    registerCheck(db, run.id, {
      name: "mutating-check",
      command: nodeCommand(["-e", "require('fs').writeFileSync('src/generated.js','export const generated = true;\\n')"]),
      required: true
    });
    const result = runChecks(db, root, run.id, config)[0];
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, "failed");
    assert.deepEqual(result.mutatedPaths, ["src/generated.js"]);
    assert.match(result.preview, /changed source-of-truth files/i);
  } finally {
    db.close();
  }
});

test("a non-mutating successful verification command passes", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startRun(db, root, config, "Run clean verification");
    registerCheck(db, run.id, {
      name: "clean-check",
      command: nodeCommand(["-e", "process.exit(0)"]),
      required: true
    });
    const result = runChecks(db, root, run.id, config)[0];
    assert.equal(result.status, "passed");
    assert.deepEqual(result.mutatedPaths, []);
  } finally {
    db.close();
  }
});
