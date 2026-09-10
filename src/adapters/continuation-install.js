import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { invariant } from "../core/errors.js";
import { safeManifestPath } from "../core/security.js";
import { stableStringify } from "../core/util.js";

const CONTINUATION_MANIFEST_KEY = "continuationHooks";
const MANIFEST_RELATIVE = ".agents/metis/install-manifest.json";
const HOSTS = new Set(["claude", "codex"]);
const COMMON_EVENTS = ["Stop", "SessionStart"];
const CLAUDE_EVENTS = [...COMMON_EVENTS, "StopFailure", "SessionEnd"];

function eventsFor(host) {
  return host === "claude" ? CLAUDE_EVENTS : COMMON_EVENTS;
}
const SETTINGS_BY_HOST = {
  claude: ".claude/settings.json",
  codex: ".codex/hooks.json"
};
const RUNTIME_HOOK_RELATIVE = ".agents/metis/runtime/src/adapters/continuation-hook.js";
const MAX_JSON_BYTES = 4 * 1024 * 1024;

function assertHost(host) {
  invariant(HOSTS.has(host), "HOST_INVALID", `Unsupported continuation host: ${host}.`);
}

function safeRelative(root, relative, code = "CONTINUATION_PATH_INVALID") {
  return safeManifestPath(root, relative, { code });
}

function manifestFile(root) {
  return safeRelative(root, MANIFEST_RELATIVE, "CONTINUATION_MANIFEST_PATH_INVALID");
}

function settingsFile(root, host) {
  return safeRelative(root, SETTINGS_BY_HOST[host], "CONTINUATION_SETTINGS_PATH_INVALID");
}

function runtimeHookFile(root) {
  return safeRelative(root, RUNTIME_HOOK_RELATIVE, "CONTINUATION_RUNTIME_PATH_INVALID");
}

function readObject(file, label) {
  if (!existsSync(file)) return { value: {}, existed: false };
  const stat = lstatSync(file);
  if (!stat.isFile()) {
    return { error: `${label} is not a regular file` };
  }
  if (stat.size > MAX_JSON_BYTES) {
    return { error: `${label} exceeds the maximum supported size` };
  }
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: `${label} must contain a JSON object` };
    }
    return { value, existed: true };
  } catch (error) {
    return { error: `${label} is invalid JSON: ${error.message}` };
  }
}

function readInstallManifest(root) {
  const file = manifestFile(root);
  if (!existsSync(file.absolute)) return { file, manifest: null };
  const parsed = readObject(file.absolute, MANIFEST_RELATIVE);
  if (parsed.error) invariant(false, "CONTINUATION_MANIFEST_INVALID", parsed.error);
  const manifest = parsed.value;
  invariant(manifest.version === 4, "INSTALL_MANIFEST_VERSION", "This installation was created by an incompatible Metis version. Remove it before installing continuation hooks.");
  invariant(Array.isArray(manifest.hosts), "INSTALL_MANIFEST_INVALID", "The install manifest hosts must be an array.");
  invariant(Array.isArray(manifest.files), "INSTALL_MANIFEST_INVALID", "The install manifest files must be an array.");
  return { file, manifest };
}

function atomicWrite(file, content) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const mode = existsSync(file) ? (lstatSync(file).mode & 0o777) : 0o600;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode });
    renameSync(temporary, file);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function writeInstallManifest(file, manifest) {
  manifest.updatedAt = new Date().toISOString();
  mkdirSync(path.dirname(file.absolute), { recursive: true });
  atomicWrite(file.absolute, `${stableStringify(manifest)}\n`);
}

