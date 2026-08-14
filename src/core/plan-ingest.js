import { transaction } from "./db.js";
import { invariant } from "./errors.js";
import { addInterfaceContract } from "./interfaces.js";
import { addMilestone, ensureDefaultMilestone, listMilestones } from "./milestones.js";
import { getArtifact, getRun, latestArtifact, putArtifact, recordEvent } from "./state.js";
import { addTask, getTask, listTasks } from "./tasks.js";
import { validateMutableOwnershipPaths } from "./worktrees.js";
import { PLAN_DRAFT_SCHEMA } from "./plan-draft-schema.js";
import { PHASES, ROLES, TASK_KINDS, TASK_KINDS_BY_ROLE } from "./metadata.js";
import { asArray, isSafeRepoPath, normalizeRepoPath, parseJson, sha256, stableStringify } from "./util.js";

const PLANNED_PHASES = new Set(["execute", "review", "verify", "curate"]);

function artifactContent(artifact) {
  invariant(artifact?.content, "PLAN_DRAFT_NOT_FOUND", "The planner has no persisted plan draft.");
  try {
    return JSON.parse(artifact.content);
  } catch {
    throw new Error("The persisted plan draft is not valid JSON.");
  }
}

export function plannedGraphFingerprint(db, runId) {
  const milestones = listMilestones(db, runId)
    .map((milestone) => ({
      id: milestone.id,
      parentId: milestone.parent_id,
      sequence: Number(milestone.sequence),
      dependsOn: [...milestone.dependsOn].sort()
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const tasks = listTasks(db, runId)
    .filter((task) => PLANNED_PHASES.has(task.phase))
    .map((task) => {
      const interfaces = db.prepare(`
        SELECT l.interface_id, l.direction, l.allow_change,
               i.name, i.version, i.status, i.content_hash
        FROM task_interface_links l
        JOIN interface_contracts i ON i.id = l.interface_id
        WHERE l.task_id = ?
        ORDER BY l.interface_id, l.direction
      `).all(task.id).map((item) => ({
        interfaceId: item.interface_id,
        direction: item.direction,
        allowChange: Boolean(item.allow_change),
        name: item.name,
        version: Number(item.version),
        status: item.status,
        contentHash: item.content_hash
      }));
      return {
        id: task.id,
        milestoneId: task.milestone_id,
        parentTaskId: task.parent_task_id,
        taskKind: task.task_kind,
        phase: task.phase,
        role: task.role,
        wave: Number(task.wave),
        readOnly: Boolean(task.readOnly),
        sliceType: task.sliceType,
        dependsOn: [...task.dependsOn].sort(),
        targetPaths: [...task.targetPaths].sort(),
        acceptanceCriteria: [...task.acceptanceCriteria],
        requirementIds: [...task.requirementIds].sort(),
        verificationModes: [...task.verificationModes].sort(),
        interfaces
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  // This fingerprint binds the planner declaration to the structural graph.
  // Task packets are execution artifacts and may be recompiled from current
  // evidence after integration without changing the sealed plan.
  const projection = { version: 2, milestones, tasks };
  return {
    version: projection.version,
    hash: sha256(stableStringify(projection)),
    milestoneIds: milestones.map((milestone) => milestone.id),
    taskIds: tasks.map((task) => task.id),
    milestones,
    tasks
  };
}

export function currentPlanDraftBinding(db, projectRoot, runId, options = {}) {
  const receiptRow = options.receiptArtifactId
    ? db.prepare(`
      SELECT id FROM artifacts
      WHERE id = ? AND run_id = ? AND kind LIKE 'plan-draft-ingested:%' AND status = 'verified'
    `).get(options.receiptArtifactId, runId)
    : db.prepare(`
      SELECT id FROM artifacts
      WHERE run_id = ? AND kind LIKE 'plan-draft-ingested:%' AND status = 'verified'
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(runId);
  if (!receiptRow) return null;

  const receiptArtifact = getArtifact(db, projectRoot, receiptRow.id);
  const receipt = artifactContent(receiptArtifact);
  const plannerTaskId = String(receipt.plannerTaskId ?? "").trim();
  const plannerAttempt = Number(receipt.plannerAttempt);
  const plannerAttemptFence = Number(receipt.plannerAttemptFence);
  const draftArtifactId = String(receipt.draftArtifactId ?? "").trim();
  const draftContentRef = String(receipt.draftContentRef ?? "").trim();
  const receiptGraphFingerprint = String(receipt.plannedGraphFingerprint ?? "").trim();
  invariant(plannerTaskId, "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt has no planner task reference.");
  invariant(Number.isInteger(plannerAttempt) && plannerAttempt > 0, "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt has no valid planner attempt.");
  invariant(Number.isInteger(plannerAttemptFence) && plannerAttemptFence > 0, "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt has no valid planner attempt fence.");
  invariant(draftArtifactId, "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt has no draft artifact reference.");
  invariant(draftContentRef, "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt has no draft content reference.");
  invariant(receiptGraphFingerprint, "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt has no planned graph fingerprint.");
  invariant(receiptArtifact.kind === `plan-draft-ingested:${plannerTaskId}` && receiptArtifact.task_id === plannerTaskId,
    "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt is detached from its planner task.");
  invariant(receiptArtifact.metadata?.plannerTaskId === plannerTaskId
    && Number(receiptArtifact.metadata?.plannerAttempt) === plannerAttempt
    && Number(receiptArtifact.metadata?.plannerAttemptFence) === plannerAttemptFence
    && receiptArtifact.metadata?.draftArtifactId === draftArtifactId
    && receiptArtifact.metadata?.draftContentRef === draftContentRef
    && receiptArtifact.metadata?.plannedGraphFingerprint === receiptGraphFingerprint,
    "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt metadata does not match its verified content.");
  const planner = db.prepare(`
    SELECT id, run_id, role, status, result_json, attempts, attempt_fence
    FROM tasks WHERE id = ? AND run_id = ?
  `).get(plannerTaskId, runId);
  invariant(planner, "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt references a missing or wrong-run planner task.");
  invariant(planner.role === "planner", "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt task is not a planner.");
  invariant(planner.status === "completed", "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt planner is not completed.");
  invariant(Number(planner.attempts) === plannerAttempt && Number(planner.attempt_fence) === plannerAttemptFence,
    "PLAN_DRAFT_BINDING_INVALID", "The ingested plan draft receipt references a stale planner attempt.");
  const plannerResult = parseJson(planner.result_json, null);
  invariant(plannerResult?.Status === "COMPLETED", "PLAN_DRAFT_BINDING_INVALID", "The planner's current result is not completed.");
  if (options.draftArtifactId) {
    invariant(draftArtifactId === options.draftArtifactId, "PLAN_DRAFT_BINDING_MISMATCH", "The sealed plan does not reference its ingested planner draft.");
  }
  if (options.draftContentRef) {
    invariant(draftContentRef === options.draftContentRef,
      "PLAN_DRAFT_BINDING_MISMATCH", "The sealed plan does not reference the receipt's planner draft content.");
  }
  if (options.plannedGraphFingerprint) {
    invariant(receiptGraphFingerprint === options.plannedGraphFingerprint,
      "PLAN_DRAFT_GRAPH_MISMATCH", "The sealed plan does not reference the receipt's planned graph fingerprint.");
  }
  const draftRow = db.prepare(`
    SELECT id, kind, task_id, content_ref FROM artifacts
    WHERE id = ? AND run_id = ? AND kind = ? AND task_id = ? AND status = 'verified'
  `).get(draftArtifactId, runId, `plan-draft:${plannerTaskId}`, plannerTaskId);
  invariant(draftRow, "PLAN_DRAFT_BINDING_INVALID", "The ingested planner draft is missing, stale, or belongs to another run.");
  invariant(draftRow.content_ref === draftContentRef,
    "PLAN_DRAFT_BINDING_MISMATCH", "The ingested planner draft content no longer matches its receipt.");
  const draftArtifact = getArtifact(db, projectRoot, draftRow.id);
  invariant(draftArtifact.metadata?.plannerTaskId === plannerTaskId,
    "PLAN_DRAFT_BINDING_INVALID", "The planner draft metadata is detached from its planner task.");
  const producedDraft = asArray(plannerResult.ProducedArtifactRefs).find((artifact) => artifact?.id === draftArtifactId);
  invariant(producedDraft?.kind === `plan-draft:${plannerTaskId}`
    && producedDraft?.contentRef === draftContentRef
    && producedDraft?.status === "verified",
    "PLAN_DRAFT_BINDING_INVALID", "The planner's current result does not attest the bound draft artifact.");
  const attemptArtifact = latestArtifact(db, projectRoot, runId, `task-changes:${plannerTaskId}`, ["verified"]);
  const attemptAttestation = attemptArtifact ? artifactContent(attemptArtifact) : null;
  invariant(attemptArtifact?.task_id === plannerTaskId
    && Number(attemptArtifact.metadata?.attempt) === plannerAttempt
    && attemptAttestation?.taskId === plannerTaskId
    && Number(attemptAttestation?.attempt) === plannerAttempt
    && attemptAttestation?.resultStatus === "COMPLETED",
    "PLAN_DRAFT_BINDING_INVALID", "The planner draft is not attested by the current completed attempt.");
  const currentGraph = plannedGraphFingerprint(db, runId);
  invariant(currentGraph.hash === receiptGraphFingerprint,
    "PLAN_DRAFT_GRAPH_MISMATCH", "The materialized planned graph changed after planner draft ingestion.");
  invariant(stableStringify(currentGraph.milestoneIds) === stableStringify(receipt.plannedMilestoneIds ?? []),
    "PLAN_DRAFT_GRAPH_MISMATCH", "The receipt milestone set does not match the materialized planned graph.");
  invariant(stableStringify(currentGraph.taskIds) === stableStringify(receipt.plannedTaskIds ?? []),
    "PLAN_DRAFT_GRAPH_MISMATCH", "The receipt task set does not match the materialized planned graph.");
  return {
    plannerTaskId,
    draftArtifactId: draftRow.id,
    receiptArtifactId: receiptArtifact.id,
    draftContentRef,
    plannedGraphFingerprint: currentGraph.hash,
    plannedTaskIds: currentGraph.taskIds,
    draftArtifact,
    receiptArtifact
  };
}

function validateUnique(items, kind) {
  const seen = new Set();
  for (const item of items) {
    const id = requiredCanonicalString(item, "id", `${kind} id`);
    invariant(id, "PLAN_DRAFT_ID", `Every ${kind} needs an id.`);
    invariant(!seen.has(id), "PLAN_DRAFT_DUPLICATE", `Duplicate ${kind} id ${id}.`);
    seen.add(id);
  }
  return seen;
}

function topological(items, idSet, kind) {
  const pending = new Map(items.map((item) => [item.id, item]));
  const ordered = [];
  const emitted = new Set();
  while (pending.size > 0) {
    let changed = false;
    for (const [id, item] of [...pending]) {
      const dependencies = item.dependsOn;
      for (const dependency of dependencies) {
        invariant(idSet.has(String(dependency)), "PLAN_DRAFT_DEPENDENCY", `${kind} ${id} references unknown dependency ${dependency}.`);
      }
      const parent = item.parentId ?? null;
      if (parent) invariant(idSet.has(String(parent)), "PLAN_DRAFT_PARENT", `${kind} ${id} references unknown parent ${parent}.`);
      if (dependencies.every((dependency) => emitted.has(String(dependency))) && (!parent || emitted.has(String(parent)))) {
        ordered.push(item);
        emitted.add(id);
        pending.delete(id);
        changed = true;
      }
    }
    invariant(changed, "PLAN_DRAFT_CYCLE", `${kind} graph contains a cycle or forward parent dependency.`);
  }
  return ordered;
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredCanonicalString(item, key, label, code = "PLAN_DRAFT_FIELDS") {
  const value = item[key];
  invariant(typeof value === "string", code, `${label} must be a string.`);
  const normalized = value.trim();
  invariant(normalized, code, `${label} must be a non-empty string.`);
  return normalized;
}

function requiredArray(item, key, label, { nonEmpty = false, code = "PLAN_DRAFT_FIELDS" } = {}) {
  const value = item[key];
  invariant(Array.isArray(value), code, `${label} must be an array.`);
  invariant(!nonEmpty || value.length > 0, code, `${label} must not be empty.`);
  for (const entry of value) invariant(typeof entry === "string" && entry.trim(), code, `${label} must contain non-empty strings.`);
  return value.map((entry) => entry.trim());
}

function forbiddenAliases(item, kind) {
  for (const [alias, canonical] of Object.entries(PLAN_DRAFT_SCHEMA[kind].forbiddenAliases)) {
    invariant(!Object.hasOwn(item, alias), "PLAN_DRAFT_ALIAS", `${kind} uses canonical ${canonical}; alias ${alias} is not accepted.`);
  }
}

function validateParallelism(value) {
  invariant(plainObject(value), "PLAN_DRAFT_FIELDS", "PlanDraft.parallelism must be an object.");
  invariant(typeof value.eligible === "boolean", "PLAN_DRAFT_FIELDS", "PlanDraft.parallelism.eligible must be boolean.");
  for (const field of ["independentSlices", "desiredWidth", "minimumSameWaveImplementationTasks"]) {
    invariant(Number.isInteger(value[field]) && value[field] > 0, "PLAN_DRAFT_FIELDS", `PlanDraft.parallelism.${field} must be a positive integer.`);
  }
  requiredCanonicalString(value, "rationale", "PlanDraft.parallelism.rationale");
}

function validateInterfaceDraft(item, db, run) {
  invariant(plainObject(item), "PLAN_DRAFT_INTERFACE", "Every interface draft must be an object.");
  forbiddenAliases(item, "interface");
  const name = requiredCanonicalString(item, "name", "Interface name", "PLAN_DRAFT_INTERFACE");
  const id = requiredCanonicalString(item, "id", "Interface id", "PLAN_DRAFT_INTERFACE");
  requiredCanonicalString(item, "description", "Interface description", "INTERFACE_FIELDS");
  invariant(plainObject(item.schema), "INTERFACE_SCHEMA", "Interface schema must be a plain object.");
  const requirementIds = requiredArray(item, "requirementIds", "Interface requirementIds", { code: "INTERFACE_REQUIREMENTS" });
  requirementIdsForDraft(db, run.id, requirementIds, "Interface");
  return { name, id };
}

function requirementIdsForDraft(db, runId, values, kind) {
  const ids = [...new Set(values)];
  for (const id of ids) {
    invariant(db.prepare("SELECT 1 FROM requirements WHERE run_id = ? AND id = ? AND status <> 'superseded'").get(runId, id),
      "PLAN_DRAFT_REQUIREMENT", `${kind} references unknown or superseded requirement ${id}.`);
  }
  return ids;
}

function validateMilestoneDraft(item, db, run) {
  invariant(plainObject(item), "PLAN_DRAFT_MILESTONE", "Every milestone draft must be an object.");
  forbiddenAliases(item, "milestone");
  requiredCanonicalString(item, "id", "Milestone id", "PLAN_DRAFT_ID");
  requiredCanonicalString(item, "title", "Milestone title", "MILESTONE_FIELDS");
  requiredCanonicalString(item, "objective", "Milestone objective", "MILESTONE_FIELDS");
  requiredCanonicalString(item, "userVisibleOutcome", "Milestone userVisibleOutcome", "MILESTONE_DELIVERY_CONTRACT");
  requiredArray(item, "exitCriteria", "Milestone exitCriteria", { nonEmpty: true });
  const requirementIds = requiredArray(item, "requirementIds", "Milestone requirementIds");
  requiredArray(item, "dependsOn", "Milestone dependsOn");
  requirementIdsForDraft(db, run.id, requirementIds, "Milestone");
}

function validateTaskDraft(item, db, run) {
  invariant(plainObject(item), "PLAN_DRAFT_TASK", "Every task draft must be an object.");
  forbiddenAliases(item, "task");
  requiredCanonicalString(item, "id", "Task id", "PLAN_DRAFT_ID");
  const role = requiredCanonicalString(item, "role", "Task role");
  const taskKind = requiredCanonicalString(item, "taskKind", "Task taskKind");
  const runPhase = requiredCanonicalString(item, "runPhase", "Task runPhase");
  invariant(ROLES.includes(role), "TASK_ROLE_INVALID", `Unsupported task role: ${role}.`);
  invariant(PHASES.includes(runPhase), "TASK_RUN_PHASE", `Unsupported task run phase: ${runPhase}.`);
  invariant(TASK_KINDS.includes(taskKind), "TASK_KIND_INVALID", `Unsupported task kind: ${taskKind}.`);
  const rolePhases = {
    worker: new Set(["execute"]),
    coordinator: new Set(["execute"]),
    integrator: new Set(["execute"]),
    reviewer: new Set(["review"]),
    "security-reviewer": new Set(["review"]),
    "database-reviewer": new Set(["review"]),
    "performance-reviewer": new Set(["review"]),
    "accessibility-reviewer": new Set(["review"]),
    "migration-reviewer": new Set(["review"]),
    verifier: new Set(["verify"]),
    "adversarial-reviewer": new Set(["verify"]),
    curator: new Set(["curate"])
  };
  invariant(TASK_KINDS_BY_ROLE[role]?.includes(taskKind), "TASK_KIND_INVALID", `Task role ${role} does not support task kind ${taskKind}.`);
  for (const field of ["title", "goal"]) requiredCanonicalString(item, field, `Task ${field}`);
  invariant(!rolePhases[role] || rolePhases[role].has(runPhase), "PLAN_DRAFT_TASK_PHASE", `Task role ${role} must use its canonical runPhase; ${runPhase} is not allowed.`);
  invariant(Number.isInteger(item.wave) && item.wave > 0, "TASK_WAVE", "Task wave must be a positive integer.");
  invariant(typeof item.readOnly === "boolean", "PLAN_DRAFT_FIELDS", "Task readOnly must be boolean.");
  for (const field of ["targetPaths", "scope", "acceptanceCriteria", "requiredEvidence", "expectedOutputs", "requirementIds", "dependsOn", "interfaceInputs", "interfaceOutputs"]) {
    requiredArray(item, field, `Task ${field}`);
  }
  requirementIdsForDraft(db, run.id, item.requirementIds, "Task");
}

function validateDraftBeforeMaterializing(db, run, interfaces, milestones, tasks) {
  const interfaceSelectors = new Set();
  for (const item of interfaces) {
    const { name, id } = validateInterfaceDraft(item, db, run);
    invariant(!interfaceSelectors.has(name) && !interfaceSelectors.has(id), "PLAN_DRAFT_DUPLICATE", `Duplicate interface selector ${name || id}.`);
    interfaceSelectors.add(name);
    interfaceSelectors.add(id);
  }

  for (const item of milestones) validateMilestoneDraft(item, db, run);
  const milestoneIds = validateUnique(milestones, "milestone");
  const orderedMilestones = topological(milestones, milestoneIds, "milestone");

  for (const item of tasks) validateTaskDraft(item, db, run);
  const taskIds = validateUnique(tasks, "task");
  const orderedTasks = topological(tasks, taskIds, "task");
  const milestoneSet = new Set(milestoneIds);
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  const existingMilestones = new Set(db.prepare("SELECT id FROM milestones WHERE run_id = ?").all(run.id).map((row) => row.id));
  const existingTasks = new Set(db.prepare("SELECT id FROM tasks WHERE run_id = ?").all(run.id).map((row) => row.id));
  for (const item of interfaces) {
    const id = item.id;
    invariant(!db.prepare("SELECT 1 FROM interface_contracts WHERE run_id = ? AND id = ?").get(run.id, id),
      "PLAN_DRAFT_DUPLICATE", `Interface ${id} already exists in this run.`);
  }
  for (const id of milestoneIds) invariant(!existingMilestones.has(id), "PLAN_DRAFT_DUPLICATE", `Milestone ${id} already exists in this run.`);
  for (const id of taskIds) invariant(!existingTasks.has(id), "PLAN_DRAFT_DUPLICATE", `Task ${id} already exists in this run.`);

  for (const item of orderedTasks) {
    const id = item.id;
    const milestoneId = item.milestoneId ?? null;
    if (milestoneId) invariant(milestoneSet.has(String(milestoneId)) || existingMilestones.has(String(milestoneId)),
      "TASK_MILESTONE", `Task ${id} references an unknown milestone ${milestoneId}.`);
    const parentId = item.parentTaskId ?? null;
    if (parentId) {
      const parent = taskById.get(String(parentId));
      invariant(parent, "TASK_PARENT_RUN", `Task ${id} references an unknown parent ${parentId}.`);
      invariant(String(parent.role ?? "").toLowerCase() === "coordinator", "TASK_PARENT_ROLE", `Only a coordinator can own child task ${id}.`);
    }
    const readOnly = item.readOnly;
    const targetPaths = item.targetPaths.map((value) => normalizeRepoPath(value));
    if (!readOnly) {
      invariant(targetPaths.length > 0, "TASK_PATHS_REQUIRED", `Mutable task ${id} needs targetPaths.`);
      for (const target of targetPaths) invariant(isSafeRepoPath(target), "TASK_PATH_INVALID", `Unsafe repository path: ${target}.`);
      validateMutableOwnershipPaths(run.project_root, targetPaths);
    }
    const taskRequirements = requirementIdsForDraft(db, run.id, item.requirementIds, "Task");
    const phase = item.runPhase.toLowerCase();
    if (["execute", "review", "verify", "curate"].includes(phase) && taskRequirements.length === 0) {
      const activeRequirements = db.prepare("SELECT id FROM requirements WHERE run_id = ? AND status <> 'superseded'").all(run.id);
      invariant(activeRequirements.length === 1, "TASK_REQUIREMENTS_REQUIRED", `Task ${id} must link to at least one requirement.`);
    }
    for (const selector of [...item.interfaceInputs, ...item.interfaceOutputs]) {
      invariant(interfaceSelectors.has(String(selector)) || db.prepare("SELECT 1 FROM interface_contracts WHERE run_id = ? AND (id = ? OR name = ?) AND status = 'frozen'").get(run.id, String(selector), String(selector)),
        "INTERFACE_NOT_FOUND", `Task ${id} references unknown interface ${selector}.`);
    }
  }
  return { milestoneIds, taskIds, orderedMilestones, orderedTasks };
}

export function ingestPlanDraft(db, projectRoot, runId, plannerTaskId, config) {
  const run = getRun(db, runId);
  invariant(run.phase === "plan", "PLAN_INGEST_PHASE", "Plan drafts can be ingested only during plan.");
  const planner = getTask(db, plannerTaskId);
  invariant(planner.run_id === run.id && planner.role === "planner", "PLAN_INGEST_PLANNER", `${plannerTaskId} is not a planner task in this run.`);
  invariant(planner.status === "completed", "PLAN_INGEST_STATUS", "The planner task must complete before ingestion.");
  invariant(!latestArtifact(db, projectRoot, run.id, `plan-draft-ingested:${planner.id}`, ["verified"]), "PLAN_DRAFT_ALREADY_INGESTED", "This plan draft was already ingested.");
  const draftArtifact = latestArtifact(db, projectRoot, run.id, `plan-draft:${planner.id}`, ["verified"]);
  const draft = artifactContent(draftArtifact);
  invariant(draft && typeof draft === "object" && !Array.isArray(draft), "PLAN_DRAFT_SHAPE", "A plan draft must be an object.");
  for (const field of PLAN_DRAFT_SCHEMA.topLevel.requiredArrays) invariant(Array.isArray(draft[field]), "PLAN_DRAFT_FIELDS", `PlanDraft.${field} must be an array.`);
  for (const field of PLAN_DRAFT_SCHEMA.topLevel.requiredObjects) invariant(plainObject(draft[field]), "PLAN_DRAFT_FIELDS", `PlanDraft.${field} must be an object.`);
  validateParallelism(draft.parallelism);
  const interfaces = draft.interfaces;
  const milestones = draft.milestones;
  const tasks = draft.tasks;
  invariant(tasks.length > 0, "PLAN_DRAFT_TASKS", "A plan draft needs at least one task.");
  const validated = validateDraftBeforeMaterializing(db, run, interfaces, milestones, tasks);

  return transaction(db, () => {
    const interfaceMap = new Map();
    for (const item of interfaces) {
      const name = item.name;
      const key = item.id;
      const created = addInterfaceContract(db, run.id, { ...item, name, status: "frozen" });
      interfaceMap.set(key, created.id);
      interfaceMap.set(name, created.id);
    }

    for (const item of validated.orderedMilestones) addMilestone(db, run.id, item);
    const defaultMilestoneId = ensureDefaultMilestone(db, run.id);

    const createdTasks = [];
    for (const item of validated.orderedTasks) {
      const inputs = item.interfaceInputs.map((selector) => interfaceMap.get(selector) ?? selector);
      const outputs = item.interfaceOutputs.map((selector) => interfaceMap.get(selector) ?? selector);
      const created = addTask(db, run.id, {
        ...item,
        id: item.id,
        milestoneId: item.milestoneId ?? defaultMilestoneId,
        dependsOn: item.dependsOn,
        interfaceInputs: inputs,
        interfaceOutputs: outputs
      }, config);
      createdTasks.push(created);
    }

    const graphFingerprint = plannedGraphFingerprint(db, run.id);
    const receipt = {
      version: 1,
      plannerTaskId: planner.id,
      plannerAttempt: Number(planner.attempts),
      plannerAttemptFence: Number(planner.attempt_fence),
      draftArtifactId: draftArtifact.id,
      draftContentRef: draftArtifact.content_ref,
      plannedGraphFingerprint: graphFingerprint.hash,
      plannedMilestoneIds: graphFingerprint.milestoneIds,
      plannedTaskIds: graphFingerprint.taskIds,
      interfaces: [...interfaceMap.entries()].filter(([key, value]) => key === value || !interfaceMap.has(value)).map(([key, value]) => ({ key, id: value })),
      milestoneIds: milestones.map((item) => item.id),
      taskIds: createdTasks.map((item) => item.id),
      compilerTaskIds: createdTasks.flatMap((item) => db.prepare("SELECT id FROM tasks WHERE compiler_target_task_id = ?").all(item.id).map((row) => row.id))
    };
    const artifact = putArtifact(db, projectRoot, run.id, `plan-draft-ingested:${planner.id}`, receipt, {
      taskId: planner.id,
      status: "verified",
      metadata: {
        plannerTaskId: planner.id,
        plannerAttempt: Number(planner.attempts),
        plannerAttemptFence: Number(planner.attempt_fence),
        draftArtifactId: draftArtifact.id,
        draftContentRef: draftArtifact.content_ref,
        plannedGraphFingerprint: graphFingerprint.hash
      }
    });
    recordEvent(db, run.id, "plan-draft.ingested", "info", { plannerTaskId: planner.id, taskCount: createdTasks.length });
    return { ...receipt, artifactId: artifact.id };

  });
}
