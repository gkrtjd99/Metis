import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandExists, runCommand } from "./util.js";
import { capabilityRegistryManifest } from "./capabilities.js";
import { objectSecurityStatus } from "./objects.js";
import { runtimeDatabasePath, runtimeRoot } from "./paths.js";
import { ROLES } from "./metadata.js";

function parseFeature(output, name) {
  const line = output.split(/\r?\n/).find((item) => item.trim().startsWith(name));
  if (!line) return null;
  const tokens = line.trim().split(/\s+/);
  const value = tokens.at(-1)?.toLowerCase();
  if (value === "true" || value === "enabled") return true;
  if (value === "false" || value === "disabled") return false;
  return null;
}

function parseSections(text) {
  const sections = new Map([["", []]]);
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (header) {
      current = header[1].trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current).push(line);
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join("\n")]));
}

function setting(section, name) {
  if (!section) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return section.match(new RegExp(`^\\s*${escaped}\\s*=\\s*([^#\\n]+)`, "m"))?.[1]?.trim() ?? null;
}

function booleanSetting(section, name) {
  const value = setting(section, name)?.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function stringSetting(section, name) {
  const value = setting(section, name);
  if (value === null) return null;
  return value.replace(/^["']|["']$/g, "");
}

function integerSetting(section, name) {
  const value = Number(setting(section, name));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseCodexConfigText(text, file = null) {
  const sections = parseSections(text);
  const root = sections.get("");
  const features = sections.get("features");
  const v2 = sections.get("features.multi_agent_v2");
  return {
    file,
    exists: true,
    provider: stringSetting(root, "model_provider"),
    goals: booleanSetting(features, "goals"),
    multiAgentV1: booleanSetting(features, "multi_agent"),
    multiAgentV2: booleanSetting(v2, "enabled") ?? booleanSetting(features, "multi_agent_v2"),
    maxConcurrentV2: integerSetting(v2, "max_concurrent_threads_per_session")
      ?? integerSetting(root, "max_concurrent_threads_per_session"),
    hideSpawnAgentMetadata: booleanSetting(v2, "hide_spawn_agent_metadata"),
    toolNamespace: stringSetting(v2, "tool_namespace"),
    exposeSpawnAgentModelOverrides: booleanSetting(v2, "expose_spawn_agent_model_overrides"),
    waitAgentEnabled: booleanSetting(v2, "wait_agent_enabled")
  };
}

export function mergeCodexConfigLayers(...layers) {
  const fields = [
    "provider",
    "goals",
    "multiAgentV1",
    "multiAgentV2",
    "maxConcurrentV2",
    "hideSpawnAgentMetadata",
    "toolNamespace",
    "exposeSpawnAgentModelOverrides",
    "waitAgentEnabled"
  ];
  const merged = { exists: false, files: [] };
  for (const layer of layers.filter(Boolean)) {
    if (!layer.exists) continue;
    merged.exists = true;
    if (layer.file) merged.files.push(layer.file);
    for (const field of fields) {
      if (layer[field] !== null && layer[field] !== undefined) merged[field] = layer[field];
    }
  }
  merged.file = merged.files.at(-1) ?? null;
  return merged;
}

function parseCodexConfig(projectRoot) {
  const files = [
    path.join(os.homedir(), ".codex", "config.toml"),
    path.join(projectRoot, ".codex", "config.toml")
  ];
  return mergeCodexConfigLayers(...files.map((file) => existsSync(file)
    ? parseCodexConfigText(readFileSync(file, "utf8"), file)
    : { file, exists: false }));
}

const METIS_ROLES = Object.freeze(ROLES.map((role) => `metis-${role}`));

function projectRoleStatus(projectRoot) {
  const directory = path.join(projectRoot, ".codex", "agents");
  const present = existsSync(directory)
    ? new Set(readdirSync(directory).filter((file) => file.endsWith(".toml")).map((file) => file.slice(0, -5)))
    : new Set();
  return {
    directory,
    expected: [...METIS_ROLES],
    installed: METIS_ROLES.filter((role) => present.has(role)),
    missing: METIS_ROLES.filter((role) => !present.has(role))
  };
}

function installedFile(projectRoot, relative) {
  return existsSync(path.join(projectRoot, relative));
}

function hostAdapterStatus(projectRoot, host) {
  if (host === "codex") {
    const required = [
      "plugins/metis/.codex-plugin/plugin.json",
      ".agents/skills/metis/SKILL.md",
      ".agents/metis/metis.mjs"
    ];
    const present = required.filter((item) => installedFile(projectRoot, item));
    return { required, present, missing: required.filter((item) => !present.includes(item)), installed: present.length === required.length };
  }
  if (host === "claude") {
    const required = [
      ".claude/commands/metis.md",
      ".claude/skills/metis/SKILL.md",
      ".claude/agents/metis-worker.md"
    ];
    const present = required.filter((item) => installedFile(projectRoot, item));
    return { required, present, missing: required.filter((item) => !present.includes(item)), installed: present.length === required.length };
  }
  const required = [
    ".opencode/commands/metis.md",
    ".opencode/skills/metis/SKILL.md",
    ".opencode/agents/metis-worker.md"
  ];
  const present = required.filter((item) => installedFile(projectRoot, item));
  return { required, present, missing: required.filter((item) => !present.includes(item)), installed: present.length === required.length };
}

function capabilitySkillStatus(projectRoot) {
  const expected = capabilityRegistryManifest().map((item) => item.skillPath);
  const roots = [
    path.join(projectRoot, ".agents", "skills", "metis"),
    path.join(projectRoot, "skills", "metis")
  ];
  const installedRoot = roots.find((root) => existsSync(root)) ?? roots[0];
  const present = expected.filter((relative) => existsSync(path.join(installedRoot, relative)));
  return { root: installedRoot, expected, present, missing: expected.filter((item) => !present.includes(item)) };
}

function stateSecurity(projectRoot) {
  const database = runtimeDatabasePath(projectRoot);
  const directory = runtimeRoot(projectRoot);
  const mode = (target) => existsSync(target) ? (statSync(target).mode & 0o777).toString(8).padStart(3, "0") : null;
  return { directory, directoryMode: mode(directory), database, databaseMode: mode(database) };
}

function repositoryIsolation(projectRoot, config) {
  const gitHead = runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectRoot, timeout: 5000 }).status === 0;
  return {
    worktreeMode: config.worktrees.mode,
    gitHead,
    mutableDispatchReady: config.worktrees.mode === "required" && gitHead,
    sharedMutableFallback: false
  };
}

export function doctor(projectRoot, config, db = null) {
  const codex = commandExists("codex");
  const claude = commandExists("claude");
  const opencode = commandExists("opencode");
  let codexVersion = null;
  let features = "";
  if (codex) {
    codexVersion = runCommand("codex", ["--version"], { timeout: 5000 }).stdout.trim();
    features = runCommand("codex", ["features", "list"], { timeout: 10000 }).stdout;
  }
  const codexConfig = parseCodexConfig(projectRoot);
  const roles = projectRoleStatus(projectRoot);
  const adapters = {
    codex: hostAdapterStatus(projectRoot, "codex"),
    claude: hostAdapterStatus(projectRoot, "claude"),
    opencode: hostAdapterStatus(projectRoot, "opencode")
  };
  const listedGoals = parseFeature(features, "goals");
  const listedMultiAgentV2 = parseFeature(features, "multi_agent_v2");
  const listedMultiAgentV1 = parseFeature(features, "multi_agent");
  const goalMode = codex && (listedGoals ?? codexConfig.goals ?? false);
  const multiAgentV2 = codex && (listedMultiAgentV2 ?? codexConfig.multiAgentV2 ?? false);
  const multiAgentV1 = codex && (listedMultiAgentV1 ?? codexConfig.multiAgentV1 ?? false);
  let dispatchMode = "sequential";
  if (multiAgentV2) dispatchMode = "codex-native-v2";
  else if (multiAgentV1) dispatchMode = "codex-native-v1";
  const maxConcurrent = dispatchMode === "codex-native-v2"
    ? Math.min(config.orchestration.maxConcurrent, codexConfig.maxConcurrentV2 ?? config.orchestration.maxConcurrent)
    : dispatchMode === "codex-native-v1"
      ? config.orchestration.maxConcurrent
      : 1;
  const warnings = [];
  if (!codex) warnings.push("Codex CLI was not found. The runtime still works, but Codex-native Goal mode and dispatch are unavailable.");
  if (codex && !goalMode) warnings.push("Codex native Goal mode is not enabled or was not detected. Enable the goals feature, then invoke `/goal $metis \"<objective>\"`.");
  if (!codex && codexConfig.multiAgentV2) warnings.push("Codex multi-agent v2 is configured, but no Codex CLI is available on PATH.");
  if (dispatchMode === "codex-native-v2" && (codexConfig.provider ?? "openai") !== "openai") {
    warnings.push("Multi-agent v2 can depend on provider-specific transport. Test one child dispatch before a large run.");
  }
  if (dispatchMode === "codex-native-v2" && codexConfig.toolNamespace && codexConfig.toolNamespace !== "agents") {
    warnings.push(`Multi-agent v2 uses tool namespace ${codexConfig.toolNamespace}; the Metis Skill expects the host-exposed namespace.`);
  }
  if (dispatchMode === "codex-native-v2" && roles.missing.length > 0) {
    warnings.push(`Missing project-scoped Metis agent roles: ${roles.missing.join(", ")}. Run metis init --host codex --force.`);
  }
  if (dispatchMode === "codex-native-v2" && codexConfig.waitAgentEnabled === false) {
    warnings.push("Codex wait_agent is disabled. Metis can still poll task state, but native child completion handling is less direct.");
  }
  if (adapters.codex.installed && roles.missing.length > 0) {
    warnings.push(`The Codex adapter is installed, but these roles are missing: ${roles.missing.join(", ")}.`);
  }
  const boundary = {
    orchestrationBoundary: true,
    runtimeEnforcesHostToolPermissions: false,
    statement: "Metis controls orchestration and repository integration; host tool permissions remain host-controlled."
  };
  const isolation = repositoryIsolation(projectRoot, config);
  if (!isolation.mutableDispatchReady) warnings.push("Mutable dispatch requires Git HEAD and `worktrees.mode = required`; shared mutable fallback is disabled.");
  const objectStore = objectSecurityStatus(projectRoot);
  const capabilitySkills = capabilitySkillStatus(projectRoot);
  if (capabilitySkills.missing.length > 0) warnings.push(`Capability skill files are missing: ${capabilitySkills.missing.join(", ")}.`);
  const state = stateSecurity(projectRoot);
  if (state.directoryMode && state.directoryMode !== "700") warnings.push(`Runtime directory permissions are ${state.directoryMode}; use 700 for sensitive state.`);
  if (state.databaseMode && state.databaseMode !== "600") warnings.push(`State database permissions are ${state.databaseMode}; use 600 for sensitive state.`);
  const activeController = db ? db.prepare(`
    SELECT id, status, controller_owner, controller_session_id, controller_fencing_token, controller_expires_at
    FROM runs WHERE status IN ('active','blocked') ORDER BY created_at DESC LIMIT 1
  `).get() ?? null : null;
  const latestScan = db ? db.prepare("SELECT * FROM repository_scans ORDER BY created_at DESC LIMIT 1").get() ?? null : null;
  if (latestScan?.truncated) warnings.push(`Repository discovery is truncated: indexed ${latestScan.indexed_files} of ${latestScan.discovered_files ?? "unknown"} files.`);
  const capabilities = {
    codex: {
      cliAvailable: codex,
      adapterInstalled: adapters.codex.installed,
      nativeGoal: goalMode,
      nativeMultiAgent: dispatchMode === "codex-native-v2" || dispatchMode === "codex-native-v1",
      roleRouting: roles.missing.length === 0,
      modelOverrides: codexConfig.exposeSpawnAgentModelOverrides !== false,
      waitAgent: codexConfig.waitAgentEnabled !== false,
      dispatchMode,
      maxConcurrent
    },
    claude: {
      cliAvailable: claude,
      adapterInstalled: adapters.claude.installed,
      commandSurface: adapters.claude.present.includes(".claude/commands/metis.md"),
      sharedState: adapters.claude.installed,
      dispatchMode: claude && adapters.claude.installed ? "host-managed" : "unavailable"
    },
    opencode: {
      cliAvailable: opencode,
      adapterInstalled: adapters.opencode.installed,
      commandSurface: adapters.opencode.present.includes(".opencode/commands/metis.md"),
      sharedState: adapters.opencode.installed,
      dispatchMode: opencode && adapters.opencode.installed ? "host-managed" : "unavailable"
    }
  };
  const recommendedHost = capabilities.codex.cliAvailable && capabilities.codex.adapterInstalled
    ? "codex"
    : capabilities.claude.cliAvailable && capabilities.claude.adapterInstalled
      ? "claude"
      : capabilities.opencode.cliAvailable && capabilities.opencode.adapterInstalled
        ? "opencode"
        : "runtime-only";
  return {
    projectRoot,
    hosts: { codex, claude, opencode },
    adapters,
    capabilities,
    boundary,
    isolation,
    objectStore,
    stateSecurity: state,
    capabilitySkills,
    controller: activeController ? {
      runId: activeController.id,
      runStatus: activeController.status,
      owner: activeController.controller_owner,
      sessionId: activeController.controller_session_id,
      fencingToken: Number(activeController.controller_fencing_token),
      expiresAt: activeController.controller_expires_at,
      expired: Date.parse(activeController.controller_expires_at) <= Date.now()
    } : null,
    repositoryScan: latestScan ? {
      source: latestScan.source,
      discoveredFiles: Number(latestScan.discovered_files ?? latestScan.indexed_files),
      indexedFiles: Number(latestScan.indexed_files),
      limit: Number(latestScan.limit_files),
      truncated: Boolean(latestScan.truncated)
    } : null,
    recommendedHost,
    codex: {
      version: codexVersion,
      goalMode,
      multiAgentV1,
      multiAgentV2,
      configured: {
        goals: codexConfig.goals,
        multiAgentV1: codexConfig.multiAgentV1,
        multiAgentV2: codexConfig.multiAgentV2
      },
      config: codexConfig,
      roles,
      dispatchMode,
      maxConcurrent,
      childContext: "none",
      recommendation: dispatchMode === "codex-native-v2"
        ? "Use self-contained child messages with no inherited Main transcript. Keep raw child I/O outside the Main thread."
        : dispatchMode === "codex-native-v1"
          ? "Use isolated subagents with self-contained task contracts."
          : "Run bounded lanes sequentially and keep the same task/result contracts."
    },
    warnings
  };
}
