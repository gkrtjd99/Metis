import fs from "node:fs";
import path from "node:path";
import { capabilityProcedure, taskCapabilities } from "./capabilities.js";
import { invariant } from "./errors.js";
import { taskInterfaceContracts } from "./interfaces.js";
import { readObject, storeObject } from "./objects.js";
import { runtimeArea } from "./paths.js";
import { ROLE_PROTOCOLS, renderTaskPacketPrompt, resultSchemaForRole } from "./prompt-protocols.js";
import { getRun, latestArtifact, recordEvent, touchRun } from "./state.js";
import { asArray, json, makeId, now, parseJson, sha256, stableStringify } from "./util.js";

const ALLOWED_OVERLAY_FIELDS = new Set([
  "ClarifiedObjective",
  "ExecutionSteps",
  "ContextPriorities",
  "InterfaceNotes",
  "VerificationPlan",
  "AdditionalStopConditions",
  "HandoffNotes",
  "Ambiguities"
]);

// A database connection owns its task-packet cache. The cache is intentionally
// process-local: durable packet rows remain the source of truth for status.
const BLUEPRINT_CACHE = new WeakMap();

function taskRow(db, taskId) {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  invariant(row, "TASK_NOT_FOUND", `Task ${taskId} was not found.`);
  return row;
}

function list(value) {
  return parseJson(value, []);
}

function compilerPolicy(task, config) {
  if (task.role === "task-compiler") return "deterministic";
  const configured = String(config.delegation?.compilerPolicy ?? "auto").toLowerCase();
  if (["never", "deterministic"].includes(configured)) return "deterministic";
  if (["always", "llm"].includes(configured)) return "llm";
  const risky = asArray(config.delegation?.compilerRisks).includes(task.risk);
  const large = asArray(config.delegation?.compilerEfforts).includes(task.effort);
  const complex = task.complexity === "high";
  const executionKind = ["implementation", "integration", "repair", "diagnosis"].includes(task.task_kind);
  return executionKind && (risky || large || complex) ? "llm" : "deterministic";
}