function shellQuote(value) {
  const text = String(value);
  invariant(text && !/[\0\r\n]/u.test(text), "CONTINUATION_COMMAND_INVALID", "The continuation command contains invalid characters.");
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function commandFor(root, host) {
  const runtime = runtimeHookFile(root).absolute;
  invariant(existsSync(runtime) && lstatSync(runtime).isFile(), "CONTINUATION_RUNTIME_MISSING", `The installed continuation runner is missing: ${RUNTIME_HOOK_RELATIVE}`);
  return `${shellQuote(process.execPath)} --no-warnings ${shellQuote(runtime)} --host ${shellQuote(host)}`;
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function commandHook(command) {
  return { type: "command", command };
}

function ownedGroup(command) {
  return { hooks: [commandHook(command)] };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function commandLooksOwned(value, host) {
  return isObject(value)
    && value.type === "command"
    && typeof value.command === "string"
    && value.command.includes("continuation-hook.js")
    && value.command.includes(`--host '${host}'`);
}

function eventGroups(settings, event, conflicts) {
  if (!isObject(settings.hooks)) {
    conflicts.push({ event, reason: "hooks must be a JSON object" });
    return null;
  }
  if (settings.hooks[event] === undefined) {
    settings.hooks[event] = [];
    return { groups: settings.hooks[event], created: true };
  }
  if (!Array.isArray(settings.hooks[event])) {
    conflicts.push({ event, reason: `${event} hooks must be an array` });
    return null;
  }
  return { groups: settings.hooks[event], created: false };
}

function locateHook(groups, command, host, previousCommand = null) {
  let previous = null;
  let suspicious = null;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    for (let hookIndex = 0; hookIndex < group.hooks.length; hookIndex += 1) {
      const hook = group.hooks[hookIndex];
      if (deepEqual(hook, commandHook(command))) return { groupIndex, hookIndex, kind: "current" };
      if (previousCommand && deepEqual(hook, commandHook(previousCommand))) previous = { groupIndex, hookIndex, kind: "previous" };
      if (commandLooksOwned(hook, host)) suspicious = { groupIndex, hookIndex, kind: "modified" };
    }
  }
  return previous ?? suspicious;
}

function addEvent(settings, event, host, command, previousCommand, manifestRecord, result) {
  const eventState = eventGroups(settings, event, result.conflicts);
  if (!eventState) return false;
  const groups = eventState.groups;
  const found = locateHook(groups, command, host, previousCommand);
  if (!found && previousCommand) {
    const location = manifestRecord.events[event]?.location;
    const candidate = location && groups[location.groupIndex]?.hooks?.[location.hookIndex];
    if (candidate && !deepEqual(candidate, commandHook(previousCommand))) {
      result.conflicts.push({ path: SETTINGS_BY_HOST[host], event, reason: "existing continuation hook was modified; refusing to overwrite" });
      return false;
    }
  }
  if (found?.kind === "current") {
    result.preserved.push({ path: SETTINGS_BY_HOST[host], event, reason: "continuation hook already installed" });
    return true;
  }
  if (found?.kind === "previous") {
    groups[found.groupIndex].hooks[found.hookIndex] = commandHook(command);
    result.installed.push({ path: SETTINGS_BY_HOST[host], event, status: "updated" });
    manifestRecord.events[event] = {
      command,
      group: groups[found.groupIndex],
      location: { groupIndex: found.groupIndex, hookIndex: found.hookIndex },
      eventCreated: Boolean(manifestRecord.events[event]?.eventCreated)
    };
    return true;
  }
  if (found?.kind === "modified") {
    result.conflicts.push({ path: SETTINGS_BY_HOST[host], event, reason: "existing continuation hook was modified; refusing to overwrite" });
    return false;
  }
  const group = ownedGroup(command);
  groups.push(group);
  result.installed.push({ path: SETTINGS_BY_HOST[host], event, status: "created" });
  manifestRecord.events[event] = {
    command,
    group,
    location: { groupIndex: groups.length - 1, hookIndex: 0 },
    eventCreated: eventState.created
  };
  return true;
}

function normalizeManifestRecord(manifest, host, settingsRelative) {
  if (!isObject(manifest[CONTINUATION_MANIFEST_KEY])) manifest[CONTINUATION_MANIFEST_KEY] = {};
  const all = manifest[CONTINUATION_MANIFEST_KEY];
  const existing = isObject(all[host]) ? all[host] : {};
  const events = isObject(existing.events) ? existing.events : {};
  const record = {
    path: settingsRelative,
    fileCreated: Boolean(existing.fileCreated),
    hooksCreated: Boolean(existing.hooksCreated),
    events
  };
  all[host] = record;
  return record;
}

function removeOneOwned(groups, event, record, host, result) {
  if (!Array.isArray(groups)) {
    result.conflicts.push({ event, reason: `${event} hooks must be an array` });
    return false;
  }
  const command = record?.command;
  if (typeof command !== "string") {
    result.conflicts.push({ event, reason: "continuation manifest record is incomplete" });
    return false;
  }
  const found = locateHook(groups, command, host);
  if (!found || found.kind !== "current") {
    result.conflicts.push({ event, reason: "continuation hook was changed or removed; refusing to delete user content" });
    return false;
  }
  const group = groups[found.groupIndex];
  group.hooks.splice(found.hookIndex, 1);
  if (group.hooks.length === 0 && Object.keys(group).every((key) => key === "hooks")) groups.splice(found.groupIndex, 1);
  result.installed.push({ path: SETTINGS_BY_HOST[host], event, status: "removed" });
  return true;
}

function pruneEmptySettings(root, file, settings, manifestRecord) {
  if (!manifestRecord.fileCreated || Object.keys(settings).length !== 0) return;
  rmSync(file.absolute, { force: true });
  let parent = path.dirname(file.absolute);
  const rootAbsolute = path.resolve(root);
  while (parent.startsWith(`${rootAbsolute}${path.sep}`)) {
    try {
      if (requireDirectoryEntries(parent).length > 0) break;
      rmSync(parent, { recursive: true, force: true });
    } catch { break; }
    parent = path.dirname(parent);
  }
}

function requireDirectoryEntries(directory) {
  return readdirSync(directory);
}

function resultFor() {
  return { installed: [], preserved: [], conflicts: [] };
}

function validateCodexSettings(value, result, relative) {
  const unknown = Object.keys(value).filter((key) => key !== "description" && key !== "hooks");
  if (unknown.length > 0) {
    result.conflicts.push({ path: relative, reason: `Codex hooks.json contains unsupported top-level keys: ${unknown.join(", ")}` });
    return false;
  }
  if (!isObject(value.hooks)) {
    result.conflicts.push({ path: relative, reason: "Codex hooks must be a JSON object" });
    return false;
  }
  for (const event of COMMON_EVENTS) {
    if (value.hooks[event] !== undefined && !Array.isArray(value.hooks[event])) {
      result.conflicts.push({ path: relative, event, reason: `${event} hooks must be an array` });
      return false;
    }
  }
  return true;
}

export function installContinuationHooks(projectRoot, options = {}) {
  const host = options.host;
  assertHost(host);
  const result = resultFor();
  const { file: manifestPath, manifest } = readInstallManifest(projectRoot);
  if (!manifest) {
    result.conflicts.push({ path: MANIFEST_RELATIVE, reason: "Metis adapter installation manifest is missing" });
    return result;
  }
  if (!manifest.hosts.includes(host)) {
    result.conflicts.push({ path: MANIFEST_RELATIVE, reason: `${host} adapter is not installed` });
    return result;
  }
  const runtime = runtimeHookFile(projectRoot).absolute;
  if (!existsSync(runtime) || !lstatSync(runtime).isFile()) {
    result.conflicts.push({ path: RUNTIME_HOOK_RELATIVE, reason: "installed continuation runner is missing" });
    return result;
  }
  const settings = settingsFile(projectRoot, host);
  const parsed = readObject(settings.absolute, settings.relative);
  if (parsed.error) {
    result.conflicts.push({ path: settings.relative, reason: parsed.error });
    return result;
  }
  const value = structuredClone(parsed.value);
  const hooksWereMissing = !Object.hasOwn(value, "hooks");
  if (value.hooks === undefined) value.hooks = {};
  if (!isObject(value.hooks)) {
    result.conflicts.push({ path: settings.relative, reason: "hooks must be a JSON object" });
    return result;
  }
  const stagedResult = resultFor();
  if (host === "codex" && !validateCodexSettings(value, stagedResult, settings.relative)) {
    result.conflicts.push(...stagedResult.conflicts);
    return result;
  }
  const stagedManifest = structuredClone(manifest);
  const record = normalizeManifestRecord(stagedManifest, host, settings.relative);
  if (!parsed.existed) {
    record.fileCreated = true;
    record.hooksCreated = true;
  } else if (hooksWereMissing) {
    record.hooksCreated = true;
  }
  for (const event of eventsFor(host)) {
    const previousCommand = record.events[event]?.command ?? null;
    const command = commandFor(projectRoot, host);
    addEvent(value, event, host, command, previousCommand, record, stagedResult);
  }
  if (stagedResult.conflicts.length > 0) {
    return {
      installed: [],
      preserved: stagedResult.preserved,
      conflicts: stagedResult.conflicts
    };
  }
  const shouldWrite = stagedResult.installed.length > 0;
  if (shouldWrite) {
    mkdirSync(path.dirname(settings.absolute), { recursive: true });
    atomicWrite(settings.absolute, `${JSON.stringify(value, null, 2)}\n`);
    writeInstallManifest(manifestPath, stagedManifest);
  }
  return stagedResult;
}

export function uninstallContinuationHooks(projectRoot, options = {}) {
  const host = options.host;
  assertHost(host);
  const result = resultFor();
  const { file: manifestPath, manifest } = readInstallManifest(projectRoot);
  if (!manifest) {
    result.preserved.push({ path: MANIFEST_RELATIVE, reason: "Metis adapter installation manifest is missing" });
    return result;
  }
  const all = manifest[CONTINUATION_MANIFEST_KEY];
  const record = isObject(all) && isObject(all[host]) ? all[host] : null;
  if (!record) {
    result.preserved.push({ path: SETTINGS_BY_HOST[host], reason: "continuation hooks are not managed by Metis" });
    return result;
  }
  const settings = settingsFile(projectRoot, host);
  if (!existsSync(settings.absolute)) {
    delete all[host];
    if (Object.keys(all).length === 0) delete manifest[CONTINUATION_MANIFEST_KEY];
    writeInstallManifest(manifestPath, manifest);
    return result;
  }
  const parsed = readObject(settings.absolute, settings.relative);
  if (parsed.error) {
    result.conflicts.push({ path: settings.relative, reason: parsed.error });
    return result;
  }
  const value = parsed.value;
  if (!isObject(value.hooks)) {
    result.conflicts.push({ path: settings.relative, reason: "hooks must be a JSON object" });
    return result;
  }
  if (host === "codex" && !validateCodexSettings(value, result, settings.relative)) return result;
  const preview = resultFor();
  const previewValue = structuredClone(value);
  for (const event of eventsFor(host)) {
    const eventRecord = record.events?.[event];
    if (!eventRecord) continue;
    const groups = previewValue.hooks[event];
    removeOneOwned(groups, event, eventRecord, host, preview);
    if (eventRecord.eventCreated && Array.isArray(previewValue.hooks[event]) && previewValue.hooks[event].length === 0) delete previewValue.hooks[event];
  }
  if (record.hooksCreated && isObject(previewValue.hooks) && Object.keys(previewValue.hooks).length === 0) delete previewValue.hooks;
  if (preview.conflicts.length > 0) {
    result.conflicts.push(...preview.conflicts);
    return result;
  }
  let changed = false;
  for (const event of eventsFor(host)) {
    const eventRecord = record.events?.[event];
    if (!eventRecord) continue;
    const groups = value.hooks[event];
    if (removeOneOwned(groups, event, eventRecord, host, result)) {
      changed = true;
      if (eventRecord.eventCreated && Array.isArray(value.hooks[event]) && value.hooks[event].length === 0) delete value.hooks[event];
    }
  }
  if (record.hooksCreated && isObject(value.hooks) && Object.keys(value.hooks).length === 0) delete value.hooks;
  if (changed) atomicWrite(settings.absolute, `${JSON.stringify(value, null, 2)}\n`);
  if (result.conflicts.length === 0) {
    delete all[host];
    if (Object.keys(all).length === 0) delete manifest[CONTINUATION_MANIFEST_KEY];
    pruneEmptySettings(projectRoot, settings, value, record);
    writeInstallManifest(manifestPath, manifest);
  }
  return result;
}

export { RUNTIME_HOOK_RELATIVE };
