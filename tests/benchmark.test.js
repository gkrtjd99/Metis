import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BENCHMARK_ACCEPTANCE_TARGETS, BENCHMARK_MODEL, BENCHMARK_MODEL_ROLES, DEFAULT_BENCHMARK_SCENARIOS, DEFAULT_BENCHMARK_VARIANTS, benchmarkReport, candidateRuntimeContract, compareBenchmarkVariants, enforceBenchmarkModelConfig, evaluateBenchmarkAcceptance, initializeBenchmark, readWorkspaceModelEvidence, readWorkspaceRunMetrics, restoreBenchmarkModelConfig, runBenchmark, validateOuterMainReceipt } from "../src/core/benchmark.js";
import { addTask, getTask, markTaskAttemptSpawnAccepted, startTaskAttempt } from "../src/core/tasks.js";
import { recordUsageSample } from "../src/core/tokens.js";
import { SCHEMA_VERSION } from "../src/core/metadata.js";
import { readObject, storeObject } from "../src/core/objects.js";
import { sha256, stableStringify } from "../src/core/util.js";
import { forcePhase, makeProject, startTestRun } from "./helpers.js";

function outerLunaReceipt(workspace, observations = []) {
  const receipt = {
    schema: "benchmark.outer-main-receipt.v1",
    source: "benchmark.outer-runner.codex-startup-header",
    requestedModel: BENCHMARK_MODEL,
    headerModel: BENCHMARK_MODEL,
    metricsModel: observations.filter(Boolean).at(-1) ?? null,
    metricsModels: observations.filter(Boolean),
    metricsObservations: observations,
    metricsSampleCount: observations.length,
    conflict: false,
    verified: true,
    provenance: { command: "codex", provider: "openai", workspace: path.resolve(workspace), headerValid: true }
  };
  receipt.fingerprint = sha256(stableStringify(receipt));
  return receipt;
}

function officialBenchmarkCommits(root) {
  const baselineCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("git", ["commit", "--allow-empty", "-m", "benchmark candidate"], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
    stdio: "ignore"
  });
  const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { baselineCommit, candidateCommit };
}

