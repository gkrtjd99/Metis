import { invariant } from "./errors.js";
import { getRun, recordEvent, touchRun } from "./state.js";
import { asArray, json, makeId, now, parseJson, sha256, stableStringify } from "./util.js";

function normalizeRequirements(db, runId, values) {
  const ids = [...new Set(asArray(values).map((item) => String(item).trim()).filter(Boolean))];
  for (const id of ids) {
    invariant(db.prepare("SELECT 1 FROM requirements WHERE run_id = ? AND id = ? AND status <> 'superseded'").get(runId, id),
      "INTERFACE_REQUIREMENT", `Requirement ${id} was not found.`);
  }
  return ids;
}

function contentHash(input) {
  return sha256(stableStringify({
    name: input.name,
    version: input.version,
    description: input.description,
    schema: input.schema,
    requirementIds: input.requirementIds
  }));
}

function hydrate(row) {
  return {
    ...row,
    schema: parseJson(row.schema_json, {}),
    requirementIds: parseJson(row.requirement_ids_json, [])
  };
}

export function addInterfaceContract(db, runId, input) {
  const run = getRun(db, runId);
  invariant(["design", "plan"].includes(run.phase), "INTERFACE_PHASE", "Interface contracts must be defined during design or plan.");
  const name = String(input.name ?? input.Name ?? "").trim();
  const description = String(input.description ?? input.Description ?? "").trim();
  invariant(name && description, "INTERFACE_FIELDS", "An interface contract needs a name and description.");
  const previous = db.prepare("SELECT MAX(version) AS version FROM interface_contracts WHERE run_id = ? AND name = ?").get(run.id, name);
  const version = Number(input.version ?? input.Version ?? Number(previous?.version ?? 0) + 1);
  invariant(Number.isInteger(version) && version > 0, "INTERFACE_VERSION", "Interface version must be a positive integer.");
  const schema = input.schema ?? input.Schema ?? {};
  invariant(schema && typeof schema === "object" && !Array.isArray(schema), "INTERFACE_SCHEMA", "Interface schema must be an object.");
  const requirementIds = normalizeRequirements(db, run.id, input.requirementIds ?? input.RequirementIds ?? []);
  const status = String(input.status ?? input.Status ?? "draft").toLowerCase();
  invariant(["draft", "frozen", "superseded"].includes(status), "INTERFACE_STATUS", `Unsupported interface status: ${status}.`);
  const id = input.id ?? input.Id ?? makeId("iface");
  const timestamp = now();
  const hash = contentHash({ name, version, description, schema, requirementIds });
  db.prepare(`
    INSERT INTO interface_contracts(
      id, run_id, name, version, status, description, schema_json,
      requirement_ids_json, content_hash, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, run.id, name, version, status, description, json(schema), json(requirementIds), hash, timestamp, timestamp);
  if (status === "frozen") {
    db.prepare("UPDATE interface_contracts SET status = 'superseded', updated_at = ? WHERE run_id = ? AND name = ? AND id <> ? AND status = 'frozen'")
      .run(timestamp, run.id, name, id);
  }
  touchRun(db, run.id);
  recordEvent(db, run.id, "interface.created", "info", { interfaceId: id, name, version, status, contentHash: hash });
  return getInterfaceContract(db, id);
}

export function getInterfaceContract(db, selector, runId = null) {
  const row = runId
    ? db.prepare(`
        SELECT * FROM interface_contracts
        WHERE run_id = ? AND (id = ? OR name = ?)
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, version DESC LIMIT 1
      `).get(runId, selector, selector, selector)
    : db.prepare("SELECT * FROM interface_contracts WHERE id = ?").get(selector);
  invariant(row, "INTERFACE_NOT_FOUND", `Interface contract ${selector} was not found.`);
  return hydrate(row);
}

export function listInterfaceContracts(db, runId, options = {}) {
  const rows = options.status
    ? db.prepare("SELECT * FROM interface_contracts WHERE run_id = ? AND status = ? ORDER BY name, version DESC").all(runId, options.status)
    : db.prepare("SELECT * FROM interface_contracts WHERE run_id = ? ORDER BY name, version DESC").all(runId);
  return rows.map(hydrate);
}

export function freezeInterfaceContract(db, runId, selector) {
  const item = getInterfaceContract(db, selector, runId);
  invariant(item.run_id === runId, "INTERFACE_RUN", "Interface contract belongs to another run.");
  const timestamp = now();
  db.prepare("UPDATE interface_contracts SET status = 'superseded', updated_at = ? WHERE run_id = ? AND name = ? AND id <> ? AND status = 'frozen'")
    .run(timestamp, runId, item.name, item.id);
  db.prepare("UPDATE interface_contracts SET status = 'frozen', updated_at = ? WHERE id = ?").run(timestamp, item.id);
  db.prepare(`
    UPDATE task_packets SET status = 'stale', updated_at = ?
    WHERE task_id IN (SELECT task_id FROM task_interface_links WHERE interface_id IN (
      SELECT id FROM interface_contracts WHERE run_id = ? AND name = ?
    )) AND status = 'ready'
  `).run(timestamp, runId, item.name);
  db.prepare("UPDATE tasks SET contract_status = CASE WHEN contract_status = 'ready' THEN 'stale' ELSE contract_status END, updated_at = ? WHERE id IN (SELECT task_id FROM task_interface_links WHERE interface_id IN (SELECT id FROM interface_contracts WHERE run_id = ? AND name = ?))")
    .run(timestamp, runId, item.name);
  touchRun(db, runId);
  recordEvent(db, runId, "interface.frozen", "info", { interfaceId: item.id, name: item.name, version: item.version });
  return getInterfaceContract(db, item.id);
}

function resolveRef(db, runId, selector) {
  const item = getInterfaceContract(db, String(selector), runId);
  invariant(item.status === "frozen", "INTERFACE_NOT_FROZEN", `Interface ${item.name} v${item.version} is ${item.status}.`);
  return item;
}

export function bindTaskInterfaces(db, runId, taskId, input = {}) {
  db.prepare("DELETE FROM task_interface_links WHERE task_id = ?").run(taskId);
  const insert = db.prepare("INSERT INTO task_interface_links(task_id, interface_id, direction, allow_change) VALUES(?, ?, ?, ?)");
  const bound = [];
  for (const selector of asArray(input.inputs ?? input.Inputs ?? [])) {
    const item = resolveRef(db, runId, selector);
    insert.run(taskId, item.id, "input", 0);
    bound.push({ ...item, direction: "input", allowChange: false });
  }
  for (const selector of asArray(input.outputs ?? input.Outputs ?? [])) {
    const item = resolveRef(db, runId, selector);
    const allowChange = Boolean(input.allowOutputChange ?? input.AllowOutputChange ?? false);
    insert.run(taskId, item.id, "output", allowChange ? 1 : 0);
    bound.push({ ...item, direction: "output", allowChange });
  }
  return bound;
}

export function taskInterfaceContracts(db, taskId) {
  return db.prepare(`
    SELECT i.*, l.direction, l.allow_change
    FROM task_interface_links l JOIN interface_contracts i ON i.id = l.interface_id
    WHERE l.task_id = ? ORDER BY l.direction, i.name, i.version
  `).all(taskId).map((row) => ({ ...hydrate(row), direction: row.direction, allowChange: Boolean(row.allow_change) }));
}
