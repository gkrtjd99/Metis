import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  readdirSync,
  unlinkSync,
  writeSync
} from "node:fs";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CONFIG_VERSION, RUNTIME_LAYOUT_VERSION, SCHEMA_VERSION } from "./metadata.js";
import { databasePath } from "./db.js";
import { assertController } from "./ownership.js";
import { parseJson, stableStringify } from "./util.js";
import { MetisError } from "./errors.js";

function continuationError(code, message = code) {
  return new MetisError(code, `${code}: ${message}`);
}

export const CONTINUATION_PROTOCOL = "metis.continuation.v1";
export const CONTINUATION_DECISIONS = Object.freeze(["CONTINUE", "WAIT", "PAUSE", "COMPLETE", "DETACHED"]);

const SUPPORTED_HOSTS = new Set(["claude", "codex"]);
const MAX_BINDING_BYTES = 16 * 1024;
const MAX_BINDINGS = 64;
const BATCH_STALE_SECONDS = 300;
const FATAL_FAILURES = new Set(["auth", "authorization", "contract", "permanent", "external", "policy"]);

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeText(value, max = 256) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function response(decision, reasonCode, fields = {}) {
  return {
    protocol: CONTINUATION_PROTOCOL,
    decision,
    reasonCode,
    runId: fields.runId ?? null,
    bindingId: fields.bindingId ?? null,
    revision: fields.revision ?? null,
    ...fields
  };
}

function canonicalRoot(root) {
  if (typeof root !== "string" || !root.trim()) return null;
  try {
    return realpathSync(path.resolve(root));
  } catch {
    return null;
  }
}

function continuationDirectory(root) {
  return path.join(root, ".metis", "continuation");
}

function bindingFile(root, host, sessionId) {
  return path.join(continuationDirectory(root), `${hash(`${host}:${sessionId}`)}.json`);
}

function isRegularNonSymlink(file) {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function assertNoSymlinkPath(root, target, { allowMissingFinal = true } = {}) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path escapes project root");
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("symbolic path component");
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissingFinal) continue;
      throw error;
    }
  }
}

function readBoundedJson(file) {
  if (!isRegularNonSymlink(file)) throw new Error("binding is not a regular file");
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(file, flags);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_BINDING_BYTES) throw new Error("binding is too large or not a file");
    const text = readFileSync(descriptor, { encoding: "utf8" });
    if (!text || Buffer.byteLength(text, "utf8") > MAX_BINDING_BYTES) throw new Error("binding is too large");
    return JSON.parse(text);
  } finally {
    closeSync(descriptor);
  }
}

function validateBinding(value, expectedRoot = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("binding is not an object");
  const forbidden = ["token", "controllerToken", "leaseToken", "credentials", "controllerCredentials"];
  if (forbidden.some((field) => Object.hasOwn(value, field))) throw new Error("binding contains credentials");
  if (value.protocol !== CONTINUATION_PROTOCOL || Number(value.version) !== 1) throw new Error("unsupported binding protocol");
  for (const field of ["bindingId", "projectIdentity", "runId", "host", "sessionId", "controllerSessionId", "controllerFencingToken"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`binding field ${field} is invalid`);
  }
  if (!SUPPORTED_HOSTS.has(value.host)) throw new Error("unsupported binding host");
  const fence = Number(value.controllerFencingToken);
  if (!Number.isSafeInteger(fence) || fence < 0) throw new Error("binding fence is invalid");
  if (value.nativeGoalInactive !== true) throw new Error("native goal is active");
  if (typeof value.evidence !== "string" || !value.evidence.trim()) throw new Error("binding evidence is missing");
  if (expectedRoot && value.projectIdentity !== hash(expectedRoot)) throw new Error("binding project identity differs");
  return value;
}