function requirementContext(db, runId, requirementIds) {
  if (requirementIds.length === 0) return [];
  const placeholders = requirementIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, title, description, kind, priority, acceptance_json
    FROM requirements
    WHERE run_id = ? AND id IN (${placeholders}) AND status <> 'superseded'
  `).all(runId, ...requirementIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return requirementIds.map((id) => byId.get(id)).filter(Boolean).map((row) => ({
    Id: row.id,
    Title: row.title,
    Description: row.description,
    Kind: row.kind,
    Priority: row.priority,
    AcceptanceCriteria: parseJson(row.acceptance_json, [])
  }));
}

function dependencySummaries(db, taskId, maxItems) {
  return db.prepare(`
    SELECT t.id, t.title, t.role, t.task_kind, t.expected_outputs_json
    FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on
    WHERE d.task_id = ? AND t.role <> 'task-compiler' ORDER BY t.created_at
  `).all(taskId).slice(0, maxItems).map((row) => ({
    TaskId: row.id,
    Title: row.title,
    Role: row.role,
    Kind: row.task_kind,
    ExpectedOutputs: parseJson(row.expected_outputs_json, [])
  }));
}


function clipContext(value, maxChars) {
  const serialized = typeof value === "string" ? value : stableStringify(value);
  if (serialized.length <= maxChars) return serialized;
  const head = Math.max(0, Math.floor(maxChars * 0.7));
  const tail = Math.max(0, maxChars - head - 32);
  return `${serialized.slice(0, head)}\n...[context clipped]...\n${serialized.slice(-tail)}`;
}

function resolveContextRefs(db, projectRoot, runId, refs, maxChars) {
  let remaining = Math.max(0, Number(maxChars ?? 8000));
  const selected = [];
  for (const raw of refs) {
    const ref = typeof raw === "string" ? raw : String(raw?.ref ?? raw?.id ?? "");
    if (!ref) continue;
    if (ref.startsWith("artifact:")) {
      const kind = ref.slice("artifact:".length);
      const artifact = latestArtifact(db, projectRoot, runId, kind, ["verified", "waived"]);
      if (!artifact) {
        selected.push({ Ref: ref, Status: "missing" });
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(artifact.content ?? "null"); } catch { parsed = artifact.content ?? ""; }
      const allowance = Math.min(remaining, 4000);
      const content = allowance > 0 ? clipContext(parsed, allowance) : "";
      remaining = Math.max(0, remaining - content.length);
      selected.push({
        Ref: ref,
        Status: artifact.status,
        ArtifactId: artifact.id,
        ContentRef: artifact.content_ref,
        ContentHash: artifact.metadata?.contentHash ?? artifact.content_ref,
        Content: content
      });
      continue;
    }
    if (ref.startsWith("task-result:")) {
      selected.push({ Ref: ref, Status: "loaded-at-dispatch" });
      continue;
    }
    if (ref.startsWith("task-blueprint:")) {
      selected.push({ Ref: ref, Status: "embedded-in-compiler-target" });
      continue;
    }
    selected.push({ Ref: ref, Status: "reference" });
  }
  return selected;
}

const BLUEPRINT_TASK_FIELDS = [
  "id", "run_id", "milestone_id", "parent_task_id", "role", "task_kind", "wave", "phase",
  "title", "goal", "read_only", "scope_json", "non_goals_json", "constraints_json",
  "target_paths_json", "requirement_ids_json", "acceptance_json", "required_evidence_json",
  "expected_outputs_json", "verification_modes_json", "context_refs_json", "stop_conditions_json",
  "authority", "risk", "effort", "complexity", "interfaces_json", "compiler_target_task_id"
];

function sourceTask(task) {
  return Object.fromEntries(BLUEPRINT_TASK_FIELDS.map((field) => [field, task[field]]));
}

function sourceRequirements(db, runId, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`
    SELECT id, title, description, kind, priority, status, acceptance_json
    FROM requirements WHERE run_id = ? AND id IN (${placeholders})
  `).all(runId, ...ids).sort((a, b) => a.id.localeCompare(b.id));
}

function sourceDependencies(db, taskId) {
  return db.prepare(`
    SELECT d.depends_on, t.id, t.title, t.role, t.task_kind, t.expected_outputs_json, t.created_at
    FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on
    WHERE d.task_id = ? ORDER BY t.created_at
  `).all(taskId);
}

function sourceInterfaces(db, taskId) {
  return db.prepare(`
    SELECT l.interface_id, l.direction, l.allow_change, i.name, i.version, i.status,
      i.description, i.schema_json, i.requirement_ids_json, i.content_hash
    FROM task_interface_links l JOIN interface_contracts i ON i.id = l.interface_id
    WHERE l.task_id = ? ORDER BY l.direction, i.name, i.version
  `).all(taskId);
}

function sourceCapabilities(db, taskId) {
  return db.prepare(`
    SELECT tc.capability_name, tc.reason, c.description, c.skill_path, c.metadata_json
    FROM task_capabilities tc JOIN capabilities c ON c.name = tc.capability_name
    WHERE tc.task_id = ? ORDER BY c.name
  `).all(taskId).map((row) => ({
    ...row,
    procedure: capabilityProcedure(row.capability_name)
  }));
}

function sourceObjectBacking(db, projectRoot, ref) {
  if (!ref) return null;
  const hash = String(ref).replace(/^obj_/, "");
  const row = db.prepare(`
    SELECT hash, kind, bytes, compressed_bytes, path, content_encoding,
      encrypted, cipher, nonce, auth_tag
    FROM objects WHERE hash = ?
  `).get(hash);
  if (!row) return null;
  const relative = row.path.replace(/^objects[\\/]/u, "");
  const objectPath = path.join(runtimeArea(projectRoot, "objects"), relative);
  let file;
  try {
    const stat = fs.statSync(objectPath);
    file = {
      birthtimeMs: stat.birthtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      size: stat.size
    };
  } catch (error) {
    invariant(false, "OBJECT_NOT_FOUND", `Object ${hash} backing ${ref} is not readable.`, {
      objectRef: ref,
      path: objectPath,
      reason: error?.code ?? error?.name ?? "unknown"
    });
  }
  return { ...row, file };
}

function artifactContextRef(raw) {
  const ref = typeof raw === "string" ? raw : String(raw?.ref ?? raw?.id ?? "");
  return ref.startsWith("artifact:") ? ref : null;
}

function resolvedArtifactRow(db, runId, ref) {
  const artifactRef = artifactContextRef(ref);
  if (!artifactRef) return null;
  return db.prepare(`
    SELECT id, status, content_ref, metadata_json, updated_at
    FROM artifacts WHERE run_id = ? AND kind = ? AND status IN ('verified', 'waived')
    ORDER BY updated_at DESC LIMIT 1
  `).get(runId, artifactRef.slice("artifact:".length)) ?? null;
}

function artifactContentHash(row) {
  if (!row) return null;
  return parseJson(row.metadata_json, {})?.contentHash ?? row.content_ref ?? null;
}

function executionBasisForRefs(db, run, refs) {
  return {
    ContractVersion: Number(run.contract_version ?? 0),
    Artifacts: refs
      .map((ref) => {
        const artifactRef = artifactContextRef(ref);
        if (!artifactRef) return null;
        const row = resolvedArtifactRow(db, run.id, artifactRef);
        return {
          Ref: artifactRef,
          ArtifactId: row?.id ?? null,
          ContentRef: row?.content_ref ?? null,
          Status: row?.status ?? "missing",
          ContentHash: artifactContentHash(row)
        };
      })
      .filter(Boolean)
  };
}

function sourceContext(db, projectRoot, runId, refs) {
  return refs.map((raw) => {
    const ref = typeof raw === "string" ? raw : String(raw?.ref ?? raw?.id ?? "");
    if (!ref.startsWith("artifact:")) return { ref };
    const row = resolvedArtifactRow(db, runId, ref);
    return {
      ref,
      artifact: row ?? null,
      object: sourceObjectBacking(db, projectRoot, row?.content_ref)
    };
  });
}

function blueprintSource(db, task, config, visited = new Set()) {
  invariant(!visited.has(task.id), "TASK_COMPILER_TARGET_CYCLE", `Task compiler target cycle includes ${task.id}.`, {
    taskId: task.id,
    compilerTargetTaskId: task.compiler_target_task_id
  });
  visited.add(task.id);
  const requirementIds = list(task.requirement_ids_json);
  const contextRefs = list(task.context_refs_json).slice(0, Number(config.delegation?.maxContextRefs ?? 24));
  const run = getRun(db, task.run_id);
  try {
    const source = {
      task: sourceTask(task),
      requirements: sourceRequirements(db, task.run_id, requirementIds),
      dependencies: sourceDependencies(db, task.id),
      interfaces: sourceInterfaces(db, task.id),
      capabilities: sourceCapabilities(db, task.id),
      context: sourceContext(db, run.project_root, task.run_id, contextRefs),
      executionBasis: executionBasisForRefs(db, run, contextRefs),
      config: {
        maxContextRefs: Number(config.delegation?.maxContextRefs ?? 24),
        maxResolvedContextChars: Number(config.delegation?.maxResolvedContextChars ?? 8000),
        maxDependencySummaries: Number(config.delegation?.maxDependencySummaries ?? 12)
      }
    };
    if (task.role === "task-compiler" && task.compiler_target_task_id) {
      const target = taskRow(db, task.compiler_target_task_id);
      source.compilerTarget = blueprintSource(db, target, config, visited);
    }
    return source;
  } finally {
    visited.delete(task.id);
  }
}

function deepFreeze(value, visited = new WeakSet()) {
  if (!value || typeof value !== "object" || visited.has(value)) return value;
  visited.add(value);
  for (const item of Object.values(value)) deepFreeze(item, visited);
  return Object.freeze(value);
}

function taskBlueprintCore(db, task, config, executionBasis = null) {
  const run = getRun(db, task.run_id);
  const contextRefs = list(task.context_refs_json).slice(0, Number(config.delegation?.maxContextRefs ?? 24));
  const interfaces = taskInterfaceContracts(db, task.id).map((item) => ({
    Id: item.id,
    Name: item.name,
    Version: item.version,
    Status: item.status,
    Direction: item.direction,
    AllowChange: item.allowChange,
    Description: item.description,
    Schema: item.schema,
    RequirementIds: item.requirementIds,
    ContentHash: item.content_hash
  }));
  const capabilities = taskCapabilities(db, task.id).map((item) => ({
    Name: item.name,
    Reason: item.reason,
    Description: item.description,
    SkillPath: item.skillPath,
    Procedure: capabilityProcedure(item.name)
  }));
  return {
    TaskId: task.id,
    RunId: task.run_id,
    MilestoneId: task.milestone_id,
    ParentTaskId: task.parent_task_id,
    Role: task.role,
    TaskKind: task.task_kind,
    Wave: Number(task.wave),
    RunPhase: task.phase,
    Title: task.title,
    Goal: task.goal,
    ReadOnly: Boolean(task.read_only),
    Scope: list(task.scope_json),
    NonGoals: list(task.non_goals_json),
    Constraints: list(task.constraints_json),
    TargetPaths: list(task.target_paths_json),
    RequirementIds: list(task.requirement_ids_json),
    RequirementContext: requirementContext(db, task.run_id, list(task.requirement_ids_json)),
    AcceptanceCriteria: list(task.acceptance_json),
    RequiredEvidence: list(task.required_evidence_json),
    ExpectedOutputs: list(task.expected_outputs_json),
    VerificationModes: list(task.verification_modes_json),
    ContextRefs: contextRefs,
    ResolvedContext: resolveContextRefs(
      db,
      run.project_root,
      task.run_id,
      contextRefs,
      Number(config.delegation?.maxResolvedContextChars ?? 8000)
    ),
    ExecutionBasis: deepFreeze(executionBasis ?? executionBasisForRefs(db, run, contextRefs)),
    StopConditions: list(task.stop_conditions_json),
    Authority: task.authority,
    Risk: task.risk,
    Effort: task.effort,
    Complexity: task.complexity,
    Interfaces: list(task.interfaces_json),
    InterfaceContracts: interfaces,
    Capabilities: capabilities,
    UpstreamContracts: dependencySummaries(db, task.id, Number(config.delegation?.maxDependencySummaries ?? 12)),
    ResultSchema: resultSchemaForRole(task.role)
  };
}

export function taskPacketPolicy(db, taskId, config) {
  return compilerPolicy(taskRow(db, taskId), config);
}

export function taskExecutionBasis(db, taskId, config) {
  const task = taskRow(db, taskId);
  const run = getRun(db, task.run_id);
  const contextRefs = list(task.context_refs_json).slice(0, Number(config.delegation?.maxContextRefs ?? 24));
  return deepFreeze(executionBasisForRefs(db, run, contextRefs));
}

export function buildTaskBlueprint(db, taskId, config) {
  const task = taskRow(db, taskId);
  const source = blueprintSource(db, task, config);
  const sourceHash = sha256(stableStringify(source));
  let cache = BLUEPRINT_CACHE.get(db);
  if (!cache) {
    cache = new Map();
    BLUEPRINT_CACHE.set(db, cache);
  }
  const cached = cache.get(task.id);
  if (cached?.sourceHash === sourceHash) return cached.blueprint;
  const blueprint = taskBlueprintCore(db, task, config, source.executionBasis);
  if (task.role === "task-compiler" && task.compiler_target_task_id) {
    const target = taskRow(db, task.compiler_target_task_id);
    blueprint.CompilerTarget = taskBlueprintCore(db, target, config, source.compilerTarget?.executionBasis ?? null);
  }
  const result = deepFreeze({ ...blueprint, BlueprintHash: sha256(stableStringify(blueprint)) });
  cache.set(task.id, { sourceHash, blueprint: result });
  return result;
}

function validateOverlay(value) {
  const overlay = value ?? {};
  invariant(overlay && typeof overlay === "object" && !Array.isArray(overlay), "TASK_PACKET_OVERLAY", "Packet overlay must be an object.");
  for (const key of Object.keys(overlay)) {
    invariant(ALLOWED_OVERLAY_FIELDS.has(key), "TASK_PACKET_PROTECTED_FIELD", `Packet compiler cannot set protected field ${key}.`);
  }
  const normalized = {
    ClarifiedObjective: String(overlay.ClarifiedObjective ?? "").trim(),
    ExecutionSteps: asArray(overlay.ExecutionSteps),
    ContextPriorities: asArray(overlay.ContextPriorities),
    InterfaceNotes: asArray(overlay.InterfaceNotes),
    VerificationPlan: asArray(overlay.VerificationPlan),
    AdditionalStopConditions: asArray(overlay.AdditionalStopConditions),
    HandoffNotes: asArray(overlay.HandoffNotes),
    Ambiguities: asArray(overlay.Ambiguities)
  };
  return normalized;
}

function defaultExecutionSteps(blueprint) {
  const steps = [
    "Read the selected context and frozen interfaces.",
    "Perform only the declared objective inside the owned scope."
  ];
  if (blueprint.VerificationModes.length > 0) steps.push("Run the declared verification modes before completion.");
  steps.push("Return only the structured result schema.");
  return steps;
}

function defaultStopConditions(blueprint) {
  return [
    "A required frozen interface conflicts with the repository.",
    "The task needs a file or authority outside the owned scope.",
    "Required context or an upstream result is missing.",
    "A product or architecture decision is not defined."
  ].concat(blueprint.StopConditions);
}

function makePacket(blueprint, overlay, policy) {
  const packet = {
    PacketVersion: 2,
    TaskId: blueprint.TaskId,
    Role: blueprint.Role,
    TaskKind: blueprint.TaskKind,
    Wave: blueprint.Wave,
    RoleProtocol: ROLE_PROTOCOLS[blueprint.Role] ?? [],
    Objective: overlay.ClarifiedObjective || blueprint.Goal,
    Requirements: blueprint.RequirementContext,
    Rationale: blueprint.RequirementContext.length > 0
      ? blueprint.RequirementContext.map((item) => `${item.Id}: ${item.Description}`).join("\n")
      : "Complete the task contract without expanding the declared scope.",
    Scope: {
      ReadOnly: blueprint.ReadOnly,
      DeclaredScope: blueprint.Scope,
      TargetPaths: blueprint.TargetPaths
    },
    NonGoals: blueprint.NonGoals,
    Constraints: blueprint.Constraints,
    InterfaceContracts: blueprint.InterfaceContracts.map((item) => ({ ...item, Notes: overlay.InterfaceNotes })),
    UpstreamContracts: blueprint.UpstreamContracts,
    Context: {
      References: blueprint.ContextRefs,
      Selected: blueprint.ResolvedContext,
      Priorities: overlay.ContextPriorities,
      HandoffNotes: overlay.HandoffNotes
    },
    ExecutionBasis: blueprint.ExecutionBasis,
    Capabilities: blueprint.Capabilities,
    CompilerTarget: blueprint.CompilerTarget ?? null,
    ExecutionSteps: overlay.ExecutionSteps.length ? overlay.ExecutionSteps : defaultExecutionSteps(blueprint),
    AcceptanceCriteria: blueprint.AcceptanceCriteria,
    VerificationPlan: overlay.VerificationPlan.length ? overlay.VerificationPlan : blueprint.VerificationModes,
    RequiredEvidence: blueprint.RequiredEvidence,
    ExpectedOutputs: blueprint.ExpectedOutputs,
    Authority: blueprint.Authority,
    StopConditions: [...new Set(defaultStopConditions(blueprint).concat(overlay.AdditionalStopConditions))],
    ResultSchema: blueprint.ResultSchema,
    Compilation: {
      Policy: policy,
      BlueprintHash: blueprint.BlueprintHash,
      Ambiguities: overlay.Ambiguities
    }
  };
  packet.Prompt = renderTaskPacketPrompt(packet);
  packet.PacketHash = sha256(stableStringify({ ...packet, Prompt: undefined, PacketHash: undefined }));
  return packet;
}

function nextVersion(db, taskId) {
  return Number(db.prepare("SELECT MAX(version) AS version FROM task_packets WHERE task_id = ?").get(taskId)?.version ?? 0) + 1;
}

function authorizeCompilerOverlay(db, target, compilerTaskId, overlay, config, originalResult = null) {
  invariant(typeof compilerTaskId === "string" && compilerTaskId.trim(), "TASK_PACKET_COMPILER_REQUIRED",
    `Task ${target.id} requires a linked completed task compiler before an LLM packet can be compiled.`);
  const compiler = db.prepare(`
    SELECT id, run_id, role, status, compiler_target_task_id, result_json, attempts, attempt_fence
    FROM tasks WHERE id = ?
  `).get(compilerTaskId);
  invariant(compiler
    && compiler.run_id === target.run_id
    && compiler.role === "task-compiler"
    && compiler.compiler_target_task_id === target.id,
  "TASK_PACKET_COMPILER_UNTRUSTED", `Compiler ${compilerTaskId} is not authorized for task ${target.id}.`);
  const linked = db.prepare("SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on = ?")
    .get(target.id, compiler.id);
  invariant(linked, "TASK_PACKET_COMPILER_UNTRUSTED", `Compiler ${compiler.id} is not linked to task ${target.id}.`);

  invariant(compiler.status === "completed", "TASK_PACKET_COMPILER_UNTRUSTED",
    `Compiler ${compiler.id} has not completed an authorized compilation for task ${target.id}.`);
  const compilerPacket = taskPacketStatus(db, compiler.id, config);
  invariant(compilerPacket.current, "TASK_PACKET_COMPILER_UNTRUSTED",
    `Compiler ${compiler.id} no longer has the current task packet used for approval of task ${target.id}.`);
  const run = getRun(db, compiler.run_id);
  const baselineArtifact = latestArtifact(db, run.project_root, run.id, `task-baseline:${compiler.id}`, ["verified"]);
  const baseline = parseJson(baselineArtifact?.content, null);
  invariant(baseline
    && baseline.packetId === compilerPacket.packetId
    && baseline.packetHash === compilerPacket.packetHash
    && baseline.packetBlueprintHash === compilerPacket.blueprintHash
    && baseline.packetBlueprintHash === compilerPacket.compiledBlueprintHash,
  "TASK_PACKET_COMPILER_UNTRUSTED", `Compiler ${compiler.id} approval is not bound to its current task packet basis.`);
  const persistedResult = parseJson(compiler.result_json, null);
  let result = originalResult ?? persistedResult;
  // Compaction deliberately bounds PacketOverlay in active task state. When
  // authorizing after persistence, recover the authenticated full result from
  // its StructuredRef instead of comparing against a truncated overlay.
  if (!originalResult && persistedResult?.StructuredRef) {
    const structuredRef = String(persistedResult.StructuredRef);
    const structuredHash = structuredRef.replace(/^obj_/, "");
    const structuredRow = /^[0-9a-f]{64}$/iu.test(structuredHash)
      ? db.prepare("SELECT kind FROM objects WHERE hash = ?").get(structuredHash)
      : null;
    const expectedKind = `task-structured-result:${compiler.id}`;
    if (structuredRow?.kind === expectedKind) {
      try {
        const content = readObject(db, run.project_root, structuredRef);
        result = sha256(content) === structuredHash ? parseJson(content, null) : null;
      } catch {
        result = null;
      }
    } else {
      result = null;
    }
  }
  invariant(result?.Status === "COMPLETED"
    && result.TargetTaskId === target.id
    && result.PacketOverlay
    && stableStringify(validateOverlay(result.PacketOverlay)) === stableStringify(overlay),
  "TASK_PACKET_COMPILER_UNTRUSTED", `Compiler ${compiler.id} did not approve this packet overlay for task ${target.id}.`);
}

export function compileTaskPacket(db, projectRoot, taskId, config, options = {}) {
  const task = taskRow(db, taskId);
  const run = getRun(db, task.run_id);
  const policy = compilerPolicy(task, config);
  const blueprint = buildTaskBlueprint(db, task.id, config);
  const overlayProvided = options.overlay !== undefined && options.overlay !== null;
  if (policy === "llm" && !overlayProvided) {
    db.prepare("UPDATE tasks SET contract_status = 'needs-compiler', contract_policy = 'llm', updated_at = ? WHERE id = ?")
      .run(now(), task.id);
    return { taskId: task.id, status: "needs-compiler", policy, blueprint };
  }
  const overlay = validateOverlay(options.overlay ?? {});
  if (overlay.Ambiguities.length > 0) {
    db.prepare("UPDATE tasks SET contract_status = 'blocked', contract_policy = ?, updated_at = ? WHERE id = ?")
      .run(policy, now(), task.id);
    recordEvent(db, run.id, "task-packet.blocked", "warning", { taskId: task.id, ambiguities: overlay.Ambiguities });
    return { taskId: task.id, status: "blocked", policy, blueprintHash: blueprint.BlueprintHash, ambiguities: overlay.Ambiguities };
  }
  if (policy === "llm" && overlayProvided) authorizeCompilerOverlay(db, task, options.compilerTaskId, overlay, config, options.compilerResult ?? null);
  const packet = makePacket(blueprint, overlay, policy);
  const timestamp = now();
  const id = makeId("packet");
  const version = nextVersion(db, task.id);
  const packetRef = storeObject(db, projectRoot, `task-packet:${task.id}`, stableStringify(packet), { redact: true });
  db.prepare("UPDATE task_packets SET status = 'stale', updated_at = ? WHERE task_id = ? AND status = 'ready'")
    .run(timestamp, task.id);
  db.prepare(`
    INSERT INTO task_packets(
      id, task_id, version, status, policy, blueprint_hash, packet_hash,
      packet_json, packet_ref, compiler_task_id, created_at, updated_at
    ) VALUES(?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, task.id, version, policy, blueprint.BlueprintHash, packet.PacketHash,
    json(packet), packetRef, options.compilerTaskId ?? null, timestamp, timestamp
  );
  db.prepare("UPDATE tasks SET contract_status = 'ready', contract_policy = ?, compiled_packet_id = ?, updated_at = ? WHERE id = ?")
    .run(policy, id, timestamp, task.id);
  touchRun(db, run.id);
  recordEvent(db, run.id, "task-packet.compiled", "info", {
    taskId: task.id,
    packetId: id,
    version,
    policy,
    compilerTaskId: options.compilerTaskId ?? null,
    blueprintHash: blueprint.BlueprintHash,
    packetHash: packet.PacketHash
  });
  return { id, taskId: task.id, version, status: "ready", policy, blueprintHash: blueprint.BlueprintHash, packetHash: packet.PacketHash, packetRef, packet };
}

