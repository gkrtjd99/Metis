import { resolveModelCapabilities } from "./model-capabilities.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_CRITIC_PROTOCOL } from "../core/prompt-protocols.js";

// Spawn descriptors are commonly rendered into a host shell instruction. Keep
// every task-controlled value one POSIX shell argument even when a malformed
// object reaches this adapter before core ingress validation.
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function resultFileFor(task, options) {
  const identity = `${String(task.id)}\0${String(options.leaseToken)}\0${String(options.attemptFence ?? task.attempt_fence ?? 0)}`;
  const digest = createHash("sha256").update(identity).digest("hex");
  const parentRoot = path.resolve(String(options.parentRoot ?? options.workspacePath ?? process.cwd()));
  return path.join(parentRoot, ".metis", "task-results", `terminal-${digest}.json`);
}

function runtimeCliPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli.js");
}

function effortOf(task, options = {}) {
  const requested = options.requestedEffort
    ?? task.requested_effort
    ?? task.requestedEffort
    ?? task.reasoning_effort
    ?? null;
  const hasEvidence = options.runtime || options.installed || options.configured
    || options.capability || options.modelCapability
    || Array.isArray(options.supportedEfforts);
  if (hasEvidence) {
    const evidence = resolveModelCapabilities({
      host: options.host,
      model: options.model ?? task.selected_model ?? task.selectedModel,
      requestedEffort: requested,
      runtime: options.runtime ?? options.capability,
      installed: options.installed,
      configured: options.configured
    });
    return evidence.effectiveEffort;
  }

  const status = String(options.capabilityStatus
    ?? task.capability_status
    ?? task.capabilityStatus
    ?? "unknown").trim().toLowerCase();
  if (!(status === "known" || status === "safe-default")) return null;
  const effective = options.effectiveEffort
    ?? task.effective_effort
    ?? task.effectiveEffort
    ?? null;
  if (!effective) return null;
  const supported = options.supportedEfforts
    ?? task.supported_efforts
    ?? task.supportedEfforts;
  if (!Array.isArray(supported) || !supported.some((item) => String(item).toLowerCase() === String(effective).toLowerCase())) {
    return null;
  }
  return effective;
}

