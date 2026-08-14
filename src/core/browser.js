import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertBudgetAvailable, consumeBudget } from "./budget.js";
import { invariant } from "./errors.js";
import { storeObject } from "./objects.js";
import { repositoryCodeFingerprint, syncRepository } from "./repository.js";
import { normalizeCommandSpec, resolveInside } from "./security.js";
import { getRun, recordEvent, touchRun } from "./state.js";
import { asArray, json, makeId, now, parseJson, runCommand, sha256, stableStringify, truncateMiddle } from "./util.js";

function hydrateScenario(row) {
  if (!row) return null;
  return {
    ...row,
    viewport: parseJson(row.viewport_json, {}),
    command: parseJson(row.command_json, null),
    requirementIds: parseJson(row.requirement_ids_json, []),
    required: Boolean(row.required)
  };
}

function hydrateEvidence(row) {
  if (!row) return null;
  return {
    ...row,
    assertions: parseJson(row.assertions_json, []),
    screenshotRefs: parseJson(row.screenshot_refs_json, []),
    consoleErrors: parseJson(row.console_errors_json, []),
    networkFailures: parseJson(row.network_failures_json, [])
  };
}

function validateUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); }
  catch { invariant(false, "BROWSER_URL", `Invalid browser scenario URL: ${value}`); }
  invariant(["http:", "https:"].includes(parsed.protocol), "BROWSER_URL", "Browser scenarios require an http or https URL.");
  return parsed.toString();
}

function validateRequirements(db, runId, values) {
  const ids = [...new Set(asArray(values).map((item) => String(item).trim()).filter(Boolean))];
  for (const id of ids) {
    invariant(db.prepare("SELECT 1 FROM requirements WHERE id = ? AND run_id = ? AND status <> 'superseded'").get(id, runId), "BROWSER_REQUIREMENT", `Requirement ${id} was not found.`);
  }
  return ids;
}

export function registerBrowserScenario(db, runId, input) {
  const run = getRun(db, runId);
  const name = String(input.name ?? "").trim();
  invariant(name, "BROWSER_SCENARIO_NAME", "A browser scenario needs a name.");
  const url = validateUrl(input.url);
  const command = normalizeCommandSpec(input.command, { code: "BROWSER_COMMAND" });
  const viewport = {
    width: Math.max(1, Math.floor(Number(input.viewport?.width ?? 1280))),
    height: Math.max(1, Math.floor(Number(input.viewport?.height ?? 720)))
  };
  invariant(Number.isFinite(viewport.width) && Number.isFinite(viewport.height), "BROWSER_VIEWPORT", "Browser viewport dimensions must be finite numbers.");
  const requirementIds = validateRequirements(db, run.id, input.requirementIds ?? []);
  const timestamp = now();
  const id = input.id ?? makeId("browser");
  db.prepare(`
    INSERT INTO browser_scenarios(
      id, run_id, name, url, viewport_json, command_json,
      requirement_ids_json, required, status, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(run_id, name) DO UPDATE SET
      url = excluded.url,
      viewport_json = excluded.viewport_json,
      command_json = excluded.command_json,
      requirement_ids_json = excluded.requirement_ids_json,
      required = excluded.required,
      status = 'pending',
      updated_at = excluded.updated_at
  `).run(id, run.id, name, url, json(viewport), stableStringify(command), json(requirementIds), input.required === false ? 0 : 1, timestamp, timestamp);
  touchRun(db, run.id);
  recordEvent(db, run.id, "browser.scenario.registered", "info", { name, url, viewport, requirementIds, required: input.required !== false });
  return getBrowserScenario(db, run.id, name);
}

export function getBrowserScenario(db, runId, idOrName) {
  const row = db.prepare("SELECT * FROM browser_scenarios WHERE run_id = ? AND (id = ? OR name = ?) ORDER BY updated_at DESC LIMIT 1").get(runId, idOrName, idOrName);
  invariant(row, "BROWSER_SCENARIO_NOT_FOUND", `Browser scenario ${idOrName} was not found.`);
  return hydrateScenario(row);
}

