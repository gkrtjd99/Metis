#!/usr/bin/env node
/**
 * 계획·승인은 deterministic harness가 수행하며 native Main 검증과 구분한다.
 * 실제 worker와 verifier는 승인된 Codex descriptor의 모델·effort를 사용한다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAcceptance } from "./test-native-acceptance.mjs";
import { runChild } from "./test-native-effort-delivery.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_CACHE = path.join(os.homedir(), ".codex", "models_cache.json");
export const CHILD_TIMEOUT_MS = 90_000;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const REQUESTED_MODEL = "gpt-5.6-luna";
export const REQUESTED_EFFORT = "medium";
const SECRET_ENV = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/iu;
const CONTROLLER_ENV = /^(?:METIS_(?:CONTROLLER|SESSION|RUN|LEASE|OWNER|AUTH)|CLAUDE_CODE_SESSION|CODEX_SESSION)/u;

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !SECRET_ENV.test(key) && !CONTROLLER_ENV.test(key)));
}

function bounded(value, limit = 160) {
  return typeof value === "string" && value ? value.slice(0, limit) : null;
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function executable(name) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${name}`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000, env: cleanEnv()
  });
  if (result.status !== 0) return null;
  const resolved = result.stdout.trim().split(/\r?\n/u).at(-1);
  return resolved && !resolved.includes(" ") ? resolved : null;
}

function allowlistedModel(model) {
  if (!model || typeof model !== "object") return null;
  const id = typeof model.slug === "string" ? model.slug
    : typeof model.id === "string" ? model.id
      : typeof model.model === "string" ? model.model : null;
  if (!id) return null;
  const supported = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
      .map((item) => typeof item === "string" ? item : item?.effort)
      .filter((item) => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
    : [];
  return {
    id,
    displayName: typeof model.display_name === "string" ? model.display_name : null,
    defaultReasoningLevel: typeof model.default_reasoning_level === "string"
      ? model.default_reasoning_level : null,
    supportedReasoningLevels: [...new Set(supported)],
    multiAgentReasoningEffort: typeof model.multi_agent_reasoning_effort === "string"
      ? model.multi_agent_reasoning_effort : null
  };
}

function normalizedModel(model) {
  if (model && typeof model.id === "string" && Array.isArray(model.supportedReasoningLevels)) return model;
  return allowlistedModel(model);
}

export function lunaEvidence(catalog) {
  const models = Array.isArray(catalog) ? catalog : catalog?.models;
  const luna = (models ?? [])
    .map(normalizedModel)
    .find((model) => model?.id === REQUESTED_MODEL);
  if (!luna) return { found: false, model: null, supportsRequestedEffort: false };
  return {
    found: true,
    model: luna,
    supportsRequestedEffort: luna.supportedReasoningLevels.includes(REQUESTED_EFFORT)
  };
}

function readCachedCatalog() {
  try {
    if (!existsSync(CODEX_CACHE)) return { available: false, source: "models-cache", reason: "cache-not-found" };
    const parsed = JSON.parse(readFileSync(CODEX_CACHE, "utf8"));
    const models = Array.isArray(parsed?.models) ? parsed.models.map(allowlistedModel).filter(Boolean) : [];
    return { available: true, source: "models-cache", clientVersion: bounded(parsed?.client_version, 40), models };
  } catch {
    return { available: false, source: "models-cache", reason: "cache-unreadable" };
  }
}

function bundledCatalog(command) {
  if (!command) return { available: false, source: "bundled-catalog", reason: "executable-not-found" };
  const result = spawnSync(command, ["debug", "models", "--bundled"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, env: cleanEnv()
  });
  const parsed = parseJson(result.stdout);
  const models = (Array.isArray(parsed) ? parsed : parsed?.models)
    ?.map(allowlistedModel).filter(Boolean) ?? [];
  return {
    available: result.status === 0 && models.length > 0,
    source: "bundled-catalog",
    models,
    exitCode: result.status,
    signal: result.signal
  };
}

export function localCodexEvidence(command = executable("codex")) {
  const bundled = bundledCatalog(command);
  const cached = readCachedCatalog();
  const bundledLuna = lunaEvidence(bundled.models);
  const cachedLuna = lunaEvidence(cached.models);
  const selected = bundledLuna.found ? bundledLuna : cachedLuna;
  return {
    source: bundledLuna.found ? bundled.source : cachedLuna.found ? cached.source : null,
    model: selected.model,
    found: selected.found,
    supportsRequestedEffort: selected.supportsRequestedEffort,
    bundled: { available: bundled.available, luna: bundledLuna },
    cache: { available: cached.available, luna: cachedLuna }
  };
}

export function codexArgs({ model = REQUESTED_MODEL, reasoningEffort = REQUESTED_EFFORT } = {}) {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--model", model,
    "--config", `model_reasoning_effort=\"${reasoningEffort}\"`,
    "--sandbox", "read-only",
    "--json", "-"
  ];
}

function parseJsonLines(text) {
  const events = [];
  let invalidLines = 0;
  for (const line of String(text ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    const value = parseJson(line);
    if (value && typeof value === "object" && !Array.isArray(value)) events.push(value);
    else invalidLines += 1;
  }
  return { events, invalidLines };
}

function textFrom(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  return [value.text, value.content, value.message, value.output].map(textFrom).filter(Boolean).join("\n");
}

const ALLOWED_EVENT_TYPES = new Set([
  "thread.started", "turn.started", "turn.completed", "item.completed", "error", "turn.failed", "turn.cancelled"
]);
const ALLOWED_NON_TOOL_ITEM_TYPES = new Set(["agent_message", "reasoning"]);

function isToolEvent(event) {
  const item = event?.item;
  if (!item || typeof item !== "object") return false;
  const type = String(item.type ?? "").toLowerCase();
  return !ALLOWED_NON_TOOL_ITEM_TYPES.has(type);
}

export function collectCodexReceipt(stdout, stderr = "") {
  const parsed = parseJsonLines(stdout);
  const observed = { model: null, sessionId: null, response: null };
  const errors = [];
  const permissionDenials = [];
  const responses = [];
  const unsupportedEvents = [];
  const unsupportedItems = [];
  let toolUse = false;
  let terminalResult = false;
  let usage = null;
  for (const event of parsed.events) {
    const type = String(event.type ?? "").toLowerCase();
    if (!ALLOWED_EVENT_TYPES.has(type)) unsupportedEvents.push(type || "missing-event-type");
    if (event.item && typeof event.item === "object") {
      const itemType = String(event.item.type ?? "").toLowerCase();
      if (!ALLOWED_NON_TOOL_ITEM_TYPES.has(itemType)) unsupportedItems.push(itemType || "missing-item-type");
    }
    observed.sessionId ??= event.thread_id ?? event.threadId ?? event.session_id ?? event.sessionId ?? null;
    observed.model ??= event.model ?? event.model_id ?? event.modelId ?? null;
    if (event.type === "turn.completed") {
      terminalResult = true;
      usage = event.usage && typeof event.usage === "object" ? {
        inputTokens: Number.isFinite(event.usage.input_tokens) ? event.usage.input_tokens : null,
        outputTokens: Number.isFinite(event.usage.output_tokens) ? event.usage.output_tokens : null,
        reasoningOutputTokens: Number.isFinite(event.usage.reasoning_output_tokens)
          ? event.usage.reasoning_output_tokens : null,
        totalTokens: Number.isFinite(event.usage.total_tokens) ? event.usage.total_tokens : null
      } : null;
    }
    if (type === "error" || type.includes("failed") || type.includes("cancelled")) errors.push("provider-error");
    if (type.includes("denied") || type.includes("approval") && event.status === "denied") permissionDenials.push("permission-denied");
    if (isToolEvent(event)) toolUse = true;
    const item = event.item;
    if (item?.type === "agent_message" || item?.type === "assistant_message" || type === "agent_message") {
      const text = textFrom(item ?? event);
      if (text) responses.push(text);
    }
    if (typeof event.text === "string" && (type.includes("message") || type === "assistant")) responses.push(event.text);
  }
  observed.response = responses.at(-1) ?? null;
  return {
    observed,
    structuredResponse: parseJson(observed.response),
    permissionDenials,
    errors,
    invalidLines: parsed.invalidLines,
    unsupportedEvents,
    unsupportedItems,
    toolUse,
    terminalResult,
    eventCount: parsed.events.length,
    stderrPresent: Boolean(String(stderr).trim()),
    usage
  };
}

export function validateCodexReceipt(receipt, execution, expectedRole) {
  const structured = receipt?.structuredResponse;
  const checks = {
    exitZero: execution?.exitCode === 0 && !execution.signal && !execution.timedOut,
    session: typeof receipt?.observed?.sessionId === "string" && receipt.observed.sessionId.length > 0,
    terminalResult: receipt?.terminalResult === true,
    structured: Boolean(structured && typeof structured === "object" && !Array.isArray(structured)
      && structured.status === "ok" && structured.role === expectedRole),
    noTools: receipt?.toolUse !== true && structured?.tools_used === false,
    noPermissionDenials: Array.isArray(receipt?.permissionDenials) && receipt.permissionDenials.length === 0,
    noUnexpectedText: receipt?.invalidLines === 0,
    noUnexpectedEvents: Array.isArray(receipt?.unsupportedEvents) && receipt.unsupportedEvents.length === 0,
    noUnsupportedItems: Array.isArray(receipt?.unsupportedItems) && receipt.unsupportedItems.length === 0,
    noUnexpectedStderr: receipt?.stderrPresent !== true,
    noProviderError: !receipt?.errors?.length,
    outputComplete: execution?.outputTruncated !== true,
    noSpawnError: !execution?.error
  };
  return { valid: Object.values(checks).every(Boolean), checks };
}

async function runCodexChild({ descriptor, prompt, cwd, evidenceDir, name, host, model, requestedEffort }) {
  const command = executable("codex");
  const expectedModel = model ?? REQUESTED_MODEL;
  const expectedEffort = requestedEffort ?? REQUESTED_EFFORT;
  const expectedRoute = { host: host ?? "codex", model: expectedModel, requestedEffort: expectedEffort };
  const exactDescriptor = descriptor?.host === expectedRoute.host
    && descriptor.model === expectedRoute.model
    && descriptor.requested_effort === expectedRoute.requestedEffort
    && descriptor.effective_effort === expectedRoute.requestedEffort
    && descriptor.reasoning_effort === expectedRoute.requestedEffort
    && descriptor.effort_delivery === "field"
    && descriptor.effort_launch_ready === true;
  if (!exactDescriptor) {
    throw Object.assign(new Error("Codex descriptor route mismatch"), { code: "descriptor-route-mismatch" });
  }
  const args = codexArgs({ model: descriptor.model, reasoningEffort: descriptor.reasoning_effort });
  const rawPath = path.join(evidenceDir, `${name}.codex.stdout-stderr.log`);
  const execution = await runChild(command, args, prompt, rawPath, {
    cwd, timeoutMs: CHILD_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES
  });
  const parsed = collectCodexReceipt(execution.stdout, execution.stderr);
  const role = name.includes("worker") ? "worker" : "verifier";
  const validation = validateCodexReceipt(parsed, execution, role);
  const receipt = {
    provider: "codex",
    requested: { model: descriptor.model, effort: descriptor.requested_effort },
    cli: { modelFlag: descriptor.model, configEffort: descriptor.reasoning_effort, jsonEvents: true, tools: "disabled-by-prompt; no-tools-flag-unavailable" },
    observed: { model: bounded(parsed.observed.model), sessionId: bounded(parsed.observed.sessionId) },
    structured_response: {
      status: parsed.structuredResponse?.status === "ok" ? "ok" : parsed.structuredResponse?.status == null ? null : "unexpected",
      role: ["worker", "verifier"].includes(parsed.structuredResponse?.role) ? parsed.structuredResponse.role : null,
      tools_used: typeof parsed.structuredResponse?.tools_used === "boolean" ? parsed.structuredResponse.tools_used : null
    },
    provider_confirmation: { model: "unconfirmed", effort: "unconfirmed" },
    permission_denial_count: parsed.permissionDenials.length,
    exit: { code: execution.exitCode, signal: execution.signal, timedOut: execution.timedOut, forceKilled: execution.forceKilled },
    provider_error: parsed.errors.length > 0,
    invalid_output_lines: parsed.invalidLines,
    output_truncated: execution.outputTruncated,
    validation: { valid: validation.valid },
    usage: parsed.usage,
    cost_control: { dollar_limit: "unavailable", time_limit_seconds: CHILD_TIMEOUT_MS / 1000, output_limit_bytes: MAX_OUTPUT_BYTES },
    api_billed_usd: "unavailable",
    durationMs: execution.durationMs,
    rawPath
  };
  if (!validation.valid) {
    const error = Object.assign(new Error("Codex child receipt failed closed validation"), { code: "codex-child-receipt-invalid" });
    error.details = { role, checks: validation.checks, receipt };
    throw error;
  }
  return { receipt, structured: parsed.structuredResponse };
}

export function offlineValidation() {
  const valid = collectCodexReceipt([
    JSON.stringify({ type: "thread.started", thread_id: "offline-worker" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"status":"ok","role":"worker","source_text":"export const answer = 42;\\n","tools_used":false}' } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } })
  ].join("\n"));
  const invalid = collectCodexReceipt([
    JSON.stringify({ type: "thread.started", thread_id: "offline-invalid" }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "denied" } }),
    JSON.stringify({ type: "turn.completed" })
  ].join("\n"));
  const validated = validateCodexReceipt(valid, { exitCode: 0, signal: null, timedOut: false, outputTruncated: false }, "worker");
  const rejected = validateCodexReceipt(invalid, { exitCode: 0, signal: null, timedOut: false, outputTruncated: false }, "worker");
  const args = codexArgs();
  const checks = {
    catalogModel: lunaEvidence([{ slug: REQUESTED_MODEL, supported_reasoning_levels: [{ effort: "medium" }] }]).supportsRequestedEffort,
    exactModel: args.includes(REQUESTED_MODEL),
    exactEffort: args.includes(`model_reasoning_effort=\"${REQUESTED_EFFORT}\"`),
    readOnly: args.includes("read-only"),
    jsonEvents: args.includes("--json"),
    noDangerousBypass: !args.some((arg) => String(arg).includes("dangerously")),
    validReceipt: validated.valid,
    toolReceiptRejected: !rejected.valid,
    missingSessionRejected: !validateCodexReceipt(
      collectCodexReceipt(JSON.stringify({ type: "turn.completed" })),
      { exitCode: 0, signal: null, timedOut: false, outputTruncated: false }, "worker"
    ).valid
  };
  return { status: Object.values(checks).every(Boolean) ? "validated" : "failed", networkAttempted: false, checks };
}

export async function runCodexAcceptance() {
  const command = executable("codex");
  const evidence = localCodexEvidence(command);
  if (!command || !evidence.found || !evidence.supportsRequestedEffort) {
    return {
      status: "unavailable", attempted: false, networkAttempted: false,
      actualChildProvider: "codex", underlyingDescriptorHost: "codex",
      evidence, reason: "local-luna-medium-evidence-missing"
    };
  }
  const report = await runAcceptance({
    host: "codex",
    model: REQUESTED_MODEL,
    requestedEffort: REQUESTED_EFFORT,
    capabilities: { [REQUESTED_MODEL]: ["low", "medium", "high", "xhigh", "max"] },
    provider: runCodexChild
  });
  const successful = report.status === "validated" && report.providers?.length === 2
    && report.providers.every((item) => item.provider === "codex" && item.validation?.valid === true);
  return {
    ...report,
    status: successful ? "validated" : "failed",
    attempted: true,
    networkAttempted: true,
    actualChildProvider: "codex",
    underlyingDescriptorHost: "codex",
    e2eClaim: "codex-adapter-descriptor-e2e",
    nativeChildren: successful,
    deterministicHarness: true,
    conclusion: successful ? "deterministic-public-cli-runtime-with-native-codex-worker-verifier" : "failed-closed",
    localModelEvidence: {
      source: evidence.source,
      model: evidence.model,
      supportsRequestedEffort: evidence.supportsRequestedEffort
    },
    cost: {
      dollarLimit: "unavailable",
      timeLimitSeconds: CHILD_TIMEOUT_MS / 1000,
      outputLimitBytes: MAX_OUTPUT_BYTES,
      apiBilledUsd: "unavailable",
      supervisorAgentCostIncluded: false
    },
    providerCost: { dollarLimit: "unavailable", timeLimitSeconds: CHILD_TIMEOUT_MS / 1000, outputLimitBytes: MAX_OUTPUT_BYTES, apiBilledUsd: "unavailable" }
  };
}

function usage() {
  return "Usage: node scripts/test-native-codex-acceptance.mjs --run | --offline-test | --help";
}

const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) process.stdout.write(`${usage()}\n`);
  else if (args.has("--offline-test")) {
    const report = offlineValidation();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === "validated" ? 0 : 1;
  } else if (!args.has("--run")) {
    process.stdout.write(`${JSON.stringify({ status: "opt-in-required", attempted: false, networkAttempted: false })}\n`);
  } else {
    const report = await runCodexAcceptance();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === "validated" ? 0 : 1;
  }
}
