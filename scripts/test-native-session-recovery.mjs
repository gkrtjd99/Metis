#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { collectClaudeReceipt, validateClaudeReceipt } from "./test-native-effort-delivery.mjs";

const LIMIT = 256 * 1024;
const TIMEOUT = 90_000;

export function memoryMatches(actual, expected) {
  return actual?.status === "ok" && actual?.tools_used === false
    && actual.goal_id === expected.goal_id && actual.answer === expected.answer
    && actual.constraint === expected.constraint;
}

export function isTextDelta(event) {
  return event?.type === "stream_event" && event.event?.type === "content_block_delta"
    && event.event.delta?.type === "text_delta" && Boolean(event.event.delta.text);
}

export function isCompactBoundary(event) {
  return event?.type === "system" && event.subtype === "compact_boundary"
    && event.compact_metadata?.trigger === "manual";
}

function invoke(root, evidence, name, prompt, { session, interrupt = false } = {}) {
  return new Promise((resolve) => {
    const args = ["--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages",
      "--model", "sonnet", "--effort", "medium", "--tools", "", "--max-budget-usd", "0.15"];
    if (session) args.push("--resume", session);
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|PRIVATE_KEY|METIS_CONTROLLER/iu.test(key)));
    const child = spawn("claude", args, { cwd: root, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let pending = "";
    let interrupted = false;
    let timedOut = false;
    let truncated = false;
    let spawnError = false;
    const kill = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT);
    function capture(target, chunk) {
      const remaining = LIMIT - bytes;
      if (chunk.length > remaining) truncated = true;
      target.push(chunk.subarray(0, Math.max(0, remaining)));
      bytes += Math.min(chunk.length, Math.max(0, remaining));
      if (truncated) kill();
    }
    child.stdout.on("data", (chunk) => {
      capture(stdout, chunk);
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (interrupt && !interrupted && isTextDelta(event)) { interrupted = true; kill(); }
      }
    });
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.on("error", () => { spawnError = true; });
    child.stdin.on("error", () => {});
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      writeFileSync(path.join(evidence, `${name}.stdout.jsonl`), out, { mode: 0o600 });
      writeFileSync(path.join(evidence, `${name}.stderr.log`), err, { mode: 0o600 });
      const receipt = collectClaudeReceipt(out, err);
      const execution = { exitCode, signal, timedOut, outputTruncated: truncated, error: spawnError ? "spawn-error" : null };
      const validation = validateClaudeReceipt(receipt, execution);
      const events = out.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      const terminal = events.findLast((event) => event.type === "result");
      const cost = terminal?.total_cost_usd ?? terminal?.cost_usd;
      resolve({ receipt, execution, validation, interrupted,
        compactBoundary: events.some(isCompactBoundary),
        cost: Number.isFinite(cost) && cost >= 0 ? cost : null });
    });
    child.stdin.end(prompt);
  });
}

