import { chmodSync, writeFileSync } from "node:fs";
import { ensureRuntimeLayout, runtimeConfigPath } from "./paths.js";
import { readJsonFile, stableStringify } from "./util.js";

const OBSOLETE_ORCHESTRATION_FIELDS = new Set(["requireIndependentReview", "requireAdversarialCompletionReview"]);

export const DEFAULT_CONFIG = Object.freeze({
  version: 6,
  host: "codex",
  approvalPolicy: "autonomous-local",
  controller: {
    // A controller commonly waits several minutes for an independent child.
    // Keep the lease longer than one normal host turn while retaining a
    // frequent heartbeat for prompt crash recovery.
    leaseSeconds: 600,
    heartbeatSeconds: 120
  },
  storage: {
    encryptObjects: true,
    redactSecrets: true
  },
  productDelivery: {
    capabilities: true,
    requireBrowserEvidence: true,
    requireMilestoneExitCriteria: true,
    checkpoints: true
  },
  delegation: {
    mainMode: "orchestrator-only",
    scheduleByWave: true,
    requireReadyTaskPacket: true,
    compilerPolicy: "auto",
    compilerRisks: ["high", "critical"],
    compilerEfforts: ["large"],
    diagnoseBeforeRetry: true,
    maxContextRefs: 24,
    maxResolvedContextChars: 8000,
    maxDependencySummaries: 12
  },
  budgets: {
    mainContextTokens: 3000,
    workerResultTokens: 700,
    taskPacketTokens: 2400,
    compilerResultTokens: 1400,
    recentEvents: 6,
    rawPreviewChars: 1000,
    reserveTokens: 7000,
    maxRemainingFraction: 0.18,
    model: null,
    tokenizer: {
      mode: "required",
      command: null,
      args: [],
      timeoutMs: 5000
    },
    run: {
      inputTokens: 1000000,
      outputTokens: 300000,
      toolCalls: 1500,
      agentSpawns: 160,
      researchCalls: 40,
      wallClockMinutes: 480,
      retries: 80
    }
  },
  orchestration: {
    maxConcurrent: 8,
    maxTasks: 180,
    maxTasksPerMilestone: 48,
    maxDelegationDepth: 2,
    leaseMinutes: 30,
    leaseHeartbeatSeconds: 300,
    maxRetries: 2,
    loopThreshold: 3,
    progressStallThreshold: 3,
    requireDesignCritic: true,
    requirePlanCritic: true,
    autoCreateRepairTasks: true,
    maxPlanCriticalFindings: 0,
    maxDesignCriticalFindings: 0,
    maxOpenHighImpactAssumptions: 0,
    maxOpenCriticalRisks: 0,
    lifecycleOverlap: {
      predesign: true
    },
    specialistReviews: {
      enabled: true
    }
  },
  worktrees: {
    mode: "required",
    keepFailed: false,
    keepCompleted: false,
    integrationLockSeconds: 120
  },
  models: {
    main: {
      codex: { model: null, reasoningEffort: null },
      claude: { model: null, reasoningEffort: null },
      opencode: { model: null, reasoningEffort: null }
    },
    defaults: {
      codex: { worker: null },
      claude: { worker: null },
      opencode: { worker: null }
    },
    routes: {
      scout: { tier: "worker", model: null, reasoningEffort: "low" },
      researcher: { tier: "worker", model: null, reasoningEffort: "medium" },
      synthesizer: { tier: "strong", model: null, reasoningEffort: "high" },
      designer: { tier: "strong", model: null, reasoningEffort: "high" },
      "design-critic": { tier: "strong", model: null, reasoningEffort: "high" },
      planner: { tier: "strong", model: null, reasoningEffort: "high" },
      "plan-critic": { tier: "strong", model: null, reasoningEffort: "high" },
      "task-compiler": { tier: "strong", model: null, reasoningEffort: "high" },
      worker: { tier: "worker", model: null, reasoningEffort: "high" },
      coordinator: { tier: "worker", model: null, reasoningEffort: "medium" },
      integrator: { tier: "strong", model: null, reasoningEffort: "high" },
      diagnostician: { tier: "strong", model: null, reasoningEffort: "high" },
      reviewer: { tier: "strong", model: null, reasoningEffort: "high" },
      "security-reviewer": { tier: "strong", model: null, reasoningEffort: "high" },
      "database-reviewer": { tier: "strong", model: null, reasoningEffort: "high" },
      "performance-reviewer": { tier: "strong", model: null, reasoningEffort: "high" },
      "accessibility-reviewer": { tier: "strong", model: null, reasoningEffort: "high" },
      "migration-reviewer": { tier: "strong", model: null, reasoningEffort: "high" },
      verifier: { tier: "strong", model: null, reasoningEffort: "high" },
      "adversarial-reviewer": { tier: "strong", model: null, reasoningEffort: "high" },
      curator: { tier: "worker", model: null, reasoningEffort: "medium" }
    },
    effortPolicy: {
      ordinaryWorker: { initial: "high", reasoningRetries: ["xhigh", "max"] },
      strongRole: { initial: "high", reasoningRetries: ["xhigh", "max"] },
      transient: "hold",
      external: "hold",
      contract: "hold",
      dependency: "hold",
      plan: "hold"
    },
    // These are capabilities proven by the corresponding installed adapter.
    // A model/host absent from this map is intentionally unknown and routes
    // fail closed instead of sending an unverified effort argument.
    capabilities: {
      codex: { models: {} },
      claude: { models: {} },
      opencode: { models: {} }
    }
  },
  index: {
    maxFiles: 50000,
    allowTruncated: false,
    maxDepth: 4,
    symbols: true,
    symbolProvider: "auto",
    ctagsCommand: "ctags",
    ctagsTimeoutMs: 30000,
    maxSymbols: 50000,
    dependencies: true,
    maxDependencyEdges: 100000,
    ignore: [
      ".git",
      ".metis",
      ".agents/metis",
      ".agents/skills/metis",
      ".agents/plugins/marketplace.json",
      "plugins/metis",
      ".codex/config.toml",
      ".codex/agents/metis-scout.toml",
      ".codex/agents/metis-researcher.toml",
      ".codex/agents/metis-synthesizer.toml",
      ".codex/agents/metis-designer.toml",
      ".codex/agents/metis-design-critic.toml",
      ".codex/agents/metis-planner.toml",
      ".codex/agents/metis-plan-critic.toml",
      ".codex/agents/metis-task-compiler.toml",
      ".codex/agents/metis-worker.toml",
      ".codex/agents/metis-coordinator.toml",
      ".codex/agents/metis-integrator.toml",
      ".codex/agents/metis-diagnostician.toml",
      ".codex/agents/metis-reviewer.toml",
      ".codex/agents/metis-security-reviewer.toml",
      ".codex/agents/metis-database-reviewer.toml",
      ".codex/agents/metis-performance-reviewer.toml",
      ".codex/agents/metis-accessibility-reviewer.toml",
      ".codex/agents/metis-migration-reviewer.toml",
      ".codex/agents/metis-verifier.toml",
      ".codex/agents/metis-adversarial-reviewer.toml",
      ".codex/agents/metis-curator.toml",
      ".claude/commands/metis.md",
      ".claude/skills/metis",
      ".claude/agents/metis-*.md",
      ".opencode/commands/metis.md",
      ".opencode/skills/metis",
      ".opencode/agents/metis-*.md",
      "node_modules",
      "dist",
      "build",
      "coverage",
      ".next",
      ".venv",
      "target"
    ]
  },
  verification: {
    timeoutMs: 600000,
    failFast: true
  },
  browser: {
    timeoutMs: 120000,
    failOnConsoleError: true,
    failOnNetworkFailure: true,
    maxScreenshots: 20
  },
  cleanup: {
    keepContexts: 8,
    worktreeMaxAgeHours: 24
  }
});