async function assertProcessGone(pid, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} survived bounded cleanup polling`);
}

async function waitForFile(file, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`file ${file} was not created within ${timeoutMs}ms`);
}

async function killTestProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  await assertProcessGone(pid, 2000);
}


test("benchmark initialization isolates the Metis setup as an explicit variant step", () => {
  const { root, db } = makeProject();
  try {
    const commits = officialBenchmarkCommits(root);
    const initialized = initializeBenchmark(root, { name: "generated-eval", ...commits });
    const config = JSON.parse(readFileSync(initialized.file, "utf8"));
    const plain = config.variants.find((variant) => variant.name === "metis-pre-1.0-baseline");
    const metis = config.variants.find((variant) => variant.name === "metis-1.0.0-candidate");
    assert.ok(plain.setupByHost.codex.some((spec) => spec.command === "{node}" && spec.args.includes("init") && spec.args.includes("codex")));
    assert.ok(plain.setupByHost.codex.some((spec) => spec.args.includes("--prepare-baseline")));
    assert.equal(plain.instrumentation, "controller-lease-only");
    assert.ok(metis.setupByHost.codex.some((spec) => spec.command === "{node}" && spec.args.includes("init") && spec.args.includes("codex")));
    assert.equal(metis.command.command, "codex");
    assert.ok(metis.command.args.some((arg) => arg.includes("/goal $metis")));
    assert.equal(config.variants.find((variant) => variant.name === "plain-host").setup?.length ?? 0, 0);
    const codexCommands = config.variants.map((variant) => variant.commands.codex);
    assert.ok(codexCommands.every((command) => command.command === "codex"));
    assert.ok(codexCommands.every((command) => command.args.includes("--model") && command.args[command.args.indexOf("--model") + 1] === BENCHMARK_MODEL));
    assert.ok(codexCommands.every((command) => command.args.includes("--dangerously-bypass-approvals-and-sandbox")));
    assert.ok(codexCommands.every((command) => !command.args.includes("--approve-for-me")));
    assert.deepEqual(config.variants.find((variant) => variant.name === "plain-host").commands.codex.args.slice(3, 7), ["--dangerously-bypass-approvals-and-sandbox", "--ephemeral", "-C", "{workspace}"]);
    assert.deepEqual(config.variants.find((variant) => variant.name === "plain-host").commands.codex.args.slice(1, 3), ["--model", BENCHMARK_MODEL]);
    assert.equal(metis.commands.claude.command, "claude");
    assert.ok(metis.commands.claude.args.includes("--print"));
    assert.ok(metis.setupByHost.claude[0].args.includes("claude"));
  } finally {
    db.close();
  }
});

test("official benchmark comparison rejects a dirty or mismatched checkout before reporting", () => {
  const { root, db } = makeProject();
  try {
    const commits = officialBenchmarkCommits(root);
    writeFileSync(path.join(root, "uncommitted.txt"), "dirty\n");
    assert.throws(
      () => compareBenchmarkVariants(db, "release-eval", "metis-pre-1.0-baseline", "metis-1.0.0-candidate", {
        projectRoot: root,
        ...commits
      }),
      (error) => error.code === "BENCHMARK_DIRTY_REPOSITORY"
    );
  } finally {
    db.close();
  }
});

test("official benchmark comparison requires five config-bound repetitions per scenario", () => {
  const { root, db } = makeProject();
  try {
    writeFileSync(path.join(root, ".git", "info", "exclude"), ".metis/\n", { flag: "a" });
    const commits = officialBenchmarkCommits(root);
    const initialized = initializeBenchmark(root, { name: "release-eval", ...commits });
    const configHash = sha256(stableStringify(JSON.parse(readFileSync(initialized.file, "utf8"))));
    const insert = db.prepare(`
      INSERT INTO benchmark_runs(
        id, name, variant, scenario, status, duration_ms, verification_status,
        changed_files, input_tokens, output_tokens, policy, result_ref, created_at
      ) VALUES(?, 'release-eval', ?, ?, 'completed', 10, 'passed', 1, 1, 1, 'null', ?, ?)
    `);
    let sequence = 0;
    for (const scenario of DEFAULT_BENCHMARK_SCENARIOS) {
      for (const [variant, metisSource, variantCommit] of [
        ["metis-pre-1.0-baseline", "git-worktree", commits.baselineCommit],
        ["metis-1.0.0-candidate", "working-tree", commits.candidateCommit]
      ]) {
        sequence += 1;
        const id = `release-${sequence}`;
        const resultRef = storeObject(db, root, "benchmark:release-eval", JSON.stringify({
          id,
          benchmark: "release-eval",
          scenario: scenario.name,
          variant,
          repetition: 1,
          status: "completed",
          verificationStatus: "passed",
          durationMs: 10,
          changedFiles: ["src/value.js"],
          inputTokens: 1,
          outputTokens: 1,
          provenance: {
            benchmarkName: "release-eval",
            benchmarkConfigHash: configHash,
            requiredSuite: true,
            benchmarkBaselineCommit: commits.baselineCommit,
            benchmarkCandidateCommit: commits.candidateCommit,
            variantCommit,
            metisSource
          }
        }));
        insert.run(id, variant, scenario.name, resultRef, `2026-01-01T00:00:${String(sequence).padStart(2, "0")}Z`);
      }
    }
    assert.throws(
      () => compareBenchmarkVariants(db, "release-eval", "metis-pre-1.0-baseline", "metis-1.0.0-candidate", {
        projectRoot: root,
        file: initialized.file,
        ...commits
      }),
      (error) => error.code === "BENCHMARK_REPETITIONS"
    );
    db.prepare("UPDATE benchmark_runs SET slot_utilization = 0.5 WHERE id = 'release-1'").run();
    assert.throws(
      () => compareBenchmarkVariants(db, "release-eval", "metis-pre-1.0-baseline", "metis-1.0.0-candidate", {
        projectRoot: root,
        file: initialized.file,
        ...commits
      }),
      (error) => error.code === "BENCHMARK_PROVENANCE"
    );
  } finally {
    db.close();
  }
});

test("benchmark Metis fixtures explicitly pin every supported route to Luna", () => {
  const { root, db } = makeProject();
  try {
    const evidence = enforceBenchmarkModelConfig(root);
    const config = JSON.parse(readFileSync(path.join(root, ".metis", "config.json"), "utf8"));
    assert.equal(evidence.model, BENCHMARK_MODEL);
    assert.deepEqual(evidence.roles, BENCHMARK_MODEL_ROLES);
    for (const role of BENCHMARK_MODEL_ROLES) assert.equal(config.models.routes[role].model, BENCHMARK_MODEL, role);
    assert.equal(config.models.defaults.codex.worker, BENCHMARK_MODEL);
    assert.deepEqual(config.models.capabilities.codex.models[BENCHMARK_MODEL], ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(config.models.benchmark.enabled, true);
    const effortByRole = Object.fromEntries(evidence.effortEvidence.map((item) => [item.role, item]));
    assert.equal(effortByRole.scout.requestedEffort, "low");
    assert.equal(effortByRole.scout.effectiveEffort, "low");
    assert.equal(effortByRole.synthesizer.effectiveEffort, "low");
    assert.equal(effortByRole.planner.effectiveEffort, "medium");
    assert.equal(effortByRole["plan-critic"].effectiveEffort, "low");
    for (const role of ["worker", "reviewer", "verifier"]) assert.equal(effortByRole[role].effectiveEffort, "high", role);
    for (const role of BENCHMARK_MODEL_ROLES) {
      assert.equal(effortByRole[role].requestedEffort, effortByRole[role].effectiveEffort, role);
      assert.equal(config.models.routes[role].reasoningEffort, effortByRole[role].effectiveEffort, role);
    }
  } finally { db.close(); }
});

test("non-Codex benchmark fixtures retain their host-selected model", () => {
  const { root, db } = makeProject({ config: { host: "claude" } });
  try {
    const file = path.join(root, ".metis", "config.json");
    const before = readFileSync(file, "utf8");
    assert.equal(enforceBenchmarkModelConfig(root, { host: "claude" }), null);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally { db.close(); }
});

test("benchmark effort pinning fails closed when fixture capability evidence cannot honor a role request", () => {
  const { root, db } = makeProject({ config: { models: { capabilities: { codex: { models: { [BENCHMARK_MODEL]: ["high"] } } } } } });
  try {
    assert.throws(() => enforceBenchmarkModelConfig(root), (error) => error.code === "BENCHMARK_EFFORT_FALLBACK");
  } finally { db.close(); }
});

test("benchmark recovery quarantines an obsolete config without rewriting model provenance", () => {
  const { root, db, config } = makeProject();
  try {
    const snapshot = enforceBenchmarkModelConfig(root);
    const { run } = startTestRun(db, root, config, "Benchmark recovery model contract", { contract: { lifecycleProfile: "balanced" } });
    forcePhase(db, root, config, run.id, "discover");
    addTask(db, run.id, {
      id: "recovery-synthesizer",
      title: "Synthesize benchmark discovery",
      goal: "Preserve the current model route after host recovery",
      role: "synthesizer",
      taskKind: "synthesis",
      runPhase: "discover",
      wave: 2,
      readOnly: true,
      expectedOutputs: ["artifact"],
      acceptanceCriteria: ["The synthesis route remains explicitly Luna."],
      requiredEvidence: ["Durable model provenance"]
    }, config);
    const fence = db.prepare("SELECT controller_fencing_token FROM runs WHERE id = ?").get(run.id).controller_fencing_token;
    db.prepare(`
      INSERT INTO scheduler_batches(
        id, run_id, phase, status, batch_json, rationale_json, controller_fencing_token,
        claimed_task_ids_json, spawned_task_ids_json, created_at, updated_at
      ) VALUES(?, ?, 'discover', 'prepared', ?, '[]', ?, ?, '[]', ?, ?)
    `).run("recovery-model-batch", run.id, JSON.stringify([{ taskId: "recovery-synthesizer", model: "gpt-5.6-sol" }]), fence, JSON.stringify(["recovery-synthesizer"]), new Date().toISOString(), new Date().toISOString());
    db.prepare("UPDATE tasks SET selected_model = NULL WHERE id = ?").run("recovery-synthesizer");
    const recoveryTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get("recovery-synthesizer");
    const recoveryAttempt = startTaskAttempt(db, run, recoveryTask, 1);
    db.prepare("UPDATE task_attempts SET selected_model = 'gpt-5.6-sol' WHERE id = ?").run(recoveryAttempt.id);
    const staleRoutes = Object.fromEntries(BENCHMARK_MODEL_ROLES.map((role) => [role, { model: role === "worker" ? "gpt-5.6-sol" : null }]));
    const stale = { version: 5, host: "codex", models: { defaults: { codex: { worker: "gpt-5.6-sol" } }, routes: staleRoutes } };
    writeFileSync(path.join(root, ".metis", "config.json"), `${JSON.stringify(stale)}\n`);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION));
    db.close();

    const recovered = restoreBenchmarkModelConfig(root, snapshot, { runId: run.id });
    assert.equal(recovered.restored, true);
    assert.ok(recovered.quarantined);
    assert.equal(recovered.state.runId, run.id);
    assert.equal(recovered.state.allLuna, false);
    assert.ok(recovered.state.inspectionFingerprint);
    assert.ok(recovered.state.invalid.some((item) => item.source === "task" && item.model === null));
    assert.ok(recovered.state.invalid.some((item) => item.source === "attempt" && item.model === "gpt-5.6-sol"));
    assert.ok(recovered.state.invalid.some((item) => item.source === "descriptor" && item.model === "gpt-5.6-sol"));
    const current = JSON.parse(readFileSync(path.join(root, ".metis", "config.json"), "utf8"));
    assert.equal(current.version, config.version);
    assert.equal(current.models.defaults.codex.worker, BENCHMARK_MODEL);
    for (const role of BENCHMARK_MODEL_ROLES) assert.equal(current.models.routes[role].model, BENCHMARK_MODEL, role);
    const beforeMutation = new DatabaseSync(path.join(root, ".metis", "state", "state.db"), { readOnly: true });
    assert.equal(beforeMutation.prepare("SELECT selected_model FROM tasks WHERE id = ?").get("recovery-synthesizer").selected_model, null);
    assert.equal(beforeMutation.prepare("SELECT selected_model FROM task_attempts WHERE id = ?").get(recoveryAttempt.id).selected_model, "gpt-5.6-sol");
    beforeMutation.close();
    const mutate = new DatabaseSync(path.join(root, ".metis", "state", "state.db"));
    mutate.prepare("UPDATE tasks SET selected_model = ? WHERE id = ?").run(BENCHMARK_MODEL, "recovery-synthesizer");
    mutate.prepare("UPDATE task_attempts SET selected_model = ? WHERE id = ?").run(BENCHMARK_MODEL, recoveryAttempt.id);
    mutate.prepare("UPDATE scheduler_batches SET batch_json = ? WHERE id = ?").run(JSON.stringify([{ taskId: "recovery-synthesizer", model: BENCHMARK_MODEL }]), "recovery-model-batch");
    mutate.close();
    const reopened = new DatabaseSync(path.join(root, ".metis", "state", "state.db"), { readOnly: true });
    try {
      const recoveredTask = reopened.prepare("SELECT selected_model, model_source FROM tasks WHERE id = ?").get("recovery-synthesizer");
      assert.equal(recoveredTask.selected_model, BENCHMARK_MODEL);
      assert.equal(reopened.prepare("SELECT selected_model FROM task_attempts WHERE id = ?").get(recoveryAttempt.id).selected_model, BENCHMARK_MODEL);
      const descriptor = JSON.parse(reopened.prepare("SELECT batch_json FROM scheduler_batches WHERE id = ?").get("recovery-model-batch").batch_json);
      assert.equal(descriptor[0].model, BENCHMARK_MODEL);
      assert.equal(reopened.prepare("SELECT status FROM runs WHERE id = ?").get(run.id).status, "blocked");
      assert.ok(reopened.prepare("SELECT 1 FROM events WHERE run_id = ? AND type = 'benchmark.model-recovery'").get(run.id));
    } finally { reopened.close(); }
    const evidence = readWorkspaceModelEvidence(root, { runId: run.id });
    assert.equal(evidence.allLuna, false);
    assert.equal(evidence.recoveryInvalid, true);
    const receiptEvidence = readWorkspaceModelEvidence(root, { runId: run.id, recoveryReceipt: recovered.recoveryReceipt });
    assert.equal(receiptEvidence.allLuna, false);
    assert.equal(receiptEvidence.recoveryReceiptValid, true);
    assert.equal(candidateRuntimeContract(root, { name: "trivial-local-change" }, { runId: run.id, recoveryReceipt: recovered.recoveryReceipt, requireRecoveryReceipt: true }), false);
    const deleteEvent = new DatabaseSync(path.join(root, ".metis", "state", "state.db"));
    deleteEvent.prepare("DELETE FROM events WHERE run_id = ? AND type = 'benchmark.model-recovery'").run(run.id);
    deleteEvent.close();
    assert.equal(readWorkspaceModelEvidence(root, { runId: run.id, recoveryReceipt: recovered.recoveryReceipt }).allLuna, false);
    const acceptance = evaluateBenchmarkAcceptance({
      requiredSuite: false,
      baseline: {},
      candidate: {},
      scenarios: [{
        scenario: "trivial-local-change",
        baseline: { passRate: 1, p95VerifiedDurationMs: 100, medianVerifiedDurationMs: 100, firstWorkerApplicable: false, modelEvidence: { main: { applicable: false }, nested: { applicable: true, allLuna: true, recoveryInvalid: false } } },
        candidate: { passRate: 1, p95VerifiedDurationMs: 90, medianVerifiedDurationMs: 50, firstWorkerApplicable: false, modelEvidence: { main: { applicable: false }, nested: { applicable: true, allLuna: true, recoveryInvalid: true, recoveryReceiptRequired: true, recoveryReceiptValid: false } } }
      }]
    });
    assert.equal(acceptance.passed, false);
  } finally { if (db.isOpen) db.close(); }
});

test("benchmark model evidence binds to the exact run and rejects a wrong authenticated run ID", () => {
  const { root, db, config } = makeProject();
  try {
    const snapshot = enforceBenchmarkModelConfig(root);
    const first = startTestRun(db, root, config, "Earlier benchmark run", { contract: { lifecycleProfile: "balanced" } }).run;
    forcePhase(db, root, config, first.id, "discover");
    addTask(db, first.id, {
      id: "earlier-sol-task", title: "Earlier task", goal: "Keep historical model evidence", role: "scout", taskKind: "discovery",
      runPhase: "discover", expectedOutputs: ["artifact"], acceptanceCriteria: ["Evidence is retained"], requiredEvidence: ["Model"], selectedModel: "gpt-5.6-sol"
    }, config);
    db.prepare("UPDATE tasks SET selected_model = 'gpt-5.6-sol' WHERE id = ?").run("earlier-sol-task");
    db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(first.id);
    const second = startTestRun(db, root, config, "Newer clean run", { contract: { lifecycleProfile: "balanced" } }).run;
    assert.equal(readWorkspaceModelEvidence(root, { runId: first.id }).allLuna, false);
    assert.equal(readWorkspaceModelEvidence(root, { runId: second.id }).allLuna, true);
    assert.equal(readWorkspaceModelEvidence(root).allLuna, false);
    const cleanRecovery = restoreBenchmarkModelConfig(root, { ...snapshot, runId: second.id }, { runId: second.id });
    assert.equal(cleanRecovery.state.allLuna, true);
    const cleanEvidence = readWorkspaceModelEvidence(root, { runId: second.id, recoveryReceipt: cleanRecovery.recoveryReceipt });
    assert.equal(cleanEvidence.allLuna, true);
    assert.equal(cleanEvidence.recoveryReceiptValid, true);

    const stale = { version: 5, host: "codex", models: { defaults: { codex: { worker: "gpt-5.6-sol" } }, routes: {} } };
    writeFileSync(path.join(root, ".metis", "config.json"), `${JSON.stringify(stale)}\n`);
    assert.throws(() => restoreBenchmarkModelConfig(root, { ...snapshot, runId: first.id }, { runId: second.id }), (error) => {
      assert.equal(error.code, "BENCHMARK_MODEL_RUN");
      return true;
    });
    assert.equal(JSON.parse(readFileSync(path.join(root, ".metis", "config.json"), "utf8")).version, 5);
  } finally { db.close(); }
});

test("Codex benchmark commands reject an unpinned model", async () => {
  const { root, db } = makeProject();
  try {
    const file = path.join(root, ".metis", "benchmarks", "unpinned-codex.json");
    writeFileSync(file, JSON.stringify({
      version: 2, name: "unpinned-codex", repetitions: 1,
      scenarios: [{ name: "unpinned-codex", prompt: "No-op." }],
      variants: [{ name: "candidate", command: { command: "codex", args: ["exec", "{prompt}"] } }]
    }));
    await assert.rejects(() => runBenchmark(db, root, { file, allowRepositoryExec: true }), (error) => {
      assert.equal(error.code, "BENCHMARK_CODEX_MODEL");
      return true;
    });
  } finally { db.close(); }
});

test("real Codex benchmark verification rejects missing or wrong effective model evidence", async () => {
  const { root, db } = makeProject();
  const fakeDir = mkdtempSync(path.join(os.tmpdir(), "metis-fake-codex-"));
  const fakeCodex = path.join(fakeDir, "codex");
  const modes = [
    { name: "luna", banner: "canonical", cli: BENCHMARK_MODEL, metrics: null, effective: BENCHMARK_MODEL, status: "passed" },
    { name: "missing", banner: "missing", cli: "missing", metrics: null, effective: null, status: "failed" },
    { name: "sol", banner: "canonical", cli: "gpt-5.6-sol", metrics: null, effective: "gpt-5.6-sol", status: "failed" },
    { name: "conflict", banner: "canonical", cli: BENCHMARK_MODEL, metrics: "gpt-5.6-sol", effective: BENCHMARK_MODEL, status: "failed" },
    { name: "assistant-output", banner: "assistant", cli: "ignored", metrics: null, effective: null, status: "failed" },
    { name: "ansi-output", banner: "ansi", cli: "ignored", metrics: null, effective: null, status: "failed" },
    { name: "later-stderr", banner: "later", cli: "ignored", metrics: null, effective: null, status: "failed" },
    { name: "ambiguous", banner: "ambiguous", cli: BENCHMARK_MODEL, metrics: null, effective: null, status: "failed" }
  ];
  try {
    writeFileSync(fakeCodex, "#!/bin/sh\ncase \"$BANNER_MODE\" in\n  canonical|ambiguous) printf 'OpenAI Codex v0.147.0\\n--------\\nworkdir: %s\\nmodel: %s\\n' \"$WORKDIR\" \"$CLI_MODEL\" >&2; if [ \"$BANNER_MODE\" = \"ambiguous\" ]; then printf 'model: gpt-5.6-sol\\n' >&2; fi; printf 'provider: openai\\n--------\\nuser\\n' >&2 ;;\n  assistant) printf 'model: gpt-5.6-luna\\n' ;;\n  ansi) printf '\\033[31mmodel: gpt-5.6-luna\\033[0m\\n' >&2 ;;\n  later) printf 'diagnostic\\nmodel: gpt-5.6-luna\\n' >&2 ;;\nesac\nif [ -n \"$METRICS_MODEL\" ]; then printf '{\"mainModel\":\"%s\"}' \"$METRICS_MODEL\" > \"$5\"; fi\nexit 0\n", "utf8");
    chmodSync(fakeCodex, 0o755);
    for (const mode of modes) {
      const file = path.join(root, ".metis", "benchmarks", `codex-${mode.name}.json`);
      const command = {
        command: "codex",
        args: ["exec", "--model", BENCHMARK_MODEL, "--metrics", "{workspace}/metrics.json", "{prompt}"],
        env: { BANNER_MODE: mode.banner, CLI_MODEL: mode.cli, METRICS_MODEL: mode.metrics ?? "", WORKDIR: "{workspace}", PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}` }
      };
      writeFileSync(file, JSON.stringify({
        version: 2, name: `codex-${mode.name}`, repetitions: 1, timeoutMs: 10000,
        scenarios: [{ name: `codex-${mode.name}`, host: "codex", prompt: "No-op." }],
        variants: [{ name: "plain-host", metricsFile: "metrics.json", command, commands: { codex: command } }]
      }));
      const result = await runBenchmark(db, root, { file, allowRepositoryExec: true });
      assert.equal(result.results[0].verificationStatus, mode.status, mode.name);
      const evidence = result.results[0].modelEvidence;
      assert.equal(evidence.main.requested, BENCHMARK_MODEL);
      assert.equal(evidence.main.effective, mode.effective, mode.name);
      assert.equal(evidence.main.verified, mode.status === "passed", mode.name);
      assert.equal(evidence.main.conflict, mode.name === "conflict", mode.name);
      assert.equal(evidence.main.headerValid, mode.banner === "canonical" && mode.name !== "ambiguous", mode.name);
      assert.equal(validateOuterMainReceipt(evidence.main.outerMainReceipt), mode.status === "passed", mode.name);
    }
  } finally {
    db.close();
    rmSync(fakeDir, { recursive: true, force: true });
  }
});

