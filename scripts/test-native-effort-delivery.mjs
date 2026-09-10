#!/usr/bin/env node
/**
 * Opt-in, bounded smoke test for native model/effort delivery.
 *
 * This intentionally tests only the provider child invocation. It does not
 * start a Metis parent loop, create a run, or write into the repository.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSpawnDescriptor } from "../src/adapters/spawn-descriptors.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 1_500;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_BUDGET_USD = "0.15";
const SECRET_ENV = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/iu;
const CONTROLLER_ENV = /^(?:METIS_(?:CONTROLLER|SESSION|RUN|LEASE|OWNER|AUTH)|CLAUDE_CODE_SESSION|CODEX_SESSION)/u;

function parseArgs(argv) {
  const options = { run: false, provider: "all" };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--run") options.run = true;
    else if (item === "--json") options.json = true;
    else if (item === "--provider") {
      const provider = String(argv[++index] ?? "").toLowerCase();
      if (!["claude", "codex", "all"].includes(provider)) throw new Error("--provider must be claude, codex, or all.");
      options.provider = provider;
    } else if (item === "--help" || item === "-h") options.help = true;
    else throw new Error(`Unknown option: ${item}`);
  }
  return options;
}

function usage() {
  return "Usage: node scripts/test-native-effort-delivery.mjs --run [--provider claude|codex|all] [--json]";
}

function executable(name) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000 });
  if (result.status !== 0) return null;
  const resolved = result.stdout.trim().split(/\r?\n/u).at(-1);
  return resolved && !resolved.includes(" ") ? resolved : null;
}

function probe(command, args) {
  if (!command) return { available: false, reason: "executable-not-found" };
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8_000 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    available: result.status === 0,
    exitCode: result.status,
    signal: result.signal,
    supportsEffortFlag: /(?:--effort\s+<|--effort\b)/u.test(output),
    outputPreview: output.replace(/\s+/gu, " ").slice(0, 240)
  };
}

function childEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !SECRET_ENV.test(key) && !CONTROLLER_ENV.test(key)));
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function parseJsonLines(text) {
  const events = [];
  const invalidLines = [];
  for (const line of String(text ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    const value = safeJson(line);
    if (value && typeof value === "object" && !Array.isArray(value)) events.push(value);
    else invalidLines.push(line.slice(0, 240));
  }
  return { events, invalidLines };
}

function denialValues(event) {
  const values = [event.permission_denials, event.permissionDenials, event.result?.permission_denials, event.result?.permissionDenials];
  return values.flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);
}

export function collectClaudeReceipt(stdout, stderr) {
  const parsedLines = parseJsonLines(stdout);
  const observed = { model: null, sessionId: null, response: null };
  const permissionDenials = [];
  const errors = [];
  const responseObjects = [];
  let toolUse = false;
  let terminalResult = false;
  for (const event of parsedLines.events) {
    observed.model ??= event.model ?? event.message?.model ?? event.result?.model ?? null;
    observed.sessionId ??= event.session_id ?? event.sessionId ?? event.result?.session_id ?? null;
    permissionDenials.push(...denialValues(event));
    if (event.type === "permission_denial" || event.type === "permission_denied") permissionDenials.push(event.tool_name ?? event.message ?? "permission denied");
    if (event.type === "error" || event.is_error === true || event.result?.is_error === true) errors.push("provider-error");
    if (event.type === "tool_use" || event.tool_use || event.result?.tool_use
      || (Array.isArray(event.message?.content) && event.message.content.some((block) => block?.type === "tool_use"))
      || (Array.isArray(event.content) && event.content.some((block) => block?.type === "tool_use"))) toolUse = true;
    if (event.type === "result") {
      terminalResult = true;
      observed.model ??= event.model ?? null;
      observed.sessionId ??= event.session_id ?? null;
      if (typeof event.result === "string") observed.response = event.result;
    }
    const content = event.message?.content ?? event.content;
    if (Array.isArray(content)) {
      for (const block of content) if (block?.type === "text" && typeof block.text === "string") responseObjects.push(block.text);
    }
    if (typeof event.text === "string") responseObjects.push(event.text);
  }
  observed.response ??= responseObjects.join("\n").trim() || null;
  const structured = observed.response ? safeJson(observed.response) : null;
  return {
    observed, structuredResponse: structured, permissionDenials, errors,
    invalidLines: parsedLines.invalidLines, toolUse, terminalResult, eventCount: parsedLines.events.length,
    stderrPresent: Boolean(String(stderr ?? "").trim())
  };
}

export function validateClaudeReceipt(receipt, execution, requested = { model: "sonnet", effort: "medium" }) {
  // transport 성공과 model/effort 적용 확인은 서로 다른 주장으로 유지한다.
  const structured = receipt?.structuredResponse;
  const checks = {
    exitZero: execution?.exitCode === 0 && !execution.signal && !execution.timedOut,
    session: typeof receipt?.observed?.sessionId === "string" && receipt.observed.sessionId.length > 0,
    terminalResult: receipt?.terminalResult === true,
    structured: Boolean(structured && typeof structured === "object" && !Array.isArray(structured) && structured.status === "ok"),
    noTools: receipt?.toolUse !== true && structured?.tools_used === false,
    noPermissionDenials: Array.isArray(receipt?.permissionDenials) && receipt.permissionDenials.length === 0,
    noUnexpectedText: Array.isArray(receipt?.invalidLines) && receipt.invalidLines.length === 0,
    outputComplete: execution?.outputTruncated !== true,
    noSpawnError: !execution?.error,
    noProviderError: !receipt?.errors?.length
  };
  const modelMatch = receipt?.observed?.model === requested.model;
  const valid = Object.values(checks).every(Boolean);
  return {
    valid, checks,
    // sonnet may be an alias; a canonical observed model is not CLI model
    // application proof, so report mismatch separately instead of claiming it.
    model_confirmation: modelMatch ? "exact-observed" : receipt?.observed?.model ? "mismatch-unconfirmed" : "unconfirmed",
    effort_confirmation: "unconfirmed",
    conclusion: valid ? "transport-validated-only" : "failed-closed"
  };
}

function codexLocalEvidence() {
  // 이 smoke는 Codex catalog를 조사하거나 실제 Codex child를 실행하지 않는다.
  return { localModelEvidence: null, reason: "codex-catalog-not-inspected-by-this-smoke", networkAttempted: false };
}

function cliSelection(args) {
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] ? String(args[index + 1]) : null;
  };
  return { model: valueAfter("--model"), effort: valueAfter("--effort") };
}

function boundedText(value, limit = 160) {
  return typeof value === "string" && value ? value.slice(0, limit) : null;
}

function structuredSummary(value) {
  return {
    status: value?.status === "ok" ? "ok" : value?.status == null ? null : "unexpected",
    tools_used: typeof value?.tools_used === "boolean" ? value.tools_used : null
  };
}

export function runChild(command, args, prompt, rawPath, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timeoutMs = Number(options.timeoutMs ?? TIMEOUT_MS);
    const maxOutputBytes = Number(options.maxOutputBytes ?? MAX_OUTPUT_BYTES);
    const child = spawn(command, args, { cwd: options.cwd ?? ROOT, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    let outputBytes = 0;
    let timedOut = false;
    let forceKilled = false;
    let settled = false;
    let killTimer = null;
    const capture = (target, chunk) => {
      if (outputBytes >= maxOutputBytes) return;
      const value = Buffer.from(chunk);
      const remaining = maxOutputBytes - outputBytes;
      target.push(value.subarray(0, remaining));
      outputBytes += Math.min(value.length, remaining);
    };
    const finish = (execution) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const stdout = Buffer.concat(output).toString("utf8");
      const stderr = Buffer.concat(errors).toString("utf8");
      writeFileSync(rawPath, Buffer.concat([...output, ...errors]), { mode: 0o600 });
      resolve({ ...execution, stdout, stderr, outputTruncated: outputBytes >= maxOutputBytes, durationMs: Date.now() - startedAt });
    };
    child.stdout.on("data", (chunk) => capture(output, chunk));
    child.stderr.on("data", (chunk) => capture(errors, chunk));
    const timer = setTimeout(() => {
      // 먼저 정상 종료를 요청하고, 불응한 child만 bounded SIGKILL로 정리한다.
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          forceKilled = true;
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.once("error", (error) => finish({ exitCode: null, signal: null, timedOut, forceKilled, error: "spawn-error" }));
    child.once("close", (exitCode, signal) => finish({ exitCode, signal, timedOut, forceKilled, error: null }));
    // 짧게 종료하는 fake/provider가 bounded prompt 쓰기 전에 stdin을 닫을 수 있다.
    // EPIPE를 소비해 플랫폼 차이로 수집된 receipt가 crash로 바뀌지 않게 한다.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

async function claudeSmoke() {
  const command = executable("claude");
  const help = probe(command, ["--help"]);
  if (!command) return { provider: "claude", available: false, attempted: false, status: "unavailable", reason: help.reason };
  if (!help.supportsEffortFlag) return { provider: "claude", available: false, attempted: false, status: "unavailable", reason: "effort-flag-not-supported", cli: help };

  const task = {
    id: "native-effort-delivery-smoke",
    role: "worker",
    model_tier: "worker",
    selected_model: "sonnet",
    requested_effort: "medium",
    capability_status: "known",
    supported_efforts: ["low", "medium", "high"]
  };
  const prompt = [
    "Native delivery smoke only. Do not use tools, shell, filesystem, network, or Metis commands.",
    "Return exactly one short JSON object and no markdown: {\"status\":\"ok\",\"model\":\"<observed-or-unknown>\",\"effort\":\"<observed-or-unknown>\",\"tools_used\":false}.",
    "This response is a child response, not a Metis COMPLETE result."
  ].join(" ");
  const descriptor = renderSpawnDescriptor("claude", task, { content: "No-tools bounded native smoke." }, {
    runtime: { model: "sonnet", supportedEfforts: ["low", "medium", "high"] },
    startup: { requiredInputs: [], tools: [], permissions: [], cwd: ROOT }
  });
  const temp = mkdtempSync(path.join(os.tmpdir(), "metis-native-effort-"));
  chmodSync(temp, 0o700);
  const rawPath = path.join(temp, "claude.stdout-stderr.log");
  try {
    // Descriptor model/effort argv are passed unchanged. Fixed flags only select
    // print/JSON/no-tools operation and the provider's own spend ceiling.
    const args = [...descriptor.args, "--tools", "", "--output-format", "stream-json", "--print", "--max-budget-usd", MAX_BUDGET_USD];
    const requestedCli = cliSelection(descriptor.args);
    const execution = await runChild(descriptor.command, args, prompt, rawPath);
    const parsed = collectClaudeReceipt(execution.stdout, execution.stderr);
    const validation = validateClaudeReceipt(parsed, execution, requestedCli);
    const failureCode = validation.valid ? null
      : execution.timedOut ? "timeout"
        : execution.error ? "spawn-error"
          : execution.outputTruncated ? "output-truncated"
            : parsed.permissionDenials.length ? "permission-denied"
              : execution.exitCode !== 0 ? "nonzero-exit"
                : !validation.checks.session ? "missing-session-receipt"
                  : !validation.checks.terminalResult ? "missing-terminal-result"
                    : !validation.checks.structured ? "invalid-structured-response"
                    : !validation.checks.noUnexpectedText ? "unexpected-output"
                      : !validation.checks.noTools ? "tool-use-observed"
                        : "receipt-validation-failed";
    return {
      provider: "claude", available: true, attempted: true,
      status: validation.valid ? "validated" : "failed",
      descriptor: { command: descriptor.command, args: descriptor.args },
      requested_cli: requestedCli,
      observed: { model: boundedText(parsed.observed.model), sessionId: boundedText(parsed.observed.sessionId) },
      structured_response: structuredSummary(parsed.structuredResponse),
      provider_confirmation: { model: validation.model_confirmation, effort: validation.effort_confirmation },
      permission_denial_count: parsed.permissionDenials.length,
      exit: { code: execution.exitCode, signal: execution.signal, timedOut: execution.timedOut, forceKilled: execution.forceKilled },
      error_code: failureCode, durationMs: execution.durationMs,
      cli_estimate_usd: null, api_billed_usd: "unavailable", raw_output_path: rawPath, event_count: parsed.eventCount,
      output_truncated: execution.outputTruncated, conclusion: validation.conclusion
    };
  } catch {
    return { provider: "claude", available: true, attempted: true, status: "failed", error_code: "smoke-internal-error", raw_output_path: rawPath };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
  if (!options.run && process.env.METIS_NATIVE_EFFORT_SMOKE !== "1") {
    const report = { smoke: "native-effort-delivery", status: "opt-in-required", attempted: false, providers: [] };
    process.stdout.write(`${options.json ? JSON.stringify(report) : JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const providers = [];
  if (options.provider === "claude" || options.provider === "all") providers.push(await claudeSmoke());
  if (options.provider === "codex" || options.provider === "all") {
    const command = executable("codex");
    const help = probe(command, ["--help"]);
    providers.push({ provider: "codex", available: Boolean(command), attempted: false, status: "unavailable", cli: help, ...codexLocalEvidence() });
  }
  const status = providers.some((item) => item.status === "failed") ? "failed"
    : providers.some((item) => item.status === "validated") ? "validated"
      : "unavailable";
  const report = { smoke: "native-effort-delivery", status, bounded: { timeoutMs: TIMEOUT_MS, maxBudgetUsd: Number(MAX_BUDGET_USD), maxSuccessfulAttempts: 1, tools: "none", metisParentLoop: false }, providers };
  process.stdout.write(`${options.json ? JSON.stringify(report) : JSON.stringify(report, null, 2)}\n`);
  return status === "failed" ? 1 : 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  });
  process.exitCode = exitCode;
}