function baseDescriptor(task, compactContract, options = {}) {
  const attemptFence = Number(options.attemptFence ?? task.attempt_fence ?? 0);
  const batchId = options.batchId ? String(options.batchId) : null;
  const effective = effortOf(task, options);
  const requested = options.requestedEffort
    ?? task.requested_effort
    ?? task.requestedEffort
    ?? null;
  const resultFile = options.leaseToken ? resultFileFor(task, options) : null;
  const parentRoot = options.parentRoot ?? options.workspacePath ?? process.cwd();
  const terminalHandoff = options.leaseToken ? {
    task_id: task.id,
    lease: String(options.leaseToken),
    result_file: resultFile,
    command: `cd ${shellQuote(parentRoot)} && $METIS --root ${shellQuote(parentRoot)} task finish ${shellQuote(task.id)} --lease ${shellQuote(options.leaseToken)} --file ${shellQuote(resultFile)} --pretty`,
    invocation: {
      executable: process.execPath,
      args: [
        "--no-warnings",
        runtimeCliPath(),
        "--root", String(parentRoot),
        "task", "finish", String(task.id),
        "--lease", String(options.leaseToken),
        "--file", String(resultFile),
        "--pretty"
      ],
      cwd: path.resolve(String(parentRoot))
    }
  } : null;
  const completionOwner = task.parent_task_id
    ? `Parent owner ${task.parent_task_id} owns the subsequent owner next/action loop; do not notify Main for ordinary child completion.`
    : "Main owns the subsequent next/action loop.";
  const ownerExecution = task.role === "coordinator" ? {
    required: true,
    supported: options.ownerCapability?.supported === true,
    mode: options.ownerCapability?.mode ?? null,
    delivery: options.ownerCapability?.mode === "host-relay" ? "host-relay" : "direct",
    evidence: options.ownerCapability?.evidence ?? null,
    next_command: options.leaseToken
      ? `$METIS --root ${shellQuote(options.parentRoot ?? process.cwd())} owner next ${shellQuote(task.id)} --lease ${shellQuote(options.leaseToken)} --pretty`
      : null,
    unsupported_code: "NESTED_DELEGATION_UNSUPPORTED"
  } : null;
  const ownerInstructions = ownerExecution
    ? ownerExecution.delivery === "host-relay"
      ? `\n\n# TASK OWNER\n승인된 direct-child subtree를 현재 세션에서 운영하세요. 하위 작업마다 goal lifecycle을 시작하지 마세요. owner claim 준비 후 Main host에 batch ID만 relay; 직접 중첩 spawn 하지 않음; 결정/완료는 owner 유지. Main controller credentials를 하위 agent에 전달하지 마세요. 완료 또는 범위·계약·권한 변경과 미해결 blocker만 Main에 보고하세요.\n${JSON.stringify(ownerExecution)}\n지원 capability가 없으면 하위 spawn을 시도하지 말고 NESTED_DELEGATION_UNSUPPORTED blocker를 보고하세요.`
      : `\n\n# TASK OWNER\n승인된 direct-child subtree를 현재 세션에서 운영하세요. 하위 작업마다 goal lifecycle을 시작하지 마세요. 실행과 검증에는 별도 host agent/receipt를 사용하고 Main controller credentials를 하위 agent에 전달하지 마세요. owner next/claim/ack/heartbeat는 자신의 lease로만 호출하세요. 완료 또는 범위·계약·권한 변경과 미해결 blocker만 Main에 보고하세요.\n${JSON.stringify(ownerExecution)}\n지원 capability가 없으면 하위 spawn을 시도하지 말고 NESTED_DELEGATION_UNSUPPORTED blocker를 보고하세요.`
    : "";
  const message = terminalHandoff
    ? `${compactContract.content}${task.role === "plan-critic" ? `\n\n# PLAN CRITIC TERMINAL PROTOCOL\n${PLAN_CRITIC_PROTOCOL.join("\n")}` : ""}\n\n# MANDATORY TERMINAL HANDOFF\nBefore returning your terminal result, write only the declared ResultSchema JSON to the exact task-scoped file ${shellQuote(terminalHandoff.result_file)} using the file tool, then execute this exact command successfully from the parent repository root:\n${terminalHandoff.command}\nThe file is the durable completion input; do not place result JSON in the shell command. Do not return until it succeeds. Do not pass raw transcript or worker output to Main; after success, return only a bounded ACK referring to the persisted result. ${completionOwner}${ownerInstructions}`
    : `${compactContract.content}${ownerInstructions}`;
  return {
    protocol: "metis.spawn.v1",
    host: options.host ?? null,
    run_id: task.run_id ?? options.runId ?? null,
    task_name: task.id,
    parent_task_id: task.parent_task_id ?? null,
    workspace_path: options.workspacePath ?? null,
    workspace_mode: options.workspaceMode ?? null,
    attempt_fence: attemptFence,
    idempotency_key: batchId ? `scheduler:${batchId}:${task.id}:${attemptFence}` : `task:${task.id}:${attemptFence}`,
    ...(batchId ? { batch_id: batchId } : {}),
    agent_type: `metis-${task.role}`,
    model_tier: task.model_tier ?? null,
    fork_turns: "none",
    ...(task.selected_model ? { model: task.selected_model } : {}),
    ...(effective ? { effective_effort: effective } : {}),
    ...(requested ? { requested_effort: requested } : {}),
    ...(requested && !effective ? { effort_deferred: true } : {}),
    message,
    completion_owner: task.parent_task_id ?? "main",
    ...(ownerExecution ? { owner_execution: ownerExecution } : {}),
    ...(terminalHandoff ? { terminal_handoff: terminalHandoff } : {})
  };
}

export function codexSpawnDescriptor(task, compactContract, options = {}) {
  const descriptor = baseDescriptor(task, compactContract, { host: "codex", ...options });
  const effort = effortOf(task, options);
  return effort ? { ...descriptor, reasoning_effort: effort } : descriptor;
}

function explicitStartup(options) {
  const startup = options.startup ?? options;
  const explicit = (flag, value) => flag === true || value !== undefined && value !== null;
  return explicit(startup.requiredInputsExplicit, startup.requiredInputs ?? startup.inputs)
    && explicit(startup.toolsExplicit, startup.tools)
    && explicit(startup.permissionsExplicit, startup.permissions)
    && explicit(startup.cwdExplicit, startup.cwd);
}

export function claudeSpawnDescriptor(task, compactContract, options = {}) {
  const descriptor = baseDescriptor(task, compactContract, { host: "claude", ...options });
  const effort = effortOf(task, options);
  const args = [];
  if (effort) args.push("--effort", effort);
  if (explicitStartup(options)) args.push("--bare", "--exclude-dynamic-system-prompt-sections", "--strict-mcp-config");
  const boundedVerifier = task.parent_task_id && task.model_tier === "worker"
    && ["reviewer", "verifier"].includes(task.role) && !task.selected_model;
  return {
    ...descriptor,
    ...(boundedVerifier ? { model: "sonnet", model_source: "claude-worker-profile" } : {}),
    command: options.command ?? "claude", args
  };
}

export function renderSpawnDescriptor(host, task, compactContract, options = {}) {
  if (String(host ?? "").toLowerCase() === "claude") return claudeSpawnDescriptor(task, compactContract, options);
  if (String(host ?? "").toLowerCase() === "codex") return codexSpawnDescriptor(task, compactContract, options);
  return baseDescriptor(task, compactContract, options);
}