function listBindings(root, options = {}) {
  const directory = continuationDirectory(root);
  if (!existsSync(directory)) return [];
  assertNoSymlinkPath(root, directory, { allowMissingFinal: false });
  const stat = lstatSync(directory);
  if (!stat.isDirectory()) throw new Error("continuation directory is not a directory");
  if (options.sessionId !== undefined) {
    const file = bindingFile(root, options.host, options.sessionId);
    if (!existsSync(file)) return [];
    assertNoSymlinkPath(root, file, { allowMissingFinal: false });
    return [{ file, value: validateBinding(readBoundedJson(file), root) }];
  }
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length > MAX_BINDINGS) throw new Error("too many continuation bindings");
  const bindings = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("unsafe continuation binding entry");
    const file = path.join(directory, entry.name);
    const value = validateBinding(readBoundedJson(file), root);
    bindings.push({ file, value });
  }
  return bindings;
}

function bindingSummary(binding) {
  if (!binding) return {};
  return {
    bindingId: binding.bindingId,
    runId: binding.runId,
    host: binding.host,
    sessionId: binding.sessionId,
    controllerSessionId: binding.controllerSessionId,
    controllerFencingToken: Number(binding.controllerFencingToken)
  };
}

function immutableBindingPart(binding) {
  return {
    protocol: CONTINUATION_PROTOCOL,
    version: 1,
    bindingId: binding.bindingId,
    projectIdentity: binding.projectIdentity,
    runId: binding.runId,
    host: binding.host,
    sessionId: binding.sessionId,
    controllerSessionId: binding.controllerSessionId,
    controllerFencingToken: String(binding.controllerFencingToken),
    nativeGoalInactive: true,
    evidence: binding.evidence
  };
}

function makeBinding(root, run, credentials, options) {
  const rawSessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
  const rawEvidence = typeof options.evidence === "string" ? options.evidence.trim() : "";
  const rawHost = typeof options.host === "string" ? options.host.trim() : "";
  const host = rawHost.toLowerCase();
  if (rawHost.length > 32 || !SUPPORTED_HOSTS.has(host)) throw continuationError("CONTINUATION_HOST_UNSUPPORTED", "Only claude and codex continuation hosts are supported.");
  if (options.nativeGoalInactive !== true) throw continuationError("CONTINUATION_NATIVE_GOAL_ACTIVE", "The native host goal must be inactive.");
  if (!rawEvidence) throw continuationError("CONTINUATION_EVIDENCE_REQUIRED", "Binding evidence is required.");
  if (!rawSessionId) throw continuationError("CONTINUATION_SESSION_REQUIRED", "A host session ID is required.");
  if (rawSessionId.length > 256 || rawEvidence.length > 1024) throw continuationError("CONTINUATION_INPUT_TOO_LARGE", "Binding identity and evidence exceed their limits.");
  if (!credentials?.sessionId || credentials.sessionId !== run.controller_session_id) throw continuationError("CONTINUATION_SESSION_MISMATCH", "Credentials do not identify the run controller.");
  const secret = credentials.token ? String(credentials.token) : "";
  if (secret && (rawSessionId.includes(secret) || rawEvidence.includes(secret))) throw continuationError("CONTINUATION_SECRET_IN_EVIDENCE", "Binding identity and evidence must not contain controller credentials.");
  const sessionId = rawSessionId;
  const evidence = rawEvidence;
  if (run.host !== host) throw continuationError("CONTINUATION_HOST_MISMATCH", "The binding host does not match the run host.");
  if (run.status !== "active" || run.phase === "complete") throw continuationError("CONTINUATION_CONTROLLER_INACTIVE", "Only an active root controller can bind continuation.");
  const immutable = {
    projectIdentity: hash(root),
    runId: run.id,
    host,
    sessionId,
    controllerSessionId: String(run.controller_session_id),
    controllerFencingToken: String(run.controller_fencing_token),
    nativeGoalInactive: true,
    evidence
  };
  return {
    ...immutable,
    protocol: CONTINUATION_PROTOCOL,
    version: 1,
    bindingId: hash(stableStringify({
      projectIdentity: immutable.projectIdentity,
      runId: immutable.runId,
      host: immutable.host,
      sessionId: immutable.sessionId,
      controllerSessionId: immutable.controllerSessionId,
      controllerFencingToken: immutable.controllerFencingToken,
      ...(options.rebind === true ? { nonce: randomUUID() } : {})
    }))
  };
}

