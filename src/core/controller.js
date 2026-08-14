import {
  advancePhase,
  fastPathEligibility,
  gateReport,
  getRun,
  lifecycleRoute,
  lifecycleReviewRequired,
  latestArtifact,
  materializeFastPathPrerequisites,
  recordEvent
} from "./state.js";
import { addTask, getRunnableTasks, getTask, listTasks } from "./tasks.js";
import { proposeSchedule } from "./scheduler.js";
import { progressStatus, sampleProgress } from "./progress.js";
import { budgetStatus } from "./budget.js";
import { reviewReport } from "./reviews.js";
import { isSafeRepoPath, parseJson, stableStringify } from "./util.js";
import { checkpointStatus } from "./checkpoints.js";
import { browserStatus } from "./browser.js";
import { repositoryCodeFingerprint } from "./repository.js";
import {
  predesignCanonicalLaneSpecs,
  predesignCanonicalSynthesisSpecs,
  predesignLaneSpecs,
  predesignSynthesisSpecs
} from "./lifecycle-lanes.js";
import { transaction } from "./db.js";
import { assertController } from "./ownership.js";
import { MetisError, invariant } from "./errors.js";

// Drive is deliberately a small deterministic reducer.  It may perform only
// state transitions whose complete contract is already present in the action;
// all work that needs a child, a human, or semantic judgement remains a
// terminal controller action for Main.
export const MAX_DRIVE_ITERATIONS = 32;
const DRIVE_STOP_TYPES = new Set([
  "SPAWN_BATCH",
  "WAIT_FOR_AGENTS",
  "USER_OR_AUTHORITY_REQUIRED",
  "BUDGET_DECISION_REQUIRED",
  "COMPLETE"
]);

function artifactExists(db, runId, kind, statuses = ["verified", "waived"]) {
  const placeholders = statuses.map(() => "?").join(",");
  return Boolean(db.prepare(`
    SELECT 1 FROM artifacts WHERE run_id = ? AND kind = ? AND status IN (${placeholders})
    ORDER BY updated_at DESC LIMIT 1
  `).get(runId, kind, ...statuses));
}

function phaseTasks(tasks, phase) {
  return tasks.filter((task) => task.phase === phase);
}

function taskState(tasks, phase) {
  const items = phaseTasks(tasks, phase);
  return {
    total: items.length,
    pending: items.filter((item) => item.status === "pending"),
    running: items.filter((item) => item.status === "running"),
    blocked: items.filter((item) => ["blocked", "failed"].includes(item.status)),
    terminal: items.filter((item) => ["completed", "waived"].includes(item.status))
  };
}

function roleTasks(tasks, phase, role) {
  return tasks.filter((task) => task.phase === phase && task.role === role);
}

function allTerminal(items) {
  return items.length > 0 && items.every((item) => ["completed", "waived"].includes(item.status));
}

function activeRequirementIds(db, runId) {
  return db.prepare("SELECT id FROM requirements WHERE run_id = ? AND status <> 'superseded' ORDER BY priority, id")
    .all(runId).map((row) => row.id);
}

function nextWave(items, fallback = 1) {
  return items.length ? Math.max(...items.map((item) => Number(item.wave ?? 1))) + 1 : fallback;
}