export function listBrowserScenarios(db, runId) {
  return db.prepare("SELECT * FROM browser_scenarios WHERE run_id = ? ORDER BY required DESC, name").all(runId).map((row) => {
    const scenario = hydrateScenario(row);
    const evidence = db.prepare("SELECT * FROM browser_evidence WHERE scenario_id = ? ORDER BY created_at DESC LIMIT 1").get(row.id);
    return { ...scenario, latestEvidence: hydrateEvidence(evidence) };
  });
}

function commandCwd(projectRoot, command) {
  if (!command.cwd) return projectRoot;
  return resolveInside(projectRoot, command.cwd, { code: "BROWSER_CWD" }).absolute;
}

function parseBrowserOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch {
    const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(lines[index]); } catch {}
    }
    return { parseError: "Browser verifier did not emit JSON." };
  }
}

function screenshotRefs(db, projectRoot, values, maxScreenshots) {
  const refs = [];
  for (const item of asArray(values).slice(0, maxScreenshots)) {
    const relative = String(item).trim();
    if (!relative) continue;
    const resolved = resolveInside(projectRoot, relative, { code: "BROWSER_SCREENSHOT_PATH" });
    invariant(existsSync(resolved.absolute), "BROWSER_SCREENSHOT_MISSING", `Browser screenshot was not found: ${relative}`);
    refs.push(storeObject(db, projectRoot, "browser-screenshot", readFileSync(resolved.absolute)));
  }
  return refs;
}

function addRequirementTraces(db, runId, scenario, evidence) {
  const timestamp = now();
  const reference = {
    type: "browser",
    scenarioId: scenario.id,
    scenario: scenario.name,
    evidenceId: evidence.id,
    status: evidence.status,
    codeFingerprint: evidence.code_fingerprint,
    outputRef: evidence.output_ref
  };
  for (const requirementId of scenario.requirementIds) {
    db.prepare(`
      INSERT INTO trace_links(id, run_id, requirement_id, target_type, target_id, relation, status, evidence_refs_json, created_at, updated_at)
      VALUES(?, ?, ?, 'browser-scenario', ?, 'verified-by', 'current', ?, ?, ?)
      ON CONFLICT(run_id, requirement_id, target_type, target_id, relation) DO UPDATE SET
        status = 'current', evidence_refs_json = excluded.evidence_refs_json, updated_at = excluded.updated_at
    `).run(makeId("trace"), runId, requirementId, scenario.id, json([reference]), timestamp, timestamp);
  }
}