export async function runRecovery() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "metis-native-session-recovery-"));
  const root = path.join(directory, "project");
  const evidence = path.join(directory, "evidence");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(evidence, { mode: 0o700 });
  const memory = { goal_id: randomUUID(), answer: 42, constraint: `preserve-${randomUUID()}` };
  const report = { status: "failed", scope: "no-tools-native-session-recovery-only", nativeMetisLoopVerified: false,
    evidence, calls: [], checks: {}, modelConfirmation: "unconfirmed", effortConfirmation: "unconfirmed" };
  function record(name, result) {
    report.calls.push({ name, ...result.execution, interrupted: result.interrupted,
      session: result.receipt.observed.sessionId, model: result.receipt.observed.model,
      transportValid: result.validation.valid, cliEstimateUsd: result.cost,
      permissionDenials: result.receipt.permissionDenials.length, toolUse: result.receipt.toolUse });
  }
  function requireCondition(condition, code) { if (!condition) throw new Error(code); }
  try {
    const seed = await invoke(root, evidence, "seed", `This is a no-tools session recovery test, not a Metis execution. Memorize this exact record for a later turn: ${JSON.stringify(memory)}. Do not use tools. Return exactly a JSON object with those three fields plus status "ok" and tools_used false.`);
    record("seed", seed);
    requireCondition(seed.validation.valid && memoryMatches(seed.receipt.structuredResponse, memory), "seed-invalid");
    const session = seed.receipt.observed.sessionId;
    const interrupted = await invoke(root, evidence, "interrupted", "Do not use tools or change the remembered record. Start writing a long numbered explanation of arithmetic; this disposable test will interrupt the process while you are answering.", { session, interrupt: true });
    record("interrupted", interrupted);
    requireCondition(interrupted.interrupted && interrupted.execution.signal === "SIGKILL"
      && !interrupted.execution.timedOut && !interrupted.execution.outputTruncated && !interrupted.execution.error
      && !interrupted.receipt.terminalResult
      && interrupted.receipt.observed.sessionId === session && !interrupted.receipt.toolUse
      && interrupted.receipt.permissionDenials.length === 0 && interrupted.receipt.errors.length === 0, "interrupt-not-observed");
    report.checks.actualProcessKilledDuringText = true;
    const resumed = await invoke(root, evidence, "resumed", "Do not use tools. Recall the exact goal_id, answer, and constraint from the original remembered record, not from this message. Return only a JSON object with those three fields plus status \"ok\" and tools_used false.", { session });
    record("resumed", resumed);
    requireCondition(resumed.validation.valid && resumed.receipt.observed.sessionId === session
      && memoryMatches(resumed.receipt.structuredResponse, memory), "resume-memory-mismatch");
    report.checks.sameSession = true;
    report.checks.originalMemoryRetainedWithoutRestating = true;
    report.modelConfirmation = resumed.validation.model_confirmation;
    report.status = "validated";
  } catch (error) {
    report.error = /^[a-z-]+$/u.test(error.message) ? error.message : "probe-error";
  }
  report.knownCliEstimateUsd = report.calls.reduce((total, call) => total + (call.cliEstimateUsd ?? 0), 0);
  report.costIncomplete = report.calls.some((call) => call.cliEstimateUsd === null);
  writeFileSync(path.join(evidence, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}

export async function runCompactRecovery(priorEvidence) {
  const previous = JSON.parse(readFileSync(path.join(priorEvidence, "report.json"), "utf8"));
  if (previous.status !== "validated" || previous.scope !== "no-tools-native-session-recovery-only") throw new Error("prior-recovery-required");
  const session = previous.calls[0].session;
  const seed = collectClaudeReceipt(readFileSync(path.join(priorEvidence, "seed.stdout.jsonl"), "utf8"), "");
  const memory = seed.structuredResponse;
  const root = path.join(path.dirname(priorEvidence), "project");
  const evidence = mkdtempSync(path.join(path.dirname(priorEvidence), "compact-evidence-"));
  const report = { status: "failed", scope: "no-tools-native-compact-only", nativeMetisLoopVerified: false,
    session, evidence, calls: [], checks: {} };
  const compact = await invoke(root, evidence, "compact", "/compact Preserve the exact original remembered goal_id, answer, and constraint for the next turn.", { session });
  report.calls.push({ name: "compact", ...compact.execution, compactBoundary: compact.compactBoundary,
    cliEstimateUsd: compact.cost, session: compact.receipt.observed.sessionId });
  const safe = compact.execution.exitCode === 0 && !compact.execution.signal && !compact.execution.error
    && !compact.execution.timedOut && !compact.execution.outputTruncated && compact.receipt.errors.length === 0
    && compact.receipt.permissionDenials.length === 0 && !compact.receipt.toolUse;
  if (!safe || !compact.compactBoundary || compact.receipt.observed.sessionId !== session) {
    report.error = "compact-boundary-not-confirmed";
  } else {
    report.checks.actualCompactBoundary = true;
    const resumed = await invoke(root, evidence, "post-compact", "Do not use tools. Return exactly a JSON object recalling the original goal_id, answer, and constraint, plus status \"ok\" and tools_used false. The original values are intentionally not repeated here.", { session });
    report.calls.push({ name: "post-compact", ...resumed.execution, cliEstimateUsd: resumed.cost,
      session: resumed.receipt.observed.sessionId, model: resumed.receipt.observed.model });
    if (resumed.validation.valid && resumed.receipt.observed.sessionId === session && memoryMatches(resumed.receipt.structuredResponse, memory)) {
      report.status = "validated";
      report.checks.sameSessionAndOriginalMemory = true;
    } else report.error = "post-compact-memory-mismatch";
  }
  writeFileSync(path.join(evidence, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--run") {
    const report = await runRecovery();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "validated" ? 0 : 1;
  } else if (process.argv.length === 4 && process.argv[2] === "--run-compact") {
    const report = await runCompactRecovery(path.resolve(process.argv[3]));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "validated" ? 0 : 1;
  } else {
    process.stdout.write(`${JSON.stringify({ status: "opt-in-required", networkAttempted: false })}\n`);
  }
}
