import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { invariant } from "./errors.js";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { builtInBenchmarkPrompt, prepareBuiltInBenchmarkFixture, primeGitWorktreeAdministration } from "./benchmark-fixtures.js";
import { escalateModelRoute, negotiateEffort } from "./model-routing.js";
import { claudeSpawnDescriptor, codexSpawnDescriptor } from "../adapters/spawn-descriptors.js";
import { readObject, storeObject } from "./objects.js";
import { runtimeArea } from "./paths.js";
import { assertNoSymlinkTraversal, normalizeCommandSpec, resolveInside, safeManifestPath, substituteCommandSpec } from "./security.js";
import { recordEvent } from "./state.js";
import { makeId, now, redactValue, runCommand, sha256, stableStringify } from "./util.js";
import { CONFIG_VERSION, ROLES, SCHEMA_VERSION } from "./metadata.js";

const METIS_CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
export const BENCHMARK_MODEL = "gpt-5.6-luna";
export const BENCHMARK_MODEL_ROLES = Object.freeze([...ROLES]);
const BENCHMARK_CODEX_SUPPORTED_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

// This policy is written only into disposable benchmark fixtures.  Values
// come from the canonical role metadata/default routes, with the smallest
// schema-safe pre-execution settings called out explicitly so benchmark
// startup does not spend high-effort turns on bounded orchestration review.
const BENCHMARK_EFFORT_OVERRIDES = Object.freeze({
  scout: "low",
  synthesizer: "low",
  planner: "medium",
  "plan-critic": "low"
});

function benchmarkEffortPolicy(role, route) {
  return BENCHMARK_EFFORT_OVERRIDES[role]
    ?? route?.reasoningEffort
    ?? DEFAULT_CONFIG.models.routes[role]?.reasoningEffort
    ?? "medium";
}

/** The required deterministic suite.  Commands are deliberately supplied by
 * the caller; these records describe the contract and acceptance evidence. */
export const DEFAULT_BENCHMARK_SCENARIOS = Object.freeze([
  { name: "trivial-local-change", expectedProfile: "fast", prompt: builtInBenchmarkPrompt("trivial-local-change"), externalResearch: false },
  { name: "four-slice-standard-change", expectedProfile: "balanced", expectedFirstWaveWidth: 4, prompt: builtInBenchmarkPrompt("four-slice-standard-change") },
  { name: "eight-slice-standard-change", expectedProfile: "balanced", expectedFirstWaveWidth: 8, prompt: builtInBenchmarkPrompt("eight-slice-standard-change") },
  { name: "shared-interface-change", expectedProfile: "balanced", frozenInterface: true, prompt: builtInBenchmarkPrompt("shared-interface-change") },
  { name: "reasoning-failure", localProbe: true, expectedAttempts: ["high", "xhigh", "max"], prompt: builtInBenchmarkPrompt("reasoning-failure") },
  { name: "transient-failure", localProbe: true, expectedAttempts: ["high", "high"], prompt: builtInBenchmarkPrompt("transient-failure") },
  { name: "contract-failure", localProbe: true, expectedNoBlindRetry: true, prompt: builtInBenchmarkPrompt("contract-failure") },
  { name: "codex-host", localProbe: true, host: "codex", expectedEffortField: "reasoning_effort", prompt: builtInBenchmarkPrompt("codex-host") },
  { name: "claude-host", localProbe: true, host: "claude", expectedEffortArgument: "--effort", prompt: builtInBenchmarkPrompt("claude-host") }
]);

// Benchmark workspaces are disposable Git fixtures, and repository execution
// is still guarded by runBenchmark's explicit --allow-repository-exec gate.
// Use Codex's fully unrestricted mode inside that already-isolated boundary so
// benchmark runs do not measure approval/sandbox mediation overhead.
const CODEX_COMMAND = Object.freeze({ command: "codex", args: ["exec", "--model", BENCHMARK_MODEL, "--dangerously-bypass-approvals-and-sandbox", "--ephemeral", "-C", "{workspace}", "{prompt}"] });
const CODEX_METIS_COMMAND = Object.freeze({ ...CODEX_COMMAND, args: [...CODEX_COMMAND.args.slice(0, -1), "/goal $metis {prompt}"] });
const CLAUDE_COMMAND = Object.freeze({ command: "claude", args: ["--print", "--permission-mode", "acceptEdits", "--no-session-persistence", "{prompt}"] });
const CLAUDE_METIS_COMMAND = Object.freeze({ ...CLAUDE_COMMAND, args: [...CLAUDE_COMMAND.args.slice(0, -1), "/goal $metis {prompt}"] });
const METIS_SETUP_BY_HOST = Object.freeze({
  codex: [{ command: "{node}", args: ["--no-warnings", "{metis}", "--root", "{workspace}", "init", "--host", "codex"] }],
  claude: [{ command: "{node}", args: ["--no-warnings", "{metis}", "--root", "{workspace}", "init", "--host", "claude"] }]
});
const BASELINE_SETUP_BY_HOST = Object.freeze(Object.fromEntries(Object.entries(METIS_SETUP_BY_HOST).map(([host, setup]) => [host, [
  ...setup,
  { command: "{node}", args: ["{benchmarkFixtureTool}", "--prepare-baseline", "{workspace}"] }
]])));

export const DEFAULT_BENCHMARK_VARIANTS = Object.freeze([
  { name: "metis-pre-1.0-baseline", metisSource: "baseline", instrumentation: "controller-lease-only", command: CODEX_METIS_COMMAND, commands: { codex: CODEX_METIS_COMMAND, claude: CLAUDE_METIS_COMMAND }, setupByHost: BASELINE_SETUP_BY_HOST },
  { name: "metis-1.0.0-candidate", metisSource: "candidate", command: CODEX_METIS_COMMAND, commands: { codex: CODEX_METIS_COMMAND, claude: CLAUDE_METIS_COMMAND }, setupByHost: METIS_SETUP_BY_HOST },
  { name: "plain-host", command: CODEX_COMMAND, commands: { codex: CODEX_COMMAND, claude: CLAUDE_COMMAND } }
]);

export const BENCHMARK_ACCEPTANCE_TARGETS = Object.freeze({
  "trivial-local-change": { medianImprovement: 0.30 },
  "four-slice-standard-change": { medianImprovement: 0.20 },
  "eight-slice-standard-change": { medianImprovement: 0.20 },
  all: { timeToFirstWorkerImprovement: 0.35, p95NoRegression: true, passRateNoRegression: true }
});

const REQUIRED_VARIANT_NAMES = new Set(DEFAULT_BENCHMARK_VARIANTS.map((variant) => variant.name));
const REQUIRED_SCENARIO_NAMES = new Set(DEFAULT_BENCHMARK_SCENARIOS.map((scenario) => scenario.name));

export function benchmarkConfigPath(projectRoot) {
  return path.join(runtimeArea(projectRoot, "benchmarks"), "benchmark.json");
}

export function initializeBenchmark(projectRoot, options = {}) {
  const file = options.file ? path.resolve(options.file) : benchmarkConfigPath(projectRoot);
  invariant(!existsSync(file) || options.force, "BENCHMARK_EXISTS", `Benchmark config already exists: ${file}.`);
  const commits = resolveOfficialBenchmarkCommits(projectRoot, options, { requireClean: false });
  mkdirSync(path.dirname(file), { recursive: true });
  const config = {
    version: 2,
    name: options.name ?? "metis-evaluation",
    repetitions: 5,
    minimumRepetitions: 5,
    deterministicLocal: true,
    requiredSuite: true,
    baselineCommit: commits.baselineCommit,
    candidateCommit: commits.candidateCommit,
    timeoutMs: 900000,
    scenarios: DEFAULT_BENCHMARK_SCENARIOS.map((scenario) => ({
      ...scenario,
      builtInFixture: true,
      verify: [{ command: "{node}", args: ["{fixtureVerifier}", "--verify", "{workspace}", "{scenario}"] }]
    })),
    variants: DEFAULT_BENCHMARK_VARIANTS
  };
  writeFileSync(file, `${stableStringify(config)}\n`, "utf8");
  return { file, config };
}

/**
 * Codex benchmark runs must not inherit an uncontrolled model fallback. This
 * is applied only inside disposable Codex benchmark workspaces after their
 * Metis CLI has initialized its project config. Production defaults and other
 * hosts remain model-neutral.
 */