export function taskPacketStatus(db, taskId, config) {
  const task = taskRow(db, taskId);
  const blueprint = buildTaskBlueprint(db, task.id, config);
  const row = db.prepare("SELECT * FROM task_packets WHERE task_id = ? ORDER BY version DESC LIMIT 1").get(task.id);
  if (!row) return { taskId: task.id, status: task.contract_status, policy: compilerPolicy(task, config), current: false, blueprintHash: blueprint.BlueprintHash };
  const current = row.status === "ready" && row.blueprint_hash === blueprint.BlueprintHash;
  if (!current && row.status === "ready") {
    db.prepare("UPDATE task_packets SET status = 'stale', updated_at = ? WHERE id = ?").run(now(), row.id);
    db.prepare("UPDATE tasks SET contract_status = 'stale', updated_at = ? WHERE id = ?").run(now(), task.id);
  }
  return {
    taskId: task.id,
    packetId: row.id,
    version: row.version,
    status: current ? "ready" : row.status === "ready" ? "stale" : row.status,
    policy: row.policy,
    current,
    blueprintHash: blueprint.BlueprintHash,
    compiledBlueprintHash: row.blueprint_hash,
    packetHash: row.packet_hash,
    compilerTaskId: row.compiler_task_id
  };
}

export function getTaskPacket(db, taskId, config) {
  const status = taskPacketStatus(db, taskId, config);
  invariant(status.current, "TASK_PACKET_NOT_READY", `Task ${taskId} has no current ready packet.`);
  const row = db.prepare("SELECT * FROM task_packets WHERE id = ?").get(status.packetId);
  return { ...status, packetRef: row.packet_ref, packet: parseJson(row.packet_json, {}) };
}

export function listTaskPackets(db, runId, config) {
  return db.prepare("SELECT id FROM tasks WHERE run_id = ? ORDER BY phase, wave, created_at").all(runId)
    .map((row) => taskPacketStatus(db, row.id, config));
}

export function ensureTaskPacket(db, projectRoot, taskId, config) {
  const status = taskPacketStatus(db, taskId, config);
  if (status.current) return getTaskPacket(db, taskId, config);
  return compileTaskPacket(db, projectRoot, taskId, config);
}

export function markTaskPacketStale(db, taskId, reason = "task blueprint changed") {
  const task = taskRow(db, taskId);
  const timestamp = now();
  db.prepare("UPDATE task_packets SET status = 'stale', updated_at = ? WHERE task_id = ? AND status = 'ready'").run(timestamp, task.id);
  db.prepare("UPDATE tasks SET contract_status = 'stale', updated_at = ? WHERE id = ?").run(timestamp, task.id);
  recordEvent(db, task.run_id, "task-packet.stale", "warning", { taskId: task.id, reason });
}
