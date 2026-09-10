#!/usr/bin/env node
/**
 * controller 자격 증명은 parent만 보유하며 공개 CLI로 상태를 조정한다.
 * 실제 Claude 호출은 worker와 verifier에만 사용한다.
 * 이 실행기는 native Main의 자율 $metis 루프를 검증하지 않는다.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectClaudeReceipt, runChild, validateClaudeReceipt } from "./test-native-effort-delivery.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.js");
const CHILD_TIMEOUT_MS = 120_000;
const CHILD_BUDGET_USD = "1";
const TOTAL_TARGET_USD = 3;
const DEFAULT_ACCEPTANCE_HOST = "claude";
const DEFAULT_ACCEPTANCE_MODEL = "sonnet";
const DEFAULT_ACCEPTANCE_EFFORT = "medium";
const DEFAULT_ACCEPTANCE_CAPABILITIES = Object.freeze(["low", "medium", "high"]);
const SECRET_ENV = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/iu;
const CONTROLLER_ENV = /^(?:METIS_(?:CONTROLLER|SESSION|RUN|LEASE|OWNER|AUTH)|CLAUDE_CODE_SESSION|CODEX_SESSION)/u;

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !SECRET_ENV.test(key) && !CONTROLLER_ENV.test(key)));
}

function json(value) {
  return JSON.stringify(value);
}

function bounded(value, limit = 160) {
  return typeof value === "string" && value ? value.slice(0, limit) : null;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function acceptanceRoute(options = {}) {
  const host = String(options.host ?? DEFAULT_ACCEPTANCE_HOST).trim().toLowerCase();
  const model = String(options.model ?? DEFAULT_ACCEPTANCE_MODEL).trim();
  const requestedEffort = String(options.requestedEffort ?? DEFAULT_ACCEPTANCE_EFFORT).trim().toLowerCase();
  const capabilities = options.capabilities ?? { [model]: [...DEFAULT_ACCEPTANCE_CAPABILITIES] };
  return { host, model, requestedEffort, capabilities };
}

export function assertAcceptanceDescriptor(spawn, route) {
  if (route.host === "claude") {
    if (spawn?.command !== "claude"
      || JSON.stringify(spawn.args?.slice(0, 4)) !== JSON.stringify(["--model", route.model, "--effort", route.requestedEffort])
      || spawn.effort_exact_required !== true
      || spawn.effort_launch_ready !== true) {
      throw new AcceptanceError("child-route-mismatch", "Claude descriptor did not carry the approved model and effort.");
    }
  } else if (route.host === "codex") {
    const exact = spawn?.host === "codex"
      && spawn.model === route.model
      && spawn.requested_effort === route.requestedEffort
      && spawn.effective_effort === route.requestedEffort
      && spawn.reasoning_effort === route.requestedEffort
      && spawn.effort_delivery === "field"
      && spawn.effort_exact_required === true
      && spawn.effort_launch_ready === true;
    if (!exact) {
      throw new AcceptanceError("child-route-mismatch", "Codex descriptor did not carry the approved model and effort fields.");
    }
  } else {
    throw new AcceptanceError("child-route-mismatch", `Unsupported acceptance host: ${route.host}.`);
  }
}

function privateFile(directory, name, content) {
  const file = path.join(directory, name);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

class AcceptanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function validateSourceText(source) {
  if (typeof source !== "string" || source.length > 512) return { valid: false, reason: "source-bounds" };
  const match = /^export const answer = (-?\d+);\n?$/u.exec(source);
  if (!match) return { valid: false, reason: "source-grammar" };
  const answer = Number(match[1]);
  return Number.isSafeInteger(answer) ? { valid: true, answer } : { valid: false, reason: "source-number" };
}

function verifyCandidate(root) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    "import { answer } from './value.js'; process.stdout.write(JSON.stringify({ answer, syntax_ok: true }));"], {
    cwd: root, env: cleanEnv(), encoding: "utf8", timeout: 10_000
  });
  const observed = parseJson(result.stdout);
  return { exitCode: result.status, syntaxOk: result.status === 0 && observed?.syntax_ok === true,
    answer: typeof observed?.answer === "number" ? observed.answer : null };
}

function validateVerifierObservation(value, actual) {
  return Boolean(value && value.status === "ok" && value.role === "verifier"
    && typeof value.observed_answer === "number" && value.observed_answer === actual.answer
    && value.syntax_ok === actual.syntaxOk && value.tools_used === false);
}

function cli(root, args, controller, evidenceDir, name, options = {}) {
  const auth = controller ? [
    "--controller-session", controller.sessionId,
    "--controller-owner", controller.owner,
    "--controller-token", controller.token,
    "--controller-fence", String(controller.fencingToken)
  ] : [];
  const result = spawnSync(process.execPath, ["--no-warnings", CLI, ...args, ...auth, "--root", root], {
    cwd: root,
    env: cleanEnv(),
    encoding: "utf8",
    timeout: Number(options.timeoutMs ?? 30_000)
  });
  const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const rawPath = privateFile(evidenceDir, `${name}.jsonl`, raw);
  const value = parseJson(result.stdout || result.stderr);
  if (result.error || result.signal || result.status !== 0 || !value || value.error) {
    throw new AcceptanceError(value?.error?.code ?? (result.error ? "cli-spawn-error" : "cli-failed"),
      "public CLI step failed", { step: name, exitCode: result.status, signal: result.signal, rawPath });
  }
  return value;
}

function controllerFrom(start) {
  const controller = start?.controller;
  if (!controller?.sessionId || !controller?.owner || !controller?.token || controller.fencingToken == null) {
    throw new AcceptanceError("controller-receipt-missing", "start did not return a controller receipt");
  }
  return {
    sessionId: controller.sessionId,
    owner: controller.owner,
    token: controller.token,
    fencingToken: controller.fencingToken
  };
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "metis-native-accept-"));
  chmodSync(directory, 0o700);
  const root = path.join(directory, "project");
  const evidenceDir = path.join(directory, "evidence");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(evidenceDir, { mode: 0o700 });
  writeFileSync(path.join(root, "package.json"), `${json({ name: "metis-native-acceptance-fixture", type: "module" })}\n`, { mode: 0o644 });
  writeFileSync(path.join(root, "value.js"), "export const answer = 41;\n", { mode: 0o644 });
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: root, env: cleanEnv(), encoding: "utf8" });
    if (result.status !== 0) throw new AcceptanceError("fixture-git-failed", "fixture git setup failed");
  };
  git(["init", "-q"]);
  git(["add", "package.json", "value.js"]);
  git(["-c", "user.name=Metis acceptance fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial fixture"]);
  return { root, evidenceDir };
}

async function runProviderChild({ descriptor, prompt, cwd, evidenceDir, name, host = DEFAULT_ACCEPTANCE_HOST, model = DEFAULT_ACCEPTANCE_MODEL, requestedEffort = DEFAULT_ACCEPTANCE_EFFORT }) {
  const route = acceptanceRoute({ host, model, requestedEffort });
  assertAcceptanceDescriptor(descriptor, route);
  if (route.host !== "claude") {
    throw new AcceptanceError("child-provider-mismatch", "The default provider is Claude-only; supply a host-specific provider for another adapter.");
  }
  const rawPath = path.join(evidenceDir, `${name}.stdout-stderr.log`);
  const args = [...descriptor.args, "--tools", "", "--output-format", "stream-json", "--print", "--max-budget-usd", CHILD_BUDGET_USD];
  const execution = await runChild(descriptor.command, args, prompt, rawPath, {
    cwd,
    timeoutMs: Math.min(CHILD_TIMEOUT_MS, 90_000),
    maxOutputBytes: 256 * 1024
  });
  const parsed = collectClaudeReceipt(execution.stdout, execution.stderr);
  const validation = validateClaudeReceipt(parsed, execution, {
    model: route.model,
    effort: route.requestedEffort
  });
  const terminal = execution.stdout.split(/\r?\n/u).map(parseJson).find((event) => event?.type === "result");
  const estimate = terminal?.total_cost_usd ?? terminal?.cost_usd;
  const receipt = {
    requested: { model: route.model, effort: route.requestedEffort },
    observed: { model: bounded(parsed.observed.model), sessionId: bounded(parsed.observed.sessionId) },
    structured_response: {
      status: parsed.structuredResponse?.status === "ok" ? "ok" : parsed.structuredResponse?.status == null ? null : "unexpected",
      role: ["worker", "verifier"].includes(parsed.structuredResponse?.role) ? parsed.structuredResponse.role : null,
      tools_used: typeof parsed.structuredResponse?.tools_used === "boolean" ? parsed.structuredResponse.tools_used : null
    },
    permission_denial_count: parsed.permissionDenials.length,
    exit: { code: execution.exitCode, signal: execution.signal, timedOut: execution.timedOut },
    provider_error: parsed.errors.length > 0,
    invalid_output_lines: parsed.invalidLines.length,
    output_truncated: execution.outputTruncated,
    validation: { valid: validation.valid, model: validation.model_confirmation, effort: validation.effort_confirmation },
    cli_estimate_usd: typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0 ? estimate : null,
    durationMs: execution.durationMs,
    api_billed_usd: "unavailable",
    rawPath
  };
  if (!validation.valid) throw new AcceptanceError("child-receipt-invalid", "provider child receipt failed closed validation", { receipt });
  return { receipt, structured: parsed.structuredResponse };
}

function taskResult(summary, evidenceRefs = [], extra = {}) {
  return {
    Status: "COMPLETED", Files: [], Summary: bounded(summary, 300), EvidenceRefs: evidenceRefs,
    AcceptanceResults: ["value.js exports answer 42", "syntax check passes"]
      .map((criterion) => ({ criterion, status: "passed", evidenceRefs })),
    Blockers: [], ...extra
  };
}

export function offlineValidation() {
  const valid42 = validateSourceText("export const answer = 42;\n");
  const valid41 = validateSourceText("export const answer = 41;\n");
  const invalidJs = validateSourceText("process.exit(1);\n");
  const fixedVerdict = validateVerifierObservation({ status: "ok", role: "verifier", passed: true, tools_used: false }, { answer: 42, syntaxOk: true });
  const missingReceipt = validateClaudeReceipt(collectClaudeReceipt(JSON.stringify({ type: "result", result: "{\\\"status\\\":\\\"ok\\\",\\\"tools_used\\\":false}" }), ""), {
    exitCode: 0, signal: null, timedOut: false, outputTruncated: false, error: null
  }, { model: "sonnet", effort: "medium" });
  const checks = {
    valid42: valid42.valid && valid42.answer === 42,
    answer41RejectedAgainstRequirement: valid41.valid && valid41.answer === 41 && valid41.answer !== 42,
    invalidJsRejected: invalidJs.valid === false,
    fixedVerdictRejected: fixedVerdict === false,
    missingReceiptRejected: missingReceipt.valid === false
  };
  return { status: Object.values(checks).every(Boolean) ? "validated" : "failed", networkAttempted: false, checks };
}

export async function runAcceptance(options = {}) {
  const route = acceptanceRoute(options);
  const provider = options.provider ?? runProviderChild;
  const project = fixture();
  const evidenceDir = project.evidenceDir;
  const root = project.root;
  const results = {
    fixtureRoot: root, evidenceDir, nativeMainVerified: false,
    nativeChildren: provider === runProviderChild, deterministicHarness: true, providers: [],
    route: { host: route.host, model: route.model, requestedEffort: route.requestedEffort }
  };
  try {
    cli(root, ["init", "--host", route.host], null, evidenceDir, "01-init");
    cli(root, ["model", "configure", "--data", json({
      host: route.host,
      subagents: { default: { model: route.model, effort: route.requestedEffort } },
      capabilities: route.capabilities
    })], null, evidenceDir, "02-model-configure");
    const started = cli(root, ["start", "Create a verified answer module", "--host", route.host, "--plan-only"], null, evidenceDir, "03-start");
    const controller = controllerFrom(started);
    results.runId = started.run?.id ?? null;
    const contract = {
      objective: "Create a verified answer module", scope: ["value.js"], nonGoals: ["Unrelated changes"],
      constraints: ["Keep ES module syntax"], successCriteria: ["value.js exports answer 42", "syntax check passes"],
      complexity: "trivial", route: { lifecycleProfile: "fast", executionApprovalRequired: true, documentationRequired: false },
      requirements: [{ id: "REQ-ANSWER", title: "Provide verified answer", description: "Export answer 42", kind: "functional", priority: "must", acceptance: ["value.js exports answer 42", "syntax check passes"] }]
    };
    cli(root, ["contract", "freeze", "--data", json(contract)], controller, evidenceDir, "04-contract-freeze");
    cli(root, ["advance", "discover"], controller, evidenceDir, "05-advance-discover");
    const planned = cli(root, ["drive", "--data", json({ executionSettings: {
      host: route.host, model: route.model, requestedEffort: route.requestedEffort, confirmed: true,
      evidence: "automated acceptance fixture; user-approved test execution"
    } })], controller, evidenceDir, "06-plan-materialize");
    if (planned.type !== "USER_OR_AUTHORITY_REQUIRED") throw new AcceptanceError("plan-materialization-unexpected", "fast path did not stop for approval");
    cli(root, ["plan", "execute", "--reason", "automated acceptance fixture execution approval"], controller, evidenceDir, "07-plan-execute");
    cli(root, ["advance", "execute"], controller, evidenceDir, "08-advance-execute");
    cli(root, ["pause", "bounded interrupt before worker dispatch"], controller, evidenceDir, "09-pause");
    cli(root, ["resume"], controller, evidenceDir, "10-resume");
    const restored = cli(root, ["goal", "restore"], controller, evidenceDir, "11-restore");
    if (restored.run?.phase !== "execute" || restored.executionApproval?.pass !== true || JSON.stringify(restored).includes(controller.token)) {
      throw new AcceptanceError("resume-boundary-failed", "resume did not restore approved execute state without token leakage");
    }
    results.resume = { paused: true, resumed: true, phase: restored.run.phase, approval: restored.executionApproval.pass };

    const workerBatch = cli(root, ["schedule", "claim", "--owner", "native-worker", "--limit", "1"], controller, evidenceDir, "12-worker-claim");
    const worker = workerBatch.batch?.[0];
    if (!worker) throw new AcceptanceError("worker-claim-missing", "worker was not claimable");
    assertAcceptanceDescriptor(worker.spawn, route);
    const workerPrompt = [
      "You are the implementation worker in a bounded Metis acceptance fixture.",
      "Requirement: value.js must export the number 42 as answer.",
      "The project uses package.json type module. Use ES module syntax, not CommonJS or module.exports.",
      "The bounded output contract is one declaration: export const answer = <integer>; followed by an optional newline. No other statements or comments.",
      "Do not use tools, shell, filesystem, network, or Metis commands.",
      "Return exactly one JSON object and no markdown with status ok, role worker, a source_text field containing the complete implementation, and tools_used false.",
      "Do not return a claimed answer or verdict; the parent will validate the source grammar and execute the candidate independently.",
      "This is a child receipt, not a Metis COMPLETE result."
    ].join(" ");
    const workerNative = await provider({ descriptor: worker.spawn, prompt: workerPrompt, cwd: worker.workspacePath, evidenceDir, name: "13-worker-native", ...route });
    results.providers.push({ role: "worker", ...workerNative.receipt });
    const workerSource = validateSourceText(workerNative.structured.source_text);
    if (!workerSource.valid) throw new AcceptanceError("worker-source-invalid", "worker source failed the bounded fixture grammar", { reason: workerSource.reason, receipt: workerNative.receipt });
    writeFileSync(path.join(worker.workspacePath, "value.js"), workerNative.structured.source_text, { mode: 0o644 });
    const workerObservation = verifyCandidate(worker.workspacePath);
    if (workerObservation.exitCode !== 0 || !workerObservation.syntaxOk || workerObservation.answer !== 42) {
      throw new AcceptanceError("worker-candidate-failed", "worker source failed independent candidate execution", { observation: workerObservation });
    }
    const workerReceipt = { [worker.taskId]: { receipt: workerNative.receipt.observed.sessionId, batchId: workerBatch.batchId, taskId: worker.taskId, attemptFence: worker.attemptFence } };
    cli(root, ["schedule", "ack", workerBatch.batchId, "--tasks", worker.taskId, "--receipts", json(workerReceipt), "--owner", "native-worker"], controller, evidenceDir, "14-worker-ack");
    cli(root, ["task", "finish", worker.taskId, "--lease", worker.leaseToken, "--data", json(taskResult("Worker source was independently executed before integration.", ["value.js:1"], { Files: ["value.js"] }))], null, evidenceDir, "15-worker-finish");
    cli(root, ["pause", "bounded interrupt after worker completion"], controller, evidenceDir, "15a-pause-after-worker");
    cli(root, ["resume"], controller, evidenceDir, "15b-resume-after-worker");
    const workerRestore = cli(root, ["goal", "restore"], controller, evidenceDir, "15c-restore-after-worker");
    const completedTasks = cli(root, ["task", "list", "--status", "completed"], controller, evidenceDir, "15d-completed-tasks");
    const restoredWorker = (completedTasks.tasks ?? completedTasks).find?.((task) => task.id === worker.taskId);
    if (workerRestore.run?.id !== results.runId || workerRestore.executionApproval?.pass !== true
      || !restoredWorker || restoredWorker.status !== "completed" || restoredWorker.attempts !== 1
      || Number(restoredWorker.attempt_fence) !== Number(worker.attemptFence)) {
      throw new AcceptanceError("worker-resume-boundary-failed", "worker completion did not survive public pause/resume");
    }
    results.resume.workerCompletion = { paused: true, resumed: true, sameRun: true, workerCompleted: true, attemptFence: restoredWorker.attempt_fence ?? null };
    const verifierPreparation = cli(root, ["drive"], controller, evidenceDir, "16-drive-verifier");
    for (const task of verifierPreparation.action?.tasks ?? verifierPreparation.tasks ?? []) {
      if (task.taskId) cli(root, ["task", "packet", "compile", task.taskId], controller, evidenceDir, `16-packet-${task.taskId}`);
    }

    const verifierBatch = cli(root, ["schedule", "claim", "--owner", "native-verifier", "--limit", "1"], controller, evidenceDir, "17-verifier-claim");
    const verifier = verifierBatch.batch?.[0];
    if (!verifier || verifier.taskId === worker.taskId) throw new AcceptanceError("verifier-claim-missing", "independent verifier was not claimable");
    const source = readFileSync(path.join(root, "value.js"), "utf8");
    const candidateSource = validateSourceText(source);
    if (!candidateSource.valid) throw new AcceptanceError("candidate-source-invalid", "integrated candidate failed the bounded fixture grammar");
    const actual = verifyCandidate(root);
    const verifierPrompt = [
      "You are an independent verifier in a bounded Metis acceptance fixture.",
      "Requirement: value.js must export the number 42 as answer.",
      "Do not use tools, shell, filesystem, network, or Metis commands.",
      `The parent supplied the current candidate file content: ${JSON.stringify(source)}`,
      "Inspect the candidate content yourself and return exactly one JSON object with status ok, role verifier, observed_answer as a number, syntax_ok as a boolean, and tools_used false.",
      "Do not return a fixed verdict or rely on a worker transcript; the parent compares your observation with an independent Node execution."
    ].join(" ");
    assertAcceptanceDescriptor(verifier.spawn, route);
    const verifierNative = await provider({ descriptor: verifier.spawn, prompt: verifierPrompt, cwd: verifier.workspacePath, evidenceDir, name: "18-verifier-native", ...route });
    results.providers.push({ role: "verifier", ...verifierNative.receipt });
    if (!verifierNative.receipt.observed.sessionId
      || verifierNative.receipt.observed.sessionId === workerNative.receipt.observed.sessionId) {
      throw new AcceptanceError("verifier-session-not-independent", "verifier must use a distinct child session");
    }
    if (!validateVerifierObservation(verifierNative.structured, actual) || actual.answer !== 42 || !actual.syntaxOk) {
      throw new AcceptanceError("verifier-observation-mismatch", "independent verifier observation did not match Node execution", { actual });
    }
    const candidate = cli(root, ["artifact", "latest", "integration-candidate"], controller, evidenceDir, "19-candidate");
    const verifierReceipt = { [verifier.taskId]: { receipt: verifierNative.receipt.observed.sessionId, batchId: verifierBatch.batchId, taskId: verifier.taskId, attemptFence: verifier.attemptFence } };
    cli(root, ["schedule", "ack", verifierBatch.batchId, "--tasks", verifier.taskId, "--receipts", json(verifierReceipt), "--owner", "native-verifier"], controller, evidenceDir, "20-verifier-ack");
    cli(root, ["task", "finish", verifier.taskId, "--lease", verifier.leaseToken, "--data", json(taskResult("Independent native verifier observed answer 42.", [{ type: "artifact", id: candidate.id, contentRef: candidate.content_ref }]))], null, evidenceDir, "21-verifier-finish");
    const terminal = cli(root, ["drive"], controller, evidenceDir, "22-drive-complete");
    const final = cli(root, ["goal", "restore"], controller, evidenceDir, "23-final-restore");
    results.phase = final.run?.phase ?? null;
    results.status = final.run?.status ?? null;
    results.terminalType = terminal.type ?? null;
    if (terminal.type !== "COMPLETE" || final.run?.phase !== "complete" || final.run?.status !== "completed") {
      throw new AcceptanceError("runtime-not-complete", "runtime did not reach its completion gate", { terminalType: terminal.type });
    }
    results.status = "validated";
    results.conclusion = results.nativeChildren ? "deterministic-public-cli-runtime-with-native-worker-verifier" : "offline-fixture-only";
    results.cost = { childBudgetUsdEach: Number(CHILD_BUDGET_USD), targetTotalCliEstimateUsd: TOTAL_TARGET_USD, apiBilledUsd: "unavailable", supervisorAgentCostIncluded: false };
    return results;
  } catch (error) {
    results.status = "failed";
    results.error = { code: error.code ?? "acceptance-error", message: error.message, details: error.details ?? {} };
    return results;
  }
}

function usage() {
  return "Usage: node scripts/test-native-acceptance.mjs --run | --offline-test | --help";
}

const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    process.stdout.write(`${usage()}\n`);
  } else if (args.has("--offline-test")) {
    const report = offlineValidation();
    process.stdout.write(`${json(report)}\n`);
    process.exitCode = report.status === "validated" ? 0 : 1;
  } else if (!args.has("--run")) {
    process.stdout.write(`${json({ status: "opt-in-required", attempted: false, networkAttempted: false })}\n`);
  } else {
    const report = await runAcceptance();
    process.stdout.write(`${json(report)}\n`);
    process.exitCode = report.status === "validated" ? 0 : 1;
  }
}
