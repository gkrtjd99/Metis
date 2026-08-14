import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { invariant } from "./errors.js";
import { storeObject } from "./objects.js";
import { assertBudgetAvailable, consumeBudget } from "./budget.js";
import { getRun, recordEvent, touchRun } from "./state.js";
import { asArray, json, makeId, now, parseJson, runCommand, sha256, stableStringify, truncateMiddle } from "./util.js";
import { repositoryCodeFingerprint, syncRepository } from "./repository.js";
import { normalizeCommandSpec, resolveInside } from "./security.js";

function detectFromPackageJson(projectRoot) {
  const file = path.join(projectRoot, "package.json");
  if (!existsSync(file)) return [];
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const scripts = pkg.scripts ?? {};
  return ["lint", "typecheck", "test", "build"].filter((name) => scripts[name]).map((name) => ({
    name,
    command: { command: "npm", args: ["run", name] },
    required: true
  }));
}

export function detectChecks(projectRoot) {
  const checks = detectFromPackageJson(projectRoot);
  if (existsSync(path.join(projectRoot, "pyproject.toml")) && existsSync(path.join(projectRoot, "tests"))) checks.push({ name: "pytest", command: { command: "python", args: ["-m", "pytest"] }, required: true });
  if (existsSync(path.join(projectRoot, "Cargo.toml"))) {
    checks.push({ name: "cargo-test", command: { command: "cargo", args: ["test"] }, required: true });
    checks.push({ name: "cargo-clippy", command: { command: "cargo", args: ["clippy", "--all-targets", "--all-features", "--", "-D", "warnings"] }, required: false });
  }
  if (existsSync(path.join(projectRoot, "go.mod"))) checks.push({ name: "go-test", command: { command: "go", args: ["test", "./..."] }, required: true });
  if (existsSync(path.join(projectRoot, "gradlew"))) checks.push({ name: "gradle-check", command: { command: "./gradlew", args: ["check"] }, required: true });
  if (existsSync(path.join(projectRoot, "pom.xml"))) checks.push({ name: "maven-verify", command: { command: "mvn", args: ["verify"] }, required: true });
  return [...new Map(checks.map((check) => [check.name, check])).values()];
}

function validateIds(db, runId, table, values, code) {
  const ids = [...new Set(asArray(values).map((item) => String(item).trim()).filter(Boolean))];
  for (const id of ids) invariant(db.prepare(`SELECT 1 FROM ${table} WHERE run_id = ? AND id = ?`).get(runId, id), code, `${table} item ${id} was not found.`);
  return ids;
}

export function registerCheck(db, runId, check) {
  const run = getRun(db, runId);
  invariant(check.name?.trim(), "CHECK_FIELDS", "A check needs a name.");
  const command = normalizeCommandSpec(check.command, { code: "CHECK_COMMAND" });
  const requirementIds = validateIds(db, run.id, "requirements", check.requirementIds ?? check.RequirementIds ?? [], "CHECK_REQUIREMENT");
  const invariantIds = validateIds(db, run.id, "invariants", check.invariantIds ?? check.InvariantIds ?? [], "CHECK_INVARIANT");
  const timestamp = now();
  const id = check.id ?? makeId("check");
  const commandJson = stableStringify(command);
  const commandHash = sha256(commandJson);
  db.prepare(`
    INSERT INTO checks(
      id, run_id, name, command_json, command_hash, required, status,
      requirement_ids_json, invariant_ids_json, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    ON CONFLICT(run_id, name) DO UPDATE SET
      command_json = excluded.command_json, command_hash = excluded.command_hash,
      required = excluded.required, requirement_ids_json = excluded.requirement_ids_json,
      invariant_ids_json = excluded.invariant_ids_json,
      status = CASE WHEN checks.command_hash = excluded.command_hash THEN checks.status ELSE 'pending' END,
      output_ref = CASE WHEN checks.command_hash = excluded.command_hash THEN checks.output_ref ELSE NULL END,
      exit_code = CASE WHEN checks.command_hash = excluded.command_hash THEN checks.exit_code ELSE NULL END,
      code_fingerprint = CASE WHEN checks.command_hash = excluded.command_hash THEN checks.code_fingerprint ELSE NULL END,
      updated_at = excluded.updated_at
  `).run(id, run.id, check.name.trim(), commandJson, commandHash, check.required === false ? 0 : 1, json(requirementIds), json(invariantIds), timestamp, timestamp);
  touchRun(db, run.id);
  return listChecks(db, run.id).find((item) => item.name === check.name.trim());
}