export function enforceBenchmarkModelConfig(workspace, options = {}) {
  const host = String(options.host ?? "codex").trim().toLowerCase();
  // The bundled reproducibility contract currently has an explicit model only
  // for Codex. Other hosts retain their own selected model unless a separate,
  // host-specific benchmark contract is added.
  if (host !== "codex") return null;
  const file = path.join(workspace, ".metis", "config.json");
  invariant(existsSync(file), "BENCHMARK_MODEL_CONFIG", `Metis fixture config is missing: ${file}.`);
  const config = JSON.parse(readFileSync(file, "utf8"));
  const currentModels = config.models && typeof config.models === "object" && !Array.isArray(config.models)
    ? config.models
    : {};
  const currentRoutes = currentModels.routes && typeof currentModels.routes === "object" && !Array.isArray(currentModels.routes)
    ? currentModels.routes
    : {};
  const routes = { ...currentRoutes };
  const configuredEfforts = currentModels.capabilities?.codex?.models?.[BENCHMARK_MODEL];
  const defaultEfforts = Array.isArray(configuredEfforts) && configuredEfforts.length > 0
    ? configuredEfforts
    : BENCHMARK_CODEX_SUPPORTED_EFFORTS;
  const effortEvidence = [];
  for (const role of BENCHMARK_MODEL_ROLES) {
    const defaultRoute = DEFAULT_CONFIG.models.routes[role] ?? { tier: "worker", reasoningEffort: "high" };
    const route = routes[role] && typeof routes[role] === "object" && !Array.isArray(routes[role]) ? routes[role] : {};
    const requestedEffort = benchmarkEffortPolicy(role, { ...defaultRoute, ...route });
    const negotiated = negotiateEffort(requestedEffort, { supportedEfforts: defaultEfforts, source: "benchmark-role-metadata" });
    invariant(negotiated.effectiveEffort === requestedEffort, "BENCHMARK_EFFORT_FALLBACK", `Benchmark role ${role} fell back from ${requestedEffort} to ${negotiated.effectiveEffort ?? "null"}.`);
    routes[role] = {
      ...defaultRoute,
      ...route,
      model: BENCHMARK_MODEL,
      reasoningEffort: negotiated.effectiveEffort
    };
    effortEvidence.push({
      role,
      requestedEffort,
      effectiveEffort: negotiated.effectiveEffort,
      supportedEfforts: negotiated.supportedEfforts,
      source: negotiated.source,
      capabilityStatus: negotiated.capabilityStatus
    });
  }
  // Preserve custom roles too, but make them explicit rather than allowing
  // an adapter/host default to silently select another model.
  for (const role of Object.keys(routes)) {
    const route = routes[role];
    if (route && typeof route === "object" && !Array.isArray(route)) routes[role] = { ...route, model: BENCHMARK_MODEL };
  }
  const capabilities = currentModels.capabilities && typeof currentModels.capabilities === "object" && !Array.isArray(currentModels.capabilities)
    ? currentModels.capabilities
    : {};
  const codexCapabilities = capabilities.codex && typeof capabilities.codex === "object" && !Array.isArray(capabilities.codex)
    ? capabilities.codex
    : {};
  const codexModels = codexCapabilities.models && typeof codexCapabilities.models === "object" && !Array.isArray(codexCapabilities.models)
    ? codexCapabilities.models
    : {};
  const nextModels = {
    ...currentModels,
    defaults: { ...(currentModels.defaults ?? {}), codex: { ...(currentModels.defaults?.codex ?? {}), worker: BENCHMARK_MODEL } },
    routes,
    benchmark: { enabled: true, efforts: Object.fromEntries(effortEvidence.map((item) => [item.role, item.effectiveEffort])) },
    capabilities: { ...capabilities, codex: { ...codexCapabilities, models: { ...codexModels, [BENCHMARK_MODEL]: codexModels[BENCHMARK_MODEL] ?? defaultEfforts } } }
  };
  const nextConfig = { ...config, version: CONFIG_VERSION, models: nextModels };
  writeFileSync(file, `${stableStringify(nextConfig)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
  return {
    file,
    model: BENCHMARK_MODEL,
    roles: [...BENCHMARK_MODEL_ROLES],
    routeCount: Object.keys(routes).length,
    effortEvidence,
    explicit: true,
    configSnapshot: nextConfig
  };
}

function benchmarkRouteModel(config, role) {
  return config?.models?.routes?.[role]?.model
    ?? config?.models?.defaults?.codex?.worker
    ?? null;
}

function pinnedBenchmarkConfig(snapshot) {
  const config = snapshot?.configSnapshot;
  invariant(config && typeof config === "object" && !Array.isArray(config), "BENCHMARK_MODEL_RECOVERY_CONFIG", "Benchmark model recovery needs the authenticated current config snapshot.");
  invariant(Number(config.version) === CONFIG_VERSION, "BENCHMARK_MODEL_RECOVERY_CONFIG", `Benchmark model recovery refuses obsolete config version ${config.version ?? "(missing)"}.`);
  invariant(config.models?.defaults?.codex?.worker === BENCHMARK_MODEL, "BENCHMARK_MODEL_RECOVERY_CONFIG", "Benchmark model recovery snapshot is not pinned to Luna.");
  for (const role of BENCHMARK_MODEL_ROLES) {
    invariant(config.models?.routes?.[role]?.model === BENCHMARK_MODEL, "BENCHMARK_MODEL_RECOVERY_CONFIG", `Benchmark model recovery route ${role} is not pinned to Luna.`);
  }
  return config;
}

function inspectBenchmarkModelRows(db, runId) {
  const schema = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
  invariant(schema === String(SCHEMA_VERSION), "BENCHMARK_MODEL_RECOVERY_SCHEMA", `Benchmark model recovery refuses state schema ${schema ?? "(missing)"}; expected ${SCHEMA_VERSION}.`);
  invariant(db.prepare("SELECT id FROM runs WHERE id = ?").get(runId), "BENCHMARK_MODEL_RUN", `Benchmark model recovery run ${runId} does not exist.`);
  const invalid = [];
  const inspected = { runId, tasks: [], attempts: [], descriptors: [] };
  let taskCount = 0;
  let attemptCount = 0;
  let descriptorCount = 0;
  const taskColumns = tableColumns(db, "tasks");
  invariant(taskColumns.has("run_id") && taskColumns.has("selected_model"), "BENCHMARK_MODEL_RECORDS", "Benchmark model recovery cannot verify task model provenance.");
  if (taskColumns.has("run_id") && taskColumns.has("selected_model")) {
    const rows = db.prepare("SELECT id, role, selected_model FROM tasks WHERE run_id = ? ORDER BY id").all(runId);
    taskCount = rows.length;
    for (const row of rows) {
      inspected.tasks.push({ id: row.id, role: row.role, model: row.selected_model ?? null });
      if (row.selected_model !== BENCHMARK_MODEL) invalid.push({ source: "task", taskId: row.id, role: row.role, model: row.selected_model ?? null });
    }
  }
  const attemptColumns = tableColumns(db, "task_attempts");
  invariant(attemptColumns.has("run_id") && attemptColumns.has("selected_model"), "BENCHMARK_MODEL_RECORDS", "Benchmark model recovery cannot verify attempt model provenance.");
  if (attemptColumns.has("run_id") && attemptColumns.has("selected_model")) {
    const rows = db.prepare("SELECT id, task_id, role, selected_model FROM task_attempts WHERE run_id = ? ORDER BY start_at, id").all(runId);
    attemptCount = rows.length;
    for (const row of rows) {
      inspected.attempts.push({ id: row.id, taskId: row.task_id, role: row.role, model: row.selected_model ?? null });
      if (row.selected_model !== BENCHMARK_MODEL) invalid.push({ source: "attempt", attemptId: row.id, taskId: row.task_id, role: row.role, model: row.selected_model ?? null });
    }
  }
  invariant(tableExists(db, "scheduler_batches"), "BENCHMARK_MODEL_RECORDS", "Benchmark model recovery cannot verify scheduler model descriptors.");
  if (tableExists(db, "scheduler_batches")) {
    const rows = db.prepare("SELECT id, batch_json FROM scheduler_batches WHERE run_id = ? ORDER BY created_at, id").all(runId);
    for (const row of rows) {
      let items;
      try { items = JSON.parse(row.batch_json ?? "[]"); } catch {
        invalid.push({ source: "descriptor", batchId: row.id, taskId: null, model: null, parseError: true });
        continue;
      }
      if (!Array.isArray(items)) {
        invalid.push({ source: "descriptor", batchId: row.id, taskId: null, model: null, parseError: true });
        continue;
      }
      for (const item of items) {
        descriptorCount += 1;
        const taskId = item && typeof item === "object" ? item.taskId ?? item.task_id ?? null : null;
        const model = item && typeof item === "object" ? item.model ?? null : null;
        inspected.descriptors.push({ batchId: row.id, taskId, model });
        if (model !== BENCHMARK_MODEL) invalid.push({ source: "descriptor", batchId: row.id, taskId, model });
      }
    }
  }
  return { runId, taskCount, attemptCount, descriptorCount, allLuna: invalid.length === 0, invalid, inspected, inspectionFingerprint: sha256(stableStringify(inspected)) };
}

/**
 * Restore the authenticated benchmark config after a host process exits.
 * Host crash recovery may put an obsolete workspace snapshot back in place;
 * that snapshot must never replace the current Luna routing or null model
 * provenance in durable scheduler records.
 */
export function restoreBenchmarkModelConfig(workspace, snapshot, options = {}) {
  const config = pinnedBenchmarkConfig(snapshot);
  const runId = options.runId ?? snapshot?.runId;
  invariant(typeof runId === "string" && runId.length > 0, "BENCHMARK_MODEL_RUN", "Benchmark model recovery requires the exact benchmark run ID.");
  if (snapshot?.runId !== undefined) invariant(snapshot.runId === runId, "BENCHMARK_MODEL_RUN", "Benchmark model recovery run ID does not match the authenticated snapshot.");
  const file = path.join(workspace, ".metis", "config.json");
  let current = null;
  try { current = JSON.parse(readFileSync(file, "utf8")); } catch {}
  const currentPinned = Number(current?.version) === CONFIG_VERSION
    && current?.models?.defaults?.codex?.worker === BENCHMARK_MODEL
    && BENCHMARK_MODEL_ROLES.every((role) => current?.models?.routes?.[role]?.model === BENCHMARK_MODEL);
  const stateFile = path.join(runtimeArea(workspace, "state"), "state.db");
  invariant(existsSync(stateFile), "BENCHMARK_MODEL_RUN", "Benchmark model recovery state database is missing.");
  const db = new DatabaseSync(stateFile);
  let state = { runId, taskCount: 0, attemptCount: 0, descriptorCount: 0, allLuna: false, invalid: [] };
  let quarantined = null;
  let recoveryEvent = null;
  try {
    db.exec("BEGIN IMMEDIATE");
    const recoveryTimestamp = now();
    db.prepare("UPDATE runs SET controller_fencing_token = controller_fencing_token + 1, revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'active'")
      .run(recoveryTimestamp, runId);
    db.prepare("UPDATE scheduler_batches SET status = 'aborted', aborted_reason = 'benchmark model recovery fenced active descendants', updated_at = ? WHERE run_id = ? AND status IN ('claimed', 'prepared', 'partially-spawned', 'spawned')")
      .run(recoveryTimestamp, runId);
    db.prepare("UPDATE leases SET expires_at = ? WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)")
      .run(recoveryTimestamp, runId);
    // Validate the exact run before touching the config or any durable state.
    state = inspectBenchmarkModelRows(db, runId);
    if (!currentPinned) {
      if (existsSync(file)) {
        quarantined = `${file}.obsolete-${Date.now()}.json`;
        renameSync(file, quarantined);
      }
      writeFileSync(file, `${stableStringify(config)}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(file, 0o600);
    }
      recoveryEvent = recordEvent(db, runId, "benchmark.model-recovery", state.allLuna ? "info" : "error", {
        runId,
        restoredConfig: !currentPinned,
        quarantinedConfig: quarantined,
        allLuna: state.allLuna,
        invalid: state.invalid,
        inspection: state.inspected,
        inspectionFingerprint: state.inspectionFingerprint
      });
      if (!state.allLuna) {
        db.prepare("UPDATE runs SET status = 'blocked', updated_at = ?, revision = revision + 1 WHERE id = ? AND status IN ('active', 'paused')")
          .run(now(), runId);
      }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { db.close(); }
  const recoveryReceipt = {
    runId,
    eventCount: 1,
    eventFingerprints: [recoveryEvent.fingerprint],
    inspectionFingerprint: state.inspectionFingerprint,
    taskCount: state.taskCount,
    attemptCount: state.attemptCount,
    descriptorCount: state.descriptorCount,
    invalidCount: state.invalid.length,
    allLuna: state.allLuna
  };
  return {
    ...snapshot,
    file,
    restored: !currentPinned,
    quarantined,
    state,
    recoveryReceipt
  };
}

function pruneEmpty(directory, stop) {
  let current = path.resolve(directory);
  const boundary = path.resolve(stop);
  while (current.startsWith(`${boundary}${path.sep}`)) {
    if (!existsSync(current)) { current = path.dirname(current); continue; }
    if (readdirSync(current).length > 0) break;
    rmSync(current, { recursive: true, force: true });
    current = path.dirname(current);
  }
}

export function stripInstalledMetis(source, target) {
  const manifestFile = path.join(source, ".agents", "metis", "install-manifest.json");
  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    for (const record of manifest.files ?? []) {
      const installed = safeManifestPath(target, record.path, { code: "BENCHMARK_MANIFEST_PATH" }).absolute;
      rmSync(installed, { recursive: true, force: true });
      pruneEmpty(path.dirname(installed), target);
    }
    const marketplaceRecord = manifest.marketplace;
    if (marketplaceRecord?.path) {
      const marketplaceFile = safeManifestPath(target, marketplaceRecord.path, { code: "BENCHMARK_MANIFEST_PATH" }).absolute;
      if (existsSync(marketplaceFile)) {
        const marketplace = JSON.parse(readFileSync(marketplaceFile, "utf8"));
        marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
        const index = marketplace.plugins.findIndex((item) => item?.name === "metis");
        if (index >= 0) {
          if (marketplaceRecord.previousEntry) marketplace.plugins[index] = marketplaceRecord.previousEntry;
          else marketplace.plugins.splice(index, 1);
        }
        if (marketplaceRecord.fileCreated && marketplace.plugins.length === 0) {
          rmSync(marketplaceFile, { force: true });
          pruneEmpty(path.dirname(marketplaceFile), target);
        } else writeFileSync(marketplaceFile, `${stableStringify(marketplace)}\n`, "utf8");
      }
    }
  }
  rmSync(path.join(target, ".metis"), { recursive: true, force: true });
  rmSync(path.join(target, ".agents", "metis"), { recursive: true, force: true });
}

function copyFixture(source, target) {
  cpSync(source, target, {
    recursive: true,
    filter: (candidate) => ![".git", ".metis", "node_modules", "dist", "build", "coverage"].includes(path.basename(candidate))
  });
  stripInstalledMetis(source, target);
}

function initializeGit(workspace) {
  if (runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspace, timeout: 5000 }).status !== 0) {
    runCommand("git", ["init", "-q"], { cwd: workspace, timeout: 5000 });
  }
  runCommand("git", ["add", "-A"], { cwd: workspace, timeout: 30000 });
  runCommand("git", ["-c", "user.name=Metis", "-c", "user.email=metis@local", "commit", "-qm", "benchmark baseline", "--allow-empty"], { cwd: workspace, timeout: 30000 });
  primeGitWorktreeAdministration(workspace);
}

function prepareFixtureVerifier(workspace, scenario) {
  const file = path.join(workspace, ".metis-benchmark-verifier.mjs");
  const resultFile = JSON.stringify(String(scenario.resultFile ?? ".metis-benchmark-result.json"));
  writeFileSync(file, `import { readFileSync } from "node:fs";\nconst expected = process.argv[2];\nconst value = JSON.parse(readFileSync(${resultFile}, "utf8"));\nif (value.scenario !== expected || value.verified !== true) throw new Error("Benchmark fixture contract failed: expected a verified result marker for the scenario.");\n`, "utf8");
  return file;
}

function resolveBenchmarkCommit(projectRoot, value, code, label) {
  invariant(typeof value === "string" && value.trim().length > 0, code, `${label} commit must be supplied explicitly.`);
  const result = runCommand("git", ["rev-parse", "--verify", `${value.trim()}^{commit}`], { cwd: projectRoot, timeout: 5000 });
  invariant(result.status === 0, code, `${label} commit is unavailable: ${value}.`);
  const commit = result.stdout.trim();
  invariant(/^[0-9a-f]{40}$/.test(commit), code, `${label} commit did not resolve to a full SHA.`);
  return commit;
}

function resolveOfficialBenchmarkCommits(projectRoot, config, options = {}) {
  if (options.requireClean === true) {
    const status = runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: projectRoot, timeout: 10000 });
    invariant(status.status === 0, "BENCHMARK_REPOSITORY", `Unable to inspect benchmark repository status: ${status.stderr || status.error || "unknown error"}`);
    invariant(status.stdout.trim() === "", "BENCHMARK_DIRTY_REPOSITORY", "Official benchmarks require a clean repository checkout.");
  }
  const baselineCommit = resolveBenchmarkCommit(projectRoot, config.baselineCommit, "BENCHMARK_BASELINE_COMMIT", "Baseline");
  const candidateCommit = resolveBenchmarkCommit(projectRoot, config.candidateCommit, "BENCHMARK_CANDIDATE_COMMIT", "Candidate");
  invariant(baselineCommit !== candidateCommit, "BENCHMARK_COMMITS", "Official benchmark baseline and candidate commits must differ.");
  const head = resolveBenchmarkCommit(projectRoot, "HEAD", "BENCHMARK_CANDIDATE_COMMIT", "Current checkout");
  invariant(candidateCommit === head, "BENCHMARK_CANDIDATE_COMMIT", "Candidate provenance must match the benchmark repository HEAD.");
  return { baselineCommit, candidateCommit, head };
}

function createBaselineWorktree(projectRoot, workspaceRoot, commit) {
  const verified = resolveBenchmarkCommit(projectRoot, commit, "BENCHMARK_BASELINE_COMMIT", "Baseline");
  const directory = path.join(workspaceRoot, "metis-baseline-cli");
  const added = runCommand("git", ["worktree", "add", "--detach", directory, verified], { cwd: projectRoot, timeout: 30000 });
  invariant(added.status === 0, "BENCHMARK_BASELINE_WORKTREE", `Unable to materialize baseline Metis CLI: ${added.stderr || added.error || "unknown error"}`);
  return { directory, cli: path.join(directory, "src", "cli.js"), commit: verified };
}

