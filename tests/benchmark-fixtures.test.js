import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { builtInBenchmarkContract, builtInBenchmarkPrompt, prepareBaselineObservation, prepareBuiltInBenchmarkFixture, solveBuiltInBenchmarkFixture, verifyBuiltInBenchmarkFixture } from "../src/core/benchmark-fixtures.js";
import { selectLifecycleProfile } from "../src/core/contracts.js";

const scenarios = [
  "trivial-local-change",
  "four-slice-standard-change",
  "eight-slice-standard-change",
  "shared-interface-change",
  "reasoning-failure",
  "transient-failure",
  "contract-failure",
  "codex-host",
  "claude-host"
];

function fixture(name) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "metis-built-in-fixture-test-"));
  const prepared = prepareBuiltInBenchmarkFixture(workspace, name);
  return { workspace, prepared };
}

test("all required benchmark scenarios materialize deterministic git-ready projects", async (t) => {
  for (const name of scenarios) {
    await t.test(name, async () => {
      const { workspace, prepared } = fixture(name);
      try {
        assert.equal(prepared.scenario, name);
        assert.ok(prepared.prompt.includes("Run the supplied verifier"));
        assert.equal(prepared.verify.length, 1);
        assert.equal(prepared.verify[0].cwd, workspace);
        assert.equal(prepared.verify[0].args.at(-1), name);
        const result = await verifyBuiltInBenchmarkFixture(workspace, name);
        assert.equal(result.passed, false, "baseline must fail until the bounded source change is made");
        assert.match(result.error, /incorrect|incomplete|failed|honor|return/);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
});

test("trivial fixture pins every deterministic fast-profile gate", () => {
  const prompt = builtInBenchmarkPrompt("trivial-local-change");
  assert.match(prompt, /complexity "trivial"/);
  assert.match(prompt, /exactly one functional must requirement/);
  assert.match(prompt, /lifecycleProfile "fast"/);
});

test("shared-interface fixture selects balanced and enforces its frozen interface hash", async () => {
  const contract = builtInBenchmarkContract("shared-interface-change");
  const selected = selectLifecycleProfile(contract, contract.complexity, contract.requirements, contract.scope);
  assert.equal(selected.lifecycleProfile, "balanced");
  assert.equal(selected.signals.sharedInterfaceDecision, true);
  assert.deepEqual(contract.scope, ["src/consumer-a.js", "src/consumer-b.js"]);
  assert.equal(contract.complexity, "standard");
  assert.deepEqual(contract.requirements.map((item) => [item.id, item.kind, item.priority]), [
    ["REQ-CONSUMER-A", "functional", "must"],
    ["REQ-CONSUMER-B", "functional", "must"]
  ]);
  assert.equal(contract.route.sharedInterfaceRequired, true);
  assert.match(builtInBenchmarkPrompt("shared-interface-change"), /sharedInterfaceRequired true/);

  const { workspace, prepared } = fixture("shared-interface-change");
  try {
    for (const file of prepared.metadata.mutableFiles) writeFileSync(path.join(workspace, file.path), file.expected);
    assert.equal((await verifyBuiltInBenchmarkFixture(workspace, "shared-interface-change")).passed, true);

    const interfaceRecord = path.join(workspace, "src/interface-contract.json");
    const original = readFileSync(interfaceRecord, "utf8");
    const tamperedRecord = JSON.parse(original);
    tamperedRecord.hash = "tampered";
    writeFileSync(interfaceRecord, `${JSON.stringify(tamperedRecord)}\n`);
    const tampered = await verifyBuiltInBenchmarkFixture(workspace, "shared-interface-change");
    assert.equal(tampered.passed, false);
    assert.match(tampered.error, /Immutable benchmark artifact/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("fresh benchmark fixtures prime Git worktree administration before the first add", () => {
  const { workspace } = fixture("trivial-local-change");
  const adminPath = path.resolve(workspace, execFileSync("git", ["rev-parse", "--git-path", "worktrees"], { cwd: workspace, encoding: "utf8" }).trim());
  const worktree = path.join(workspace, "fixture-first-worktree");
  try {
    assert.equal(existsSync(adminPath), true);
    execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: workspace, encoding: "utf8" });
    assert.equal(existsSync(worktree), true);
    execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: workspace, encoding: "utf8" });
    assert.equal(existsSync(worktree), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("verifier checks real behavior and ignores a forged success marker", async () => {
  const { workspace, prepared } = fixture("trivial-local-change");
  try {
    assert.match(prepared.prompt, /exactly one functional must requirement/);
    assert.match(prepared.prompt, /scope \["src\/value\.js"\]/);
    writeFileSync(path.join(workspace, ".metis-benchmark-result.json"), JSON.stringify({ scenario: "trivial-local-change", verified: true }));
    const baseline = await verifyBuiltInBenchmarkFixture(workspace, "trivial-local-change");
    assert.equal(baseline.passed, false);
    writeFileSync(path.join(workspace, "src/value.js"), "export function answer() { return 42; }\n");
    const passed = await verifyBuiltInBenchmarkFixture(workspace, "trivial-local-change");
    assert.equal(passed.passed, true);
    const cliResult = execFileSync(prepared.verifier.command, prepared.verifier.args, { cwd: workspace, encoding: "utf8" });
    assert.match(cliResult, /"verified":true/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tampering with immutable tests or policy input fails even when source behavior is correct", async () => {
  const { workspace } = fixture("reasoning-failure");
  try {
    writeFileSync(path.join(workspace, "src/retry-policy.js"), `export function planAttempts(input) {\n  if (input.failureClass === "reasoning") return { attempts: ["high", "xhigh", "max"] };\n  if (input.failureClass === "transient") return { attempts: ["high", "high"] };\n  return { attempts: ["high"], blindRetry: false, requiresDecision: true };\n}\n`);
    const okay = await verifyBuiltInBenchmarkFixture(workspace, "reasoning-failure");
    assert.equal(okay.passed, true);
    writeFileSync(path.join(workspace, "src/policy-input.json"), JSON.stringify({ failureClass: "reasoning", requestedEffort: "max", maxAttempts: 3 }) + "\n");
    const tamperedInput = await verifyBuiltInBenchmarkFixture(workspace, "reasoning-failure");
    assert.equal(tamperedInput.passed, false);
    writeFileSync(path.join(workspace, "src/policy-input.json"), JSON.stringify({ failureClass: "reasoning", requestedEffort: "high", maxAttempts: 3 }) + "\n");
    writeFileSync(path.join(workspace, "tests/policy.test.mjs"), readFileSync(path.join(workspace, "tests/policy.test.mjs"), "utf8").replace("policy is deterministic", "policy was tampered"));
    const tamperedTest = await verifyBuiltInBenchmarkFixture(workspace, "reasoning-failure");
    assert.equal(tamperedTest.passed, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("verification denies source modules permission to rewrite immutable artifacts", async () => {
  const { workspace } = fixture("reasoning-failure");
  try {
    const testFile = path.join(workspace, "tests/policy.test.mjs");
    const original = readFileSync(testFile, "utf8");
    writeFileSync(path.join(workspace, "src/retry-policy.js"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(testFile)}, "export default true;\\n");
      export function planAttempts() { return { attempts: ["high", "xhigh", "max"] }; }
    `);
    const result = await verifyBuiltInBenchmarkFixture(workspace, "reasoning-failure");
    assert.equal(result.passed, false);
    assert.equal(readFileSync(testFile, "utf8"), original);
    assert.match(result.error, /restricted|permission|denied|failed/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("deterministic policy and adapter probes apply the canonical bounded solution", async () => {
  for (const name of ["reasoning-failure", "transient-failure", "contract-failure", "codex-host", "claude-host"]) {
    const { workspace } = fixture(name);
    try {
      const solved = solveBuiltInBenchmarkFixture(workspace, name);
      assert.ok(solved.files.length > 0);
      assert.equal((await verifyBuiltInBenchmarkFixture(workspace, name)).passed, true);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  }
});

test("baseline observation extends only the controller liveness window", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "metis-baseline-observer-test-"));
  try {
    const runtime = path.join(workspace, ".metis");
    mkdirSync(runtime, { recursive: true });
    const original = { version: 5, host: "codex", controller: { leaseSeconds: 90, heartbeatSeconds: 30 }, orchestration: { maxConcurrent: 8 } };
    writeFileSync(path.join(runtime, "config.json"), JSON.stringify(original));
    const result = prepareBaselineObservation(workspace);
    const observed = JSON.parse(readFileSync(path.join(runtime, "config.json"), "utf8"));
    assert.equal(result.instrumentation, "controller-lease-only");
    assert.deepEqual(observed, { ...original, controller: { leaseSeconds: 600, heartbeatSeconds: 120 } });
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