function withBindingLock(root, callback) {
  const directory = continuationDirectory(root);
  assertNoSymlinkPath(root, directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkPath(root, directory, { allowMissingFinal: false });
  const lock = path.join(directory, ".bind.lock");
  assertNoSymlinkPath(root, lock);
  let descriptor;
  try {
    descriptor = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw continuationError("CONTINUATION_BIND_BUSY", "Another binding update is in progress.");
    throw error;
  }
  try {
    return callback();
  } finally {
    try { closeSync(descriptor); } catch {}
    try { unlinkSync(lock); } catch {}
  }
}

function writeBindingAtomic(root, file, binding) {
  const directory = continuationDirectory(root);
  assertNoSymlinkPath(root, directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkPath(root, directory, { allowMissingFinal: false });
  if (existsSync(file)) {
    assertNoSymlinkPath(root, file, { allowMissingFinal: false });
    if (!isRegularNonSymlink(file)) throw new Error("unsafe existing binding");
  }
  const temporary = `${file}.tmp-${process.pid}-${hash(`${Date.now()}-${Math.random()}`).slice(0, 16)}`;
  assertNoSymlinkPath(root, temporary);
  const payload = `${stableStringify(binding)}\n`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, payload, 0, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try {
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function databaseSidecarsSafe(file) {
  const sidecars = [`${file}-wal`, `${file}-shm`, `${file}-journal`];
  for (const sidecar of sidecars) {
    if (existsSync(sidecar) && !isRegularNonSymlink(sidecar)) return false;
  }
  return true;
}

function immutableSqliteSupported() {
  const [major, minor] = String(process.versions.node).split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 16);
}

function databaseGuard(file) {
  const stat = lstatSync(file, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    wal: existsSync(`${file}-wal`),
    shm: existsSync(`${file}-shm`),
    journal: existsSync(`${file}-journal`)
  };
}

function sameDatabaseGuard(file, before) {
  try {
    const after = databaseGuard(file);
    return stableStringify(after) === stableStringify(before);
  } catch {
    return false;
  }
}

function openExistingDatabase(root) {
  const file = databasePath(root);
  if (!existsSync(file)) return null;
  assertNoSymlinkPath(root, path.join(root, ".metis"), { allowMissingFinal: false });
  assertNoSymlinkPath(root, path.dirname(file), { allowMissingFinal: false });
  if (!isRegularNonSymlink(file)) throw new Error("state database is not a regular file");
  if (!databaseSidecarsSafe(file)) throw new Error("state database sidecars are unsafe");
  const guard = databaseGuard(file);
  if (guard.wal || guard.shm || guard.journal) {
    const error = new Error("state database has live SQLite sidecars");
    error.code = "STATE_BUSY";
    throw error;
  }
  if (!immutableSqliteSupported()) {
    const error = new Error("immutable SQLite URI support requires Node.js 22.16 or newer");
    error.code = "IMMUTABLE_UNSUPPORTED";
    throw error;
  }
  const databaseName = `${pathToFileURL(file).href}?immutable=1`;
  const db = new DatabaseSync(databaseName, { readOnly: true });
  return { db, guard, immutable: true, file };
}

function checkRuntimeMetadata(root, db) {
  const layoutFile = path.join(root, ".metis", "layout.json");
  const configFile = path.join(root, ".metis", "config.json");
  for (const file of [layoutFile, configFile]) {
    if (!existsSync(file) || !isRegularNonSymlink(file)) throw new Error("runtime metadata is missing or unsafe");
  }
  const layout = readBoundedJson(layoutFile);
  const config = readBoundedJson(configFile);
  if (Number(layout.version) !== RUNTIME_LAYOUT_VERSION || Number(config.version) !== CONFIG_VERSION) throw new Error("runtime metadata version is unsupported");
  const schema = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
  if (String(schema) !== String(SCHEMA_VERSION)) throw new Error("state schema version is unsupported");
}

function parseArray(text, fallback = []) {
  const value = parseJson(text, fallback);
  if (!Array.isArray(value)) throw new Error("state JSON array is malformed");
  return value;
}

function budgetExceeded(db, runId, { ignoreWallClock = false } = {}) {
  const row = db.prepare("SELECT * FROM budget_state WHERE run_id = ?").get(runId);
  if (!row) throw new Error("budget state is missing");
  const pairs = [
    ["inputTokens", row.input_token_limit, row.input_tokens],
    ["outputTokens", row.output_token_limit, row.output_tokens],
    ["toolCalls", row.tool_call_limit, row.tool_calls],
    ["agentSpawns", row.agent_spawn_limit, row.agent_spawns],
    ["researchCalls", row.research_call_limit, row.research_calls],
    ["retries", row.retry_limit, row.retries]
  ];
  const isCounter = (value) => {
    if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed >= 0;
    }
    return false;
  };
  for (const [, limit, used] of pairs) {
    if ((limit !== null && !isCounter(limit)) || !isCounter(used)) throw new Error("budget counter is invalid");
  }
  if (row.wall_clock_limit_ms !== null && !isCounter(row.wall_clock_limit_ms)) throw new Error("wall clock budget is invalid");
  const exceeded = pairs.filter(([, limit, used]) => limit !== null && Number(used) > Number(limit)).map(([name]) => name);
  if (row.wall_clock_limit_ms !== null && !ignoreWallClock) {
    const started = db.prepare("SELECT created_at FROM runs WHERE id = ?").get(runId)?.created_at;
    if (!started || !Number.isFinite(Date.parse(started))) throw new Error("run creation timestamp is invalid");
    if (Date.now() - Date.parse(started) > Number(row.wall_clock_limit_ms)) exceeded.push("wallClockMs");
  }
  return [...new Set(exceeded)];
}

function durableCompletion(db, run) {
  if (run.status !== "completed" || run.phase !== "complete") return false;
  const event = db.prepare("SELECT 1 FROM events WHERE run_id = ? AND type = 'run.completed' LIMIT 1").get(run.id);
  if (!event) return false;
  const nonTerminal = Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status NOT IN ('completed','waived')").get(run.id)?.count ?? 0);
  return nonTerminal === 0;
}

function blockingState(db, runId) {
  const checkpoint = db.prepare("SELECT kind FROM checkpoints WHERE run_id = ? AND blocking = 1 AND status = 'pending' LIMIT 1").get(runId);
  if (checkpoint) return "CHECKPOINT_PENDING";
  const finding = db.prepare("SELECT kind FROM findings WHERE run_id = ? AND kind = 'blocker' AND status = 'valid' LIMIT 1").get(runId);
  if (finding) return "BLOCKER_PRESENT";
  const review = db.prepare("SELECT severity FROM review_findings WHERE run_id = ? AND severity IN ('error','critical') AND status NOT IN ('resolved','accepted','rejected') LIMIT 1").get(runId);
  if (review) return "REVIEW_BLOCKER_PRESENT";
  const decision = db.prepare("SELECT 1 FROM decisions WHERE run_id = ? AND status = 'needs-review' LIMIT 1").get(runId);
  if (decision) return "DECISION_PENDING";
  return null;
}

function staleExecution(db, runId) {
  const leases = db.prepare(`
    SELECT task_id, expires_at FROM leases
    WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ? AND status = 'running')
  `).all(runId);
  if (leases.some((lease) => !lease.expires_at || !Number.isFinite(Date.parse(lease.expires_at)))) return "TASK_LEASE_INVALID";
  if (leases.some((lease) => Date.parse(lease.expires_at) <= Date.now())) return "TASK_LEASE_EXPIRED";
  const batches = db.prepare(`
    SELECT id, status, claimed_task_ids_json, spawned_task_ids_json, updated_at, controller_fencing_token
    FROM scheduler_batches WHERE run_id = ? AND status IN ('claimed','prepared','partially-spawned','spawned')
  `).all(runId);
  const runFence = Number(db.prepare("SELECT controller_fencing_token FROM runs WHERE id = ?").get(runId)?.controller_fencing_token);
  if (batches.some((batch) => Number(batch.controller_fencing_token) !== runFence)) return "BATCH_CONTROLLER_FENCE_MISMATCH";
  for (const batch of batches) {
    const claimed = parseArray(batch.claimed_task_ids_json);
    const spawned = new Set(parseArray(batch.spawned_task_ids_json).map(String));
    const receiptRows = db.prepare("SELECT task_id, host_receipt FROM task_spawn_acks WHERE batch_id = ?").all(batch.id);
    const receipts = new Set(receiptRows.filter((row) => typeof row.host_receipt === "string" && row.host_receipt.trim()).map((row) => row.task_id));
    const missing = claimed.filter((id) => !spawned.has(String(id)) && !receipts.has(id));
    const updatedAt = Date.parse(batch.updated_at);
    if (!Number.isFinite(updatedAt)) return "BATCH_STATE_INVALID";
    if (missing.length > 0 && Date.now() - updatedAt > BATCH_STALE_SECONDS * 1000) return "BATCH_PREPARATION_EXPIRED";
  }
  return null;
}

function ownerRelayPending(db, runId) {
  const rows = db.prepare(`
    SELECT id, parent_task_id, claimed_task_ids_json
    FROM scheduler_batches
    WHERE run_id = ? AND parent_task_id IS NOT NULL AND status IN ('prepared','partially-spawned')
    ORDER BY created_at, id LIMIT 25
  `).all(runId);
  for (const row of rows) {
    const claimed = parseArray(row.claimed_task_ids_json);
    const acked = new Set(db.prepare(`
      SELECT ack.task_id
      FROM task_spawn_acks ack
      JOIN tasks task ON task.id = ack.task_id AND task.run_id = ? AND task.attempt_fence = ack.attempt_fence
      JOIN scheduler_batches batch ON batch.id = ack.batch_id AND batch.run_id = task.run_id
      JOIN runs run ON run.id = task.run_id AND run.controller_fencing_token = batch.controller_fencing_token
      WHERE ack.batch_id = ? AND ack.host_receipt IS NOT NULL AND length(trim(ack.host_receipt)) > 0
    `).all(runId, row.id).map((item) => item.task_id));
    if (claimed.some((id) => !acked.has(id))) return { batchId: row.id, ownerTaskId: row.parent_task_id };
  }
  return null;
}

function stateFingerprint(db, run) {
  const tasks = db.prepare(`
    SELECT id, parent_task_id, role, phase, status, failure_class, attempts, attempt_fence, max_attempts
    FROM tasks WHERE run_id = ? ORDER BY id
  `).all(run.id);
  const leases = db.prepare(`
    SELECT task_id, fencing_token FROM leases
    WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?) ORDER BY task_id
  `).all(run.id);
  const batches = db.prepare(`
    SELECT id, parent_task_id, phase, status, controller_fencing_token,
      claimed_task_ids_json, spawned_task_ids_json FROM scheduler_batches
    WHERE run_id = ? ORDER BY id
  `).all(run.id).map((batch) => ({
    id: batch.id, parentTaskId: batch.parent_task_id, phase: batch.phase, status: batch.status,
    controllerFence: Number(batch.controller_fencing_token),
    claimed: parseArray(batch.claimed_task_ids_json), spawned: parseArray(batch.spawned_task_ids_json)
  }));
  const acks = db.prepare(`
    SELECT task_id, attempt_fence, batch_id, acknowledged_at FROM task_spawn_acks
    WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?) ORDER BY task_id, attempt_fence
  `).all(run.id).map((ack) => ({
    taskId: ack.task_id, attemptFence: Number(ack.attempt_fence), batchId: ack.batch_id,
    acknowledgedAt: ack.acknowledged_at
  }));
  const budget = db.prepare(`
    SELECT input_tokens, output_tokens, tool_calls, agent_spawns, research_calls, retries,
      input_token_limit, output_token_limit, tool_call_limit, agent_spawn_limit,
      research_call_limit, retry_limit, wall_clock_limit_ms FROM budget_state WHERE run_id = ?
  `).get(run.id);
  const event = db.prepare("SELECT id, fingerprint, count FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1").get(run.id);
  return hash(stableStringify({
    run: { id: run.id, status: run.status, phase: run.phase, revision: Number(run.revision), contractVersion: Number(run.contract_version) },
    tasks, leases, batches, acks, budget, event: event ? { id: Number(event.id), fingerprint: event.fingerprint, count: Number(event.count) } : null
  }));
}

function classifyDatabase(db, root, binding) {
  checkRuntimeMetadata(root, db);
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(binding.runId);
  if (!run) return response("PAUSE", "BOUND_RUN_MISSING", bindingSummary(binding));
  const revision = Number(run.revision);
  const commonBase = {
    ...bindingSummary(binding),
    revision: Number.isInteger(revision) && revision >= 0 ? revision : null,
    phase: safeText(run.phase, 32)
  };
  if (!Number.isInteger(revision) || revision < 0
      || !Number.isInteger(Number(run.controller_fencing_token))
      || !run.created_at || !Number.isFinite(Date.parse(run.created_at))) {
    return response("PAUSE", "RUN_STATE_INVALID", commonBase);
  }
  const common = { ...commonBase, stateFingerprint: stateFingerprint(db, run) };
  if (run.project_root !== root) {
    let storedRoot;
    try { storedRoot = realpathSync(run.project_root); } catch { storedRoot = null; }
    if (storedRoot !== root) return response("PAUSE", "PROJECT_IDENTITY_MISMATCH", common);
  }
  if (run.controller_session_id !== binding.controllerSessionId
      || Number(run.controller_fencing_token) !== Number(binding.controllerFencingToken)) {
    return response("PAUSE", "CONTROLLER_FENCE_MISMATCH", common);
  }
  if (!["active", "paused", "blocked", "completed"].includes(run.status)
      || !["intake", "discover", "research", "design", "plan", "execute", "review", "verify", "curate", "complete"].includes(run.phase)) {
    return response("PAUSE", "RUN_STATE_INVALID", common);
  }
  if (run.status === "paused") return response("PAUSE", "RUN_PAUSED", common);
  if (run.status === "blocked") return response("PAUSE", "RUN_BLOCKED", common);
  const complete = durableCompletion(db, run);
  const budget = budgetExceeded(db, run.id, { ignoreWallClock: complete });
  if (budget.length) return response("PAUSE", "BUDGET_EXCEEDED", { ...common, budgetKeys: budget.slice(0, 8) });
  const blocker = blockingState(db, run.id);
  if (blocker) return response("PAUSE", blocker, common);
  if (complete) return response("COMPLETE", "RUNTIME_COMPLETED", common);
  if (!run.controller_expires_at || !Number.isFinite(Date.parse(run.controller_expires_at))) return response("PAUSE", "CONTROLLER_EXPIRED", common);
  if (Date.parse(run.controller_expires_at) <= Date.now()) return response("PAUSE", "CONTROLLER_EXPIRED", common);
  if (run.phase === "complete" || run.status === "completed") return response("PAUSE", "COMPLETION_NOT_DURABLE", common);

  const stale = staleExecution(db, run.id);
  if (stale) return response("PAUSE", stale, common);
  const relay = ownerRelayPending(db, run.id);
  if (relay) return response("CONTINUE", "OWNER_RELAY_PENDING", { ...common, actionType: "RELAY_OWNER_BATCH", ...relay });

  const pending = db.prepare(`
    SELECT task.id FROM tasks task
    WHERE task.run_id = ? AND task.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies dependency
        LEFT JOIN tasks prerequisite ON prerequisite.id = dependency.depends_on
        WHERE dependency.task_id = task.id
          AND (prerequisite.id IS NULL OR prerequisite.status NOT IN ('completed','waived'))
      )
    ORDER BY task.priority DESC, task.created_at LIMIT 24
  `).all(run.id);
  if (pending.length) return response("CONTINUE", "MAIN_ACTION_PENDING", {
    ...common, actionType: "DISPATCH_OR_APPLY", taskIds: pending.map((item) => item.id)
  });
  const running = db.prepare("SELECT id, attempt_fence, failure_class FROM tasks WHERE run_id = ? AND status = 'running' ORDER BY priority DESC, created_at LIMIT 24").all(run.id);
  if (running.length) {
    const leaseRows = db.prepare(`
      SELECT task_id, fencing_token, expires_at FROM leases
      WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ? AND status = 'running')
    `).all(run.id);
    const leasesByTask = new Map();
    for (const lease of leaseRows) {
      const rows = leasesByTask.get(lease.task_id) ?? [];
      rows.push(lease);
      leasesByTask.set(lease.task_id, rows);
    }
    const invalidLease = running.find((task) => {
      const rows = leasesByTask.get(task.id) ?? [];
      return rows.length === 0 || rows.some((lease) => Number(lease.fencing_token) !== Number(task.attempt_fence)
        || !Number.isFinite(Date.parse(lease.expires_at)) || Date.parse(lease.expires_at) <= Date.now());
    });
    if (invalidLease) return response("PAUSE", "TASK_LEASE_INVALID", { ...common, taskId: invalidLease.id });
    const acked = db.prepare(`
      SELECT DISTINCT task.id FROM tasks task
      JOIN task_spawn_acks ack ON ack.task_id = task.id AND ack.attempt_fence = task.attempt_fence
      JOIN scheduler_batches batch ON batch.id = ack.batch_id AND batch.run_id = task.run_id
      WHERE task.run_id = ? AND task.status = 'running'
        AND batch.controller_fencing_token = (SELECT controller_fencing_token FROM runs WHERE id = task.run_id)
        AND ack.host_receipt IS NOT NULL AND length(trim(ack.host_receipt)) > 0
    `).all(run.id).map((item) => item.id);
    const ackedSet = new Set(acked);
    const unacknowledged = running.filter((task) => !ackedSet.has(task.id));
    if (unacknowledged.length) return response("CONTINUE", "CHILD_RECEIPT_PENDING", { ...common, actionType: "ACK_CHILD_RECEIPT", taskIds: unacknowledged.map((item) => item.id) });
    return response("WAIT", "ACTIVE_CHILD_RUNNING", {
      ...common, activeChildCount: running.length, taskIds: running.map((item) => item.id)
    });
  }
  const failed = db.prepare("SELECT id, status, failure_class FROM tasks WHERE run_id = ? AND status IN ('failed','blocked') ORDER BY updated_at DESC LIMIT 24").all(run.id);
  if (failed.length) {
    const fatal = failed.find((task) => FATAL_FAILURES.has(String(task.failure_class ?? "").toLowerCase()));
    if (fatal) return response("PAUSE", "FATAL_TASK_FAILURE", { ...common, taskId: fatal.id });
    return response("CONTINUE", "RECOVERY_ACTION_PENDING", { ...common, actionType: "DIAGNOSE_OR_RETRY", taskIds: failed.map((item) => item.id) });
  }
  return response("CONTINUE", "ACTION_REFRESH_REQUIRED", { ...common, actionType: "REFRESH_MAIN_ACTION" });
}

export function inspectContinuation(root, options = {}) {
  const canonical = canonicalRoot(root);
  const rawHost = typeof options.host === "string" ? options.host.trim() : "";
  const rawSessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
  const host = rawHost.toLowerCase();
  const sessionId = rawSessionId;
  if (!canonical || !host || !sessionId || rawHost.length > 32 || rawSessionId.length > 256) return response("DETACHED", "INVALID_SESSION_CONTEXT");
  if (!SUPPORTED_HOSTS.has(host)) return response("PAUSE", "HOST_UNSUPPORTED");
  let bindings;
  try { bindings = listBindings(canonical, { host, sessionId }); } catch { return response("PAUSE", "BINDING_INVALID"); }
  const current = bindings[0];
  if (!current) return response("DETACHED", "NO_BINDING");
  if (current.value.host !== host || current.value.sessionId !== sessionId) return response("PAUSE", "BINDING_INVALID", bindingSummary(current.value));
  let opened;
  try {
    opened = openExistingDatabase(canonical);
    if (!opened) return response("PAUSE", "BOUND_DATABASE_MISSING", bindingSummary(current.value));
    const { db } = opened;
    db.exec("BEGIN");
    let result;
    try {
      result = classifyDatabase(db, canonical, current.value);
    } finally {
      try { db.exec("ROLLBACK"); } catch {}
    }
    if (opened.immutable && !sameDatabaseGuard(opened.file, opened.guard)) {
      return response("PAUSE", "STATE_CHANGED_DURING_INSPECTION", bindingSummary(current.value));
    }
    return result;
  } catch (error) {
    if (error?.code === "STATE_BUSY") return response("PAUSE", "STATE_BUSY", bindingSummary(current.value));
    if (error?.code === "IMMUTABLE_UNSUPPORTED") return response("PAUSE", "IMMUTABLE_UNSUPPORTED", bindingSummary(current.value));
    return response("PAUSE", "STATE_UNREADABLE", bindingSummary(current.value));
  } finally {
    try { opened?.db?.close(); } catch {}
  }
}

export function bindContinuation(db, root, runId, credentials, options = {}) {
  const canonical = canonicalRoot(root);
  if (!canonical) throw continuationError("CONTINUATION_ROOT_REQUIRED", "A canonical project root is required.");
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) throw continuationError("RUN_NOT_FOUND", `Run ${runId} was not found.`);
  if (run.project_root !== canonical) {
    let stored;
    try { stored = realpathSync(run.project_root); } catch { stored = null; }
    if (stored !== canonical) throw continuationError("CONTINUATION_PROJECT_MISMATCH", "The run belongs to another canonical project root.");
  }
  assertController(db, runId, credentials);
  const binding = makeBinding(canonical, run, credentials, options);
  return withBindingLock(canonical, () => {
    const existing = listBindings(canonical);
    for (const item of existing) {
      const value = item.value;
      const same = value.runId === runId && value.sessionId === binding.sessionId
        && value.controllerSessionId === binding.controllerSessionId
        && Number(value.controllerFencingToken) === Number(binding.controllerFencingToken);
      if (same && stableStringify(immutableBindingPart(value)) === stableStringify(immutableBindingPart(binding)) && options.rebind !== true) {
        return bindingSummary(value);
      }
      if (same && options.rebind === true) continue;
      if (value.runId === runId && value.controllerSessionId === run.controller_session_id
          && Number(value.controllerFencingToken) === Number(run.controller_fencing_token)) {
        throw continuationError("CONTINUATION_FOREIGN_LIVE_BINDING", "Another live host session already binds this run.");
      }
    }
    const file = bindingFile(canonical, binding.host, binding.sessionId);
    writeBindingAtomic(canonical, file, binding);
    return bindingSummary(binding);
  });
}

export function detachContinuation(db, root, runId, credentials, options = {}) {
  const canonical = canonicalRoot(root);
  if (!canonical) throw continuationError("CONTINUATION_ROOT_REQUIRED", "A canonical project root is required.");
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) throw continuationError("RUN_NOT_FOUND", `Run ${runId} was not found.`);
  assertController(db, runId, credentials);
  const sessionId = safeText(options.sessionId, 256);
  const host = safeText(options.host, 32)?.toLowerCase();
  if (!sessionId || !SUPPORTED_HOSTS.has(host)) throw continuationError("CONTINUATION_SESSION_REQUIRED", "A supported host and session ID are required.");
  return withBindingLock(canonical, () => {
    const file = bindingFile(canonical, host, sessionId);
    if (!existsSync(file)) {
      let bindings;
      try { bindings = listBindings(canonical); } catch { throw continuationError("CONTINUATION_BINDING_INVALID", "A continuation binding is malformed or unsafe."); }
      if (bindings.some(({ value }) => value.runId === runId && value.sessionId === sessionId)) {
        throw continuationError("CONTINUATION_FOREIGN_BINDING", "The binding belongs to another host.");
      }
      return { protocol: CONTINUATION_PROTOCOL, detached: false, runId, bindingId: null };
    }
    assertNoSymlinkPath(canonical, file, { allowMissingFinal: false });
    const binding = validateBinding(readBoundedJson(file), canonical);
    if (binding.runId !== runId || binding.sessionId !== sessionId || binding.host !== host
        || binding.controllerSessionId !== run.controller_session_id
        || Number(binding.controllerFencingToken) !== Number(run.controller_fencing_token)) throw continuationError("CONTINUATION_FOREIGN_BINDING", "The binding does not belong to the authenticated controller session.");
    unlinkSync(file);
    return { protocol: CONTINUATION_PROTOCOL, detached: true, runId, bindingId: binding.bindingId };
  });
}