function removeBaselineWorktree(projectRoot, baseline) {
  if (!baseline) return;
  runCommand("git", ["worktree", "remove", "--force", baseline.directory], { cwd: projectRoot, timeout: 30000 });
}

function changedFiles(workspace) {
  const result = runCommand("git", ["status", "--porcelain=v1", "-z"], { cwd: workspace, timeout: 10000 });
  if (result.status !== 0) return [];
  return result.stdout.split("\0").filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean).sort();
}

function readUsage(workspace, usageFile) {
  if (usageFile) {
    const file = resolveInside(workspace, usageFile, { code: "BENCHMARK_USAGE_PATH" }).absolute;
    if (!existsSync(file)) return { inputTokens: null, outputTokens: null };
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      const inputTokens = Number(value.inputTokens ?? value.input_tokens ?? value.usage?.input_tokens);
      const outputTokens = Number(value.outputTokens ?? value.output_tokens ?? value.usage?.output_tokens);
      return {
        inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
        outputTokens: Number.isFinite(outputTokens) ? outputTokens : null
      };
    } catch { return { inputTokens: null, outputTokens: null }; }
  }
  const stateFile = path.join(workspace, ".metis", "state", "state.db");
  if (!existsSync(stateFile)) return { inputTokens: null, outputTokens: null };
  let db;
  try {
    db = new DatabaseSync(stateFile, { readOnly: true });
    if (!tableExists(db, "usage_samples")) return { inputTokens: null, outputTokens: null };
    const observed = db.prepare(`
      SELECT COUNT(*) AS samples, SUM(observed_input_tokens) AS input_tokens,
        SUM(observed_output_tokens) AS output_tokens
      FROM usage_samples
      WHERE observed_input_tokens IS NOT NULL OR observed_output_tokens IS NOT NULL
    `).get();
    if (Number(observed?.samples ?? 0) === 0) return { inputTokens: null, outputTokens: null };
    return {
      inputTokens: observed.input_tokens === null ? null : Number(observed.input_tokens),
      outputTokens: observed.output_tokens === null ? null : Number(observed.output_tokens)
    };
  } catch { return { inputTokens: null, outputTokens: null }; }
  finally { try { db?.close(); } catch {} }
}

function readMetricsFile(workspace, metricsFile) {
  if (!metricsFile) return {};
  const file = resolveInside(workspace, metricsFile, { code: "BENCHMARK_METRICS_PATH" }).absolute;
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    const number = (key) => Number.isFinite(Number(value[key])) ? Number(value[key]) : null;
    return {
      timeToFirstWorkerMs: number("timeToFirstWorkerMs") ?? number("time_to_first_worker_ms"),
      maxConcurrency: number("maxConcurrency") ?? number("max_concurrency"),
      slotUtilization: number("slotUtilization") ?? number("slot_utilization"),
      retryCount: number("retryCount") ?? number("retry_count"),
      host: value.host ?? null,
      model: value.model ?? null,
      mainModel: value.mainModel ?? value.main_model ?? null,
      ...(Array.isArray(value.mainModelObservations ?? value.main_model_observations)
        ? { mainModelObservations: value.mainModelObservations ?? value.main_model_observations }
        : {}),
      requestedEffort: value.requestedEffort ?? value.requested_effort ?? null,
      effectiveEffort: value.effectiveEffort ?? value.effective_effort ?? null
    };
  } catch { return {}; }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function concurrencyMetrics(intervals, capacity) {
  const endpoints = intervals.flatMap(({ start, end }) => [
    { at: Date.parse(start), delta: 1 },
    { at: Date.parse(end), delta: -1 }
  ]).filter((item) => Number.isFinite(item.at)).sort((left, right) => left.at - right.at || left.delta - right.delta);
  if (endpoints.length < 2) return { maxConcurrency: endpoints.length ? 1 : null, slotUtilization: endpoints.length ? 1 / capacity : null };
  let active = 0;
  let maximum = 0;
  let weightedMs = 0;
  let previousAt = endpoints[0].at;
  for (const endpoint of endpoints) {
    weightedMs += active * Math.max(0, endpoint.at - previousAt);
    active += endpoint.delta;
    maximum = Math.max(maximum, active);
    previousAt = endpoint.at;
  }
  const spanMs = Math.max(0, endpoints.at(-1).at - endpoints[0].at);
  return {
    maxConcurrency: maximum,
    slotUtilization: spanMs > 0 && capacity > 0 ? weightedMs / spanMs / capacity : null
  };
}

/** Read orchestration evidence without opening the workspace through the
 * candidate schema. This also works for the unmodified 1.0.0 baseline and is
 * intentionally observational: benchmark instrumentation must not change the
 * behavior being measured. */
export function readWorkspaceRunMetrics(workspace) {
  const file = path.join(workspace, ".metis", "state", "state.db");
  if (!existsSync(file)) return {};
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const run = db.prepare("SELECT id, created_at, updated_at FROM runs ORDER BY created_at DESC LIMIT 1").get();
    if (!run) return {};
    let intervals = [];
    let firstWorkerAt = null;
    let retryCount = null;
    let mainModel = null;
    let mainModelObservations = [];
    let provenance = {};
    if (tableExists(db, "usage_samples")) {
      const usageRows = db.prepare(`
        SELECT model FROM usage_samples
        WHERE run_id = ? AND role = 'main'
        ORDER BY created_at, id
      `).all(run.id);
      mainModelObservations = usageRows.map((row) => row.model === null || String(row.model).trim() === "" ? null : String(row.model).trim());
      mainModel = mainModelObservations.filter(Boolean).at(-1) ?? null;
    }
    if (tableExists(db, "task_attempts")) {
      const attempts = db.prepare(`
        SELECT attempt.*, task.task_kind
        FROM task_attempts attempt JOIN tasks task ON task.id = attempt.task_id
        WHERE attempt.run_id = ? ORDER BY attempt.start_at, attempt.id
      `).all(run.id);
      intervals = attempts.map((attempt) => ({
        start: attempt.spawn_accepted_at ?? attempt.start_at,
        end: attempt.execution_ended_at ?? attempt.terminal_at ?? run.updated_at
      }));
      firstWorkerAt = attempts.filter((attempt) => attempt.role === "worker" && attempt.task_kind === "implementation")
        .map((attempt) => attempt.spawn_accepted_at ?? attempt.start_at)
        .filter(Boolean).sort()[0] ?? null;
      retryCount = Math.max(0, attempts.length - new Set(attempts.map((attempt) => attempt.task_id)).size);
      const latest = attempts.at(-1) ?? {};
      provenance = {
        host: latest.host ?? null,
        model: latest.selected_model ?? null,
        requestedEffort: latest.requested_effort ?? null,
        effectiveEffort: latest.effective_effort ?? null
      };
    } else if (tableExists(db, "task_spawn_acks")) {
      const attempts = db.prepare(`
        SELECT ack.task_id, ack.attempt_fence, ack.acknowledged_at AS start_at,
          task.updated_at AS terminal_at, task.role, task.task_kind, task.attempts,
          task.selected_model, task.reasoning_effort
        FROM task_spawn_acks ack JOIN tasks task ON task.id = ack.task_id
        WHERE task.run_id = ? ORDER BY ack.acknowledged_at, ack.task_id
      `).all(run.id);
      intervals = attempts.map((attempt) => ({ start: attempt.start_at, end: attempt.terminal_at ?? run.updated_at }));
      firstWorkerAt = attempts.filter((attempt) => attempt.role === "worker" && attempt.task_kind === "implementation").map((attempt) => attempt.start_at).filter(Boolean).sort()[0] ?? null;
      const taskRows = db.prepare("SELECT attempts FROM tasks WHERE run_id = ?").all(run.id);
      retryCount = taskRows.reduce((sum, task) => sum + Math.max(0, Number(task.attempts ?? 0) - 1), 0);
      const latest = attempts.at(-1) ?? {};
      provenance = {
        host: null,
        model: latest.selected_model ?? null,
        requestedEffort: latest.reasoning_effort ?? null,
        effectiveEffort: latest.reasoning_effort ?? null
      };
    }
    let capacity = 8;
    try {
      const config = JSON.parse(readFileSync(path.join(workspace, ".metis", "config.json"), "utf8"));
      capacity = Math.max(1, Number(config.orchestration?.maxConcurrent ?? capacity));
    } catch {}
    const concurrency = concurrencyMetrics(intervals, capacity);
    return {
      timeToFirstWorkerMs: firstWorkerAt ? Math.max(0, Date.parse(firstWorkerAt) - Date.parse(run.created_at)) : null,
      maxConcurrency: concurrency.maxConcurrency,
      slotUtilization: concurrency.slotUtilization,
      retryCount,
      mainModel,
      mainModelObservations,
      ...provenance
    };
  } catch { return {}; }
  finally { try { db?.close(); } catch {} }
}

function readRunMetrics(workspace, metricsFile) {
  return { ...readWorkspaceRunMetrics(workspace), ...readMetricsFile(workspace, metricsFile) };
}

function tableColumns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function workspaceRunRows(workspace) {
  const file = path.join(workspace, ".metis", "state", "state.db");
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT id, created_at FROM runs ORDER BY created_at, id").all(); }
  finally { db.close(); }
}

function resolveBenchmarkRunId(workspace, priorRunIds) {
  const rows = workspaceRunRows(workspace);
  const prior = new Set(priorRunIds ?? []);
  const created = rows.filter((row) => !prior.has(row.id));
  invariant(created.length === 1, "BENCHMARK_MODEL_RUN", created.length === 0
    ? "Benchmark execution did not create an identifiable run."
    : "Benchmark execution created multiple runs; exact run binding is ambiguous.");
  return created[0].id;
}