test("default benchmark suite contains the required nine scenarios, three variants, and five repetitions", () => {
  const { root, db } = makeProject();
  try {
    const commits = officialBenchmarkCommits(root);
    const initialized = initializeBenchmark(root, { name: "required-eval", ...commits });
    const config = JSON.parse(readFileSync(initialized.file, "utf8"));
    assert.equal(config.requiredSuite, true);
    assert.equal(config.repetitions, 5);
    assert.deepEqual(config.scenarios.map((item) => item.name), DEFAULT_BENCHMARK_SCENARIOS.map((item) => item.name));
    assert.deepEqual(config.variants.map((item) => item.name), DEFAULT_BENCHMARK_VARIANTS.map((item) => item.name));
    assert.equal(config.baselineCommit, commits.baselineCommit);
    assert.equal(config.candidateCommit, commits.candidateCommit);
    assert.notEqual(config.baselineCommit, config.candidateCommit);
  } finally { db.close(); }
});

test("official benchmark initialization requires explicit distinct commits", () => {
  const { root, db } = makeProject();
  try {
    assert.throws(() => initializeBenchmark(root, { name: "missing-commits" }), (error) => error.code === "BENCHMARK_BASELINE_COMMIT");
    const commits = officialBenchmarkCommits(root);
    assert.throws(() => initializeBenchmark(root, { name: "same-commit", baselineCommit: commits.candidateCommit, candidateCommit: commits.candidateCommit }), (error) => error.code === "BENCHMARK_COMMITS");
    assert.throws(() => initializeBenchmark(root, { name: "missing-baseline", baselineCommit: "0".repeat(40), candidateCommit: commits.candidateCommit }), (error) => error.code === "BENCHMARK_BASELINE_COMMIT");
  } finally { db.close(); }
});

