import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

function canonicalSectionHeader(raw) {
  const parts = [];
  let part = "";
  let quote = null;
  let escaped = false;
  for (const character of raw.trim()) {
    if (escaped) {
      part += character;
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      part += character;
      escaped = true;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = quote === character ? null : quote ?? character;
      part += character;
      continue;
    }
    if (character === "." && !quote) {
      parts.push(part.trim());
      part = "";
      continue;
    }
    part += character;
  }
  parts.push(part.trim());
  const first = parts[0][0];
  if (parts.length === 1 && (first === "\"" || first === "'") && parts[0].at(-1) === first
      && parts[0].slice(1, -1).includes(".")) return `__literal__:${parts[0]}`;
  return parts.map((part) => part.replace(/^["']|["']$/gu, "").trim()).join(".");
}

function parseSections(text) {
  const sections = new Map([["", []]]);
  let current = "";
  for (const line of text.split(/\r?\n/u)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (header) {
      current = canonicalSectionHeader(header[1]);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current).push(line);
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join("\n")]));
}

function setting(section, name) {
  if (!section) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const line = section.split(/\r?\n/u).find((item) => new RegExp(`^\\s*${escaped}\\s*=`, "u").test(item));
  if (!line) return null;
  const value = line.slice(line.indexOf("=") + 1);
  let quote = null;
  let escapedCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escapedCharacter) {
      escapedCharacter = false;
      continue;
    }
    if (quote && character === "\\") {
      escapedCharacter = true;
      continue;
    }
    if ((character === "\"" || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
      continue;
    }
    if (character === "#" && !quote) return value.slice(0, index).trim();
  }
  return value.trim();
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
  return value.replace(/^["']|["']$/gu, "");
}

function integerSetting(section, name) {
  const raw = setting(section, name);
  if (raw === null) return null;
  const value = Number(raw);
  return /^[-+]?\d+$/u.test(raw) && Number.isSafeInteger(value) ? value : null;
}

function settingPresent(section, name) {
  return setting(section, name) !== null;
}

function invalidIntegerSetting(section, name) {
  const raw = setting(section, name);
  if (raw === null) return false;
  const value = Number(raw);
  return !/^[-+]?\d+$/u.test(raw) || !Number.isSafeInteger(value);
}

function concurrencySetting(sections) {
  const v2 = sections.get("features.multi_agent_v2");
  const root = sections.get("");
  if (settingPresent(v2, "max_concurrent_threads_per_session")) {
    return {
      value: integerSetting(v2, "max_concurrent_threads_per_session"),
      invalid: invalidIntegerSetting(v2, "max_concurrent_threads_per_session")
    };
  }
  return {
    value: integerSetting(root, "max_concurrent_threads_per_session"),
    invalid: invalidIntegerSetting(root, "max_concurrent_threads_per_session")
  };
}

export function parseCodexConfigText(text, file = null) {
  const sections = parseSections(text);
  const root = sections.get("");
  const features = sections.get("features");
  const v2 = sections.get("features.multi_agent_v2");
  const concurrency = concurrencySetting(sections);
  return {
    file,
    exists: true,
    provider: stringSetting(root, "model_provider"),
    goals: booleanSetting(features, "goals"),
    multiAgentV1: booleanSetting(features, "multi_agent"),
    multiAgentV2: booleanSetting(v2, "enabled") ?? booleanSetting(features, "multi_agent_v2"),
    maxConcurrentV2: concurrency.value,
    maxConcurrentV2Invalid: concurrency.invalid,
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
    "maxConcurrentV2Invalid",
    "hideSpawnAgentMetadata",
    "toolNamespace",
    "exposeSpawnAgentModelOverrides",
    "waitAgentEnabled"
  ];
  const merged = { exists: false, files: [] };
  for (const layer of layers.filter(Boolean)) {
    if (!layer.exists) continue;
    merged.exists = true;
    if (layer.invalid) {
      merged.invalid = true;
      if (layer.reason) merged.reason = layer.reason;
    }
    if (layer.file) merged.files.push(layer.file);
    for (const field of fields) {
      if (layer[field] !== null && layer[field] !== undefined) merged[field] = layer[field];
    }
  }
  merged.file = merged.files.at(-1) ?? null;
  return merged;
}

function invalidProjectConfig(file, reason) {
  return { file, exists: true, invalid: true, reason: String(reason).slice(0, 240) };
}

export function projectCodexConfig(projectRoot) {
  if (!projectRoot) return { exists: false };
  const codexDirectory = path.join(projectRoot, ".codex");
  const file = path.join(codexDirectory, "config.toml");
  try {
    const directoryStat = lstatSync(codexDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return invalidProjectConfig(file, "The project .codex path is not a real directory.");
    const fileStat = lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return invalidProjectConfig(file, "The project Codex config path is not a real file.");
    const parsed = parseCodexConfigText(readFileSync(file, "utf8"), file);
    if (parsed.maxConcurrentV2Invalid || (parsed.maxConcurrentV2 !== null && parsed.maxConcurrentV2 <= 0)) {
      return invalidProjectConfig(file, "The project Codex concurrency setting is invalid.");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { file, exists: false };
    return invalidProjectConfig(file, error?.message ?? "The project Codex config could not be read.");
  }
}

export function hostConcurrencyLimit(projectRoot, host, configuredLimit) {
  const globalLimit = Number(configuredLimit);
  if (!Number.isSafeInteger(globalLimit) || globalLimit <= 0) return 0;
  if (String(host ?? "").trim().toLowerCase() !== "codex") return globalLimit;
  const project = projectCodexConfig(projectRoot);
  if (project.invalid) return 0;
  const projectLimit = project.maxConcurrentV2;
  return Number.isInteger(projectLimit) && projectLimit > 0
    ? Math.min(globalLimit, projectLimit)
    : globalLimit;
}