/** Read every persisted nested model selection and scheduler batch model. */
export function readWorkspaceModelEvidence(workspace, options = {}) {
  const file = path.join(workspace, ".metis", "state", "state.db");
  if (!existsSync(file)) return { expectedModel: BENCHMARK_MODEL, allLuna: false, error: "state database is missing" };
  const hasRequestedRunId = typeof options === "string" || Object.prototype.hasOwnProperty.call(options, "runId");
  const requestedRunId = typeof options === "string" ? options : options?.runId;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const runs = db.prepare("SELECT id FROM runs ORDER BY created_at, id").all();
    const run = hasRequestedRunId
      ? db.prepare("SELECT id FROM runs WHERE id = ?").get(requestedRunId)
      : runs.length === 1 ? runs[0] : null;
    if (!run) return { expectedModel: BENCHMARK_MODEL, allLuna: false, runId: requestedRunId ?? null, error: hasRequestedRunId ? `run ${requestedRunId || "(missing)"} is missing` : runs.length === 0 ? "run is missing" : "run ID is ambiguous" };
    const runRecord = db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id);
    const recoveryEvents = tableExists(db, "events")
      ? db.prepare("SELECT id, type, fingerprint, payload_json FROM events WHERE run_id = ? AND type = 'benchmark.model-recovery' ORDER BY created_at, id").all(run.id)
      : [];
    const expectedReceipt = options && typeof options === "object" ? options.recoveryReceipt : null;
    let recoveryInvalid = false;
    let recoveryReceiptValid = expectedReceipt ? true : null;
    for (const event of recoveryEvents) {
      try {
        const payload = JSON.parse(event.payload_json ?? "{}");
        const canonicalFingerprint = sha256(stableStringify({ type: event.type, payload: redactValue(payload) }));
        const fingerprintValid = payload.inspection && payload.inspectionFingerprint === sha256(stableStringify(payload.inspection));
        if (event.fingerprint !== canonicalFingerprint || payload.allLuna !== true || !Array.isArray(payload.invalid) || payload.invalid.length > 0 || !fingerprintValid) recoveryInvalid = true;
      } catch { recoveryInvalid = true; }
    }
    if (expectedReceipt) {
      const currentFingerprints = recoveryEvents.map((event) => event.fingerprint);
      const lastPayload = recoveryEvents.length ? JSON.parse(recoveryEvents.at(-1).payload_json ?? "{}") : null;
      if (expectedReceipt.runId !== run.id
          || expectedReceipt.eventCount !== recoveryEvents.length
          || stableStringify(expectedReceipt.eventFingerprints ?? []) !== stableStringify(currentFingerprints)
          || !recoveryEvents.length
          || expectedReceipt.inspectionFingerprint !== lastPayload?.inspectionFingerprint) {
        recoveryReceiptValid = false;
        recoveryInvalid = true;
      }
    }
    const runBlocked = runRecord?.status === "blocked";
    const mainUsageSamples = tableExists(db, "usage_samples")
      ? db.prepare(`
        SELECT id, model, created_at FROM usage_samples
        WHERE run_id = ? AND role = 'main'
        ORDER BY created_at, id
      `).all(run.id).map((sample) => ({
        id: sample.id,
        model: sample.model === null || String(sample.model).trim() === "" ? null : String(sample.model).trim(),
        createdAt: sample.created_at ?? null
      }))
      : [];
    const mainUsageModels = mainUsageSamples.map((sample) => sample.model).filter((model) => model !== null);
    const mainModel = mainUsageModels.at(-1) ?? null;
    const mainUsageInvalid = mainUsageSamples.filter((sample) => sample.model !== null && sample.model !== BENCHMARK_MODEL);
    const taskColumns = tableColumns(db, "tasks");
    if (!taskColumns.has("run_id") || !taskColumns.has("selected_model")) return { expectedModel: BENCHMARK_MODEL, allLuna: false, runId: run.id, error: "task model provenance schema is missing" };
    const tasks = taskColumns.has("run_id")
      ? db.prepare(`SELECT role, ${taskColumns.has("model_tier") ? "model_tier" : "NULL AS model_tier"}, selected_model, ${taskColumns.has("model_source") ? "model_source" : "NULL AS model_source"} FROM tasks WHERE run_id = ? ORDER BY id`).all(run.id)
      : [];
    const attemptColumns = tableColumns(db, "task_attempts");
    if (!attemptColumns.has("run_id") || !attemptColumns.has("selected_model")) return { expectedModel: BENCHMARK_MODEL, allLuna: false, runId: run.id, error: "attempt model provenance schema is missing" };
    const attempts = attemptColumns.has("run_id") && attemptColumns.has("selected_model")
      ? db.prepare(`SELECT task_id, role, ${attemptColumns.has("tier") ? "tier" : "NULL AS tier"}, selected_model, ${attemptColumns.has("model_source") ? "model_source" : "NULL AS model_source"} FROM task_attempts WHERE run_id = ? ORDER BY start_at, id`).all(run.id)
      : [];
    const descriptors = [];
    if (!tableExists(db, "scheduler_batches")) return { expectedModel: BENCHMARK_MODEL, allLuna: false, runId: run.id, error: "scheduler model descriptor schema is missing" };
    if (tableExists(db, "scheduler_batches")) {
      const batches = db.prepare("SELECT id, batch_json FROM scheduler_batches WHERE run_id = ? ORDER BY created_at, id").all(run.id);
      for (const batch of batches) {
        try {
          const items = JSON.parse(batch.batch_json ?? "[]");
          if (!Array.isArray(items)) throw new Error("batch_json is not an array");
          for (const item of items) descriptors.push({ batchId: batch.id, taskId: item && typeof item === "object" ? item.taskId ?? item.task_id ?? null : null, model: item && typeof item === "object" ? item.model ?? null : null });
        } catch {
          descriptors.push({ batchId: batch.id, taskId: null, model: null, parseError: true });
        }
      }
    }
    const configuredRoutes = [];
    try {
      const config = JSON.parse(readFileSync(path.join(workspace, ".metis", "config.json"), "utf8"));
      for (const role of BENCHMARK_MODEL_ROLES) configuredRoutes.push({ role, model: config.models?.routes?.[role]?.model ?? null });
    } catch {
      configuredRoutes.push({ role: null, model: null, error: "fixture config is missing or invalid" });
    }
    const invalid = [
      ...(runBlocked ? [{ source: "run", runId: run.id, status: runRecord.status }] : []),
      ...(recoveryInvalid ? [{ source: "recovery", runId: run.id, model: null }] : []),
      ...mainUsageInvalid.map((sample) => ({ source: "usage-sample", id: sample.id, model: sample.model, createdAt: sample.createdAt })),
      ...configuredRoutes.filter((item) => item.model !== BENCHMARK_MODEL).map((item) => ({ source: "route", role: item.role, model: item.model })),
      ...tasks.filter((item) => item.selected_model !== BENCHMARK_MODEL).map((item) => ({ source: "task", role: item.role, model: item.selected_model ?? null })),
      ...attempts.filter((item) => item.selected_model !== BENCHMARK_MODEL).map((item) => ({ source: "attempt", taskId: item.task_id, role: item.role, model: item.selected_model ?? null })),
      ...descriptors.filter((item) => item.model !== BENCHMARK_MODEL).map((item) => ({ source: "descriptor", batchId: item.batchId, taskId: item.taskId, model: item.model }))
    ];
    return {
      expectedModel: BENCHMARK_MODEL,
      runId: run.id,
      runStatus: runRecord?.status ?? null,
      recoveryInvalid,
      recoveryReceiptValid,
      allLuna: invalid.length === 0 && !runBlocked && !recoveryInvalid,
      mainModel,
      mainUsageSamples,
      mainUsageSampleCount: mainUsageSamples.length,
      mainUsageModels,
      mainUsageInvalid,
      taskCount: tasks.length,
      attemptCount: attempts.length,
      descriptorCount: descriptors.length,
      routeCount: configuredRoutes.length,
      routes: configuredRoutes,
      tasks: tasks.map((item) => ({ role: item.role, tier: item.model_tier, selectedModel: item.selected_model ?? null, source: item.model_source ?? null })),
      attempts: attempts.map((item) => ({ taskId: item.task_id, role: item.role, tier: item.tier, selectedModel: item.selected_model ?? null, source: item.model_source ?? null })),
      descriptors,
      invalid
    };
  } catch (error) {
    return { expectedModel: BENCHMARK_MODEL, allLuna: false, error: error instanceof Error ? error.message : String(error) };
  } finally { try { db?.close(); } catch {} }
}

function commandModel(spec) {
  if (!spec || spec.command !== "codex") return null;
  const args = Array.isArray(spec.args) ? spec.args : [];
  const index = args.indexOf("--model");
  return index >= 0 ? args[index + 1] ?? null : null;
}

export function parseCodexStartupHeader(stderr, expectedWorkspace = null, expectedProvider = "openai") {
  const lines = String(stderr ?? "").split(/\r?\n/u);
  const versionLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^OpenAI Codex v\d+(?:\.\d+){2,}(?:[-+][A-Za-z0-9.-]+)?$/u.test(line));
  const fail = (reason) => ({ valid: false, reason, models: [], model: null, workdir: null, provider: null });
  if (versionLines.length !== 1) return fail(versionLines.length === 0 ? "missing-version-header" : "ambiguous-version-header");
  const headerStart = versionLines[0].index;
  if (lines[headerStart + 1] !== "--------") return fail("missing-opening-delimiter");
  const headerEnd = lines.indexOf("--------", headerStart + 2);
  if (headerEnd < 0) return fail("missing-closing-delimiter");
  const afterHeader = lines.slice(headerEnd + 1).find((line) => line.trim() !== "");
  if (afterHeader !== "user") return fail("missing-user-section");
  const fields = { workdir: [], model: [], provider: [] };
  for (const line of lines.slice(headerStart + 2, headerEnd)) {
    const match = /^(workdir|model|provider):[ \t]+([^\r\n]+)$/u.exec(line);
    if (match) fields[match[1]].push(match[2].trim());
  }
  if (fields.workdir.length !== 1 || fields.model.length !== 1 || fields.provider.length !== 1) return fail("invalid-header-fields");
  const workdir = fields.workdir[0];
  const provider = fields.provider[0];
  if (expectedWorkspace !== null && path.resolve(workdir) !== path.resolve(String(expectedWorkspace))) return fail("workdir-mismatch");
  if (expectedProvider !== null && provider !== expectedProvider) return fail("provider-mismatch");
  return { valid: true, reason: null, models: [fields.model[0]], model: fields.model[0], workdir, provider };
}

export function parseCodexStartupModels(stderr, expectedWorkspace = null, expectedProvider = "openai") {
  return parseCodexStartupHeader(stderr, expectedWorkspace, expectedProvider).models;
}

const OUTER_MAIN_RECEIPT_SCHEMA = "benchmark.outer-main-receipt.v1";
const OUTER_MAIN_RECEIPT_SOURCE = "benchmark.outer-runner.codex-startup-header";
const OUTER_RECEIPT_ALIASES = Object.freeze(["outerMainReceipt", "mainModelReceipt", "outerRunnerReceipt", "runnerReceipt"]);

function outerMainReceiptPayload(receipt) {
  const { fingerprint: ignored, ...payload } = receipt ?? {};
  return payload;
}

/**
 * Validate the one in-memory outer-runner model receipt used by candidate
 * runtime checks and persisted benchmark acceptance. The fingerprint binds
 * the exact startup/metrics observations; aliases are resolved separately so
 * contradictory caller fields cannot silently select one route.
 */
export function validateOuterMainReceipt(receipt, options = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  if (receipt.schema !== OUTER_MAIN_RECEIPT_SCHEMA || receipt.source !== OUTER_MAIN_RECEIPT_SOURCE) return false;
  if (Object.prototype.hasOwnProperty.call(receipt, "requested")
      || Object.prototype.hasOwnProperty.call(receipt, "effective")
      || Object.prototype.hasOwnProperty.call(receipt, "model")) return false;
  if (receipt.requestedModel !== BENCHMARK_MODEL || receipt.headerModel !== BENCHMARK_MODEL) return false;
  if (receipt.conflict !== false || receipt.verified !== true) return false;
  if (!Object.prototype.hasOwnProperty.call(receipt, "metricsModel")
      || !Object.prototype.hasOwnProperty.call(receipt, "metricsModels")
      || !Object.prototype.hasOwnProperty.call(receipt, "metricsObservations")
      || !Number.isInteger(receipt.metricsSampleCount)
      || receipt.metricsSampleCount < 0
      || !Array.isArray(receipt.metricsModels)
      || !Array.isArray(receipt.metricsObservations)
      || receipt.metricsSampleCount !== receipt.metricsObservations.length
      || stableStringify(receipt.metricsModels) !== stableStringify(receipt.metricsObservations.filter((model) => model !== null))) return false;
  if (receipt.metricsModel !== null && receipt.metricsModel !== BENCHMARK_MODEL) return false;
  if (receipt.metricsModel !== null && receipt.metricsModel !== receipt.headerModel) return false;
  if (receipt.metricsModel !== null && !receipt.metricsModels.includes(receipt.metricsModel)) return false;
  if (receipt.metricsModels.some((model) => model !== BENCHMARK_MODEL)
      || receipt.metricsObservations.some((model) => model !== null && model !== BENCHMARK_MODEL)) return false;
  const provenance = receipt.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)
      || provenance.command !== "codex"
      || provenance.provider !== "openai"
      || provenance.headerValid !== true
      || typeof provenance.workspace !== "string"
      || !path.isAbsolute(provenance.workspace)) return false;
  if (options.expectedWorkspace !== undefined && path.resolve(provenance.workspace) !== path.resolve(String(options.expectedWorkspace))) return false;
  if (receipt.fingerprint !== sha256(stableStringify(outerMainReceiptPayload(receipt)))) return false;
  return true;
}

function resolveOuterMainReceipt(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return { receipt: null, conflict: false };
  const aliases = OUTER_RECEIPT_ALIASES
    .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
    .map((key) => ({ key, value: source[key] }));
  if (aliases.length > 1 && aliases.some(({ value }) => stableStringify(value) !== stableStringify(aliases[0].value))) {
    return { receipt: null, conflict: true, aliases: aliases.map(({ key }) => key) };
  }
  return { receipt: aliases.length ? aliases[0].value : null, conflict: false, aliases: aliases.map(({ key }) => key) };
}

function mainModelEvidence(commandSpec, execution, measured, applicable, workspace) {
  if (!applicable) return {
    expected: BENCHMARK_MODEL,
    applicable: false,
    requested: null,
    effective: null,
    source: "not-applicable",
    verified: null,
    cliModels: [],
    headerValid: null,
    headerReason: "not-applicable",
    metricsModel: null,
    conflict: false
  };
  const requested = commandModel(commandSpec);
  const header = parseCodexStartupHeader(execution.stderr ?? "", workspace, "openai");
  const cliModels = header.models;
  const effective = header.valid ? header.model : null;
  const metricsObservations = Array.isArray(measured.mainModelObservations)
    ? measured.mainModelObservations.map((model) => model === null || String(model).trim() === "" ? null : String(model).trim())
    : [];
  if (measured.mainModel !== null && measured.mainModel !== undefined
      && !metricsObservations.includes(String(measured.mainModel).trim())) {
    metricsObservations.push(String(measured.mainModel).trim());
  }
  const metricsModels = metricsObservations.filter((model) => model !== null);
  const metricsModel = measured.mainModel ?? metricsModels.at(-1) ?? null;
  const conflict = Boolean(effective && metricsModels.some((model) => model !== effective));
  const outerMainReceipt = {
    schema: OUTER_MAIN_RECEIPT_SCHEMA,
    source: OUTER_MAIN_RECEIPT_SOURCE,
    requestedModel: requested,
    headerModel: effective,
    metricsModel,
    metricsModels,
    metricsObservations,
    metricsSampleCount: metricsObservations.length,
    conflict,
    verified: requested === BENCHMARK_MODEL && header.valid && effective === BENCHMARK_MODEL && !conflict,
    provenance: {
      command: commandSpec?.command ?? null,
      provider: header.provider,
      workspace: path.resolve(workspace),
      headerValid: header.valid
    }
  };
  outerMainReceipt.fingerprint = sha256(stableStringify(outerMainReceiptPayload(outerMainReceipt)));
  const outerReceiptValid = validateOuterMainReceipt(outerMainReceipt, { expectedWorkspace: workspace });
  return {
    expected: BENCHMARK_MODEL,
    applicable: true,
    requested,
    effective,
    source: header.valid ? "codex-startup-banner" : "invalid-codex-startup-banner",
    cliModels,
    headerValid: header.valid,
    headerReason: header.reason,
    metricsModel,
    conflict,
    verified: outerReceiptValid,
    outerMainReceipt,
    outerReceiptValid
  };
}