test("official benchmark rejects a dirty candidate checkout before execution", async () => {
  const { root, db } = makeProject();
  try {
    const commits = officialBenchmarkCommits(root);
    const initialized = initializeBenchmark(root, { name: "dirty-official", ...commits });
    writeFileSync(path.join(root, "dirty-candidate.txt"), "dirty\n");
    await assert.rejects(() => runBenchmark(db, root, { file: initialized.file, allowRepositoryExec: true }), (error) => {
      assert.equal(error.code, "BENCHMARK_DIRTY_REPOSITORY");
      return true;
    });
  } finally { db.close(); }
});

test("benchmark runner rejects missing or false repository-exec approval before spawning commands", async () => {
  const { root, db } = makeProject();
  const file = path.join(root, ".metis", "benchmarks", "approval-required.json");
  const marker = path.join(root, "benchmark-command-executed");
  try {
    writeFileSync(file, JSON.stringify({
      version: 2,
      name: "approval-required",
      repetitions: 1,
      scenarios: [{ name: "approval-required", prompt: "Do not run.", verify: [] }],
      variants: [{
        name: "command-that-must-not-run",
        command: { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")`] }
      }]
    }, null, 2));

    for (const options of [{ file }, { file, allowRepositoryExec: false }]) {
      await assert.rejects(() => runBenchmark(db, root, options), (error) => {
        assert.equal(error.code, "BENCHMARK_EXEC_APPROVAL");
        return true;
      });
      assert.equal(existsSync(marker), false);
    }
  } finally { db.close(); }
});

test("benchmark runner compares isolated local variants", async () => {
  const { root, db } = makeProject();
  try {
    const file = path.join(root, ".metis", "benchmarks", "local.json");
    writeFileSync(file, JSON.stringify({
      version: 2,
      name: "local-eval",
      repetitions: 1,
      timeoutMs: 10000,
      scenarios: [{
        name: "write-result",
        source: ".",
        prompt: "Write the result file.",
        verify: [{ command: "{node}", args: ["-e", "require('fs').accessSync('result.txt')"] }]
      }],
      variants: [
        { name: "baseline", command: { command: "{node}", args: ["-e", "require('fs').writeFileSync('{workspace}/result.txt','baseline')"] } },
        { name: "candidate", command: { command: "{node}", args: ["-e", "require('fs').writeFileSync('{workspace}/result.txt','candidate')"] } }
      ]
    }, null, 2));

    const result = await runBenchmark(db, root, { file, allowRepositoryExec: true });
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((item) => item.verificationStatus === "passed"));
    assert.ok(result.results.every((item) => item.resultRef.startsWith("obj_")));
    assert.ok(result.results.every((item) => !("execution" in item) && !("verification" in item)));
    const report = benchmarkReport(db, "local-eval");
    assert.equal(report.length, 2);
    const comparison = compareBenchmarkVariants(db, "local-eval", "baseline", "candidate");
    assert.equal(comparison.baseline.passRate, 1);
    assert.equal(comparison.candidate.passRate, 1);
    const persisted = db.prepare("SELECT policy FROM benchmark_runs WHERE name = ? ORDER BY created_at LIMIT 1").get("local-eval");
    const policy = JSON.parse(persisted.policy);
    assert.equal(policy.expected, BENCHMARK_MODEL);
    assert.equal(policy.main.requested, null);
    assert.equal(report[0].modelEvidence.expected, BENCHMARK_MODEL);
    assert.equal(report[0].modelEvidence.nested.allLuna, null);
  } finally {
    db.close();
  }
});