export function runBrowserScenario(db, projectRoot, runId, idOrName, config, options = {}) {
  const run = getRun(db, runId);
  const scenario = getBrowserScenario(db, run.id, idOrName);
  assertBudgetAvailable(db, run.id, { toolCalls: 1 });
  syncRepository(db, projectRoot, config, run.id);
  const command = normalizeCommandSpec(scenario.command, { code: "BROWSER_COMMAND" });
  const result = runCommand(command.command, command.args, {
    cwd: commandCwd(projectRoot, command),
    timeout: command.timeoutMs ?? options.timeoutMs ?? config.browser.timeoutMs,
    env: {
      ...process.env,
      ...command.env,
      METIS_BROWSER_URL: scenario.url,
      METIS_BROWSER_VIEWPORT_WIDTH: String(scenario.viewport.width),
      METIS_BROWSER_VIEWPORT_HEIGHT: String(scenario.viewport.height),
      METIS_BROWSER_SCENARIO: scenario.name
    },
    shell: false
  });
  const parsed = parseBrowserOutput(result.stdout);
  const repositoryAfter = syncRepository(db, projectRoot, config, run.id);
  const mutatedPaths = [...repositoryAfter.created, ...repositoryAfter.modified, ...repositoryAfter.deleted];
  const assertions = asArray(parsed.assertions).map((item) => typeof item === "string" ? { name: item, pass: true } : item).filter(Boolean);
  const failedAssertions = assertions.filter((item) => item.pass === false || item.status === "failed");
  const consoleErrors = asArray(parsed.consoleErrors ?? parsed.console_errors).map(String);
  const networkFailures = asArray(parsed.networkFailures ?? parsed.network_failures).map(String);
  const screenshots = screenshotRefs(db, projectRoot, parsed.screenshots ?? [], Number(config.browser.maxScreenshots ?? 20));
  const output = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");
  const outputRef = storeObject(db, projectRoot, `browser:${scenario.name}`, output, { redact: true });
  const policyFailure = (config.browser.failOnConsoleError !== false && consoleErrors.length > 0)
    || (config.browser.failOnNetworkFailure !== false && networkFailures.length > 0);
  const declaredFailure = parsed.status === "failed" || parsed.pass === false || Boolean(parsed.parseError);
  const status = result.status === 0 && !repositoryAfter.checksInvalidated && !policyFailure && !declaredFailure && failedAssertions.length === 0
    ? "passed"
    : "failed";
  const codeFingerprint = repositoryCodeFingerprint(db);
  const actionsHash = sha256(stableStringify(parsed.actions ?? []));
  const id = makeId("browser_evidence");
  const timestamp = now();
  db.prepare(`
    INSERT INTO browser_evidence(
      id, run_id, scenario_id, status, code_fingerprint, actions_hash,
      assertions_json, screenshot_refs_json, console_errors_json,
      network_failures_json, output_ref, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, run.id, scenario.id, status, codeFingerprint, actionsHash, json(assertions), json(screenshots), json(consoleErrors), json(networkFailures), outputRef, timestamp);
  db.prepare("UPDATE browser_scenarios SET status = ?, updated_at = ? WHERE run_id = ? AND id = ?")
    .run(status, timestamp, run.id, scenario.id);
  db.prepare(`
    INSERT INTO typed_evidence(
      id, run_id, type, subject_type, subject_id, status, payload_json,
      content_ref, code_fingerprint, created_at, updated_at
    ) VALUES(?, ?, 'browser', 'browser-scenario', ?, ?, ?, ?, ?, ?, ?)
  `).run(makeId("evidence"), run.id, scenario.id, status === "passed" ? "current" : "failed", json({ scenario: scenario.name, url: scenario.url, viewport: scenario.viewport, assertions, screenshotRefs: screenshots, consoleErrors, networkFailures, actionsHash, mutatedPaths }), outputRef, codeFingerprint, timestamp, timestamp);
  const evidence = hydrateEvidence(db.prepare("SELECT * FROM browser_evidence WHERE id = ?").get(id));
  if (status === "passed") addRequirementTraces(db, run.id, scenario, evidence);
  consumeBudget(db, run.id, { toolCalls: 1 }, { source: `browser:${scenario.name}` });
  touchRun(db, run.id);
  recordEvent(db, run.id, "browser.scenario.finished", status === "passed" ? "info" : "error", {
    scenario: scenario.name,
    status,
    exitCode: result.status,
    codeFingerprint,
    assertions: assertions.length,
    failedAssertions: failedAssertions.length,
    consoleErrors: consoleErrors.length,
    networkFailures: networkFailures.length,
    mutatedPaths,
    outputRef
  });
  return {
    scenario,
    evidence,
    exitCode: result.status,
    mutatedPaths,
    preview: status === "failed" ? truncateMiddle([parsed.parseError, ...consoleErrors, ...networkFailures, result.stderr, result.error].filter(Boolean).join("\n"), config.budgets.rawPreviewChars) : ""
  };
}

export function browserStatus(db, runId, codeFingerprint = null) {
  const scenarios = listBrowserScenarios(db, runId);
  const currentFingerprint = codeFingerprint ?? null;
  const required = scenarios.filter((item) => item.required);
  const missing = required.filter((item) => !item.latestEvidence || item.latestEvidence.status !== "passed" || (currentFingerprint && item.latestEvidence.code_fingerprint !== currentFingerprint));
  return { runId, scenarios, required: required.length, missing: missing.map((item) => item.name), pass: missing.length === 0 };
}