function candidatePolicyContract(scenarioName) {
  const config = {
    host: "codex",
    models: {
      routes: { worker: { tier: "worker", model: null, reasoningEffort: "high" } },
      defaults: { codex: { worker: "gpt-5.6-luna" } },
      capabilities: { codex: { models: { "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"] } } }
    }
  };
  const task = {
    role: "worker", model_tier: "worker", selected_model: "gpt-5.6-luna", model_source: "host-default",
    requested_effort: "high", effective_effort: "high", reasoning_effort: "high", escalation_level: 0,
    supported_efforts: ["low", "medium", "high", "xhigh", "max"], effort_source: "model-capability", capability_status: "known"
  };
  if (scenarioName === "reasoning-failure") {
    const first = escalateModelRoute(config, task, "reasoning", { host: "codex" });
    const second = escalateModelRoute(config, {
      ...task,
      requested_effort: first.requestedEffort,
      effective_effort: first.effectiveEffort,
      reasoning_effort: first.effectiveEffort,
      escalation_level: first.escalationLevel
    }, "reasoning", { host: "codex" });
    return first.requestedEffort === "xhigh" && first.effectiveEffort === "xhigh"
      && second.requestedEffort === "max" && second.effectiveEffort === "max";
  }
  if (["transient-failure", "contract-failure"].includes(scenarioName)) {
    const failureClass = scenarioName === "transient-failure" ? "transient" : "contract";
    const held = escalateModelRoute(config, task, failureClass, { host: "codex" });
    return held.requestedEffort === "high" && held.effectiveEffort === "high" && held.escalationLevel === 0;
  }
  if (scenarioName === "codex-host" || scenarioName === "claude-host") {
    const options = {
      requestedEffort: "xhigh",
      runtime: {
        host: scenarioName === "codex-host" ? "codex" : "claude",
        model: scenarioName === "codex-host" ? BENCHMARK_MODEL : "claude-benchmark-model",
        supportedEfforts: ["high", "xhigh"],
        source: "benchmark-probe"
      }
    };
    const descriptor = scenarioName === "codex-host"
      ? codexSpawnDescriptor(task, { content: "contract" }, options)
      : claudeSpawnDescriptor(task, { content: "contract" }, options);
    return scenarioName === "codex-host"
      ? descriptor.reasoning_effort === "xhigh"
      : descriptor.args?.includes("--effort") && descriptor.args?.includes("xhigh");
  }
  return true;
}

function authenticatedLifecycleProfile(db, workspace, runId) {
  const contract = db.prepare(`
    SELECT id, contract_hash
    FROM goal_contracts
    WHERE run_id = ? AND status = 'active'
    ORDER BY version DESC LIMIT 1
  `).get(runId);
  if (!contract) return null;
  const artifacts = db.prepare(`
    SELECT content_ref, metadata_json
    FROM artifacts
    WHERE run_id = ? AND kind = 'goal-contract' AND status = 'verified'
    ORDER BY updated_at DESC
  `).all(runId);
  for (const artifact of artifacts) {
    if (!artifact.content_ref) continue;
    try {
      const metadata = JSON.parse(artifact.metadata_json ?? "{}");
      if (metadata.immutable !== true || metadata.contractId !== contract.id || metadata.contractHash !== contract.contract_hash) continue;
      const content = JSON.parse(readObject(db, workspace, artifact.content_ref));
      if (content.contractHash !== contract.contract_hash) continue;
      const { contractHash: ignored, ...payload } = content;
      if (sha256(stableStringify(payload)) !== contract.contract_hash) continue;
      return content.route?.lifecycleProfile ?? null;
    } catch { /* A missing/tampered authenticated object is failed evidence. */ }
  }
  return null;
}

export function candidateRuntimeContract(workspace, scenario, options = {}) {
  if (["reasoning-failure", "transient-failure", "contract-failure", "codex-host", "claude-host"].includes(scenario.name)) {
    return candidatePolicyContract(scenario.name);
  }
  const file = path.join(workspace, ".metis", "state", "state.db");
  if (!existsSync(file)) return false;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const hasRequestedRunId = typeof options === "string" || Object.prototype.hasOwnProperty.call(options, "runId");
    const requestedRunId = typeof options === "string" ? options : options?.runId;
    const runs = db.prepare("SELECT id FROM runs ORDER BY created_at, id").all();
    const run = hasRequestedRunId
      ? db.prepare("SELECT id FROM runs WHERE id = ?").get(requestedRunId)
      : runs.length === 1 ? runs[0] : null;
    if (!run) return false;
    if (options?.requireRecoveryReceipt === true && !options.recoveryReceipt) return false;
    const outerReceipt = resolveOuterMainReceipt(options);
    if (outerReceipt.conflict || !validateOuterMainReceipt(outerReceipt.receipt, { expectedWorkspace: workspace })) return false;
    if (scenario.expectedProfile && authenticatedLifecycleProfile(db, workspace, run.id) !== scenario.expectedProfile) return false;
    const modelEvidence = readWorkspaceModelEvidence(workspace, { runId: run.id, recoveryReceipt: options.recoveryReceipt });
    // Nested Metis runs do not necessarily emit a usage_samples row for the
    // host process. The authenticated outer runner receipt is authoritative
    // for that process; an explicit nested sample remains independently
    // binding and must agree with Luna.
    if (modelEvidence.mainUsageInvalid?.length > 0) return false;
    if (!modelEvidence.allLuna) return false;
    if (scenario.name === "trivial-local-change") return true;
    if (scenario.name === "shared-interface-change") {
      return Boolean(db.prepare("SELECT 1 FROM interface_contracts WHERE run_id = ? AND status = 'frozen' LIMIT 1").get(run.id));
    }
    const expected = Number(scenario.expectedFirstWaveWidth ?? 0);
    if (expected > 0) {
      const rows = db.prepare(`
        SELECT wave, COUNT(*) AS count FROM tasks
        WHERE run_id = ? AND phase = 'execute' AND task_kind = 'implementation' AND read_only = 0
        GROUP BY wave ORDER BY wave
      `).all(run.id);
      const first = rows[0];
      return Boolean(first && Number(first.count) === expected);
    }
    return true;
  } catch { return false; }
  finally { try { db?.close(); } catch {} }
}

/**
 * Execute a benchmark command with containment around the exact process we
 * started.  `spawnSync({ timeout })` only waits for the direct child and can
 * leave descendants behind; detached POSIX children give us a private process
 * group, which is terminated as a unit on timeout.  Completion is withheld
 * until both the child close event and process-group disappearance are
 * observed; otherwise a descendant can outlive the recorded benchmark.
 */