test("benchmark workspace paths are canonical across setup, command, verifier, and cleanup", async () => {
  const { root, db } = makeProject();
  const originalTmpdir = os.tmpdir;
  const physicalTmpdir = mkdtempSync(path.join(originalTmpdir(), "metis-benchmark-canonical-"));
  const lexicalTmpdir = `${physicalTmpdir}-alias`;
  const observationFile = path.join(root, ".canonical-workspace-observations.json");
  const recordWorkspace = [
    "const fs = require('node:fs');",
    "const file = process.argv[1];",
    "const stage = process.argv[2];",
    "const workspace = process.argv[3];",
    "const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};",
    "value[stage] = workspace;",
    "fs.writeFileSync(file, JSON.stringify(value));"
  ].join(" ");
  try {
    symlinkSync(physicalTmpdir, lexicalTmpdir, process.platform === "win32" ? "junction" : "dir");
    os.tmpdir = () => lexicalTmpdir;
    writeFileSync(path.join(root, ".metis", "benchmarks", "canonical-workspace.json"), JSON.stringify({
      version: 2,
      name: "canonical-workspace",
      repetitions: 1,
      timeoutMs: 10000,
      scenarios: [{
        name: "canonical-workspace",
        source: ".",
        prompt: "Record the benchmark workspace path.",
        verify: [{ command: process.execPath, args: ["-e", recordWorkspace, observationFile, "verifier", "{workspace}"] }]
      }],
      variants: [{
        name: "candidate",
        setup: [{ command: process.execPath, args: ["-e", recordWorkspace, observationFile, "setup", "{workspace}"] }],
        command: { command: process.execPath, args: ["-e", recordWorkspace, observationFile, "command", "{workspace}"] }
      }]
    }));

    const result = await runBenchmark(db, root, {
      file: path.join(root, ".metis", "benchmarks", "canonical-workspace.json"),
      allowRepositoryExec: true
    });
    assert.equal(result.results[0].status, "completed");
    assert.equal(result.results[0].verificationStatus, "passed");
    assert.equal(existsSync(observationFile), true);
    const observed = JSON.parse(readFileSync(observationFile, "utf8"));
    const canonicalTmpdir = realpathSync.native(lexicalTmpdir);
    assert.equal(observed.setup, observed.command);
    assert.equal(observed.command, observed.verifier);
    assert.equal(path.relative(canonicalTmpdir, observed.command).startsWith(".."), false);
    assert.equal(path.relative(lexicalTmpdir, observed.command).startsWith(".."), true);
    assert.equal(readdirSync(physicalTmpdir).length, 0);
  } finally {
    os.tmpdir = originalTmpdir;
    rmSync(observationFile, { force: true });
    db.close();
    if (existsSync(lexicalTmpdir)) unlinkSync(lexicalTmpdir);
    rmSync(physicalTmpdir, { recursive: true, force: true });
  }
});

test("benchmark runner materializes and externally verifies a built-in fixture", async () => {
  const { root, db } = makeProject();
  try {
    const file = path.join(root, ".metis", "benchmarks", "built-in.json");
    writeFileSync(file, JSON.stringify({
      version: 2,
      name: "built-in-eval",
      repetitions: 1,
      timeoutMs: 10000,
      scenarios: [{
        name: "trivial-local-change",
        builtInFixture: true,
        // The runner must ignore an agent/config-writable no-op and invoke
        // the built-in external oracle instead.
        verify: [{ command: "{node}", args: ["-e", "process.exit(0)"] }]
      }],
      variants: [{
        name: "candidate",
        command: { command: "{node}", args: ["-e", "require('fs').writeFileSync('src/value.js','export function answer() { return 42; }\\n')"] }
      }]
    }));
    const result = await runBenchmark(db, root, { file, allowRepositoryExec: true });
    assert.equal(result.results[0].status, "completed");
    assert.equal(result.results[0].verificationStatus, "passed");
    assert.deepEqual(result.results[0].changedFiles, ["src/value.js"]);
  } finally { db.close(); }
});

test("local policy probes verify the actual candidate runtime without a host account", async () => {
  const { root, db } = makeProject();
  try {
    const file = path.join(root, ".metis", "benchmarks", "policy-probe.json");
    writeFileSync(file, JSON.stringify({
      version: 2, name: "policy-probe", repetitions: 1, timeoutMs: 10000,
      scenarios: [{ name: "claude-host", builtInFixture: true, localProbe: true, verify: [{ command: "ignored", args: [] }] }],
      variants: [{ name: "candidate", metisSource: "candidate", command: { command: "ignored", args: [] } }]
    }));
    const result = await runBenchmark(db, root, { file, allowRepositoryExec: true });
    assert.equal(result.results[0].host, "local");
    assert.equal(result.results[0].verificationStatus, "passed");
    assert.equal(result.results[0].modelEvidence.main.applicable, false);
    assert.equal(result.results[0].modelEvidence.main.verified, null);
  } finally { db.close(); }
});

test("benchmark runner records command timeouts as failures", async () => {
  const { root, db } = makeProject();
  try {
    const file = path.join(root, ".metis", "benchmarks", "timeout.json");
    writeFileSync(file, JSON.stringify({
      version: 2,
      name: "timeout-eval",
      repetitions: 1,
      timeoutMs: 20,
      scenarios: [{ name: "timeout", source: ".", prompt: "Wait." }],
      variants: [{ name: "candidate", command: { command: "{node}", args: ["-e", "setTimeout(() => {}, 1000)"] } }]
    }));
    const result = await runBenchmark(db, root, { file, allowRepositoryExec: true });
    assert.equal(result.results[0].status, "failed");
    assert.equal(result.results[0].verificationStatus, "failed");
    assert.equal(benchmarkReport(db, "timeout-eval")[0].successfulRuns, 0);
  } finally { db.close(); }
});

