import { resolveModelCapabilities } from "./model-capabilities.js";
import { createHash } from "node:crypto";
import path from "node:path";
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
  const terminalHandoff = options.leaseToken ? {
    task_id: task.id,
    lease: String(options.leaseToken),
    result_file: resultFileFor(task, options),
    command: `cd ${shellQuote(options.parentRoot ?? options.workspacePath ?? process.cwd())} && $METIS --root ${shellQuote(options.parentRoot ?? options.workspacePath ?? process.cwd())} task finish ${shellQuote(task.id)} --lease ${shellQuote(options.leaseToken)} --file ${shellQuote(resultFileFor(task, options))} --pretty`
  } : null;
  const message = terminalHandoff
    ? `${compactContract.content}${task.role === "plan-critic" ? `\n\n# PLAN CRITIC TERMINAL PROTOCOL\n${PLAN_CRITIC_PROTOCOL.join("\n")}` : ""}\n\n# MANDATORY TERMINAL HANDOFF\nBefore returning your terminal result, write only the declared ResultSchema JSON to the exact task-scoped file ${shellQuote(terminalHandoff.result_file)} using the file tool, then execute this exact command successfully from the parent repository root:\n${terminalHandoff.command}\nThe file is the durable completion input; do not place result JSON in the shell command. Do not return until it succeeds. Do not pass raw transcript or worker output to Main; after success, return only a bounded ACK referring to the persisted result. Main owns the subsequent next/action loop.`
    : compactContract.content;
  return {
    task_name: task.id,
    attempt_fence: attemptFence,
    idempotency_key: batchId ? `scheduler:${batchId}:${task.id}:${attemptFence}` : `task:${task.id}:${attemptFence}`,
    ...(batchId ? { batch_id: batchId } : {}),
    agent_type: `metis-${task.role}`,
    fork_turns: "none",
    ...(task.selected_model ? { model: task.selected_model } : {}),
    ...(effective ? { effective_effort: effective } : {}),
    ...(requested ? { requested_effort: requested } : {}),
    ...(requested && !effective ? { effort_deferred: true } : {}),
    message,
    ...(terminalHandoff ? { terminal_handoff: terminalHandoff } : {})
  };
}

export function codexSpawnDescriptor(task, compactContract, options = {}) {
  const descriptor = baseDescriptor(task, compactContract, options);
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
  const descriptor = baseDescriptor(task, compactContract, options);
  const effort = effortOf(task, options);
  const args = [];
  if (effort) args.push("--effort", effort);
  if (explicitStartup(options)) args.push("--bare", "--exclude-dynamic-system-prompt-sections", "--strict-mcp-config");
  return { ...descriptor, command: options.command ?? "claude", args };
}

export function renderSpawnDescriptor(host, task, compactContract, options = {}) {
  if (String(host ?? "").toLowerCase() === "claude") return claudeSpawnDescriptor(task, compactContract, options);
  if (String(host ?? "").toLowerCase() === "codex") return codexSpawnDescriptor(task, compactContract, options);
  return baseDescriptor(task, compactContract, options);
}