function runStructured(spec, workspace, timeoutMs, variables) {
  const command = substituteCommandSpec(spec, variables, { code: "BENCHMARK_COMMAND" });
  const cwd = command.cwd ? resolveInside(workspace, command.cwd, { code: "BENCHMARK_CWD" }).absolute : workspace;
  const commandText = [command.command, ...command.args].join(" ");
  const limitMs = Math.max(1, Number(command.timeoutMs ?? timeoutMs));
  const maxBuffer = 128 * 1024 * 1024;
  const processToken = `metis-benchmark-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requireTokenContainment = variables.requiredSuite === true;
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let status = null;
    let signal = null;
    let error = null;
    let timedOut = false;
    let cleanupStarted = false;
    let forceSent = false;
    let closed = false;
    let groupGone = true;
    let tokenProcessesGone = true;
    let cleanupDeadlineReached = false;
    let settled = false;
    let timeoutTimer = null;
    let forceTimer = null;
    let deadlineTimer = null;
    let cleanupPollTimer = null;
    let errorCode = null;
    let tokenInspectionAvailable = null;
    let stdoutHandler = null;
    let stderrHandler = null;
    let childErrorHandler = null;
    let childCloseHandler = null;

    const termGraceMs = 250;
    const cleanupWaitMs = 1000;
    const pollMs = 10;

    const append = (current, chunk) => {
      if (current.length >= maxBuffer) return current;
      const text = String(chunk);
      return current + text.slice(0, maxBuffer - current.length);
    };
    const signalProcessGroup = (kind) => {
      if (!child?.pid) return;
      try {
        // Negative PIDs target only the private group created by detached:true.
        // Never fall back to a broad process search or an unrelated PID.
        if (process.platform !== "win32") process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (caught) {
        if (caught?.code !== "ESRCH") error ??= caught?.message ?? String(caught);
      }
    };
    const processGroupExists = () => {
      if (!child?.pid || process.platform === "win32") return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (caught) {
        if (caught?.code === "ESRCH") return false;
        // EPERM means the group still exists but is not signalable by this
        // process. Treat all other errors as present as well: returning in
        // that state could strand a descendant.
        return true;
      }
    };
    const tokenProcessIds = () => {
      if (tokenInspectionAvailable === false) return null;
      if (process.platform === "linux") {
        const found = [];
        try {
          for (const entry of readdirSync("/proc")) {
            if (!/^\d+$/u.test(entry)) continue;
            const pid = Number(entry);
            if (pid === process.pid) continue;
            try {
              const environment = readFileSync(`/proc/${entry}/environ`, "utf8");
              if (environment.split("\0").includes(`METIS_BENCHMARK_PROCESS_TOKEN=${processToken}`)) found.push(pid);
            } catch (caught) {
              if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(caught?.code)) return null;
            }
          }
          tokenInspectionAvailable = true;
          return found;
        } catch {
          tokenInspectionAvailable = false;
          return null;
        }
      }
      if (process.platform === "darwin") {
        const listing = runCommand("ps", ["eww", "-axo", "pid=,command="], { timeout: 5000 });
        if (listing.status !== 0) {
          tokenInspectionAvailable = false;
          return null;
        }
        tokenInspectionAvailable = true;
        return listing.stdout.split("\n")
          .filter((line) => line.includes(`METIS_BENCHMARK_PROCESS_TOKEN=${processToken}`))
          .map((line) => Number(line.trim().match(/^(\d+)/u)?.[1]))
          .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
      }
      tokenInspectionAvailable = true;
      return [];
    };
    const signalTokenProcesses = (kind) => {
      for (const pid of tokenProcessIds() ?? []) {
        try { process.kill(pid, kind); }
        catch (caught) { if (caught?.code !== "ESRCH") error ??= caught?.message ?? String(caught); }
      }
    };
    const refreshContainment = () => {
      groupGone = !processGroupExists();
      const tokenPids = tokenProcessIds();
      if (tokenPids === null && requireTokenContainment) {
        errorCode ??= "BENCHMARK_CONTAINMENT_UNAVAILABLE";
        error ??= "Official benchmark process-token containment inspection is unavailable.";
      }
      tokenProcessesGone = tokenPids === null || tokenPids.length === 0;
    };
    const detachChildIO = ({ force = false } = {}) => {
      if (child?.stdout) {
        if (stdoutHandler) child.stdout.off("data", stdoutHandler);
        child.stdout.destroy();
      }
      if (child?.stderr) {
        if (stderrHandler) child.stderr.off("data", stderrHandler);
        child.stderr.destroy();
      }
      if (child) {
        if (childErrorHandler) child.off("error", childErrorHandler);
        if (childCloseHandler) child.off("close", childCloseHandler);
        if (force) {
          // A post-deadline ChildProcess error must not become unhandled after
          // our listener is detached, and an unreapable child must not keep
          // the benchmark caller's event loop referenced.
          child.on("error", () => {});
          child.unref();
        }
      }
    };
    const finish = ({ force = false } = {}) => {
      if (settled) return;
      if (!force && !closed) return;
      if (!force && cleanupStarted && !cleanupDeadlineReached && (!forceSent || !groupGone || !tokenProcessesGone)) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      clearTimeout(deadlineTimer);
      clearInterval(cleanupPollTimer);
      detachChildIO({ force });
      resolve({
        command: commandText,
        status,
        signal,
        stdout,
        stderr,
        error: error ?? (timedOut ? `Command timed out after ${limitMs}ms.` : null),
        errorCode: errorCode ?? (timedOut ? "BENCHMARK_TIMEOUT" : null)
      });
    };
    const pollCleanup = () => {
      refreshContainment();
      finish();
    };
    const beginCleanup = (reason) => {
      if (cleanupStarted || settled) return;
      cleanupStarted = true;
      if (reason === "timeout") {
        timedOut = true;
        error ??= `Command timed out after ${limitMs}ms.`;
      }
      signalProcessGroup("SIGTERM");
      signalTokenProcesses("SIGTERM");
      cleanupPollTimer = setInterval(pollCleanup, pollMs);
      forceTimer = setTimeout(() => {
        forceSent = true;
        signalProcessGroup("SIGKILL");
        signalTokenProcesses("SIGKILL");
        pollCleanup();
        // A command that cannot be reaped must not hang the benchmark runner
        // forever. The deadline converts containment failure into an explicit
        // terminal error after one final group kill and state check.
        deadlineTimer = setTimeout(() => {
          if (settled) return;
          signalProcessGroup("SIGKILL");
          signalTokenProcesses("SIGKILL");
          refreshContainment();
          cleanupDeadlineReached = true;
          errorCode = "BENCHMARK_CLEANUP_TIMEOUT";
          error = `Command cleanup-timeout after ${cleanupWaitMs}ms; child close or process-group disappearance was not observed after ${reason}.`;
          // `close` waits for inherited stdio to close. A descendant can keep
          // those descriptors open even after the direct child exits, so the
          // bounded deadline must be able to settle without that event.
          finish({ force: true });
        }, cleanupWaitMs);
      }, termGraceMs);
    };
    const onTimeout = () => {
      if (closed || settled) return;
      beginCleanup("timeout");
    };

    try {
      child = spawn(command.command, command.args, {
        cwd,
        shell: false,
        detached: true,
        env: { ...process.env, ...command.env, METIS_BENCHMARK_PROCESS_TOKEN: processToken },
        stdio: ["ignore", "pipe", "pipe"]
      });
      stdoutHandler = (chunk) => { stdout = append(stdout, chunk); };
      stderrHandler = (chunk) => { stderr = append(stderr, chunk); };
      childErrorHandler = (caught) => {
        error ??= caught?.message ?? String(caught);
        if (!closed) {
          closed = true;
          finish();
        }
      };
      childCloseHandler = (code, closeSignal) => {
        status = code;
        signal = closeSignal;
        closed = true;
        refreshContainment();
        if (!timedOut && (!groupGone || !tokenProcessesGone)) beginCleanup("normal exit with live descendants");
        finish();
      };
      child.stdout?.on("data", stdoutHandler);
      child.stderr?.on("data", stderrHandler);
      child.once("error", childErrorHandler);
      child.once("close", childCloseHandler);
      timeoutTimer = setTimeout(onTimeout, limitMs);
    } catch (caught) {
      error = caught?.message ?? String(caught);
      errorCode = "BENCHMARK_COMMAND";
      closed = true;
      finish();
    }
  });
}

function parseConfig(file) {
  invariant(existsSync(file), "BENCHMARK_CONFIG", `Benchmark config not found: ${file}.`);
  const config = JSON.parse(readFileSync(file, "utf8"));
  invariant(config.version === 2, "BENCHMARK_VERSION", "Benchmark config version must be 2.");
  invariant(Array.isArray(config.scenarios) && config.scenarios.length > 0, "BENCHMARK_SCENARIOS", "Benchmark needs scenarios.");
  invariant(Array.isArray(config.variants) && config.variants.length > 0, "BENCHMARK_VARIANTS", "Benchmark needs variants.");
  if (config.requiredSuite === true) {
    invariant(config.scenarios.length === DEFAULT_BENCHMARK_SCENARIOS.length, "BENCHMARK_SCENARIO_COUNT", "The required benchmark suite has exactly nine scenarios.");
    invariant(new Set(config.scenarios.map((item) => item.name)).size === config.scenarios.length, "BENCHMARK_SCENARIO_NAMES", "Benchmark scenario names must be unique.");
    for (const name of REQUIRED_SCENARIO_NAMES) invariant(config.scenarios.some((item) => item.name === name), "BENCHMARK_SCENARIO_MISSING", `Required benchmark scenario is missing: ${name}.`);
    invariant(config.variants.length === DEFAULT_BENCHMARK_VARIANTS.length, "BENCHMARK_VARIANT_COUNT", "The required benchmark suite has exactly three variants.");
    for (const name of REQUIRED_VARIANT_NAMES) invariant(config.variants.some((item) => item.name === name), "BENCHMARK_VARIANT_MISSING", `Required benchmark variant is missing: ${name}.`);
    invariant(Number(config.repetitions ?? 0) >= 5, "BENCHMARK_REPETITIONS", "Deterministic benchmark suites require at least five repetitions.");
    invariant(typeof config.baselineCommit === "string" && config.baselineCommit.length >= 7, "BENCHMARK_BASELINE_COMMIT", "Required suites need a baseline commit.");
    invariant(typeof config.candidateCommit === "string" && config.candidateCommit.length >= 7 && config.candidateCommit !== config.baselineCommit, "BENCHMARK_CANDIDATE_COMMIT", "Required suites need a distinct candidate commit.");
    for (const scenario of config.scenarios) {
      invariant(Array.isArray(scenario.verify) && scenario.verify.length > 0, "BENCHMARK_VERIFY_REQUIRED", `Required scenario ${scenario.name} needs an executable verification command.`);
      invariant(scenario.builtInFixture === true, "BENCHMARK_FIXTURE_REQUIRED", `Required scenario ${scenario.name} needs a built-in immutable fixture contract.`);
      invariant(!scenario.metricsFile && !scenario.usageFile, "BENCHMARK_OBSERVER_OVERRIDE", `Required scenario ${scenario.name} cannot override durable observer metrics.`);
    }
    for (const variant of config.variants) invariant(!variant.metricsFile && !variant.usageFile, "BENCHMARK_OBSERVER_OVERRIDE", `Required variant ${variant.name} cannot override durable observer metrics.`);
  }
  for (const scenario of config.scenarios) for (const item of scenario.verify ?? []) normalizeCommandSpec(item, { code: "BENCHMARK_VERIFY" });
  for (const variant of config.variants) {
    const command = normalizeCommandSpec(variant.command, { code: "BENCHMARK_COMMAND" });
    if (command.command === "codex") invariant(commandModel(command) === BENCHMARK_MODEL, "BENCHMARK_CODEX_MODEL", `Codex benchmark command for ${variant.name} must explicitly select ${BENCHMARK_MODEL}.`);
    for (const item of variant.setup ?? []) normalizeCommandSpec(item, { code: "BENCHMARK_SETUP" });
    for (const [host, item] of Object.entries(variant.commands ?? {})) {
      const normalized = normalizeCommandSpec(item, { code: "BENCHMARK_COMMAND" });
      if (host === "codex" || normalized.command === "codex") invariant(commandModel(normalized) === BENCHMARK_MODEL, "BENCHMARK_CODEX_MODEL", `Codex benchmark command for ${variant.name} must explicitly select ${BENCHMARK_MODEL}.`);
    }
    for (const setup of Object.values(variant.setupByHost ?? {})) {
      for (const item of setup ?? []) normalizeCommandSpec(item, { code: "BENCHMARK_SETUP" });
    }
  }
  return config;
}

export async function runBenchmark(db, projectRoot, options = {}) {
  invariant(options.allowRepositoryExec === true, "BENCHMARK_EXEC_APPROVAL", "Benchmark execution requires explicit `--allow-repository-exec` approval.");
  const file = options.file ? path.resolve(options.file) : benchmarkConfigPath(projectRoot);
  const config = parseConfig(file);
  if (options.baselineCommit !== undefined) config.baselineCommit = options.baselineCommit;
  if (options.candidateCommit !== undefined) config.candidateCommit = options.candidateCommit;
  const repetitions = Math.max(1, Number(options.repetitions ?? config.repetitions ?? 1));
  if (config.deterministicLocal === true) invariant(repetitions >= Number(config.minimumRepetitions ?? 5), "BENCHMARK_REPETITIONS", `Deterministic benchmark suites require at least ${config.minimumRepetitions ?? 5} repetitions.`);
  const timeoutMs = Number(options.timeoutMs ?? config.timeoutMs ?? 900000);
  const officialCommits = config.requiredSuite === true
    ? resolveOfficialBenchmarkCommits(projectRoot, config, { requireClean: true })
    : null;
  if (officialCommits) {
    // Use canonical SHAs in every durable result even if a hand-authored
    // config supplied an abbreviated SHA or a named ref.
    config.baselineCommit = officialCommits.baselineCommit;
    config.candidateCommit = officialCommits.candidateCommit;
  }
  const benchmarkConfigHash = sha256(stableStringify(config));
  const reportRoot = path.join(runtimeArea(projectRoot, "benchmarks"), "runs", `${Date.now()}-${process.pid}`);
  mkdirSync(reportRoot, { recursive: true });
  const workspaceRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "metis-benchmark-run-")));
  const baseline = config.requiredSuite === true
    ? createBaselineWorktree(projectRoot, workspaceRoot, config.baselineCommit)
    : null;
  const results = [];
  try {
    for (const scenario of config.scenarios) {
      if (options.scenario && scenario.name !== options.scenario) continue;
      const fixture = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "metis-benchmark-fixture-")));
      try {
        let builtInFixture = null;
        if (scenario.builtInFixture === true) {
          builtInFixture = prepareBuiltInBenchmarkFixture(fixture, scenario);
        } else {
          const sourceValue = String(scenario.source ?? ".");
          const source = sourceValue === "."
            ? path.resolve(projectRoot)
            : assertNoSymlinkTraversal(projectRoot, sourceValue, { code: "BENCHMARK_SOURCE_PATH" }).absolute;
          copyFixture(source, fixture);
        }
        for (const variant of config.variants) {
          if (options.variant && variant.name !== options.variant) continue;
          for (let repetition = 1; repetition <= repetitions; repetition += 1) {
            const id = makeId("bench");
            const workspace = realpathSync.native(mkdtempSync(path.join(workspaceRoot, `${scenario.name}-${variant.name}-${repetition}-`)));
            try {
              copyFixture(fixture, workspace);
              initializeGit(workspace);
              const fixtureVerifier = builtInFixture?.verifierFile ?? prepareFixtureVerifier(workspace, scenario);
              const promptFile = path.join(workspace, ".metis-benchmark-prompt.txt");
              const prompt = String(builtInFixture?.prompt ?? scenario.prompt ?? "");
              writeFileSync(promptFile, prompt, "utf8");
              const metis = variant.metisSource === "baseline" ? baseline?.cli : METIS_CLI;
              if (variant.metisSource) invariant(metis, "BENCHMARK_METIS_CLI", `No Metis CLI is available for ${variant.name}.`);
              const host = String(scenario.localProbe === true ? "local" : scenario.host ?? variant.host ?? "codex").toLowerCase();
              const commandSpec = scenario.localProbe === true
                ? { command: process.execPath, args: [builtInFixture.verifierFile, "--solve", workspace, scenario.name] }
                : variant.commands?.[host] ?? variant.command;
              const setupSpecs = scenario.localProbe === true ? [] : variant.setupByHost?.[host] ?? variant.setup ?? [];
              invariant(commandSpec, "BENCHMARK_HOST_COMMAND", `Variant ${variant.name} has no command for host ${host}.`);
              const variables = { workspace, promptFile, prompt, fixtureVerifier, benchmarkFixtureTool: fileURLToPath(new URL("./benchmark-fixtures.js", import.meta.url)), scenario: scenario.name, variant: variant.name, repetition, host, node: process.execPath, metis: metis ?? METIS_CLI, requiredSuite: config.requiredSuite === true };
              // Start at the goal boundary, before variant setup, so setup is
              // included in wall-clock completion time.
              const goalStarted = performance.now();
              const setupStarted = goalStarted;
              const setup = [];
              let setupPassed = true;
              for (const setupSpec of setupSpecs) {
                const setupResult = await runStructured(setupSpec, workspace, timeoutMs, variables);
                setup.push({ command: setupResult.command, exitCode: setupResult.status, stdout: setupResult.stdout, stderr: setupResult.stderr, error: setupResult.error, errorCode: setupResult.errorCode });
                if (setupResult.status !== 0) { setupPassed = false; break; }
              }
              let modelConfigEvidence = null;
              if (setupPassed && variant.metisSource && scenario.localProbe !== true) {
                modelConfigEvidence = enforceBenchmarkModelConfig(workspace, { host });
                if (modelConfigEvidence) setup.push({ command: "internal:benchmark-model-config", exitCode: 0, stdout: stableStringify(modelConfigEvidence), stderr: "", error: null });
              }
              const benchmarkRunIdsBeforeExecution = modelConfigEvidence ? workspaceRunRows(workspace).map((row) => row.id) : null;
              const setupFinished = performance.now();
              const execution = setupPassed
                ? await runStructured(commandSpec, workspace, timeoutMs, variables)
                : { status: -1, signal: null, stdout: "", stderr: "Variant setup failed.", error: "setup failed", command: normalizeCommandSpec(commandSpec) };
              const executionFinished = performance.now();
              const usage = readUsage(workspace, variant.usageFile ?? scenario.usageFile);
              const measured = readRunMetrics(workspace, variant.metricsFile ?? scenario.metricsFile);
              const codexMainApplicable = scenario.localProbe !== true && host === "codex" && commandSpec.command === "codex";
              const nestedApplicable = Boolean(modelConfigEvidence);
              const outerMainReceipt = mainModelEvidence(commandSpec, execution, measured, codexMainApplicable, workspace);
              let fixtureConfigEvidence = modelConfigEvidence;
              let benchmarkRunId = null;
              let recoveryReceipt = null;
              if (modelConfigEvidence) {
                try {
                  benchmarkRunId = resolveBenchmarkRunId(workspace, benchmarkRunIdsBeforeExecution);
                  fixtureConfigEvidence = restoreBenchmarkModelConfig(workspace, modelConfigEvidence, { runId: benchmarkRunId });
                  recoveryReceipt = fixtureConfigEvidence.recoveryReceipt;
                } catch (error) {
                  fixtureConfigEvidence = {
                    ...modelConfigEvidence,
                    restored: false,
                    recoveryError: error instanceof Error ? error.message : String(error)
                  };
                }
              }
              const verification = [];
              const executionPassed = setupPassed && execution.status === 0 && !execution.error;
              let verificationPassed = executionPassed;
              const verificationStarted = executionFinished;
              // Required built-in scenarios always use the external oracle;
              // an edited benchmark config cannot replace it with a no-op.
              const verificationSpecs = builtInFixture
                ? [{ command: process.execPath, args: [builtInFixture.verifierFile, "--verify", workspace, scenario.name] }]
                : scenario.verify ?? [];
              for (const verify of verificationSpecs) {
                const check = await runStructured(verify, workspace, timeoutMs, variables);
                verification.push({ command: check.command, exitCode: check.status, stdout: check.stdout, stderr: check.stderr, error: check.error, errorCode: check.errorCode });
                if (check.status !== 0) verificationPassed = false;
              }
              if (variant.metisSource === "candidate" && scenario.builtInFixture === true) {
                const passed = candidateRuntimeContract(workspace, scenario, {
                  runId: benchmarkRunId ?? "", recoveryReceipt, requireRecoveryReceipt: Boolean(modelConfigEvidence),
                  outerMainReceipt
                });
                verification.push({ command: "internal:candidate-runtime-contract", exitCode: passed ? 0 : 1, stdout: "", stderr: passed ? "" : `Candidate runtime contract failed for ${scenario.name}.` });
                if (!passed) verificationPassed = false;
              }
              const finished = performance.now();
              const changed = changedFiles(workspace).filter((item) => item !== ".metis-benchmark-prompt.txt" && item !== ".metis-benchmark-verifier.mjs");
              const nestedModelEvidence = nestedApplicable
                ? { ...readWorkspaceModelEvidence(workspace, { runId: benchmarkRunId ?? "", recoveryReceipt }), applicable: true }
                : { expectedModel: BENCHMARK_MODEL, applicable: false, allLuna: null, taskCount: 0, attemptCount: 0, descriptorCount: 0, routes: [], tasks: [], attempts: [], descriptors: [], invalid: [], source: "not-applicable" };
              const modelEvidence = {
                expected: BENCHMARK_MODEL,
                main: outerMainReceipt,
                outerMainReceipt,
                fixtureConfig: fixtureConfigEvidence,
                recoveryReceipt,
                nested: nestedModelEvidence
              };
              if (codexMainApplicable || nestedApplicable) {
                const mainPassed = !codexMainApplicable || modelEvidence.main.verified === true;
                const nestedPassed = !nestedApplicable || modelEvidence.nested.allLuna === true;
                verification.push({
                  command: "internal:benchmark-model-contract",
                  exitCode: mainPassed && nestedPassed ? 0 : 1,
                  stdout: "",
                  stderr: mainPassed && nestedPassed ? "" : "Benchmark model evidence is missing or not pinned to gpt-5.6-luna."
                });
                if (!mainPassed || !nestedPassed) verificationPassed = false;
              }
              const rawResult = {
                id, benchmark: config.name, scenario: scenario.name, variant: variant.name, repetition,
                command: execution.command, setup,
                status: executionPassed ? "completed" : "failed",
                verificationStatus: verificationPassed ? "passed" : "failed",
                durationMs: finished - goalStarted,
                setupDurationMs: setupFinished - setupStarted,
                executionDurationMs: executionFinished - setupFinished,
                verificationDurationMs: finished - verificationStarted,
                changedFiles: changed,
                inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
                firstWorkerApplicable: scenario.localProbe !== true,
                timeToFirstWorkerMs: measured.timeToFirstWorkerMs ?? null,
                maxConcurrency: measured.maxConcurrency ?? null,
                slotUtilization: measured.slotUtilization ?? null,
                retryCount: measured.retryCount ?? null,
                host: measured.host ?? host,
                model: measured.model ?? variant.model ?? null,
                requestedModel: modelEvidence.main.requested,
                effectiveModel: modelEvidence.main.effective,
                modelEvidence,
                requestedEffort: measured.requestedEffort ?? variant.requestedEffort ?? null,
                effectiveEffort: measured.effectiveEffort ?? variant.effectiveEffort ?? null,
                provenance: {
                  benchmarkName: config.name,
                  benchmarkConfigHash,
                  requiredSuite: config.requiredSuite === true,
                  benchmarkBaselineCommit: config.baselineCommit ?? null,
                  benchmarkCandidateCommit: config.candidateCommit ?? null,
                  variantCommit: variant.metisSource === "baseline" ? config.baselineCommit ?? null : variant.metisSource === "candidate" ? config.candidateCommit ?? null : null,
                  metisSource: variant.metisSource === "baseline" ? "git-worktree" : variant.metisSource === "candidate" ? "working-tree" : "none",
                  instrumentation: variant.instrumentation ?? null
                },
                execution, verification
              };
              const resultRef = storeObject(db, projectRoot, `benchmark:${config.name}`, stableStringify(rawResult), { redact: true });
              db.prepare(`
                INSERT INTO benchmark_runs(id, name, variant, scenario, status, duration_ms, verification_status,
                  changed_files, input_tokens, output_tokens, time_to_first_worker_ms, max_concurrency,
                  slot_utilization, retry_count, host, model, policy, result_ref, created_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(id, config.name, variant.name, scenario.name, rawResult.status, rawResult.durationMs,
                rawResult.verificationStatus, changed.length, rawResult.inputTokens, rawResult.outputTokens,
                rawResult.timeToFirstWorkerMs, rawResult.maxConcurrency, rawResult.slotUtilization, rawResult.retryCount,
                rawResult.host, rawResult.model, stableStringify(rawResult.modelEvidence), resultRef, now());
              results.push({
                id, benchmark: config.name, scenario: scenario.name, variant: variant.name, repetition,
                command: rawResult.command, status: rawResult.status, verificationStatus: rawResult.verificationStatus,
                durationMs: rawResult.durationMs, setupDurationMs: rawResult.setupDurationMs,
                executionDurationMs: rawResult.executionDurationMs, verificationDurationMs: rawResult.verificationDurationMs,
                changedFiles: changed, inputTokens: rawResult.inputTokens, outputTokens: rawResult.outputTokens,
                firstWorkerApplicable: rawResult.firstWorkerApplicable,
                timeToFirstWorkerMs: rawResult.timeToFirstWorkerMs, maxConcurrency: rawResult.maxConcurrency,
                slotUtilization: rawResult.slotUtilization, retryCount: rawResult.retryCount,
                host: rawResult.host, model: rawResult.model, requestedEffort: rawResult.requestedEffort,
                effectiveEffort: rawResult.effectiveEffort, provenance: rawResult.provenance,
                requestedModel: rawResult.requestedModel, effectiveModel: rawResult.effectiveModel,
                modelEvidence: rawResult.modelEvidence,
                resultRef, workspace: options.keepWorkspaces ? workspace : null
              });
            } finally { if (!options.keepWorkspaces) rmSync(workspace, { recursive: true, force: true }); }
          }
        }
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    }
    const report = benchmarkReport(db, config.name);
    const summaryFile = path.join(reportRoot, "summary.json");
    writeFileSync(summaryFile, `${stableStringify({ version: 2, benchmark: config.name, createdAt: now(), results, report })}\n`, "utf8");
    return { file, name: config.name, results, report, summaryFile, workspaceRoot: options.keepWorkspaces ? workspaceRoot : null };
  } finally {
    removeBaselineWorktree(projectRoot, baseline);
    if (!options.keepWorkspaces) rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function aggregateBenchmarkRows(rows, includeScenario) {
  const groups = new Map();
  for (const row of rows) {
    const key = includeScenario ? `${row.name}\0${row.scenario}\0${row.variant}` : `${row.name}\0${row.variant}`;
    const declaredScenario = DEFAULT_BENCHMARK_SCENARIOS.find((scenario) => scenario.name === row.scenario);
    const group = groups.get(key) ?? {
      name: row.name,
      ...(includeScenario ? { scenario: row.scenario } : {}),
      variant: row.variant,
      firstWorkerApplicable: declaredScenario ? declaredScenario.localProbe !== true : null,
      runs: 0,
      passed: 0,
      durationMs: 0,
      changedFiles: 0,
      inputTokens: 0,
      outputTokens: 0,
      inputSamples: 0,
      outputSamples: 0,
      verifiedDurations: [],
      firstWorker: [],
      concurrency: [],
      utilization: [],
      retries: [],
      modelPolicyRows: 0,
      modelPolicies: []
    };
    group.runs += 1;
    if (row.verification_status === "passed") group.passed += 1;
    group.durationMs += Number(row.duration_ms ?? 0);
    // A failed verification is not a successful completion and must not affect
    // completion-time percentiles, while still contributing to pass rate.
    if (row.verification_status === "passed" && Number.isFinite(Number(row.duration_ms))) group.verifiedDurations.push(Number(row.duration_ms));
    group.changedFiles += Number(row.changed_files ?? 0);
    if (row.input_tokens !== null) {
      group.inputTokens += Number(row.input_tokens);
      group.inputSamples += 1;
    }
    if (row.output_tokens !== null) {
      group.outputTokens += Number(row.output_tokens);
      group.outputSamples += 1;
    }
    if (row.time_to_first_worker_ms !== null && Number.isFinite(Number(row.time_to_first_worker_ms))) group.firstWorker.push(Number(row.time_to_first_worker_ms));
    if (row.max_concurrency !== null && Number.isFinite(Number(row.max_concurrency))) group.concurrency.push(Number(row.max_concurrency));
    if (row.slot_utilization !== null && Number.isFinite(Number(row.slot_utilization))) group.utilization.push(Number(row.slot_utilization));
    if (row.retry_count !== null && Number.isFinite(Number(row.retry_count))) group.retries.push(Number(row.retry_count));
    group.modelPolicyRows += 1;
    if (row.policy) {
      try { group.modelPolicies.push(JSON.parse(row.policy)); } catch { group.modelPolicies.push(null); }
    } else group.modelPolicies.push(null);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const durations = [...group.verifiedDurations].sort((a, b) => a - b);
    const nearestRank = (fraction) => durations.length ? durations[Math.ceil(fraction * durations.length) - 1] : null;
    const median = durations.length ? (durations.length % 2 ? durations[(durations.length - 1) / 2] : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2) : null;
    const policies = group.modelPolicies.filter((item) => item && typeof item === "object");
    const nested = policies.map((item) => item.nested).filter((item) => item && typeof item === "object");
    const main = policies.map((item) => item.main).filter((item) => item && typeof item === "object");
    const applicableMain = main.filter((item) => item.applicable !== false);
    const applicableNested = nested.filter((item) => item.applicable !== false);
    const outerReceipts = main.map((item) => {
      const resolved = resolveOuterMainReceipt(item);
      return { ...resolved, valid: !resolved.conflict && validateOuterMainReceipt(resolved.receipt) };
    });
    return {
      name: group.name,
      ...(group.scenario !== undefined ? { scenario: group.scenario } : {}),
      variant: group.variant,
      runs: group.runs,
      passRate: group.runs ? Number((group.passed / group.runs).toFixed(4)) : 0,
      verificationPassRate: group.runs ? Number((group.passed / group.runs).toFixed(4)) : 0,
      successfulRuns: durations.length,
      averageDurationMs: group.runs ? Math.round(group.durationMs / group.runs) : 0,
      medianVerifiedDurationMs: median,
      p95VerifiedDurationMs: nearestRank(0.95),
      averageChangedFiles: group.runs ? Number((group.changedFiles / group.runs).toFixed(2)) : 0,
      averageInputTokens: group.inputSamples ? Math.round(group.inputTokens / group.inputSamples) : null,
      averageOutputTokens: group.outputSamples ? Math.round(group.outputTokens / group.outputSamples) : null,
      firstWorkerApplicable: group.firstWorkerApplicable,
      timeToFirstWorkerMs: group.firstWorker.length ? Math.round(group.firstWorker.reduce((sum, value) => sum + value, 0) / group.firstWorker.length) : null,
      maximumConcurrency: group.concurrency.length ? Math.max(...group.concurrency) : null,
      slotUtilization: group.utilization.length ? Number((group.utilization.reduce((sum, value) => sum + value, 0) / group.utilization.length).toFixed(4)) : null,
      retryCount: group.retries.length ? group.retries.reduce((sum, value) => sum + value, 0) : null,
      modelEvidence: policies.length ? {
        expected: BENCHMARK_MODEL,
        main: {
          requested: [...new Set(main.map((item) => item.requested ?? null))],
          effective: [...new Set(main.map((item) => item.effective ?? null))],
          applicable: applicableMain.length > 0,
          allPinned: applicableMain.length === 0 ? null : group.modelPolicyRows === group.runs && applicableMain.length === main.length && applicableMain.length === policies.length && applicableMain.every((item) => item.requested === BENCHMARK_MODEL && item.effective === BENCHMARK_MODEL),
          outerReceiptValid: applicableMain.length === 0 ? null : group.modelPolicyRows === group.runs && applicableMain.length === main.length && outerReceipts.length === main.length && outerReceipts.every((item) => item.valid)
        },
        nested: {
          applicable: applicableNested.length > 0,
          allLuna: applicableNested.length === 0 ? null : group.modelPolicyRows === group.runs && applicableNested.length === nested.length && applicableNested.length === policies.length && applicableNested.every((item) => item.allLuna === true),
          recoveryInvalid: nested.some((item) => item.recoveryInvalid === true || item.runStatus === "blocked"),
          recoveryReceiptRequired: nested.some((item) => Object.prototype.hasOwnProperty.call(item, "recoveryReceiptValid")),
          recoveryReceiptValid: nested.length > 0 && nested.every((item) => item.recoveryReceiptValid === true),
          taskCount: nested.reduce((sum, item) => sum + Number(item.taskCount ?? 0), 0),
          attemptCount: nested.reduce((sum, item) => sum + Number(item.attemptCount ?? 0), 0),
          descriptorCount: nested.reduce((sum, item) => sum + Number(item.descriptorCount ?? 0), 0),
          invalidCount: nested.reduce((sum, item) => sum + Number(item.invalid?.length ?? 0), 0)
        }
      } : null
    };
  });
}