function merge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return override ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(base?.[key] ?? {}, value)
      : value;
  }
  return result;
}

function validateConfig(config) {
  const orchestration = config?.orchestration;
  for (const field of OBSOLETE_ORCHESTRATION_FIELDS) {
    if (orchestration && Object.hasOwn(orchestration, field)) {
      throw new Error(`Obsolete configuration field orchestration.${field}; lifecycleProfile controls mandatory review gates.`);
    }
  }
  return config;
}

export function configPath(projectRoot) {
  return runtimeConfigPath(projectRoot);
}

export function loadConfig(projectRoot) {
  const configured = readJsonFile(configPath(projectRoot), {});
  validateConfig(configured);
  if (configured?.version !== undefined && configured.version !== 6) {
    throw new Error("Metis requires config version 6. Remove `.metis/config.json` and run `metis init`.");
  }
  return validateConfig(merge(DEFAULT_CONFIG, configured));
}

export function ensureConfig(projectRoot, overrides = {}) {
  ensureRuntimeLayout(projectRoot);
  const config = validateConfig(merge(loadConfig(projectRoot), validateConfig(overrides)));
  return writeConfig(projectRoot, config);
}

export function writeConfig(projectRoot, config) {
  ensureRuntimeLayout(projectRoot);
  validateConfig(config);
  if (Number(config?.version) !== 6) throw new Error("Metis config writes require version 6.");
  writeFileSync(configPath(projectRoot), `${stableStringify(config)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath(projectRoot), 0o600);
  return config;
}