export function registerDetectedChecks(db, projectRoot, runId) {
  return detectChecks(projectRoot).map((check) => registerCheck(db, runId, check));
}

export function listChecks(db, runId) {
  return db.prepare("SELECT * FROM checks WHERE run_id = ? ORDER BY required DESC, name").all(runId).map((row) => ({
    ...row,
    command: parseJson(row.command_json, null),
    required: Boolean(row.required),
    requirementIds: parseJson(row.requirement_ids_json, []),
    invariantIds: parseJson(row.invariant_ids_json, [])
  }));
}

function traceCheck(db, runId, check, evidenceRef) {
  const timestamp = now();
  for (const requirementId of check.requirementIds) {
    db.prepare(`
      INSERT INTO trace_links(id, run_id, requirement_id, target_type, target_id, relation, status, evidence_refs_json, created_at, updated_at)
      VALUES(?, ?, ?, 'check', ?, 'verified-by', 'current', ?, ?, ?)
      ON CONFLICT(run_id, requirement_id, target_type, target_id, relation) DO UPDATE SET
        status = 'current', evidence_refs_json = excluded.evidence_refs_json, updated_at = excluded.updated_at
    `).run(makeId("trace"), runId, requirementId, check.id, json([evidenceRef]), timestamp, timestamp);
  }
  for (const invariantId of check.invariantIds) {
    db.prepare("UPDATE invariants SET status = 'verified', verification_refs_json = ?, updated_at = ? WHERE id = ? AND run_id = ?")
      .run(json([evidenceRef]), timestamp, invariantId, runId);
  }
}

function commandCwd(projectRoot, command) {
  if (!command.cwd) return projectRoot;
  return resolveInside(projectRoot, command.cwd, { code: "CHECK_CWD" }).absolute;
}

export function runChecks(db, projectRoot, runId, config, options = {}) {
  const run = getRun(db, runId);
  syncRepository(db, projectRoot, config, run.id);
  const checks = listChecks(db, run.id).filter((check) => !options.name || check.name === options.name);
  invariant(checks.length > 0, "NO_CHECKS", "No verification checks are registered.");
  assertBudgetAvailable(db, run.id, { toolCalls: checks.length });
  const results = [];
  for (const check of checks) {
    const startedAt = Date.now();
    const command = normalizeCommandSpec(check.command, { code: "CHECK_COMMAND" });
    const result = runCommand(command.command, command.args, {
      cwd: commandCwd(projectRoot, command),
      timeout: command.timeoutMs ?? options.timeoutMs ?? config.verification.timeoutMs,
      env: { ...process.env, ...command.env },
      shell: false
    });
    const combined = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");
    const outputRef = storeObject(db, projectRoot, `check:${check.name}`, combined, { redact: true });
    const repositoryAfter = syncRepository(db, projectRoot, config, run.id);
    const mutatedPaths = [...repositoryAfter.created, ...repositoryAfter.modified, ...repositoryAfter.deleted];
    const status = result.status === 0 && !repositoryAfter.checksInvalidated ? "passed" : "failed";
    const codeFingerprint = repositoryCodeFingerprint(db);
    db.prepare("UPDATE checks SET status = ?, output_ref = ?, exit_code = ?, code_fingerprint = ?, updated_at = ? WHERE run_id = ? AND id = ?")
      .run(status, outputRef, result.status ?? -1, codeFingerprint, now(), run.id, check.id);
    const evidenceRef = { type: "command", checkId: check.id, name: check.name, status, commandHash: check.command_hash, outputRef, exitCode: result.status ?? -1, codeFingerprint };
    if (status === "passed") traceCheck(db, run.id, check, evidenceRef);
    const item = {
      name: check.name, command, required: check.required, status, exitCode: result.status,
      durationMs: Date.now() - startedAt, outputRef,
      preview: status === "failed" ? truncateMiddle([
        repositoryAfter.checksInvalidated ? `Verification command changed source-of-truth files: ${mutatedPaths.join(", ")}` : "",
        combined
      ].filter(Boolean).join("\n"), config.budgets.rawPreviewChars) : "",
      mutatedPaths, requirementIds: check.requirementIds, invariantIds: check.invariantIds
    };
    results.push(item);
    recordEvent(db, run.id, "check.finished", status === "passed" ? "info" : "error", item);
    consumeBudget(db, run.id, { toolCalls: 1 }, { source: `check:${check.name}` });
    if (status === "failed" && check.required && config.verification.failFast && !options.continueOnFailure) break;
  }
  touchRun(db, run.id);
  return results;
}