function controllerWaveBasis(db, run) {
  const currentArtifactId = (kind) => db.prepare(`
    SELECT id FROM artifacts
    WHERE run_id = ? AND kind = ? AND status IN ('verified', 'waived')
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(run.id, kind)?.id ?? null;
  return Object.freeze({
    runId: run.id,
    phase: run.phase,
    contractVersion: Number(run.contract_version ?? 0),
    discoveryArtifactId: currentArtifactId("discovery"),
    researchArtifactId: currentArtifactId("research")
  });
}

function addTasksAction(common, type, taskSpecs, instruction) {
  const materializable = MATERIALIZABLE_WAVE_TYPES.has(type);
  const semanticParts = type === "CREATE_DISCOVERY_WAVE"
    ? ["architecture", "tests", "boundaries"]
    : type === "CREATE_RESEARCH_WAVE" ? ["official", "patterns"] : [];
  const stableTaskSpecs = materializable && semanticParts.length > 0
    ? taskSpecs.map((spec, index) => ({
        ...spec,
        id: spec.id ?? `${type === "CREATE_DISCOVERY_WAVE" ? "discovery" : "research"}-${common.basis?.runId ?? "run"}-${type === "CREATE_DISCOVERY_WAVE" ? "scout" : "researcher"}-${semanticParts[index]}`
      }))
    : taskSpecs;
  return {
    ...common,
    type,
    taskSpecs: stableTaskSpecs,
    ...(materializable ? {
      operation: "materializeControllerTaskWave",
      command: "metis controller materialize --data '<controller-action-json>' --pretty"
    } : { command: "metis task add --data '<task-json>' --pretty" }),
    instruction
  };
}

const MATERIALIZABLE_WAVE_TYPES = new Set([
  "CREATE_PREDESIGN_WAVE", "CREATE_PREDESIGN_SYNTHESIS_WAVE",
  "CREATE_DISCOVERY_WAVE", "CREATE_DISCOVERY_SYNTHESIS",
  "CREATE_RESEARCH_WAVE", "CREATE_RESEARCH_SYNTHESIS",
  "CREATE_DESIGN_TASK", "CREATE_UI_CONTRACT_TASK", "CREATE_DESIGN_CRITIC",
  "CREATE_PLANNER_TASK", "CREATE_PLAN_CRITIC", "CREATE_DIAGNOSIS_TASK"
]);

function controllerTaskId(runId, type, suffix) {
  const prefix = {
    CREATE_DISCOVERY_SYNTHESIS: "discovery",
    CREATE_RESEARCH_SYNTHESIS: "research",
    CREATE_DESIGN_TASK: "design",
    CREATE_UI_CONTRACT_TASK: "design-ui",
    CREATE_DESIGN_CRITIC: "design",
    CREATE_PLANNER_TASK: "plan",
    CREATE_PLAN_CRITIC: "plan",
    CREATE_DIAGNOSIS_TASK: "diagnosis"
  }[type] ?? type.toLowerCase().replaceAll("_", "-");
  return `${prefix}-${runId}-${suffix}`;
}
const WAVE_ARRAY_FIELDS = [
  "scope", "nonGoals", "constraints", "targetPaths", "interfaces", "interfaceInputs", "interfaceOutputs",
  "contextRefs", "stopConditions", "expectedOutputs", "acceptanceCriteria", "requiredEvidence", "requirementIds"
];

function inputField(input, camel, pascal, fallback) {
  return input[camel] ?? input[pascal] ?? fallback;
}

function arrayField(input, camel, pascal) {
  const value = inputField(input, camel, pascal, []);
  return Array.isArray(value) ? value : [value];
}

function canonicalWaveSpec(spec, config) {
  const role = String(inputField(spec, "role", "Role", "worker")).toLowerCase();
  const taskKind = String(inputField(spec, "taskKind", "TaskKind", role)).toLowerCase();
  const readOnly = Boolean(inputField(spec, "readOnly", "ReadOnly", !["worker", "integrator", "curator"].includes(role)));
  const result = {
    id: String(inputField(spec, "id", "Id", "")),
    title: String(inputField(spec, "title", "Title", inputField(spec, "goal", "Goal", ""))).trim(),
    goal: String(inputField(spec, "goal", "Goal", inputField(spec, "title", "Title", ""))).trim(),
    role,
    taskKind,
    runPhase: String(inputField(spec, "runPhase", "RunPhase", inputField(spec, "phase", "Phase", ""))).toLowerCase(),
    wave: Number(inputField(spec, "wave", "Wave", 1)),
    readOnly,
    priority: Number(inputField(spec, "priority", "Priority", 50)),
    complexity: String(inputField(spec, "complexity", "Complexity", "medium")).toLowerCase(),
    risk: String(inputField(spec, "risk", "Risk", "medium")).toLowerCase(),
    effort: String(inputField(spec, "effort", "Effort", "medium")).toLowerCase(),
    sliceType: String(inputField(spec, "sliceType", "SliceType", taskKind === "implementation" ? "vertical" : taskKind)).toLowerCase(),
    verificationModes: [...new Set(arrayField(spec, "verificationModes", "VerificationModes").map((item) => String(item).toLowerCase()))],
    authorityBoundary: String(inputField(spec, "authorityBoundary", "AuthorityBoundary", inputField(spec, "authority", "Authority", readOnly ? "local-read" : "local-write-assigned-paths"))),
    autoGenerated: Boolean(inputField(spec, "autoGenerated", "AutoGenerated", false)),
    progressWeight: Number(inputField(spec, "progressWeight", "ProgressWeight", 1)),
    maxAttempts: Number(inputField(spec, "maxAttempts", "MaxAttempts", Number(config.orchestration.maxRetries) + 1)),
    parentTaskId: inputField(spec, "parentTaskId", "ParentTaskId", null),
    milestoneId: inputField(spec, "milestoneId", "MilestoneId", null),
    specialist: inputField(spec, "specialist", "Specialist", null),
    reviewKind: inputField(spec, "reviewKind", "ReviewKind", null)
  };
  for (const field of WAVE_ARRAY_FIELDS) {
    const pascal = field[0].toUpperCase() + field.slice(1);
    result[field] = arrayField(spec, field, pascal);
  }
  result.acceptanceCriteria = arrayField(spec, "acceptanceCriteria", "AcceptanceCriteria");
  result.dependsOn = arrayField(spec, "dependsOn", "DependsOn").map(String).sort();
  return result;
}

function canonicalExistingTask(task) {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    role: task.role,
    taskKind: task.taskKind,
    runPhase: task.phase,
    wave: Number(task.wave),
    readOnly: Boolean(task.readOnly),
    priority: Number(task.priority),
    complexity: task.complexity,
    risk: task.risk,
    effort: task.effort,
    sliceType: task.sliceType,
    verificationModes: task.verificationModes,
    authorityBoundary: task.authority,
    autoGenerated: Boolean(task.autoGenerated),
    progressWeight: Number(task.progress_weight),
    maxAttempts: Number(task.max_attempts),
    parentTaskId: task.parent_task_id,
    milestoneId: task.milestone_id,
    specialist: task.specialist,
    reviewKind: task.review_kind,
    scope: task.scope,
    nonGoals: task.nonGoals,
    constraints: task.constraints,
    targetPaths: task.targetPaths,
    interfaces: task.interfaces,
    interfaceInputs: task.interfaceInputs,
    interfaceOutputs: task.interfaceOutputs,
    contextRefs: task.contextRefs,
    stopConditions: task.stopConditions,
    expectedOutputs: task.expectedOutputs,
    acceptanceCriteria: task.acceptanceCriteria,
    requiredEvidence: task.requiredEvidence,
    requirementIds: task.requirementIds,
    dependsOn: task.dependsOn.map(String).sort()
  };
}

function expectedControllerWaveSpecs(db, run, type, basis) {
  const requirementIds = activeRequirementIds(db, run.id);
  if (type === "CREATE_PREDESIGN_WAVE") {
    return predesignCanonicalLaneSpecs({
      runId: run.id,
      requirementIds,
      discoveryCurrent: Boolean(basis.discoveryArtifactId)
    });
  }
  if (type === "CREATE_PREDESIGN_SYNTHESIS_WAVE") return predesignCanonicalSynthesisSpecs({
    runId: run.id,
    requirementIds,
    discoveryCurrent: Boolean(basis.discoveryArtifactId),
    researchCurrent: Boolean(basis.researchArtifactId)
  });
  if (type === "CREATE_DISCOVERY_WAVE") {
    return [
      ["architecture", "Map repository architecture and entry points", "Identify the smallest relevant architecture, entry points, conventions, and shared interfaces for the goal.", ["Architecture, entry points, and conventions relevant to the frozen goal."], ["Do not summarize the entire repository."], ["Relevant paths and interfaces are cited with current source evidence."], ["facts", "relevant-paths", "interfaces", "unknowns"]],
      ["tests", "Map tests and verification surface", "Locate existing tests, checks, fixtures, and behavioral verification paths for the goal.", ["Tests, checks, fixtures, and current verification conventions."], [], ["Each proposed verification route names current evidence and gaps."], ["facts", "relevant-paths", "unknowns"]],
      ["boundaries", "Map dependency and change boundaries", "Identify dependency edges, ownership boundaries, likely parallel slices, and interface risks.", ["Dependencies and change boundaries relevant to the goal."], [], ["Parallelizable and shared boundaries are explicit."], ["facts", "interfaces", "risks", "unknowns"]]
    ].map(([id, title, goal, scope, nonGoals, acceptanceCriteria, expectedOutputs]) => ({
      id: `discovery-${run.id}-scout-${id}`, title, goal, role: "scout", taskKind: "discovery", runPhase: "discover", wave: 1, readOnly: true,
      scope, nonGoals, requirementIds, acceptanceCriteria, expectedOutputs
    }));
  }
  if (type === "CREATE_RESEARCH_WAVE") {
    return [
      ["official", "Research current official implementation guidance", "Answer only the current technical questions that affect the selected design.", ["Official documentation and primary sources for relevant dependencies and APIs."], ["Facts, inference, recommendations, and uncertainty are separated.", "Version applicability is explicit."], ["sources", "findings", "constraints", "recommendations", "unknowns"]],
      ["patterns", "Research established product and workflow patterns", "Find proven patterns relevant to planning, decomposition, review, or user-facing behavior without importing an entire framework.", ["Established products and maintained primary project documentation."], ["Only applicable patterns and tradeoffs are returned."], ["sources", "findings", "recommendations", "unknowns"]]
    ].map(([id, title, goal, scope, acceptanceCriteria, expectedOutputs]) => ({
      id: `research-${run.id}-researcher-${id}`, title, goal, role: "researcher", taskKind: "research", runPhase: "research", wave: 1, readOnly: true,
      requirementIds, scope, acceptanceCriteria, expectedOutputs
    }));
  }
  const tasks = listTasks(db, run.id);
  if (type === "CREATE_DISCOVERY_SYNTHESIS") {
    const scouts = roleTasks(tasks, "discover", "scout");
    invariant(scouts.length > 0, "CONTROLLER_WAVE_STATE", "Discovery synthesis requires a scout lane.");
    return [{
      id: controllerTaskId(run.id, type, "synthesis"), title: "Synthesize repository discovery",
      goal: "Merge the completed scout evidence into the canonical discovery artifact.",
      role: "synthesizer", taskKind: "synthesis", runPhase: "discover", wave: nextWave(scouts), readOnly: true,
      dependsOn: scouts.map((item) => item.id), requirementIds,
      contextRefs: scouts.map((item) => `task-result:${item.id}`),
      acceptanceCriteria: [
        "Contradictions and unknowns remain explicit.",
        "The artifact contains only evidence supplied by child tasks.",
        "ArtifactKind is discovery.",
        "ArtifactContent.scope is a non-empty string array.",
        "ArtifactContent.knownFacts is an array.",
        "ArtifactContent.unknowns is an array.",
        "ProducedArtifacts is empty; emit the canonical discovery only through ArtifactKind and ArtifactContent."
      ],
      constraints: [
        "ArtifactContent must use lowercase scope, knownFacts, and unknowns fields.",
        "Do not emit a duplicate discovery in ProducedArtifacts."
      ],
      expectedOutputs: ["artifact:discovery"], authorityBoundary: "local-read"
    }];
  }
  if (type === "CREATE_RESEARCH_SYNTHESIS") {
    const researchers = roleTasks(tasks, "research", "researcher");
    invariant(researchers.length > 0, "CONTROLLER_WAVE_STATE", "Research synthesis requires a researcher lane.");
    return [{
      id: controllerTaskId(run.id, type, "synthesis"), title: "Synthesize external research",
      goal: "Merge completed research evidence into the canonical research artifact.",
      role: "synthesizer", taskKind: "synthesis", runPhase: "research", wave: nextWave(researchers), readOnly: true,
      dependsOn: researchers.map((item) => item.id), requirementIds,
      contextRefs: researchers.map((item) => `task-result:${item.id}`),
      acceptanceCriteria: ["Sources remain traceable.", "Contradictions and uncertainty remain explicit."],
      expectedOutputs: ["artifact:research"], authorityBoundary: "local-read"
    }];
  }
  if (type === "CREATE_DESIGN_TASK") {
    const outputs = ["artifact:design"];
    if (requiresUiDelivery(db, run.id)) outputs.push("artifact:experience-contract", "artifact:visual-contract", "artifact:browser-acceptance");
    return [{
      id: controllerTaskId(run.id, type, "designer"), title: "Design the smallest complete solution",
      goal: "Use discovery and research evidence to select the architecture and freeze shared interfaces before parallel work.",
      role: "designer", taskKind: "design", runPhase: "design", wave: 1, readOnly: true,
      requirementIds, contextRefs: ["artifact:discovery", "artifact:research", "artifact:goal-contract"],
      acceptanceCriteria: ["Every must requirement is covered.", "Shared interfaces are explicit and versionable.", "Error handling and verification are defined."],
      expectedOutputs: outputs, authorityBoundary: "local-read"
    }];
  }
  if (type === "CREATE_UI_CONTRACT_TASK") {
    const missing = ["experience-contract", "visual-contract", "browser-acceptance"].filter((kind) => !artifactExists(db, run.id, kind, ["verified"]));
    return [{
      id: controllerTaskId(run.id, type, missing.join("-")), title: "Complete UI experience and visual contracts",
      goal: `Produce the missing UI delivery artifacts: ${missing.join(", ")}.`,
      role: "designer", taskKind: "design", runPhase: "design", wave: nextWave(phaseTasks(tasks, "design")), readOnly: true,
      requirementIds, contextRefs: ["artifact:design", "artifact:discovery", "artifact:research"],
      acceptanceCriteria: ["Journeys, interaction states, existing design-system references, responsive rules, and browser scenarios are executable."],
      expectedOutputs: missing.map((kind) => `artifact:${kind}`), authorityBoundary: "local-read"
    }];
  }
  if (type === "CREATE_DESIGN_CRITIC") {
    return [{
      id: controllerTaskId(run.id, type, "critic"), title: "Critique the sealed design",
      goal: "Attack the current design seal for missing requirements, ambiguous interfaces, failure paths, and unnecessary complexity.",
      role: "design-critic", taskKind: "review", runPhase: "design", wave: nextWave(phaseTasks(tasks, "design")), readOnly: true,
      requirementIds, contextRefs: ["artifact:design-seal"],
      acceptanceCriteria: ["Return an explicit verdict and evidence-backed findings."], expectedOutputs: ["design-review-result"]
    }];
  }
  if (type === "CREATE_PLANNER_TASK") {
    return [{
      id: controllerTaskId(run.id, type, "planner"), title: "Build the milestone and subagent task DAG",
      goal: "Convert the approved design into observable milestones, frozen interfaces, dependency waves, non-overlapping ownership, and independently verifiable task blueprints.",
      role: "planner", taskKind: "planning", runPhase: "plan", wave: 1, readOnly: true,
      requirementIds, contextRefs: ["artifact:goal-contract", "artifact:discovery", "artifact:research", "artifact:design", "artifact:design-review"],
      acceptanceCriteria: ["Each task has one outcome and a clear boundary.", "Parallel tasks do not overlap mutable paths.", "PlanDraft uses canonical lower-camel-case interfaces, milestones, and tasks fields with explicit arrays, waves, dependencies, and contracts; aliases name/description/wave, kind/outcome, and consumesInterfaceIds are forbidden.", "Shared interfaces are frozen before their consumers.", "Review and verification tasks are included."],
      expectedOutputs: ["plan-draft"], authorityBoundary: "local-read"
    }];
  }
  if (type === "CREATE_PLAN_CRITIC") {
    return [{
      id: controllerTaskId(run.id, type, "critic"), title: "Critique the sealed subagent plan",
      goal: "Attack the exact sealed plan, task boundaries, waves, interfaces, verification, and compiled packet readiness.",
      role: "plan-critic", taskKind: "review", runPhase: "plan", wave: nextWave(phaseTasks(tasks, "plan")), readOnly: true,
      requirementIds, contextRefs: ["artifact:plan"],
      acceptanceCriteria: ["Every task is self-contained and safely schedulable.", "Return an explicit verdict and findings."], expectedOutputs: ["plan-review-result"]
    }];
  }
  if (type === "CREATE_DIAGNOSIS_TASK") {
    const blocked = taskState(tasks, run.phase).blocked.find((item) => !tasks.some((task) => task.role === "diagnostician" && taskReferences(task, item.id)));
    invariant(blocked, "CONTROLLER_WAVE_STATE", "Diagnosis requires an undiagnosed blocked task.");
    return [{
      id: controllerTaskId(run.id, type, blocked.id), title: `Diagnose ${blocked.id}`,
      goal: `Find the earliest invalid state that caused task ${blocked.id} to ${blocked.status}.`,
      role: "diagnostician", taskKind: "diagnosis", runPhase: run.phase, wave: Number(blocked.wave), readOnly: true,
      risk: blocked.risk ?? "medium", effort: "small", sliceType: "diagnosis", requirementIds: blocked.requirementIds ?? [],
      contextRefs: [`task:${blocked.id}`, `task-result:${blocked.id}`],
      acceptanceCriteria: ["Classify the failure.", "Identify the earliest invalid assumption or artifact.", "Recommend one next action with evidence."],
      expectedOutputs: ["diagnosis"], authorityBoundary: "local-read"
    }];
  }
  return [];
}

function assertExactControllerWave(db, run, action, specs, config, basis) {
  const expected = expectedControllerWaveSpecs(db, run, action.type, basis);
  invariant(specs.length === expected.length, "CONTROLLER_WAVE_CARDINALITY", `Controller ${action.type} must contain the complete canonical wave (${expected.length} tasks).`);
  const expectedById = new Map(expected.map((spec) => [spec.id, canonicalWaveSpec(spec, config)]));
  for (const spec of specs) {
    const canonical = expectedById.get(spec.id);
    invariant(canonical, "CONTROLLER_WAVE_ID", `Controller task ID ${spec.id} is not canonical for run ${run.id}.`);
    invariant(
      stableStringify(spec) === stableStringify(canonical),
      "CONTROLLER_WAVE_CONTRACT",
      `Controller task ${spec.id} does not match the canonical contract for the current run and basis.`
    );
  }
}

function validateStablePredesignTasks(db, run, tasks, config) {
  const requirementIds = activeRequirementIds(db, run.id);
  const canonical = [
    ...predesignCanonicalLaneSpecs({ runId: run.id, requirementIds, discoveryCurrent: false }),
    ...predesignCanonicalSynthesisSpecs({
      runId: run.id,
      requirementIds,
      discoveryCurrent: false,
      researchCurrent: false
    })
  ];
  const expectedById = new Map(canonical.map((spec) => [spec.id, canonicalWaveSpec(spec, config)]));
  for (const task of tasks.filter((item) => item.id.startsWith("predesign-"))) {
    const expected = expectedById.get(task.id);
    invariant(expected, "CONTROLLER_WAVE_ID", `Stable predesign task ID ${task.id} is not canonical for run ${run.id}.`);
    invariant(
      stableStringify(canonicalExistingTask(task)) === stableStringify(expected),
      "CONTROLLER_WAVE_CONTRACT",
      `Stable predesign task ${task.id} does not match its canonical contract; refusing dispatch.`
    );
  }
}

/**
 * Materialize a controller-produced predesign wave as one fenced transaction.
 * Existing IDs are accepted only when their canonical task contract is exact.
 */
export function materializeControllerTaskWave(db, projectRoot, runId, action, credentials, config) {
  invariant(MATERIALIZABLE_WAVE_TYPES.has(action?.type), "CONTROLLER_WAVE_TYPE", "Only controller-produced deterministic task waves can be materialized.");
  invariant(Array.isArray(action.taskSpecs) && action.taskSpecs.length > 0, "CONTROLLER_WAVE_SPECS", "A materializable controller wave needs task specs.");
  const specs = action.taskSpecs.map((spec) => canonicalWaveSpec(spec, config));
  const ids = new Set();
  for (const spec of specs) {
    invariant(spec.id, "CONTROLLER_WAVE_ID", "Every materialized controller task needs a stable ID.");
    invariant(!ids.has(spec.id), "CONTROLLER_WAVE_DUPLICATE", `Controller wave contains duplicate task ID ${spec.id}.`);
    ids.add(spec.id);
  }

  assertController(db, runId, credentials);
  return transaction(db, () => {
    assertController(db, runId, credentials);
    const run = getRun(db, runId);
    invariant(specs.every((spec) => spec.runPhase === run.phase), "CONTROLLER_WAVE_PHASE", "Controller waves can only be materialized during their declared lifecycle phase.");
    invariant(action.basis?.runId === runId, "CONTROLLER_WAVE_RUN", "The controller wave belongs to another run.");
    const currentBasis = controllerWaveBasis(db, run);
    invariant(
      stableStringify(action.basis) === stableStringify(currentBasis),
      "CONTROLLER_WAVE_BASIS_STALE",
      "The controller wave basis is stale; rediscover the current lifecycle state before materializing."
    );
    assertExactControllerWave(db, run, action, specs, config, currentBasis);

    const existing = new Map();
    for (const spec of specs) {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(spec.id);
      if (row && row.run_id !== runId) {
        invariant(false, "CONTROLLER_WAVE_ID_COLLISION", `Task ID ${spec.id} belongs to another run.`);
      }
      if (row) existing.set(spec.id, canonicalExistingTask(getTask(db, spec.id)));
    }

    // Validate the complete replay before creating any missing record.
    for (const spec of specs) {
      const current = existing.get(spec.id);
      if (current) {
        invariant(stableStringify(current) === stableStringify(spec), "CONTROLLER_WAVE_SPEC_MISMATCH", `Existing task ${spec.id} does not match the canonical controller spec.`);
      }
    }

    const createdTaskIds = [];
    const existingTaskIds = [];
    for (const original of action.taskSpecs) {
      const spec = canonicalWaveSpec(original, config);
      if (existing.has(spec.id)) {
        existingTaskIds.push(spec.id);
        continue;
      }
      addTask(db, runId, { ...original, id: spec.id }, config);
      createdTaskIds.push(spec.id);
    }
    return {
      type: action.type,
      operation: "materializeControllerTaskWave",
      runId,
      createdTaskIds,
      existingTaskIds,
      taskIds: specs.map((spec) => spec.id),
      replayed: createdTaskIds.length === 0,
      controllerFencingToken: Number(credentials.fencingToken)
    };
  });
}

function taskReferences(task, targetId) {
  return (task.contextRefs ?? []).some((item) => String(typeof item === "string" ? item : item?.ref ?? item?.id ?? "").includes(targetId));
}

function contractRoute(db, runId) {
  const row = db.prepare("SELECT route_json FROM goal_contracts WHERE run_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1").get(runId);
  return lifecycleRoute(parseJson(row?.route_json, {}));
}

function requiresUiDelivery(db, runId) {
  const kinds = db.prepare("SELECT DISTINCT lower(kind) AS kind FROM requirements WHERE run_id = ? AND status = 'active'").all(runId)
    .map((row) => row.kind);
  return kinds.some((kind) => ["ui", "frontend", "user-interface", "user-experience"].includes(kind));
}

function predesignOverlapEnabled(config) {
  return config.orchestration?.lifecycleOverlap?.predesign === true;
}

export function fastPathEligibilityForRun(db, runId, config) {
  return fastPathEligibility(db, runId, { config, isSafeRepoPath });
}

function advanceAction(db, projectRoot, run) {
  const report = gateReport(db, projectRoot, run.id);
  return report.pass ? {
    type: "ADVANCE_PHASE",
    phase: run.phase,
    targetPhase: report.to,
    command: `metis advance ${report.to} --pretty`,
    reason: `The ${run.phase} gate is satisfied.`
  } : null;
}

function dispatchAction(db, projectRoot, run, config, parentTaskId = null) {
  const proposal = proposeSchedule(db, projectRoot, run.id, config, { parentTaskId });
  if (proposal.batch.length === 0) return null;
  return {
    type: "SPAWN_BATCH",
    phase: run.phase,
    tasks: proposal.batch,
    deferred: proposal.deferred,
    command: parentTaskId
      ? `metis schedule claim --parent-task ${parentTaskId} --pretty`
      : "metis schedule claim --pretty",
    instruction: "Claim this deterministic batch, then spawn each returned contract with fork_turns=none."
  };
}

export function nextControllerAction(db, projectRoot, runId, config, options = {}) {
  const run = getRun(db, runId);
  const tasks = listTasks(db, run.id);
  const route = contractRoute(db, run.id);
  let progress = progressStatus(db, run.id, config) ?? { stalled: false, stallCount: 0, lastProgressAt: null };
  if (options.sampleProgress !== false) progress = sampleProgress(db, run.id, config);
  const budget = budgetStatus(db, run.id);
  if (!budget.pass) {
    return {
      type: "BUDGET_DECISION_REQUIRED",
      phase: run.phase,
      exceeded: budget.exceeded,
      budget,
      instruction: "Reduce scope, increase budget, or stop the managed run. Do not silently continue."
    };
  }
  if (progress.stalled && run.phase !== "intake") {
    return {
      type: "STALLED_REPLAN",
      phase: run.phase,
      stallCount: progress.stallCount,
      instruction: "Do not repeat the same approach. Inspect blockers, contracts, evidence, and model routing. Reopen the earliest invalid phase."
    };
  }
  if (run.status === "blocked") return { type: "USER_OR_AUTHORITY_REQUIRED", phase: run.phase, instruction: "Resolve the recorded blocker, then run metis resume." };
  if (run.status === "completed" || run.phase === "complete") return { type: "COMPLETE", phase: "complete" };

  const checkpoints = checkpointStatus(db, run.id);
  const immediateCheckpoints = checkpoints.blocking.filter((item) => ["decision", "authority", "external"].includes(item.kind));
  if (immediateCheckpoints.length > 0 || (run.phase === "curate" && checkpoints.blocking.length > 0)) {
    return {
      type: "USER_OR_AUTHORITY_REQUIRED",
      phase: run.phase,
      checkpoints: immediateCheckpoints.length > 0 ? immediateCheckpoints : checkpoints.blocking,
      instruction: "Resolve the blocking checkpoint with its required evidence. Do not infer human approval."
    };
  }

  const advance = advanceAction(db, projectRoot, run);
  if (advance) return advance;
  const state = taskState(tasks, run.phase);
  if (run.phase === "discover") validateStablePredesignTasks(db, run, tasks, config);
  if (state.blocked.length > 0) {
    const undiagnosed = state.blocked.find((blocked) => !tasks.some((task) => task.role === "diagnostician" && taskReferences(task, blocked.id)));
    if (undiagnosed && config.delegation?.diagnoseBeforeRetry !== false) {
      return addTasksAction(
        { phase: run.phase, gate: gateReport(db, projectRoot, run.id), basis: controllerWaveBasis(db, run) },
        "CREATE_DIAGNOSIS_TASK",
        [{
          id: controllerTaskId(run.id, "CREATE_DIAGNOSIS_TASK", undiagnosed.id),
          title: `Diagnose ${undiagnosed.id}`,
          goal: `Find the earliest invalid state that caused task ${undiagnosed.id} to ${undiagnosed.status}.`,
          role: "diagnostician",
          taskKind: "diagnosis",
          runPhase: run.phase,
          // The read-only lane shares the failed task's current wave so it can
          // use a free slot without opening any later mutable work.
          wave: Number(undiagnosed.wave),
          readOnly: true,
          risk: undiagnosed.risk ?? "medium",
          effort: "small",
          sliceType: "diagnosis",
          requirementIds: undiagnosed.requirementIds ?? [],
          contextRefs: [`task:${undiagnosed.id}`, `task-result:${undiagnosed.id}`],
          acceptanceCriteria: ["Classify the failure.", "Identify the earliest invalid assumption or artifact.", "Recommend one next action with evidence."],
          expectedOutputs: ["diagnosis"],
          authorityBoundary: "local-read"
        }],
        "Dispatch a fresh read-only diagnostician without stopping unrelated current-wave siblings. Main must not guess the failure cause or open later mutable work."
      );
    }
  }
  const dispatch = dispatchAction(db, projectRoot, run, config);
  if (dispatch) return dispatch;
  if (state.running.length > 0) {
    const schedulerBatches = db.prepare(`
      SELECT id, status, claimed_task_ids_json, spawned_task_ids_json, updated_at, controller_fencing_token
      FROM scheduler_batches
      WHERE run_id = ? AND status IN ('claimed','prepared','partially-spawned','spawned','aborted')
      ORDER BY created_at
    `).all(run.id).map((row) => {
      const spawnedTaskIds = parseJson(row.spawned_task_ids_json, []);
      const spawnReceipts = db.prepare(`
        SELECT task_id AS taskId, attempt_fence AS attemptFence, host_receipt AS hostReceipt, acknowledged_at AS acknowledgedAt
        FROM task_spawn_acks WHERE batch_id = ? ORDER BY acknowledged_at, task_id
      `).all(row.id);
      const missingReceiptTaskIds = parseJson(row.claimed_task_ids_json, []).filter((taskId) => !db.prepare(`
        SELECT 1 FROM task_spawn_acks
        WHERE batch_id = ? AND task_id = ? AND host_receipt IS NOT NULL AND length(trim(host_receipt)) > 0
        LIMIT 1
      `).get(row.id, taskId));
      const preparationAgeSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(row.updated_at)) / 1000));
      const staleAfterSeconds = Math.max(
        Number(config.orchestration.leaseMinutes) * 60,
        Math.max(30, Number(config.orchestration.leaseHeartbeatSeconds) * 2)
      );
      return {
        id: row.id,
        status: row.status,
        spawnedTaskIds,
        spawnReceipts,
        missingReceiptTaskIds,
        observedUpdatedAt: row.updated_at,
        controllerFencingToken: Number(row.controller_fencing_token),
        preparationAgeSeconds,
        staleAfterSeconds,
        stalePreparation: ["claimed", "prepared", "partially-spawned", "spawned"].includes(row.status)
          && missingReceiptTaskIds.length > 0
          && preparationAgeSeconds >= staleAfterSeconds
      };
    }).filter((batch) => batch.status !== "aborted" || batch.spawnedTaskIds.length > 0);
    const batches = schedulerBatches.map((batch) => batch.id);
    const heartbeatBatches = schedulerBatches.filter((batch) => !batch.stalePreparation);
    const stalePreparation = schedulerBatches.filter((batch) => batch.stalePreparation);
    return {
      type: "WAIT_FOR_AGENTS",
      phase: run.phase,
      taskIds: state.running.map((item) => item.id),
      schedulerBatchIds: batches,
      schedulerBatches,
      heartbeatSeconds: Math.min(Number(config.controller.heartbeatSeconds), Number(config.orchestration.leaseHeartbeatSeconds)),
      heartbeatCommands: heartbeatBatches.map((batch) => `metis schedule heartbeat ${batch.id} --pretty`),
      recoveryCommands: stalePreparation.map((batch) => (
        `metis schedule abort ${batch.id} 'stale batch preparation' `
        + `--expected-status ${batch.status} --expected-updated-at ${batch.observedUpdatedAt} `
        + `--expected-controller-fence ${Number(run.controller_fencing_token)} --pretty`
      )),
      instruction: "Wait in bounded intervals. Claimed batches are still preparing and must not be spawned or acknowledged until preparation completes; once prepared, spawn every returned descriptor through the host first and acknowledge only the nonempty child/session/agent receipts bound to each task and attempt. Heartbeat only receipt-backed tasks. When a receipt-backed child terminates, report its structured provider outcome through `metis schedule child-failure <batch-id> <task-id> --data '<json>'`; transient provider failures are requeued immediately within budget, while auth/contract/permanent failures fail closed. Claimed or prepared batches with missing receipts stop advancing their watchdog timestamp and return a fenced abort recovery command after the lease timeout. Aborted batches with accepted spawns remain heartbeat-visible until those tasks terminate. Treat only terminal child results as completion."
    };
  }
  if (state.blocked.length > 0) {
    return {
      type: "APPLY_DIAGNOSIS",
      phase: run.phase,
      tasks: state.blocked.map((item) => ({ id: item.id, status: item.status, failureClass: item.failure_class })),
      instruction: "Use the completed diagnosis to choose exactly one action: retry, revise contract, add dependency, reopen plan, or request external authority."
    };
  }

  const common = { phase: run.phase, gate: gateReport(db, projectRoot, run.id) };
  switch (run.phase) {
    case "intake":
      return {
        ...common,
        type: "FREEZE_GOAL_CONTRACT",
        command: "metis contract freeze --data '<json>' --pretty",
        schema: {
          objective: run.goal,
          scope: [],
          nonGoals: [],
          constraints: [],
          successCriteria: [],
          complexity: "trivial | standard | complex",
          route: {
            lifecycleProfile: "fast | balanced | full",
            researchRequired: true,
            designRequired: true,
            specialistReviewRequired: false,
            documentationRequired: true
          },
          requirements: [{ id: "REQ-001", title: "", description: "", kind: "functional", priority: "must", acceptance: [] }]
        }
      };
    case "discover": {
      const fastPath = fastPathEligibilityForRun(db, run.id, config);
      if (fastPath.eligible) {
        return {
          ...common,
          type: "MATERIALIZE_FAST_PATH_PREREQUISITES",
          operation: "materializeFastPathPrerequisites",
          command: "metis drive --pretty",
          paths: fastPath.paths,
          instruction: "Run the fenced idempotent prerequisite operation once. It only materializes canonical local records; continue through the normal plan, scheduler, review, verification, curation, and completion gates."
        };
      }
      if (predesignOverlapEnabled(config) && route.researchRequired !== false) {
        const discoveryCurrent = Boolean(latestArtifact(db, projectRoot, run.id, "discovery", ["verified"]));
        const researchCurrent = Boolean(latestArtifact(db, projectRoot, run.id, "research", ["verified"]));
        if (!researchCurrent) {
          const requirements = activeRequirementIds(db, run.id);
          const basis = controllerWaveBasis(db, run);
          const lanes = predesignLaneSpecs({ runId: run.id, requirementIds: requirements, tasks, discoveryCurrent });
          if (lanes.length > 0) {
            return addTasksAction(
              { ...common, basis },
              "CREATE_PREDESIGN_WAVE",
              lanes,
              "Create the three discovery scouts and two goal-contract-only researchers as one bounded predesign wave. Researchers must not consume partial discovery, and Main must not inspect or synthesize repository evidence."
            );
          }
          const synthesis = predesignSynthesisSpecs({
            runId: run.id,
            requirementIds: requirements,
            tasks,
            discoveryCurrent,
            researchCurrent
          });
          if (synthesis.length > 0) {
            return addTasksAction(
              { ...common, basis },
              "CREATE_PREDESIGN_SYNTHESIS_WAVE",
              synthesis,
              "Create the discovery and prefetched research synthesizers in one wave. Their dependency sets are disjoint; each synthesizer may consume only terminal task results from its own lane."
            );
          }
        }
      }
      if (artifactExists(db, run.id, "discovery")) break;
      const scouts = roleTasks(tasks, "discover", "scout");
      const synthesizers = roleTasks(tasks, "discover", "synthesizer");
      if (scouts.length === 0) {
        const requirements = activeRequirementIds(db, run.id);
        return addTasksAction({ ...common, basis: controllerWaveBasis(db, run) }, "CREATE_DISCOVERY_WAVE", [
          {
            id: `discovery-${run.id}-scout-architecture`,
            title: "Map repository architecture and entry points",
            goal: "Identify the smallest relevant architecture, entry points, conventions, and shared interfaces for the goal.",
            role: "scout", taskKind: "discovery", runPhase: "discover", wave: 1, readOnly: true,
            scope: ["Architecture, entry points, and conventions relevant to the frozen goal."],
            nonGoals: ["Do not summarize the entire repository."],
            requirementIds: requirements, acceptanceCriteria: ["Relevant paths and interfaces are cited with current source evidence."],
            expectedOutputs: ["facts", "relevant-paths", "interfaces", "unknowns"]
          },
          {
            id: `discovery-${run.id}-scout-tests`,
            title: "Map tests and verification surface",
            goal: "Locate existing tests, checks, fixtures, and behavioral verification paths for the goal.",
            role: "scout", taskKind: "discovery", runPhase: "discover", wave: 1, readOnly: true,
            scope: ["Tests, checks, fixtures, and current verification conventions."],
            requirementIds: requirements, acceptanceCriteria: ["Each proposed verification route names current evidence and gaps."],
            expectedOutputs: ["facts", "relevant-paths", "unknowns"]
          },
          {
            id: `discovery-${run.id}-scout-boundaries`,
            title: "Map dependency and change boundaries",
            goal: "Identify dependency edges, ownership boundaries, likely parallel slices, and interface risks.",
            role: "scout", taskKind: "discovery", runPhase: "discover", wave: 1, readOnly: true,
            scope: ["Dependencies and change boundaries relevant to the goal."],
            requirementIds: requirements, acceptanceCriteria: ["Parallelizable and shared boundaries are explicit."],
            expectedOutputs: ["facts", "interfaces", "risks", "unknowns"]
          }
        ], "Create all independent scout tasks, then claim the wave as one scheduler batch. Main must not inspect the repository directly.");
      }
      if (allTerminal(scouts) && synthesizers.length === 0) {
        return addTasksAction({ ...common, basis: controllerWaveBasis(db, run) }, "CREATE_DISCOVERY_SYNTHESIS", [{
          id: controllerTaskId(run.id, "CREATE_DISCOVERY_SYNTHESIS", "synthesis"),
          title: "Synthesize repository discovery",
          goal: "Merge the completed scout evidence into the canonical discovery artifact.",
          role: "synthesizer", taskKind: "synthesis", runPhase: "discover", wave: nextWave(scouts), readOnly: true,
          dependsOn: scouts.map((item) => item.id),
          requirementIds: activeRequirementIds(db, run.id),
          contextRefs: scouts.map((item) => `task-result:${item.id}`),
          acceptanceCriteria: [
            "Contradictions and unknowns remain explicit.",
            "The artifact contains only evidence supplied by child tasks.",
            "ArtifactKind is discovery.",
            "ArtifactContent.scope is a non-empty string array.",
            "ArtifactContent.knownFacts is an array.",
            "ArtifactContent.unknowns is an array.",
            "ProducedArtifacts is empty; emit the canonical discovery only through ArtifactKind and ArtifactContent."
          ],
          constraints: [
            "ArtifactContent must use lowercase scope, knownFacts, and unknowns fields.",
            "Do not emit a duplicate discovery in ProducedArtifacts."
          ],
          expectedOutputs: ["artifact:discovery"],
          authorityBoundary: "local-read"
        }], "Dispatch a synthesizer. Main must not write the discovery artifact itself.");
      }
      return { ...common, type: "DISCOVERY_OUTPUT_MISSING", instruction: "A completed synthesizer must return a verified discovery artifact. Diagnose the packet or result instead of synthesizing in Main." };
    }
    case "research": {
      if (route.researchRequired === false && !artifactExists(db, run.id, "research")) {
        return { ...common, type: "WAIVE_RESEARCH", command: "metis artifact waive research '<reason>'" };
      }
      if (artifactExists(db, run.id, "research")) break;
      const researchers = roleTasks(tasks, "research", "researcher");
      const synthesizers = roleTasks(tasks, "research", "synthesizer");
      if (researchers.length === 0) {
        const requirements = activeRequirementIds(db, run.id);
        return addTasksAction({ ...common, basis: controllerWaveBasis(db, run) }, "CREATE_RESEARCH_WAVE", [
          {
            id: `research-${run.id}-researcher-official`,
            title: "Research current official implementation guidance",
            goal: "Answer only the current technical questions that affect the selected design.",
            role: "researcher", taskKind: "research", runPhase: "research", wave: 1, readOnly: true,
            requirementIds: requirements, scope: ["Official documentation and primary sources for relevant dependencies and APIs."],
            acceptanceCriteria: ["Facts, inference, recommendations, and uncertainty are separated.", "Version applicability is explicit."],
            expectedOutputs: ["sources", "findings", "constraints", "recommendations", "unknowns"]
          },
          {
            id: `research-${run.id}-researcher-patterns`,
            title: "Research established product and workflow patterns",
            goal: "Find proven patterns relevant to planning, decomposition, review, or user-facing behavior without importing an entire framework.",
            role: "researcher", taskKind: "research", runPhase: "research", wave: 1, readOnly: true,
            requirementIds: requirements, scope: ["Established products and maintained primary project documentation."],
            acceptanceCriteria: ["Only applicable patterns and tradeoffs are returned."],
            expectedOutputs: ["sources", "findings", "recommendations", "unknowns"]
          }
        ], "Dispatch independent research questions in parallel. Main must not browse or collect sources directly.");
      }
      if (allTerminal(researchers) && synthesizers.length === 0) {
        return addTasksAction({ ...common, basis: controllerWaveBasis(db, run) }, "CREATE_RESEARCH_SYNTHESIS", [{
          id: controllerTaskId(run.id, "CREATE_RESEARCH_SYNTHESIS", "synthesis"),
          title: "Synthesize external research",
          goal: "Merge completed research evidence into the canonical research artifact.",
          role: "synthesizer", taskKind: "synthesis", runPhase: "research", wave: nextWave(researchers), readOnly: true,
          dependsOn: researchers.map((item) => item.id),
          requirementIds: activeRequirementIds(db, run.id),
          contextRefs: researchers.map((item) => `task-result:${item.id}`),
          acceptanceCriteria: ["Sources remain traceable.", "Contradictions and uncertainty remain explicit."],
          expectedOutputs: ["artifact:research"], authorityBoundary: "local-read"
        }], "Dispatch a synthesizer. Main must not write the research artifact itself.");
      }
      return { ...common, type: "RESEARCH_OUTPUT_MISSING", instruction: "A completed synthesizer must return a verified research artifact. Diagnose the packet or result." };
    }
    case "design": {
      if (route.designRequired === false && !artifactExists(db, run.id, "design")) {
        return { ...common, type: "WAIVE_DESIGN", command: "metis artifact waive design '<reason>'" };
      }
      if (!artifactExists(db, run.id, "design")) {
        const designers = roleTasks(tasks, "design", "designer");
        if (designers.length === 0) {
          const outputs = ["artifact:design"];
          if (requiresUiDelivery(db, run.id)) outputs.push("artifact:experience-contract", "artifact:visual-contract", "artifact:browser-acceptance");
          return addTasksAction({ ...common, basis: controllerWaveBasis(db, run) }, "CREATE_DESIGN_TASK", [{
            id: controllerTaskId(run.id, "CREATE_DESIGN_TASK", "designer"),
            title: "Design the smallest complete solution",
            goal: "Use discovery and research evidence to select the architecture and freeze shared interfaces before parallel work.",
            role: "designer", taskKind: "design", runPhase: "design", wave: 1, readOnly: true,
            requirementIds: activeRequirementIds(db, run.id),
            contextRefs: ["artifact:discovery", "artifact:research", "artifact:goal-contract"],
            acceptanceCriteria: ["Every must requirement is covered.", "Shared interfaces are explicit and versionable.", "Error handling and verification are defined."],
            expectedOutputs: outputs, authorityBoundary: "local-read"
          }], "Dispatch the designer with compiled evidence. Main must not author the technical or UI contracts.");
        }
        return { ...common, type: "DESIGN_OUTPUT_MISSING", instruction: "The designer completed without the declared design artifacts. Diagnose the result contract." };
      }
      if (requiresUiDelivery(db, run.id)) {
        const missing = ["experience-contract", "visual-contract", "browser-acceptance"].filter((kind) => !artifactExists(db, run.id, kind, ["verified"]));
        if (missing.length > 0) {
          return addTasksAction({ ...common, basis: controllerWaveBasis(db, run) }, "CREATE_UI_CONTRACT_TASK", [{
            id: controllerTaskId(run.id, "CREATE_UI_CONTRACT_TASK", missing.join("-")),
            title: "Complete UI experience and visual contracts",
            goal: `Produce the missing UI delivery artifacts: ${missing.join(", ")}.`,
            role: "designer", taskKind: "design", runPhase: "design", wave: nextWave(phaseTasks(tasks, "design")), readOnly: true,
            requirementIds: activeRequirementIds(db, run.id), contextRefs: ["artifact:design", "artifact:discovery", "artifact:research"],
            acceptanceCriteria: ["Journeys, interaction states, existing design-system references, responsive rules, and browser scenarios are executable."],
            expectedOutputs: missing.map((kind) => `artifact:${kind}`), authorityBoundary: "local-read"
          }], "Dispatch a focused designer subagent for the missing contracts.");
        }
      }
      if (!artifactExists(db, run.id, "design-seal", ["verified"])) return { ...common, type: "SEAL_DESIGN", command: "metis design seal --pretty" };
      if (!artifactExists(db, run.id, "design-review", ["verified"])) {
        const critics = roleTasks(tasks, "design", "design-critic");
        if (critics.length === 0) {
          return addTasksAction({ ...common, basis: controllerWaveBasis(db, run) }, "CREATE_DESIGN_CRITIC", [{
            id: controllerTaskId(run.id, "CREATE_DESIGN_CRITIC", "critic"),
            title: "Critique the sealed design",
            goal: "Attack the current design seal for missing requirements, ambiguous interfaces, failure paths, and unnecessary complexity.",
            role: "design-critic", taskKind: "review", runPhase: "design", wave: nextWave(phaseTasks(tasks, "design")), readOnly: true,
            requirementIds: activeRequirementIds(db, run.id), contextRefs: ["artifact:design-seal"],
            acceptanceCriteria: ["Return an explicit verdict and evidence-backed findings."], expectedOutputs: ["design-review-result"]
          }], "Dispatch an independent design critic.");
        }
        return { ...common, type: "RECORD_DESIGN_REVIEW", command: "metis design review --data '<critic-result-json>' --pretty", instruction: "Record the terminal critic result without Main rewriting it." };
      }
      break;
    }
    case "plan": {
      if (!artifactExists(db, run.id, "plan", ["verified"])) {
        const planners = roleTasks(tasks, "plan", "planner");
        if (planners.length === 0) {
          return addTasksAction({ ...common, basis: controllerWaveBasis(db, run) }, "CREATE_PLANNER_TASK", [{
            id: controllerTaskId(run.id, "CREATE_PLANNER_TASK", "planner"),
            title: "Build the milestone and subagent task DAG",
            goal: "Convert the approved design into observable milestones, frozen interfaces, dependency waves, non-overlapping ownership, and independently verifiable task blueprints.",
            role: "planner", taskKind: "planning", runPhase: "plan", wave: 1, readOnly: true,
            requirementIds: activeRequirementIds(db, run.id),
            contextRefs: ["artifact:goal-contract", "artifact:discovery", "artifact:research", "artifact:design", "artifact:design-review"],
            acceptanceCriteria: ["Each task has one outcome and a clear boundary.", "Parallel tasks do not overlap mutable paths.", "PlanDraft uses canonical lower-camel-case interfaces, milestones, and tasks fields with explicit arrays, waves, dependencies, and contracts; aliases name/description/wave, kind/outcome, and consumesInterfaceIds are forbidden.", "Shared interfaces are frozen before their consumers.", "Review and verification tasks are included."],
            expectedOutputs: ["plan-draft"], authorityBoundary: "local-read"
          }], "Dispatch a planner. Main must not hand-write worker prompts or the task graph.");
        }
        const completedPlanner = planners.find((item) => item.status === "completed");
        if (completedPlanner && artifactExists(db, run.id, `plan-draft:${completedPlanner.id}`, ["verified"])) {
          const ingested = artifactExists(db, run.id, `plan-draft-ingested:${completedPlanner.id}`, ["verified"]);
          if (!ingested) return { ...common, type: "INGEST_PLAN_DRAFT", command: `metis plan ingest ${completedPlanner.id} --pretty`, instruction: "Let the runtime validate and materialize milestones, interfaces, task packets, and compiler tasks." };
        }
        const planPhaseTasks = phaseTasks(tasks, "plan").filter((item) => item.role !== "planner");
        if (completedPlanner && planPhaseTasks.every((item) => ["completed", "waived"].includes(item.status))) {
          return { ...common, type: "SEAL_PLAN", command: "metis plan seal --pretty" };
        }
        return { ...common, type: "PLAN_DRAFT_OUTPUT_MISSING", instruction: "The planner must return a valid PlanDraft artifact. Diagnose missing or invalid output." };
      }
      if (!artifactExists(db, run.id, "plan-review", ["verified"])) {
        const critics = roleTasks(tasks, "plan", "plan-critic");
        if (critics.length === 0) {
          return addTasksAction({ ...common, basis: controllerWaveBasis(db, run) }, "CREATE_PLAN_CRITIC", [{
            id: controllerTaskId(run.id, "CREATE_PLAN_CRITIC", "critic"),
            title: "Critique the sealed subagent plan",
            goal: "Attack the exact sealed plan, task boundaries, waves, interfaces, verification, and compiled packet readiness.",
            role: "plan-critic", taskKind: "review", runPhase: "plan", wave: nextWave(phaseTasks(tasks, "plan")), readOnly: true,
            requirementIds: activeRequirementIds(db, run.id), contextRefs: ["artifact:plan"],
            acceptanceCriteria: ["Every task is self-contained and safely schedulable.", "Return an explicit verdict and findings."], expectedOutputs: ["plan-review-result"]
          }], "Dispatch an independent plan critic.");
        }
        return { ...common, type: "RECORD_PLAN_REVIEW", command: "metis plan review --data '<critic-result-json>' --pretty", instruction: "Record the terminal critic result without Main rewriting it." };
      }
      break;
    }
    case "execute":
      return { ...common, type: "EXECUTION_GRAPH_EMPTY", instruction: "No execution task is runnable. Inspect packet status, dependencies, waves, milestone state, and diagnoses. Reopen plan when the graph is wrong." };
    case "review": {
      if (!lifecycleReviewRequired(route, config, "integration")) {
        return { ...common, type: "SKIP_INTEGRATION_REVIEW", instruction: "The frozen Goal Contract waives independent integration review for this bounded goal." };
      }
      const reviews = reviewReport(db, run.id);
      if (state.total === 0) return { ...common, type: "PLAN_INTEGRATION_REVIEW", instruction: "Create independent review task packets for the integrated code and only the required specialist capabilities." };
      if (reviews.blocking.length > 0) return { ...common, type: "RECONCILE_REVIEW", command: "metis review reconcile --kind integration --pretty", blocking: reviews.blocking };
      if (!artifactExists(db, run.id, "integration-review", ["verified"])) return { ...common, type: "RECONCILE_REVIEW", command: "metis review reconcile --kind integration --pretty" };
      break;
    }
    case "verify": {
      const browser = browserStatus(db, run.id, repositoryCodeFingerprint(db));
      if (!browser.pass) {
        return { ...common, type: "PLAN_BROWSER_VERIFIERS", missingScenarios: browser.missing, instruction: "Create verifier task packets for each missing browser scenario. Main must not operate the browser or judge screenshots." };
      }
      const humanCheckpoints = checkpoints.blocking.filter((item) => item.kind === "human-verify");
      if (humanCheckpoints.length > 0) {
        return { ...common, type: "USER_OR_AUTHORITY_REQUIRED", checkpoints: humanCheckpoints, instruction: "Present current child-produced browser evidence and record explicit human resolution." };
      }
      if (!artifactExists(db, run.id, "verification-candidate", ["verified"])) return { ...common, type: "CREATE_VERIFICATION_CANDIDATE", command: "metis verification candidate --pretty", instruction: "Finish verifier tasks and deterministic checks. The runtime builds the candidate." };
      if (lifecycleReviewRequired(route, config, "completion") && !artifactExists(db, run.id, "completion-review", ["verified"])) {
        return { ...common, type: "RUN_ADVERSARIAL_REVIEW", instruction: "Dispatch an adversarial-reviewer task against the current verification candidate, then reconcile completion review." };
      }
      break;
    }
    case "curate":
      if (!artifactExists(db, run.id, "knowledge-sync", ["verified"])) return { ...common, type: "PLAN_CURATION_TASK", instruction: "Dispatch a curator task for human documentation. Run deterministic knowledge indexing only after its result integrates." };
      if (!artifactExists(db, run.id, "self-evaluation", ["verified"])) return { ...common, type: "SELF_EVALUATE", command: "metis evaluate --pretty" };
      break;
    default:
      break;
  }

  return { ...common, type: "FIX_GATE_FAILURES", failures: common.gate.failures };
}

function driveError(error) {
  if (error instanceof MetisError) {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  return { code: "INTERNAL_ERROR", message: error?.message ?? String(error) };
}

function driveOperationRecord(action, result) {
  const record = { type: action.type };
  if (action.type === "ADVANCE_PHASE") {
    record.from = action.phase;
    record.to = action.targetPhase;
    record.runPhase = result?.run?.phase ?? action.targetPhase;
  } else {
    record.operation = action.operation;
    if (Array.isArray(result?.taskIds)) record.taskIds = result.taskIds;
    if (Array.isArray(result?.createdTaskIds)) record.createdTaskIds = result.createdTaskIds;
    if (Array.isArray(result?.existingTaskIds)) record.existingTaskIds = result.existingTaskIds;
    if (result?.replayed !== undefined) record.replayed = result.replayed;
    if (result?.run?.phase) record.runPhase = result.run.phase;
  }
  return record;
}

/**
 * Apply consecutive controller-owned deterministic transitions.
 *
 * Drive never claims or spawns work and never invents artifacts.  It stops at
 * the first action requiring a child, a human, or a semantic decision.  The
 * stable IDs used by the materializers make replay safe: a second drive call
 * observes the same boundary without creating another record.
 */
export function driveController(db, projectRoot, runId, credentials, config, options = {}) {
  const deterministicStarted = performance.now();
  const requested = options.maxIterations ?? MAX_DRIVE_ITERATIONS;
  invariant(Number.isInteger(Number(requested)) && Number(requested) > 0, "DRIVE_ITERATIONS", "Drive maxIterations must be a positive integer.");
  const maxIterations = Math.min(Number(requested), MAX_DRIVE_ITERATIONS);
  const applied = [];
  let lastAction = null;
  const finish = (result) => {
    recordEvent(db, runId, "performance.controller-deterministic", "info", {
      durationMs: Math.round((performance.now() - deterministicStarted) * 100) / 100,
      iterations: Number(result.iterations ?? 0),
      appliedCount: applied.length,
      resultType: result.type
    });
    return result;
  };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    // Refresh and validate the lease before every possible state mutation.
    assertController(db, runId, credentials, { heartbeat: true, leaseSeconds: config.controller.leaseSeconds });
    let action;
    try {
      action = nextControllerAction(db, projectRoot, runId, config, { sampleProgress: false });
      lastAction = action;
    } catch (error) {
      const blocker = driveError(error);
      if (["CONTROLLER_REQUIRED", "CONTROLLER_FENCED", "CONTROLLER_EXPIRED"].includes(blocker.code)) throw error;
      return finish({
        type: "UNRECOVERABLE_BLOCKER", runId, iterations: iteration, maxIterations,
        applied, action: null, blocker
      });
    }

    if (DRIVE_STOP_TYPES.has(action.type)) {
      return finish({ type: action.type, runId, iterations: iteration, maxIterations, applied, action });
    }

    try {
      let result;
      if (action.type === "ADVANCE_PHASE") {
        assertController(db, runId, credentials, { heartbeat: true, leaseSeconds: config.controller.leaseSeconds });
        result = advancePhase(db, projectRoot, runId, action.targetPhase);
      } else if (action.type === "MATERIALIZE_FAST_PATH_PREREQUISITES") {
        assertController(db, runId, credentials, { heartbeat: true, leaseSeconds: config.controller.leaseSeconds });
        result = materializeFastPathPrerequisites(db, projectRoot, runId, credentials, config);
      } else if (MATERIALIZABLE_WAVE_TYPES.has(action.type)) {
        assertController(db, runId, credentials, { heartbeat: true, leaseSeconds: config.controller.leaseSeconds });
        result = materializeControllerTaskWave(db, projectRoot, runId, action, credentials, config);
      } else {
        return finish({
          type: "UNRECOVERABLE_BLOCKER", runId, iterations: iteration, maxIterations,
          applied, action, blocker: {
            code: "DRIVE_ACTION_REQUIRES_MAIN",
            message: `Drive cannot apply controller action ${action.type}.`
          }
        });
      }
      applied.push(driveOperationRecord(action, result));
    } catch (error) {
      const blocker = driveError(error);
      if (["CONTROLLER_REQUIRED", "CONTROLLER_FENCED", "CONTROLLER_EXPIRED"].includes(blocker.code)) throw error;
      return finish({ type: "UNRECOVERABLE_BLOCKER", runId, iterations: iteration, maxIterations, applied, action, blocker });
    }
  }

  return finish({
    type: "UNRECOVERABLE_BLOCKER", runId, iterations: maxIterations, maxIterations, applied,
    action: lastAction,
    blocker: { code: "DRIVE_ITERATION_CAP", message: `Drive stopped after ${maxIterations} deterministic transitions.` }
  });
}