function benchmarkRows(db, name = null) {
  return name
    ? db.prepare("SELECT * FROM benchmark_runs WHERE name = ? ORDER BY variant, scenario, created_at").all(name)
    : db.prepare("SELECT * FROM benchmark_runs ORDER BY name, variant, scenario, created_at").all();
}

export function benchmarkReport(db, name = null) {
  return aggregateBenchmarkRows(benchmarkRows(db, name), true);
}


export function compareBenchmarkVariants(db, name, baselineVariant, candidateVariant, options = {}) {
  invariant(name, "BENCHMARK_NAME", "Specify a benchmark name.");
  invariant(baselineVariant && candidateVariant, "BENCHMARK_VARIANTS", "Specify baseline and candidate variants.");
  const rows = benchmarkRows(db, name);
  const requiredSuite = baselineVariant === "metis-pre-1.0-baseline" && candidateVariant === "metis-1.0.0-candidate";
  const officialResults = [];
  if (requiredSuite) {
    invariant(options.baselineCommit && options.candidateCommit && options.baselineCommit !== options.candidateCommit, "BENCHMARK_PROVENANCE", "Required comparisons need distinct baseline and candidate commit evidence.");
    invariant(options.projectRoot, "BENCHMARK_PROVENANCE", "Required comparisons need the project root to read durable result provenance.");
    const commits = resolveOfficialBenchmarkCommits(options.projectRoot, {
      baselineCommit: options.baselineCommit,
      candidateCommit: options.candidateCommit
    }, { requireClean: true });
    options = { ...options, ...commits };
    const configFile = options.file ? path.resolve(options.file) : benchmarkConfigPath(options.projectRoot);
    const comparisonConfig = parseConfig(configFile);
    invariant(comparisonConfig.requiredSuite === true && comparisonConfig.name === name, "BENCHMARK_PROVENANCE", "Official comparison config does not match the required benchmark suite name.");
    comparisonConfig.baselineCommit = options.baselineCommit;
    comparisonConfig.candidateCommit = options.candidateCommit;
    const expectedConfigHash = sha256(stableStringify(comparisonConfig));
    const sameNullableNumber = (left, right) => (
      left === null || left === undefined
        ? right === null || right === undefined
        : right !== null && right !== undefined && Number(left) === Number(right)
    );
    for (const row of rows.filter((item) => item.variant === baselineVariant || item.variant === candidateVariant)) {
      invariant(row.result_ref, "BENCHMARK_PROVENANCE", `Benchmark result ${row.id} has no durable provenance.`);
      let result;
      try { result = JSON.parse(readObject(db, options.projectRoot, row.result_ref)); } catch { result = null; }
      const provenance = result?.provenance;
      const isBaseline = row.variant === baselineVariant;
      invariant(provenance?.benchmarkName === name && provenance?.requiredSuite === true, "BENCHMARK_PROVENANCE", `Benchmark result ${row.id} is not bound to the required suite identity.`);
      invariant(provenance?.benchmarkConfigHash === expectedConfigHash, "BENCHMARK_PROVENANCE", `Benchmark result ${row.id} does not match the canonical benchmark config fingerprint.`);
      invariant(provenance?.benchmarkBaselineCommit === options.baselineCommit && provenance?.benchmarkCandidateCommit === options.candidateCommit, "BENCHMARK_PROVENANCE", `Benchmark result ${row.id} does not bind both official commits.`);
      invariant(provenance?.variantCommit === (isBaseline ? options.baselineCommit : options.candidateCommit), "BENCHMARK_PROVENANCE", `Benchmark result ${row.id} does not match its declared commit.`);
      invariant(provenance?.metisSource === (isBaseline ? "git-worktree" : "working-tree"), "BENCHMARK_PROVENANCE", `Benchmark result ${row.id} does not identify its Metis source.`);
      invariant(Number.isInteger(result?.repetition) && result.repetition >= 1, "BENCHMARK_PROVENANCE", `Benchmark result ${row.id} has no repetition identity.`);
      invariant(
        result.id === row.id
          && result.benchmark === row.name
          && result.variant === row.variant
          && result.scenario === row.scenario
          && result.status === row.status
          && result.verificationStatus === row.verification_status
          && sameNullableNumber(result.durationMs, row.duration_ms)
          && Number(result.changedFiles?.length ?? 0) === Number(row.changed_files ?? 0)
          && sameNullableNumber(result.inputTokens, row.input_tokens)
          && sameNullableNumber(result.outputTokens, row.output_tokens)
          && sameNullableNumber(result.timeToFirstWorkerMs, row.time_to_first_worker_ms)
          && sameNullableNumber(result.maxConcurrency, row.max_concurrency)
          && sameNullableNumber(result.slotUtilization, row.slot_utilization)
          && sameNullableNumber(result.retryCount, row.retry_count)
          && (result.host ?? null) === (row.host ?? null)
          && (result.model ?? null) === (row.model ?? null)
          && stableStringify(result.modelEvidence ?? null) === (row.policy ?? null),
        "BENCHMARK_PROVENANCE",
        `Benchmark row ${row.id} does not match its authenticated result object.`
      );
      officialResults.push({ row, result, provenance });
    }
    invariant(new Set(officialResults.map((item) => item.provenance.benchmarkConfigHash)).size === 1, "BENCHMARK_PROVENANCE", "Official benchmark results do not share one benchmark config fingerprint.");
    for (const scenario of DEFAULT_BENCHMARK_SCENARIOS) {
      for (const variant of [baselineVariant, candidateVariant]) {
        const repetitions = new Set(officialResults
          .filter((item) => item.row.scenario === scenario.name && item.row.variant === variant)
          .map((item) => item.result.repetition));
        const minimumRepetitions = Math.max(5, Number(comparisonConfig.repetitions ?? 5));
        invariant(repetitions.size >= minimumRepetitions
          && Array.from({ length: minimumRepetitions }, (_, index) => index + 1).every((value) => repetitions.has(value)),
        "BENCHMARK_REPETITIONS", `Official benchmark ${variant}/${scenario.name} requires repetitions 1 through ${minimumRepetitions}.`);
      }
    }
  }
  const report = aggregateBenchmarkRows(rows, true);
  const aggregate = aggregateBenchmarkRows(rows, false);
  const baseline = aggregate.find((item) => item.variant === baselineVariant);
  const candidate = aggregate.find((item) => item.variant === candidateVariant);
  invariant(baseline, "BENCHMARK_BASELINE", `Benchmark variant ${baselineVariant} was not found for ${name}.`);
  invariant(candidate, "BENCHMARK_CANDIDATE", `Benchmark variant ${candidateVariant} was not found for ${name}.`);
  const delta = (key) => {
    if (baseline[key] === null || candidate[key] === null) return null;
    return Number((candidate[key] - baseline[key]).toFixed(4));
  };
  const relative = (key) => {
    if (baseline[key] === null || candidate[key] === null || baseline[key] === 0) return null;
    return Number(((candidate[key] - baseline[key]) / baseline[key]).toFixed(4));
  };
  const comparison = {
    name,
    requiredSuite,
    baseline,
    candidate,
    delta: {
      passRate: delta("passRate"),
      averageDurationMs: delta("averageDurationMs"),
      averageChangedFiles: delta("averageChangedFiles"),
      averageInputTokens: delta("averageInputTokens"),
      averageOutputTokens: delta("averageOutputTokens"),
      medianVerifiedDurationMs: delta("medianVerifiedDurationMs"),
      p95VerifiedDurationMs: delta("p95VerifiedDurationMs"),
      timeToFirstWorkerMs: delta("timeToFirstWorkerMs"),
      maximumConcurrency: delta("maximumConcurrency"),
      slotUtilization: delta("slotUtilization"),
      retryCount: delta("retryCount")
    },
    relative: {
      averageDurationMs: relative("averageDurationMs"),
      averageChangedFiles: relative("averageChangedFiles"),
      averageInputTokens: relative("averageInputTokens"),
      averageOutputTokens: relative("averageOutputTokens"),
      medianVerifiedDurationMs: relative("medianVerifiedDurationMs"),
      p95VerifiedDurationMs: relative("p95VerifiedDurationMs"),
      timeToFirstWorkerMs: relative("timeToFirstWorkerMs"),
      slotUtilization: relative("slotUtilization")
    },
    scenarios: [...new Set(report.map((item) => item.scenario))].map((scenario) => {
      const baselineScenario = report.find((item) => item.scenario === scenario && item.variant === baselineVariant);
      const candidateScenario = report.find((item) => item.scenario === scenario && item.variant === candidateVariant);
      return { scenario, baseline: baselineScenario ?? null, candidate: candidateScenario ?? null };
    })
  };
  if (!requiredSuite) return comparison;
  const acceptance = evaluateBenchmarkAcceptance(comparison, BENCHMARK_ACCEPTANCE_TARGETS);
  invariant(acceptance.passed, "BENCHMARK_ACCEPTANCE_FAILED", "Official benchmark evidence does not satisfy the release acceptance gates.", acceptance);
  return { ...comparison, acceptance };
}

