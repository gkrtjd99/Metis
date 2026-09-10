import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(os.tmpdir(), `metis-execution-policy-mutations-${Date.now()}-${process.pid}`);
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
chmodSync(evidenceRoot, 0o700);

const focusedTests = [
  "tests/plan-execution-scheduler.test.js",
  "tests/scheduler-diagnostics.test.js",
  "tests/fast-path-v2.test.js",
  "tests/execution-policy-mutations.test.js",
];
const testArgs = ["--no-warnings", "--test", ...focusedTests];

const mutations = [
  {
    id: "approval-preflight-guard",
    description: "approved execution setting drift guard",
    file: "src/core/scheduler.js",
    needle: `invariant(approval.pass, "PLAN_EXECUTION_SETTINGS_REAPPROVAL",\n      "실행 설정이 승인된 계획과 일치하지 않습니다. 계획 단계에서 다시 승인해야 합니다.", { taskId: task.id, reason: approval.reason });`,
    replacement: `invariant(true, "PLAN_EXECUTION_SETTINGS_REAPPROVAL",\n      "실행 설정이 승인된 계획과 일치하지 않습니다. 계획 단계에서 다시 승인해야 합니다.", { taskId: task.id, reason: approval.reason });`,
    tests: ["tests/plan-execution-scheduler.test.js"],
  },
  {
    id: "host-capacity-application",
    description: "project Codex host-capacity application",
    file: "src/core/scheduler.js",
    needle: "hostConcurrencyLimit(projectRoot, run.host, config.orchestration.maxConcurrent)",
    replacement: "Number(config.orchestration.maxConcurrent)",
    replaceAll: true,
    expectedReplacements: 2,
    tests: ["tests/scheduler-diagnostics.test.js"],
  },
  {
    id: "seal-rollback",
    description: "plan-seal transaction rollback",
    file: "src/core/tasks.js",
    needle: "return transaction(db, () => sealPlanInTransaction(db, runId, config, options));",
    replacement: "return sealPlanInTransaction(db, runId, config, options);",
    tests: ["tests/execution-policy-mutations.test.js"],
  },
];

function commandText(cwd, args) {
  return `cd ${JSON.stringify(cwd)} && ${process.execPath} ${args.map((arg) => JSON.stringify(arg)).join(" ")}`;
}

function classifyFailure({ status, error = null, signal = null, timedOut = false, output = "" }) {
  const syntaxOrImportFailure = /(?:SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|Cannot use import statement outside a module|Unexpected token)/u.test(output);
  const assertionFailure = /(?:AssertionError|ERR_ASSERTION)/u.test(output);
  const normalTestFailure = status === 1 && !error && !signal && timedOut !== true;
  return {
    syntaxOrImportFailure,
    assertionFailure,
    killed: normalTestFailure && assertionFailure && !syntaxOrImportFailure,
  };
}

function runOracleSelfTests() {
  assert.equal(classifyFailure({
    status: 1,
    output: "not ok 1 - runtime\nTypeError: broken implementation"
  }).killed, false, "TypeError must not count as a killed mutant");
  assert.equal(classifyFailure({
    status: 1,
    output: "not ok 1 - assertion\nAssertionError [ERR_ASSERTION]: expected guard"
  }).killed, true, "an assertion failure should count as killed");
  assert.equal(classifyFailure({
    status: 1,
    output: "SyntaxError: Unexpected token"
  }).killed, false, "syntax failures must not count as killed");
  assert.equal(classifyFailure({
    status: 1,
    error: { code: "ETIMEDOUT" },
    timedOut: true,
    output: "AssertionError: unreachable"
  }).killed, false, "timed-out runs must not count as killed");
  assert.equal(classifyFailure({
    status: 1,
    signal: "SIGTERM",
    output: "AssertionError: interrupted"
  }).killed, false, "signal-terminated runs must not count as killed");
}

function runTests(cwd, tests, label) {
  const args = ["--no-warnings", "--test", ...tests];
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 600_000,
    windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  writeFileSync(path.join(evidenceRoot, `${label}.stdout.log`), stdout, { mode: 0o600 });
  writeFileSync(path.join(evidenceRoot, `${label}.stderr.log`), stderr, { mode: 0o600 });
  const output = `${stdout}\n${stderr}`;
  const timedOut = result.error?.code === "ETIMEDOUT";
  const classification = classifyFailure({
    status: result.status,
    error: result.error ?? null,
    signal: result.signal ?? null,
    timedOut,
    output,
  });
  const passed = result.status === 0 && !result.error && !result.signal;
  return {
    label,
    command: commandText(cwd, args),
    status: result.status,
    signal: result.signal ?? null,
    timedOut,
    passed,
    ...classification,
    output,
  };
}

const snapshotAllowlist = [
  "package.json",
  "package-lock.json",
  "src",
  "skills/metis",
  "tests/helpers.js",
  ...focusedTests,
];

function snapshotRepository(destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  for (const relative of snapshotAllowlist) {
    const source = path.join(repositoryRoot, relative);
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, { recursive: true, force: false });
  }
}

function applyMutation(snapshot, mutation) {
  const target = path.join(snapshot, mutation.file);
  const before = readFileSync(target, "utf8");
  const occurrences = before.split(mutation.needle).length - 1;
  const expected = mutation.expectedReplacements ?? 1;
  if (occurrences !== expected) {
    throw new Error(`${mutation.id}: expected ${expected} occurrence(s) in ${mutation.file}, found ${occurrences}.`);
  }
  const after = mutation.replaceAll
    ? before.replaceAll(mutation.needle, mutation.replacement)
    : before.replace(mutation.needle, mutation.replacement);
  writeFileSync(target, after);
}

runOracleSelfTests();
console.log("mutation oracle self-tests: PASS");
console.log(`증거와 disposable snapshot은 삭제하지 않고 ${evidenceRoot}에 보존합니다.`);
console.log(`기준선 명령: ${commandText(repositoryRoot, testArgs)}`);
const baseline = runTests(repositoryRoot, focusedTests, "baseline");
if (!baseline.passed) {
  console.error("BASELINE FAIL: mutant 검사를 진행하지 않습니다.");
  console.error(`기준선 로그: ${evidenceRoot}/baseline.stdout.log, ${evidenceRoot}/baseline.stderr.log`);
  process.exitCode = 1;
} else {
  console.log("BASELINE PASS");
  for (const mutation of mutations) {
    const snapshot = path.join(evidenceRoot, mutation.id, "snapshot");
    mkdirSync(path.dirname(snapshot), { recursive: true });
    snapshotRepository(snapshot);
    applyMutation(snapshot, mutation);
    const result = runTests(snapshot, mutation.tests, mutation.id);
    const expectedCommand = commandText(snapshot, ["--no-warnings", "--test", ...mutation.tests]);
    console.log(`mutant ${mutation.id}: ${result.killed ? "KILLED" : result.passed ? "ALIVE" : "INVALID"}`);
    console.log(`  command: ${expectedCommand}`);
    console.log(`  logs: ${evidenceRoot}/${mutation.id}.stdout.log, ${evidenceRoot}/${mutation.id}.stderr.log`);
    if (!result.killed) {
      process.exitCode = 1;
      if (result.syntaxOrImportFailure) console.error("  syntax/import failure는 killed로 세지 않습니다.");
      else if (result.timedOut) console.error("  test execution timed out.");
      else console.error("  검증 assertion 실패가 관찰되지 않았습니다.");
    }
  }
}