test("benchmark timeout contains a child process group and bounds wall time", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are required for descendant containment");
    return;
  }
  const { root, db } = makeProject();
  let result;
  let grandchildPid = null;
  try {
    const file = path.join(root, ".metis", "benchmarks", "process-group-timeout.json");
    const grandchildScript = [
      "const fs = require('node:fs');",
      "const marker = process.argv[1];",
      "const ready = process.argv[2];",
      "process.on('SIGTERM', () => { fs.writeFileSync(marker, 'terminated'); process.exit(0); });",
      "fs.writeFileSync(ready, 'ready');",
      "if (process.send) process.send('ready');",
      "setInterval(() => {}, 1000);"
    ].join(" ");
    const parentScript = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const script = ${JSON.stringify(grandchildScript)};`,
      "const child = spawn(process.execPath, ['-e', script, process.argv[1], process.argv[2]], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "child.once('message', (message) => { if (message !== 'ready') return; fs.writeFileSync(process.argv[3], String(child.pid)); setInterval(() => {}, 1000); });"
    ].join(" ");
    writeFileSync(file, JSON.stringify({
      version: 2,
      name: "process-group-timeout",
      repetitions: 1,
      timeoutMs: 1000,
      scenarios: [{ name: "process-group-timeout", source: ".", prompt: "Wait.", verify: [] }],
      variants: [{
        name: "candidate",
        command: {
          command: "{node}",
          args: ["-e", parentScript, "{workspace}/grandchild.marker", "{workspace}/grandchild.ready", "{workspace}/grandchild.marker.pid"]
        }
      }]
    }));
    const started = performance.now();
    result = await runBenchmark(db, root, { file, allowRepositoryExec: true, keepWorkspaces: true });
    const elapsed = performance.now() - started;
    const run = result.results[0];
    const raw = JSON.parse(readObject(db, root, run.resultRef));
    const marker = path.join(run.workspace, "grandchild.marker");
    const readyMarker = path.join(run.workspace, "grandchild.ready");
    const pidFile = `${marker}.pid`;
    assert.equal(run.status, "failed");
    assert.match(raw.execution.error, /timed out/i);
    assert.equal(raw.execution.errorCode, "BENCHMARK_TIMEOUT");
    assert.ok(run.durationMs < 2500, `run duration ${run.durationMs}ms exceeded containment bound`);
    assert.ok(elapsed < 3000, `wall time ${elapsed}ms exceeded containment bound`);
    await waitForFile(readyMarker);
    await waitForFile(marker);
    await waitForFile(pidFile);
    assert.equal(readFileSync(marker, "utf8"), "terminated");
    grandchildPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
    await assertProcessGone(grandchildPid);
  } finally {
    await killTestProcess(grandchildPid);
    if (result?.workspaceRoot) rmSync(result.workspaceRoot, { recursive: true, force: true });
    db.close();
  }
});

test("benchmark cleanup deadline settles when an escaped descendant holds stdio", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are required for descendant containment");
    return;
  }
  const { root, db } = makeProject();
  const pidFile = path.join(root, "escaped-descendant.pid");
  let escapedPid = null;
  let result;
  try {
    const file = path.join(root, ".metis", "benchmarks", "cleanup-deadline.json");
    writeFileSync(file, JSON.stringify({
      version: 2,
      name: "cleanup-deadline",
      repetitions: 1,
      timeoutMs: 100,
      scenarios: [{ name: "cleanup-deadline", source: ".", prompt: "Wait.", verify: [] }],
      variants: [{
        name: "candidate",
        command: {
          command: "{node}",
          args: ["-e", [
            "const fs = require('node:fs');",
            "const { spawn } = require('node:child_process');",
            "const env = { ...process.env };",
            "delete env.METIS_BENCHMARK_PROCESS_TOKEN;",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, env, stdio: ['ignore', 'inherit', 'inherit'] });",
            "child.unref();",
            "fs.writeFileSync(process.argv[1], String(child.pid));"
          ].join(" "), pidFile]
        }
      }]
    }));
    const started = performance.now();
    result = await runBenchmark(db, root, { file, allowRepositoryExec: true, keepWorkspaces: true });
    const elapsed = performance.now() - started;
    const run = result.results[0];
    const raw = JSON.parse(readObject(db, root, run.resultRef));
    await waitForFile(pidFile);
    escapedPid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(run.status, "failed");
    assert.equal(raw.execution.errorCode, "BENCHMARK_CLEANUP_TIMEOUT");
    assert.match(raw.execution.error, /cleanup-timeout/i);
    assert.ok(run.durationMs < 2500, `run duration ${run.durationMs}ms exceeded cleanup deadline`);
    assert.ok(elapsed < 3000, `wall time ${elapsed}ms exceeded cleanup deadline`);
  } finally {
    await killTestProcess(escapedPid ?? (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null));
    if (result?.workspaceRoot) rmSync(result.workspaceRoot, { recursive: true, force: true });
    db.close();
  }
});

test("benchmark normal exit also contains surviving descendants", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are required for descendant containment");
    return;
  }
  if (process.platform === "linux") {
    assert.equal(existsSync("/proc/self/environ"), true, "Linux process-token containment requires procfs");
  } else if (process.platform === "darwin") {
    try {
      execFileSync("ps", ["eww", "-axo", "pid=,command="], { stdio: "ignore" });
    } catch {
      t.skip("The environment does not permit process-token inventory for escaped descendants");
      return;
    }
  } else {
    t.skip("Process-token containment is implemented for Linux and macOS");
    return;
  }
  const { root, db } = makeProject();
  let result;
  let survivorPid = null;
  try {
    const file = path.join(root, ".metis", "benchmarks", "process-group-normal-exit.json");
    writeFileSync(file, JSON.stringify({
      version: 2,
      name: "process-group-normal-exit",
      repetitions: 1,
      timeoutMs: 5000,
      scenarios: [{ name: "process-group-normal-exit", source: ".", prompt: "Exit after spawning.", verify: [] }],
      variants: [{
        name: "candidate",
        command: {
          command: "{node}",
          args: ["-e", [
            "const fs = require('node:fs');",
            "const { spawn } = require('node:child_process');",
            "const pidFile = process.argv[1];",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); child.unref();",
            "fs.writeFileSync(pidFile, String(child.pid));"
          ].join(" "), "{workspace}/survivor.pid"]
        }
      }]
    }));
    result = await runBenchmark(db, root, { file, allowRepositoryExec: true, keepWorkspaces: true });
    const run = result.results[0];
    survivorPid = Number(readFileSync(path.join(run.workspace, "survivor.pid"), "utf8"));
    assert.ok(Number.isInteger(survivorPid) && survivorPid > 0);
    await assertProcessGone(survivorPid);
    const raw = JSON.parse(readObject(db, root, run.resultRef));
    assert.equal(raw.execution.errorCode, null);
  } finally {
    await killTestProcess(survivorPid);
    if (result?.workspaceRoot) rmSync(result.workspaceRoot, { recursive: true, force: true });
    db.close();
  }
});

test("benchmark metrics are reconstructed directly from candidate runtime state", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { maxConcurrent: 8 } } });
  try {
    const { run } = startTestRun(db, root, config, "Measure benchmark runtime state");
    db.prepare("UPDATE runs SET created_at = '2026-01-01T00:00:00.000Z', updated_at = '2026-01-01T00:00:03.000Z' WHERE id = ?").run(run.id);
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "bench-worker", title: "Benchmark worker", goal: "Measure first worker",
      role: "worker", taskKind: "implementation", runPhase: "execute", wave: 1, readOnly: false,
      targetPaths: ["src/value.js"], scope: ["src/value.js"], acceptanceCriteria: ["Measured"],
      requiredEvidence: ["Runtime state"], expectedOutputs: ["implementation"], requirementIds: ["REQ-001"],
      complexity: "low", risk: "low", effort: "small"
    }, config);
    const task = getTask(db, "bench-worker");
    startTaskAttempt(db, run, task, 1, { startAt: "2026-01-01T00:00:01.000Z" });
    markTaskAttemptSpawnAccepted(db, task.id, 1, "2026-01-01T00:00:01.500Z");
    db.prepare("UPDATE task_attempts SET execution_started_at = '2026-01-01T00:00:02.000Z', execution_ended_at = '2026-01-01T00:00:03.000Z', terminal_at = '2026-01-01T00:00:03.000Z' WHERE task_id = ?").run(task.id);
    const metrics = readWorkspaceRunMetrics(root);
    assert.equal(metrics.timeToFirstWorkerMs, 1500);
    assert.equal(metrics.maxConcurrency, 1);
    assert.equal(metrics.slotUtilization, 0.125);
    assert.equal(metrics.retryCount, 0);
    assert.equal(metrics.requestedEffort, "high");
    assert.equal(metrics.effectiveEffort, "high");
  } finally { db.close(); }
});

test("benchmark metrics observe the unmodified 1.0.0 state schema", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-baseline-metrics-"));
  const state = path.join(root, ".metis", "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(root, ".metis", "config.json"), JSON.stringify({ orchestration: { maxConcurrent: 8 } }));
  const db = new DatabaseSync(path.join(state, "state.db"));
  db.exec(`
    CREATE TABLE runs(id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY, run_id TEXT, role TEXT, task_kind TEXT, attempts INTEGER, updated_at TEXT, selected_model TEXT, reasoning_effort TEXT);
    CREATE TABLE task_spawn_acks(task_id TEXT, attempt_fence INTEGER, acknowledged_at TEXT);
    INSERT INTO runs VALUES('run-baseline', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:04.000Z');
    INSERT INTO tasks VALUES('worker-a', 'run-baseline', 'worker', 'implementation', 2, '2026-01-01T00:00:04.000Z', 'gpt-5.6-luna', 'medium');
    INSERT INTO task_spawn_acks VALUES('worker-a', 1, '2026-01-01T00:00:02.000Z');
  `);
  db.close();
  const metrics = readWorkspaceRunMetrics(root);
  assert.equal(metrics.timeToFirstWorkerMs, 2000);
  assert.equal(metrics.maxConcurrency, 1);
  assert.equal(metrics.slotUtilization, 0.125);
  assert.equal(metrics.retryCount, 1);
    assert.equal(metrics.model, "gpt-5.6-luna");
    assert.equal(metrics.effectiveEffort, "medium");
});

test("acceptance treats first-worker timing as not applicable only when neither variant spawns a worker", () => {
  const comparison = {
    baseline: {}, candidate: {},
    scenarios: [{
      scenario: "reasoning-failure",
      baseline: { passRate: 1, medianVerifiedDurationMs: 10, p95VerifiedDurationMs: 12, timeToFirstWorkerMs: null },
      candidate: { passRate: 1, medianVerifiedDurationMs: 9, p95VerifiedDurationMs: 11, timeToFirstWorkerMs: null }
    }]
  };
  assert.equal(evaluateBenchmarkAcceptance(comparison, BENCHMARK_ACCEPTANCE_TARGETS).scenarios[0].passed, true);
  comparison.scenarios[0].baseline.timeToFirstWorkerMs = 10;
  assert.equal(evaluateBenchmarkAcceptance(comparison, BENCHMARK_ACCEPTANCE_TARGETS).scenarios[0].passed, false);
});

test("benchmark statistics use verified median and nearest-rank P95 without hiding failures", () => {
  const { db } = makeProject();
  try {
    const insert = db.prepare(`
      INSERT INTO benchmark_runs(
        id, name, variant, scenario, status, duration_ms, verification_status,
        changed_files, input_tokens, output_tokens, result_ref, created_at
      ) VALUES(?, 'quality-eval', ?, ?, 'completed', ?, ?, 1, 10, 5, NULL, ?)
    `);
    let sequence = 0;
    const add = (variant, scenario, duration, verification) => {
      sequence += 1;
      insert.run(`bench-${sequence}`, variant, scenario, duration, verification, `2026-01-01T00:00:${String(sequence).padStart(2, "0")}Z`);
    };
    for (const duration of [10, 20, 30, 40, 50]) add("baseline", "five-samples", duration, "passed");
    for (const duration of [8, 16, 24, 32, 40]) add("candidate", "five-samples", duration, "passed");
    add("baseline", "failure", 100, "failed");
    add("candidate", "failure", 90, "failed");

    const report = benchmarkReport(db, "quality-eval");
    const baseline = report.find((item) => item.variant === "baseline" && item.scenario === "five-samples");
    assert.equal(baseline.medianVerifiedDurationMs, 30);
    assert.equal(baseline.p95VerifiedDurationMs, 50);
    const failed = report.find((item) => item.variant === "baseline" && item.scenario === "failure");
    assert.equal(failed.passRate, 0);
    assert.equal(failed.successfulRuns, 0);
    assert.equal(failed.medianVerifiedDurationMs, null);
    assert.equal(failed.p95VerifiedDurationMs, null);

    const comparison = compareBenchmarkVariants(db, "quality-eval", "baseline", "candidate");
    assert.equal(comparison.baseline.passRate, Number((5 / 6).toFixed(4)));
    assert.equal(comparison.candidate.passRate, Number((5 / 6).toFixed(4)));
    assert.equal(comparison.baseline.medianVerifiedDurationMs, 30);
    assert.equal(comparison.candidate.medianVerifiedDurationMs, 24);
    assert.equal(comparison.scenarios.length, 2);

    db.prepare(`
      INSERT INTO benchmark_runs(
        id, name, variant, scenario, status, duration_ms, verification_status,
        changed_files, input_tokens, output_tokens, result_ref, created_at
      ) VALUES('output-only', 'usage-eval', 'candidate', 'tokens', 'completed', 10, 'passed', 1, NULL, 9, NULL, '2026-01-01T00:01:00Z')
    `).run();
    const usage = benchmarkReport(db, "usage-eval")[0];
    assert.equal(usage.averageInputTokens, null);
    assert.equal(usage.averageOutputTokens, 9);
  } finally {
    db.close();
  }
});

test("acceptance evaluation requires measured evidence for every applicable gate", () => {
  const lunaEvidence = {
    main: { applicable: true, allPinned: true, outerReceiptValid: true },
    nested: { applicable: true, allLuna: true }
  };
  const comparison = {
    baseline: {}, candidate: {},
    scenarios: [{
      scenario: "trivial-local-change",
      baseline: { passRate: 1, medianVerifiedDurationMs: 100, p95VerifiedDurationMs: 120, timeToFirstWorkerMs: 50, modelEvidence: lunaEvidence },
      candidate: { passRate: 1, medianVerifiedDurationMs: 69, p95VerifiedDurationMs: 120, timeToFirstWorkerMs: 30, modelEvidence: lunaEvidence }
    }, {
      scenario: "four-slice-standard-change",
      baseline: { passRate: 1, medianVerifiedDurationMs: 100, p95VerifiedDurationMs: 120, timeToFirstWorkerMs: 50, modelEvidence: lunaEvidence },
      candidate: { passRate: 1, medianVerifiedDurationMs: 80, p95VerifiedDurationMs: 120, timeToFirstWorkerMs: 30, modelEvidence: lunaEvidence }
    }]
  };
  const result = evaluateBenchmarkAcceptance(comparison, BENCHMARK_ACCEPTANCE_TARGETS);
  assert.equal(result.passed, true);
  comparison.scenarios[0].candidate.p95VerifiedDurationMs = null;
  assert.equal(evaluateBenchmarkAcceptance(comparison, BENCHMARK_ACCEPTANCE_TARGETS).passed, false);
  comparison.scenarios[0].candidate.p95VerifiedDurationMs = 120;
  comparison.scenarios[0].baseline.passRate = 0;
  comparison.scenarios[0].candidate.passRate = 0;
  assert.equal(evaluateBenchmarkAcceptance(comparison, BENCHMARK_ACCEPTANCE_TARGETS).passed, false);
  comparison.scenarios[0].candidate.p95VerifiedDurationMs = 120;
  comparison.scenarios[0].baseline.passRate = 1;
  comparison.scenarios[0].candidate.passRate = 1;
  comparison.scenarios[0].candidate.modelEvidence.main.allPinned = false;
  assert.equal(evaluateBenchmarkAcceptance(comparison, BENCHMARK_ACCEPTANCE_TARGETS).passed, false);
  comparison.scenarios[0].candidate.modelEvidence.main.allPinned = true;
  comparison.scenarios[0].candidate.modelEvidence.main.outerReceiptValid = false;
  assert.equal(evaluateBenchmarkAcceptance(comparison, BENCHMARK_ACCEPTANCE_TARGETS).passed, false);
  comparison.scenarios[0].candidate.modelEvidence = null;
  assert.equal(evaluateBenchmarkAcceptance(comparison, BENCHMARK_ACCEPTANCE_TARGETS).passed, false);
});

test("local policy probes explicitly mark first-worker timing as not applicable", () => {
  const comparison = {
    baseline: {}, candidate: {},
    scenarios: [{
      scenario: "reasoning-failure",
      baseline: { passRate: 1, medianVerifiedDurationMs: 10, p95VerifiedDurationMs: 10, timeToFirstWorkerMs: null, firstWorkerApplicable: false },
      candidate: { passRate: 1, medianVerifiedDurationMs: 10, p95VerifiedDurationMs: 10, timeToFirstWorkerMs: null, firstWorkerApplicable: false }
    }]
  };
  const result = evaluateBenchmarkAcceptance(comparison, BENCHMARK_ACCEPTANCE_TARGETS);
  assert.equal(result.passed, true);
  assert.equal(result.scenarios[0].evidence.firstWorkerApplicable, false);
});

function addImplementationTask(db, runId, config, id, wave, index) {
  addTask(db, runId, {
    id, title: `Benchmark implementation ${id}`, goal: "Implement one bounded benchmark slice",
    role: "worker", taskKind: "implementation", runPhase: "execute", wave, readOnly: false,
    targetPaths: [`src/benchmark-${index}.js`], scope: [`src/benchmark-${index}.js`],
    acceptanceCriteria: ["The slice is complete"], requiredEvidence: ["Runtime evidence"],
    expectedOutputs: ["implementation"], requirementIds: ["REQ-001"], complexity: "low", risk: "low", effort: "small"
  }, config);
}

test("candidate runtime contract requires the earliest implementation wave to have exact fan-out", () => {
  const { root, db, config } = makeProject();
  try {
    const benchmarkConfig = enforceBenchmarkModelConfig(root).configSnapshot;
    const { run } = startTestRun(db, root, benchmarkConfig, "Benchmark fan-out contract", { contract: { lifecycleProfile: "balanced" } });
    recordUsageSample(db, run.id, { role: "main", model: BENCHMARK_MODEL, observedInputTokens: 1, observedOutputTokens: 1, source: "benchmark-test" });
    forcePhase(db, root, benchmarkConfig, run.id, "plan");
    const scenario = DEFAULT_BENCHMARK_SCENARIOS.find((item) => item.name === "four-slice-standard-change");
    for (let index = 1; index <= 4; index += 1) addImplementationTask(db, run.id, benchmarkConfig, `wave-one-${index}`, 1, index);
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: outerLunaReceipt(root) }), true);
    addImplementationTask(db, run.id, benchmarkConfig, "wave-one-extra", 1, 5);
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: outerLunaReceipt(root) }), false);
  } finally { db.close(); }
});

test("candidate runtime contract rejects null/sol task and scheduler descriptor models", () => {
  const { root, db, config } = makeProject();
  try {
    const benchmarkConfig = enforceBenchmarkModelConfig(root).configSnapshot;
    const { run } = startTestRun(db, root, benchmarkConfig, "Benchmark model contract", { contract: { lifecycleProfile: "balanced" } });
    recordUsageSample(db, run.id, { role: "main", model: BENCHMARK_MODEL, observedInputTokens: 1, observedOutputTokens: 1, source: "benchmark-test" });
    forcePhase(db, root, benchmarkConfig, run.id, "plan");
    const scenario = DEFAULT_BENCHMARK_SCENARIOS.find((item) => item.name === "four-slice-standard-change");
    for (let index = 1; index <= 4; index += 1) addImplementationTask(db, run.id, benchmarkConfig, `model-wave-${index}`, 1, index);
    assert.equal(readWorkspaceModelEvidence(root).allLuna, true);
    assert.equal(candidateRuntimeContract(root, scenario), false, "nested acceptance requires an authenticated outer Luna receipt");
    const validReceipt = outerLunaReceipt(root);
    const contradictoryReceipt = { ...validReceipt, headerModel: "gpt-5.6-sol", fingerprint: "invalid" };
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: validReceipt, mainModelReceipt: contradictoryReceipt }), false, "contradictory receipt aliases fail closed");
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: { ...validReceipt, conflict: true } }), false, "receipt conflict cannot be overridden by verified");
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: { ...validReceipt, metricsModel: "gpt-5.6-sol" } }), false, "metrics/header mismatch fails closed");
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: { ...validReceipt, fingerprint: "tampered" } }), false, "receipt fingerprint is authenticated");
    db.prepare("UPDATE usage_samples SET model = 'sol' WHERE run_id = ? AND role = 'main'").run(run.id);
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: outerLunaReceipt(root) }), false);
    db.prepare("UPDATE usage_samples SET model = NULL WHERE run_id = ? AND role = 'main'").run(run.id);
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: outerLunaReceipt(root) }), true, "missing nested usage sample is covered by the outer receipt");
    db.prepare("UPDATE usage_samples SET model = ? WHERE run_id = ? AND role = 'main'").run(BENCHMARK_MODEL, run.id);
    recordUsageSample(db, run.id, { role: "main", model: "gpt-5.6-sol", observedInputTokens: 1, observedOutputTokens: 1, source: "benchmark-test" });
    recordUsageSample(db, run.id, { role: "main", model: BENCHMARK_MODEL, observedInputTokens: 1, observedOutputTokens: 1, source: "benchmark-test" });
    const allUsageEvidence = readWorkspaceModelEvidence(root, { runId: run.id });
    assert.equal(allUsageEvidence.mainUsageSampleCount, 3);
    assert.deepEqual([...allUsageEvidence.mainUsageModels].sort(), [BENCHMARK_MODEL, BENCHMARK_MODEL, "gpt-5.6-sol"].sort());
    assert.ok(allUsageEvidence.invalid.some((item) => item.source === "usage-sample" && item.model === "gpt-5.6-sol"));
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: outerLunaReceipt(root) }), false, "a later Luna sample cannot launder an earlier Sol sample");
    db.prepare("UPDATE tasks SET selected_model = 'sol' WHERE id = ?").run("model-wave-1");
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: outerLunaReceipt(root) }), false);
    db.prepare("UPDATE tasks SET selected_model = ? WHERE id = ?").run(BENCHMARK_MODEL, "model-wave-1");
    const controllerFence = db.prepare("SELECT controller_fencing_token FROM runs WHERE id = ?").get(run.id).controller_fencing_token;
    db.prepare(`
      INSERT INTO scheduler_batches(
        id, run_id, phase, status, batch_json, rationale_json, controller_fencing_token,
        claimed_task_ids_json, spawned_task_ids_json, created_at, updated_at
      ) VALUES(?, ?, 'execute', 'spawned', ?, '[]', ?, ?, '[]', ?, ?)
    `).run("model-batch", run.id, JSON.stringify([{ taskId: "model-wave-1", model: "sol" }]), controllerFence, JSON.stringify(["model-wave-1"]), new Date().toISOString(), new Date().toISOString());
    const evidence = readWorkspaceModelEvidence(root);
    assert.ok(evidence.invalid.some((item) => item.source === "descriptor" && item.model === "sol"));
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: outerLunaReceipt(root) }), false);
  } finally { db.close(); }
});

test("candidate runtime contract rejects an earlier under-sized implementation wave and mutable route spoofing", () => {
  const { root, db, config } = makeProject();
  try {
    const benchmarkConfig = enforceBenchmarkModelConfig(root).configSnapshot;
    const { run } = startTestRun(db, root, benchmarkConfig, "Benchmark early wave contract", { contract: { lifecycleProfile: "balanced" } });
    recordUsageSample(db, run.id, { role: "main", model: BENCHMARK_MODEL, observedInputTokens: 1, observedOutputTokens: 1, source: "benchmark-test" });
    forcePhase(db, root, benchmarkConfig, run.id, "plan");
    const scenario = DEFAULT_BENCHMARK_SCENARIOS.find((item) => item.name === "four-slice-standard-change");
    addImplementationTask(db, run.id, benchmarkConfig, "early-one", 1, 1);
    for (let index = 2; index <= 5; index += 1) addImplementationTask(db, run.id, benchmarkConfig, `wave-two-${index}`, 2, index);
    assert.equal(candidateRuntimeContract(root, scenario, { outerMainReceipt: outerLunaReceipt(root) }), false);
    db.prepare("UPDATE runs SET route_json = ? WHERE id = ?").run(JSON.stringify({ lifecycleProfile: "fast" }), run.id);
    const trivialScenario = DEFAULT_BENCHMARK_SCENARIOS.find((item) => item.name === "trivial-local-change");
    assert.equal(candidateRuntimeContract(root, trivialScenario, { outerMainReceipt: outerLunaReceipt(root) }), false);
    assert.equal(candidateRuntimeContract(root, { ...trivialScenario, expectedProfile: "balanced" }, { outerMainReceipt: outerLunaReceipt(root) }), true);
  } finally { db.close(); }
});