/** Evaluate measured comparison data against the prompt's acceptance gates.
 * Missing timing evidence is a failed gate, never an implied pass. */
export function evaluateBenchmarkAcceptance(comparison, targets = BENCHMARK_ACCEPTANCE_TARGETS) {
  invariant(comparison?.baseline && comparison?.candidate, "BENCHMARK_COMPARISON", "A baseline/candidate comparison is required.");
  const observedNames = new Set((comparison.scenarios ?? []).map((entry) => entry.scenario));
  const requiredScenarioEvidence = comparison.requiredSuite === true
    && DEFAULT_BENCHMARK_SCENARIOS.every((scenario) => observedNames.has(scenario.name));
  const scenarios = (comparison.scenarios ?? []).map((entry) => {
    const target = { ...(targets.all ?? {}), ...(targets[entry.scenario] ?? {}) };
    const baseline = entry.baseline;
    const candidate = entry.candidate;
    const declaredScenario = DEFAULT_BENCHMARK_SCENARIOS.find((scenario) => scenario.name === entry.scenario);
    const modelEvidenceApplicable = declaredScenario?.localProbe !== true
      || baseline?.modelEvidence?.main?.applicable === true
      || candidate?.modelEvidence?.main?.applicable === true
      || baseline?.modelEvidence?.nested?.applicable === true
      || candidate?.modelEvidence?.nested?.applicable === true;
    const modelEvidence = !modelEvidenceApplicable
      ? true
      : Boolean(
        baseline?.modelEvidence
        && candidate?.modelEvidence
        && (baseline.modelEvidence.main?.applicable !== true || (baseline.modelEvidence.main.allPinned === true && baseline.modelEvidence.main.outerReceiptValid === true))
        && (candidate.modelEvidence.main?.applicable !== true || (candidate.modelEvidence.main.allPinned === true && candidate.modelEvidence.main.outerReceiptValid === true))
        && (baseline.modelEvidence.nested?.applicable !== true || (baseline.modelEvidence.nested.allLuna === true && baseline.modelEvidence.nested.recoveryInvalid !== true && baseline.modelEvidence.nested.runStatus !== "blocked" && (baseline.modelEvidence.nested.recoveryReceiptRequired !== true || baseline.modelEvidence.nested.recoveryReceiptValid === true)))
        && (candidate.modelEvidence.nested?.applicable !== true || (candidate.modelEvidence.nested.allLuna === true && candidate.modelEvidence.nested.recoveryInvalid !== true && candidate.modelEvidence.nested.runStatus !== "blocked" && (candidate.modelEvidence.nested.recoveryReceiptRequired !== true || candidate.modelEvidence.nested.recoveryReceiptValid === true)))
      );
    const passRate = Boolean(baseline && candidate && candidate.passRate === 1 && candidate.passRate >= baseline.passRate);
    const p95 = Boolean(baseline && candidate && candidate.p95VerifiedDurationMs !== null && baseline.p95VerifiedDurationMs !== null && candidate.p95VerifiedDurationMs <= baseline.p95VerifiedDurationMs);
    const median = target.medianImprovement === undefined
      ? true
      : Boolean(baseline && candidate && baseline.medianVerifiedDurationMs > 0 && candidate.medianVerifiedDurationMs <= baseline.medianVerifiedDurationMs * (1 - target.medianImprovement));
    const declaredFirstWorkerApplicable = candidate?.firstWorkerApplicable ?? baseline?.firstWorkerApplicable;
    const firstWorkerApplicable = declaredFirstWorkerApplicable === false
      ? false
      : declaredFirstWorkerApplicable === true
        ? true
        : baseline?.timeToFirstWorkerMs === null && candidate?.timeToFirstWorkerMs === null
          ? false
          : Number.isFinite(baseline?.timeToFirstWorkerMs) && Number.isFinite(candidate?.timeToFirstWorkerMs)
            ? true
            : null;
    const firstWorker = target.timeToFirstWorkerImprovement === undefined || firstWorkerApplicable === false
      ? true
      : Boolean(firstWorkerApplicable === true && baseline && candidate && baseline.timeToFirstWorkerMs > 0 && candidate.timeToFirstWorkerMs <= baseline.timeToFirstWorkerMs * (1 - target.timeToFirstWorkerImprovement));
    return {
      scenario: entry.scenario,
      passRate,
      p95NoRegression: p95,
      medianImprovement: median,
      timeToFirstWorkerImprovement: firstWorker,
      modelEvidence,
      passed: passRate && p95 && median && firstWorker && modelEvidence,
      evidence: {
        baselineMedianMs: baseline?.medianVerifiedDurationMs ?? null,
        candidateMedianMs: candidate?.medianVerifiedDurationMs ?? null,
        baselineP95Ms: baseline?.p95VerifiedDurationMs ?? null,
        candidateP95Ms: candidate?.p95VerifiedDurationMs ?? null,
        baselineFirstWorkerMs: baseline?.timeToFirstWorkerMs ?? null,
        candidateFirstWorkerMs: candidate?.timeToFirstWorkerMs ?? null,
        modelEvidence,
        firstWorkerApplicable
      }
    };
  });
  return {
    passed: scenarios.length > 0 && scenarios.every((item) => item.passed) && (comparison.requiredSuite !== true || requiredScenarioEvidence),
    scenarioCount: scenarios.length,
    requiredScenarioEvidence,
    scenarios,
    targets
  };
}
