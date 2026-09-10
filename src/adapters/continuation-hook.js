import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Native Stop-hook adapter for Claude Code and Codex.
 *
 * This module deliberately does not open Metis' database or execute `metis
 * next`. The core continuation projection is read by the parent runtime and
 * injected into `respondToHost`; the command entry point loads that projection
 * when the core module is available.
 */

export const PROTOCOL = "metis.continuation.v1";
export const HOSTS = Object.freeze(new Set(["claude", "codex"]));
export const DECISIONS = Object.freeze(new Set(["CONTINUE", "WAIT", "PAUSE", "COMPLETE", "DETACHED"]));
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_BLOCKS = 6;
export const MAX_NO_PROGRESS = 2;

const MAX_ID_LENGTH = 256;
const MAX_REASON_LENGTH = 180;
const MAX_SYSTEM_MESSAGE_LENGTH = 240;
const ALLOWED_EVENTS = new Set(["Stop", "StopFailure", "SessionEnd", "SessionStart"]);
const RUN_CONTINUATION_MESSAGE = "Metis has more work in the same run. Use the resolved Metis launcher (`$METIS next`); existing runtime gates still apply.";
const PAUSE_MESSAGE = "Metis paused continuation. Stop is allowed; explicit resume and liveness are required before continuing.";
const ERROR_MESSAGE = "Metis continuation is unavailable. Stop is allowed; inspect the run and resume explicitly.";
const SESSION_MESSAGE = "Metis continuation is not activated. Confirm the native goal is inactive, then use the authenticated CLI bind syntax: metis continuation bind --host <host> --session-id <session_id>.";

function boundedString(value, max = MAX_ID_LENGTH) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)
    ? value
    : null;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function safeJsonParse(text) {
  try {
    const value = JSON.parse(text);
    return plainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function canonicalRoot(root) {
  try { return realpathSync(path.resolve(root)); } catch { return null; }
}

/** Resolve only the Git root enclosing cwd; never fall back to cwd. */
export function resolveEnclosingGitRoot(cwd) {
  const directory = boundedString(cwd, 4096);
  if (!directory || !path.isAbsolute(directory)) return null;
  try {
    const stat = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      maxBuffer: 16 * 1024
    });
    const root = stat.trim();
    if (!root || !path.isAbsolute(root)) return null;
    const resolved = canonicalRoot(root);
    return resolved && existsSync(path.join(resolved, ".git")) ? resolved : null;
  } catch {
    return null;
  }
}

function normalizeHostEvent(input, expectedHost = null) {
  if (!plainObject(input)) return null;
  const host = expectedHost ?? input.host;
  if (!HOSTS.has(host)) return null;
  const eventName = input.hook_event_name ?? input.event ?? "Stop";
  if (!boundedString(eventName, 32) || !ALLOWED_EVENTS.has(eventName)) return null;
  const cwd = boundedString(input.cwd, 4096);
  const sessionId = boundedString(input.session_id, MAX_ID_LENGTH);
  if (!cwd || !path.isAbsolute(cwd) || !sessionId) return null;
  if (input.host !== undefined && input.host !== host) return null;
  if (input.stop_hook_active !== undefined && typeof input.stop_hook_active !== "boolean") return null;
  const turnId = input.turn_id === undefined || input.turn_id === null ? null : boundedString(input.turn_id);
  if (input.turn_id !== undefined && input.turn_id !== null && !turnId) return null;
  return Object.freeze({
    host,
    eventName,
    cwd: path.resolve(cwd),
    sessionId,
    turnId,
    stopHookActive: input.stop_hook_active === true,
    backgroundTasks: input.background_tasks,
    // Deliberately omit last_assistant_message and all other raw model text.
  });
}

export function validateHookEvent(input, host = null) {
  return normalizeHostEvent(input, host);
}

function taskIsVisible(task) {
  if (!plainObject(task)) return false;
  if (task.active === true || task.running === true) return true;
  const status = typeof task.status === "string" ? task.status.toLowerCase() : "";
  return new Set(["running", "pending", "queued", "in_progress", "in-progress", "started"]).has(status);
}

export function hasVisibleBackgroundTasks(value) {
  return Array.isArray(value) && value.length > 0 && value.some(taskIsVisible);
}

function normalizeSnapshot(snapshot) {
  if (!plainObject(snapshot) || snapshot.protocol !== PROTOCOL) return null;
  const decision = typeof snapshot.decision === "string" ? snapshot.decision.toUpperCase() : "";
  if (!DECISIONS.has(decision)) return null;
  const reasonCode = boundedString(snapshot.reasonCode, 80);
  const runId = boundedString(snapshot.runId);
  const bindingId = boundedString(snapshot.bindingId);
  const revision = boundedInteger(snapshot.revision, 0);
  const stateFingerprint = boundedString(snapshot.stateFingerprint ?? snapshot.fingerprint, 128);
  if (!reasonCode) return null;
  if (decision !== "DETACHED" && (!runId || !bindingId || revision === null)) return null;
  return Object.freeze({
    protocol: snapshot.protocol,
    decision,
    reasonCode,
    runId: runId ?? null,
    bindingId: bindingId ?? null,
    revision: revision ?? 0,
    stateFingerprint,
    ...(snapshot.host ? { host: snapshot.host } : {})
  });
}

function fixedMessage(value, max) {
  return String(value).slice(0, max);
}

/** Pure host response conversion. No filesystem, database, or subprocess use. */
export function hostResponse(snapshot, { host = "claude", hasBackgroundTasks = false, backgroundTasks = null } = {}) {
  const current = normalizeSnapshot(snapshot);
  const visibleBackgroundTasks = hasBackgroundTasks || hasVisibleBackgroundTasks(backgroundTasks);
  if (!current || !HOSTS.has(host)) return { systemMessage: ERROR_MESSAGE };
  switch (current.decision) {
    case "CONTINUE":
      return { decision: "block", reason: fixedMessage(RUN_CONTINUATION_MESSAGE, MAX_REASON_LENGTH) };
    case "WAIT":
      // A native background event owns the wait. Do not manufacture a poll or
      // wake the model when there is no host-visible child work.
      return visibleBackgroundTasks ? ({}) : pauseResponse(host, "WAIT_NO_VISIBLE_TASK");
    case "PAUSE":
      return pauseResponse(host, current.reasonCode);
    case "COMPLETE":
      return {};
    case "DETACHED":
      return {};
    default:
      return { systemMessage: ERROR_MESSAGE };
  }
}

export const respondToHost = hostResponse;
export const toHostResponse = hostResponse;

function pauseResponse(host, reasonCode) {
  const message = fixedMessage(`${PAUSE_MESSAGE} (${boundedString(reasonCode, 80) ?? "unknown"})`, MAX_SYSTEM_MESSAGE_LENGTH);
  return { systemMessage: message };
}

function deliveryDirectory(root) {
  return path.join(root, ".metis", "continuation-delivery");
}

function deliveryPath(root, host, sessionId) {
  const digest = createHash("sha256").update(`${host}\0${sessionId}`).digest("hex");
  return path.join(deliveryDirectory(root), `${digest}.json`);
}

function readDelivery(root, host, sessionId) {
  try {
    const directory = deliveryDirectory(root);
    if (existsSync(directory) && !safeDeliveryDirectory(root, directory)) return { __invalid: true };
    const file = deliveryPath(root, host, sessionId);
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return { __invalid: true };
    const value = safeJsonParse(readFileSync(file, "utf8"));
    return value && value.version === 1 ? value : { __invalid: true };
  } catch {
    return { __invalid: true };
  }
}

function safeDeliveryDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
  }
  return true;
}

function writeDelivery(root, host, sessionId, value) {
  const directory = deliveryDirectory(root);
  const target = deliveryPath(root, host, sessionId);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  if (!safeDeliveryDirectory(root, directory)) return false;
  let descriptor;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!safeDeliveryDirectory(root, directory)) return false;
    descriptor = openSync(temporary, "wx", 0o600);
    const payload = `${JSON.stringify(value)}\n`;
    writeFileSync(descriptor, payload, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    return true;
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    return false;
  }
}

function snapshotFingerprint(snapshot, event) {
  return createHash("sha256").update(JSON.stringify({
    decision: snapshot.decision,
    reasonCode: snapshot.reasonCode,
    runId: snapshot.runId,
    bindingId: snapshot.bindingId,
    revision: snapshot.revision,
    stateFingerprint: snapshot.stateFingerprint,
    stopHookActive: event.stopHookActive
  })).digest("hex");
}

function deliveryDecision(snapshot, event, binding, previous) {
  const base = {
    version: 1,
    bindingId: binding.bindingId,
    runId: binding.runId,
    revision: snapshot.revision,
    stateFingerprint: snapshot.stateFingerprint ?? null,
    blocks: Number(previous?.blocks ?? 0),
    noProgress: Number(previous?.noProgress ?? 0),
    suppressed: previous?.suppressed === true,
    lastTurnId: previous?.lastTurnId ?? null,
    lastFingerprint: previous?.lastFingerprint ?? null
  };
  if (base.suppressed) return { suppress: true, metadata: base };
  // A repeated Codex turn_id is not proof that this Stop is a duplicate: a
  // blocked Stop may legitimately be replayed for the same turn. Progress is
  // determined only from the core state snapshot; unchanged state reaches the
  // bounded no-progress pause, while changed state remains deliverable.
  const fingerprint = snapshotFingerprint(snapshot, event);
  if (snapshot.decision !== "CONTINUE") {
    return {
      suppress: false,
      metadata: {
        ...base,
        suppressed: snapshot.decision === "PAUSE",
        lastTurnId: event.turnId,
        lastFingerprint: fingerprint,
        revision: snapshot.revision,
        stateFingerprint: snapshot.stateFingerprint ?? null
      }
    };
  }
  const sameState = snapshot.stateFingerprint && previous?.stateFingerprint
    ? snapshot.stateFingerprint === previous.stateFingerprint
    : Number(previous?.revision) === snapshot.revision;
  const noProgress = sameState ? base.noProgress + 1 : 0;
  const blocks = base.blocks + 1;
  if (blocks > MAX_BLOCKS || noProgress >= MAX_NO_PROGRESS || event.stopHookActive && blocks >= MAX_BLOCKS) {
    const paused = { ...snapshot, decision: "PAUSE", reasonCode: blocks > MAX_BLOCKS ? "CONTINUATION_BLOCK_CAP" : "NO_PROGRESS" };
    return {
      suppress: false,
      snapshot: paused,
      metadata: { ...base, blocks, noProgress, suppressed: true, lastTurnId: event.turnId, lastFingerprint: fingerprint, revision: snapshot.revision, stateFingerprint: snapshot.stateFingerprint ?? null }
    };
  }
  return {
    suppress: false,
    metadata: { ...base, blocks, noProgress, lastTurnId: event.turnId, lastFingerprint: fingerprint, revision: snapshot.revision, stateFingerprint: snapshot.stateFingerprint ?? null }
  };
}

function bindingFromSnapshot(snapshot, event, root) {
  if (!snapshot?.runId || !snapshot?.bindingId) return null;
  return Object.freeze({
    protocol: PROTOCOL,
    bindingId: snapshot.bindingId,
    runId: snapshot.runId,
    sessionId: event.sessionId,
    host: event.host,
    projectRoot: root,
    revision: snapshot.revision,
    evidence: null
  });
}

async function loadInspector() {
  try {
    const module = await import("../core/continuation.js");
    return typeof module.inspectContinuation === "function" ? module.inspectContinuation : null;
  } catch {
    return null;
  }
}

/**
 * Process one already parsed native event. `inspect` is injectable for unit
 * tests and is expected to be the pure core `inspectContinuation` function.
 */
export async function processHookEvent(input, options = {}) {
  const host = options.host ?? input?.host;
  const event = normalizeHostEvent(input, host);
  if (!event) return {};
  if (event.eventName === "SessionStart") {
    const context = JSON.stringify({ host: event.host, session_id: event.sessionId });
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `${SESSION_MESSAGE} Session context: ${context}`
      }
    };
  }
  const root = resolveEnclosingGitRoot(event.cwd);
  if (!root) return {};
  if (event.eventName !== "Stop" && event.eventName !== "StopFailure" && event.eventName !== "SessionEnd") return {};
  const inspect = options.inspect ?? await loadInspector();
  // Core inspectContinuation is the sole binding/authentication authority. If
  // it is unavailable, a Stop is an explicit visible pause; lifecycle events
  // cannot safely establish that a binding exists and therefore stay silent.
  if (typeof inspect !== "function") {
    return event.eventName === "Stop"
      ? hostResponse({ protocol: PROTOCOL, decision: "PAUSE", reasonCode: "INSPECTOR_UNAVAILABLE", runId: "unavailable", bindingId: "unavailable", revision: 0 }, { host: event.host })
      : {};
  }
  let snapshot;
  try {
    snapshot = normalizeSnapshot(await inspect(root, { host: event.host, sessionId: event.sessionId }));
  } catch {
    return event.eventName === "Stop"
      ? hostResponse({ protocol: PROTOCOL, decision: "PAUSE", reasonCode: "INSPECT_ERROR", runId: "unavailable", bindingId: "unavailable", revision: 0 }, { host: event.host })
      : {};
  }
  // DETACHED is intentionally indistinguishable from an ordinary host stop:
  // no response, no delivery directory, and no bookkeeping. An otherwise
  // malformed ABI response is an explicit visible pause, never DETACHED.
  if (snapshot?.decision === "DETACHED") return {};
  if (!snapshot) {
    return event.eventName === "Stop"
      ? hostResponse({ protocol: PROTOCOL, decision: "PAUSE", reasonCode: "SNAPSHOT_INVALID", runId: "invalid", bindingId: "invalid", revision: 0 }, { host: event.host })
      : {};
  }
  const binding = bindingFromSnapshot(snapshot, event, root);
  if (!binding) {
    return event.eventName === "Stop"
      ? hostResponse({ protocol: PROTOCOL, decision: "PAUSE", reasonCode: "BINDING_INVALID", runId: "invalid", bindingId: "invalid", revision: 0 }, { host: event.host })
      : {};
  }
  const storedDelivery = readDelivery(root, event.host, event.sessionId);
  if (storedDelivery?.__invalid === true) {
    return event.eventName === "Stop"
      ? hostResponse({ protocol: PROTOCOL, decision: "PAUSE", reasonCode: "DELIVERY_STATE_INVALID", runId: binding.runId, bindingId: binding.bindingId, revision: snapshot.revision }, { host: event.host })
      : {};
  }
  // A new bindingId is the explicit reset boundary for cancellation, failure,
  // and dedupe state from the previous authenticated binding.
  const delivery = storedDelivery?.bindingId === binding.bindingId ? storedDelivery : null;
  if (event.eventName === "StopFailure" || event.eventName === "SessionEnd") {
    writeDelivery(root, event.host, event.sessionId, {
      version: 1, bindingId: binding.bindingId, runId: binding.runId,
      revision: snapshot.revision, stateFingerprint: snapshot.stateFingerprint ?? null,
      blocks: Number(delivery?.blocks ?? 0), noProgress: Number(delivery?.noProgress ?? 0),
      suppressed: true, lastTurnId: event.turnId ?? delivery?.lastTurnId ?? null, lastFingerprint: delivery?.lastFingerprint ?? null
    });
    return {};
  }
  if (delivery?.suppressed === true) return {};
  const outcome = deliveryDecision(snapshot, event, binding, delivery);
  if (outcome.suppress) return {};
  const effectiveSnapshot = outcome.snapshot ?? snapshot;
  const response = hostResponse(effectiveSnapshot, {
    host: event.host,
    hasBackgroundTasks: hasVisibleBackgroundTasks(event.backgroundTasks)
  });
  const delivered = writeDelivery(root, event.host, event.sessionId, outcome.metadata);
  if (!delivered && effectiveSnapshot.decision === "CONTINUE") {
    return hostResponse({ protocol: PROTOCOL, decision: "PAUSE", reasonCode: "DELIVERY_WRITE_FAILED", runId: binding.runId, bindingId: binding.bindingId, revision: snapshot.revision }, { host: event.host });
  }
  return response;
}

export async function runCli({ input = process.stdin, output = process.stdout, host = null, inspect = null, sessionStartContext = false } = {}) {
  let text = "";
  try {
    for await (const chunk of input) {
      text += String(chunk);
      if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) return output.write("{}\n");
    }
  } catch {
    return output.write("{}\n");
  }
  const event = safeJsonParse(text);
  if (!event) return output.write("{}\n");
  const response = await processHookEvent(event, { host, inspect, sessionStartContext });
  output.write(`${JSON.stringify(response)}\n`);
  return response;
}

function cliHost(argv) {
  const index = argv.indexOf("--host");
  const value = index >= 0 ? argv[index + 1] : null;
  return HOSTS.has(value) ? value : null;
}

let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {}

if (invokedDirectly) {
  const host = cliHost(process.argv.slice(2));
  if (host) await runCli({ host });
  else process.stdout.write("{}\n");
}

export const _testing = Object.freeze({
  normalizeSnapshot,
  normalizeHostEvent,
  readDelivery,
  deliveryDecision,
  deliveryPath,
  MAX_BLOCKS,
  MAX_NO_PROGRESS,
  RUN_CONTINUATION_MESSAGE,
  PAUSE_MESSAGE
});
