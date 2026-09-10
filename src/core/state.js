import { currentGitChanges, currentGitRef, repositoryCodeFingerprint, syncRepository } from "./repository.js";
import { loadConfig } from "./config.js";
import { storeObject, readObject } from "./objects.js";
import { transaction } from "./db.js";
import { validateGraph } from "./graph.js";
import { validateMilestoneGraph, refreshMilestoneStatuses } from "./milestones.js";
import { initializeBudget, budgetStatus } from "./budget.js";
import { appendJournal } from "./journal.js";
import { MetisError, invariant } from "./errors.js";
import { asArray, isSafeRepoPath, json, makeId, now, parseJson, redactValue, sha256, stableStringify } from "./util.js";
import { PHASES, REVIEW_ROLES as REVIEW_ROLE_NAMES } from "./metadata.js";
import { assertController, controllerCredentials, newControllerLease, takeoverController } from "./ownership.js";
import { validateMutableOwnershipPaths } from "./worktrees.js";
import { evidenceRefIsCurrent, evidenceRefIsVerifiable } from "./provenance.js";
import { compileTaskPacket, taskPacketStatus } from "./task-packets.js";
import { bindTaskCapabilities, resolveTaskCapabilities, specialistRolesForCapabilities } from "./capabilities.js";
import { selectModelRoute } from "./model-routing.js";
import { addCheckpoint, getCheckpoint } from "./checkpoints.js";
import {
  applyPlanExecutionSettings,
  normalizePlanExecutionSettings,
  planExecutionSettings,
  previousPlanExecutionSettings,
  taskPlanExecutionSettingStatus
} from "./tasks.js";

export { PHASES };

const TERMINAL_TASK_STATUSES = new Set(["completed", "waived"]);
const BLOCKING_SEVERITIES = new Set(["error", "critical"]);
const LIFECYCLE_PROFILES = new Set(["fast", "balanced", "full"]);
const REVIEW_ROLES = new Set(REVIEW_ROLE_NAMES);

export function activeRun(db) {
  return db.prepare(`
    SELECT * FROM runs
    WHERE status IN ('active', 'blocked')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get();
}

export function getRun(db, runId = null) {
  const row = runId
    ? db.prepare("SELECT * FROM runs WHERE id = ?").get(runId)
    : activeRun(db) ?? db.prepare("SELECT * FROM runs ORDER BY updated_at DESC LIMIT 1").get();
  invariant(row, "NO_ACTIVE_RUN", "No goal run exists.");
  return { ...row, route: lifecycleRoute(parseJson(row.route_json, {})) };
}

function requirementIdentity(requirement) {
  if (!requirement) return null;
  return sha256(stableStringify({
    id: requirement.id,
    runId: requirement.run_id,
    title: requirement.title,
    description: requirement.description,
    kind: requirement.kind,
    priority: requirement.priority,
    status: requirement.status,
    acceptanceJson: requirement.acceptance_json,
    source: requirement.source
  }));
}

function contractIdentity(contract) {
  if (!contract) return null;
  return sha256(stableStringify({
    id: contract.id,
    runId: contract.run_id,
    version: contract.version,
    objective: contract.objective,
    scopeJson: contract.scope_json,
    nonGoalsJson: contract.non_goals_json,
    constraintsJson: contract.constraints_json,
    successCriteriaJson: contract.success_criteria_json,
    complexity: contract.complexity,
    routeJson: contract.route_json,
    status: contract.status,
    contractHash: contract.contract_hash
  }));
}

function fastPathBasis(run, contract, requirements) {
  const activeRequirements = requirements.filter((item) => item.status === "active").sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return Object.freeze({
    runId: run.id,
    runRevision: Number(run.revision),
    contractId: contract?.id ?? null,
    contractVersion: contract ? Number(contract.version) : null,
    contractHash: contract?.contract_hash ?? null,
    contractIdentity: contractIdentity(contract),
    requirementIds: activeRequirements.map((item) => item.id),
    requirementIdentities: activeRequirements.map((item) => ({ id: item.id, identity: requirementIdentity(item) }))
  });
}

function assertFastPathBasis(db, run, expected) {
  const contract = db.prepare(`
    SELECT * FROM goal_contracts
    WHERE run_id = ? AND status = 'active'
    ORDER BY version DESC LIMIT 1
  `).get(run.id);
  const requirements = db.prepare("SELECT * FROM requirements WHERE run_id = ? AND status = 'active' ORDER BY id").all(run.id);
  const actual = fastPathBasis(run, contract, requirements);
  invariant(actual.runRevision === expected.runRevision,
    "FAST_PATH_BASIS_STALE", "Fast path eligibility became stale before materialization (run revision changed).");
  invariant(actual.contractId === expected.contractId
    && actual.contractVersion === expected.contractVersion
    && actual.contractHash === expected.contractHash
    && actual.contractIdentity === expected.contractIdentity,
  "FAST_PATH_BASIS_STALE", "Fast path eligibility became stale before materialization (contract changed).");
  invariant(stableStringify(actual.requirementIds) === stableStringify(expected.requirementIds)
    && stableStringify(actual.requirementIdentities) === stableStringify(expected.requirementIdentities),
  "FAST_PATH_BASIS_STALE", "Fast path eligibility became stale before materialization (active requirement changed).");
}

export function fastPathEligibility(db, runId, options = {}) {
  const run = getRun(db, runId);
  const contract = activeContract(db, run.id);
  const route = contract?.route ?? run.route ?? {};
  const requirements = db.prepare("SELECT * FROM requirements WHERE run_id = ? AND status = 'active' ORDER BY id")
    .all(run.id);
  const paths = contract?.scope ?? [];
  const safePath = options.isSafeRepoPath ?? isSafeRepoPath;
  const resolvedCapabilities = resolveTaskCapabilities(db, run.id, {
    role: "worker",
    taskKind: "implementation",
    targetPaths: paths,
    requirementIds: requirements.map((item) => item.id),
    verificationModes: ["test"]
  });
  const capabilityNames = resolvedCapabilities.map((item) => item.name);
  const specialistRoles = specialistRolesForCapabilities(resolvedCapabilities);
  const explicitlyForbiddenCapabilities = new Set(["security", "database", "performance", "migration", "accessibility", "browser-testing", "frontend-ui", "visual-review", "deployment"]);
  const deploymentSegments = new Set(["deploy", "deployment", "deployments", "release", "releases", "production", "infrastructure"]);
  const deploymentScope = paths.some((item) => String(item).replaceAll("\\", "/").split("/").some((segment) => deploymentSegments.has(segment.toLowerCase())));
  const blockers = Number(db.prepare("SELECT COUNT(*) AS count FROM findings WHERE run_id = ? AND status = 'valid' AND kind = 'blocker'").get(run.id)?.count ?? 0);
  const ignoredTaskIds = new Set((options.ignoreTaskIds ?? []).map((id) => String(id)));
  const ignoredCheckpointIds = new Set((options.ignoreCheckpointIds ?? []).map((id) => String(id)));
  const checkpoints = db.prepare("SELECT id FROM checkpoints WHERE run_id = ? AND blocking = 1 AND status = 'pending'").all(run.id)
    .filter((item) => !ignoredCheckpointIds.has(String(item.id))).length;
  const activeWork = db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status NOT IN ('completed','waived')").all(run.id)
    .filter((item) => !ignoredTaskIds.has(String(item.id))).length
    + db.prepare("SELECT task_id FROM leases WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)").all(run.id)
      .filter((item) => !ignoredTaskIds.has(String(item.task_id))).length;
  const reasons = [];
  if (run.phase !== "discover") reasons.push("run is not at discover");
  if (route.lifecycleProfile !== "fast") reasons.push("lifecycle profile is not fast");
  if (contract?.complexity !== "trivial") reasons.push("complexity is not trivial");
  if (route.researchRequired !== false) reasons.push("research is required");
  if (route.designRequired !== false) reasons.push("design is required");
  if (route.specialistReviewRequired === true) reasons.push("specialist review is required");
  if (requirements.length !== 1 || requirements[0]?.kind !== "functional" || requirements[0]?.priority !== "must") reasons.push("requirements are not exactly one functional must requirement");
  if (paths.length < 1 || paths.length > 3 || paths.some((item) => !safePath(item) || item === ".")) reasons.push("scope does not contain 1-3 explicit safe local paths");
  if (paths.length >= 1 && paths.length <= 3) {
    try { validateMutableOwnershipPaths(run.project_root, paths); } catch { reasons.push("scope contains an unsafe mutable ownership path"); }
  }
  if (capabilityNames.some((name) => explicitlyForbiddenCapabilities.has(name)) || specialistRoles.length > 0 || deploymentScope) {
    reasons.push("scope resolves a specialist, security, database, performance, migration, accessibility, browser, frontend, visual, or deployment capability");
  }
  if (blockers > 0 || checkpoints > 0) reasons.push("open blockers or blocking checkpoints exist");
  if (activeWork > 0) reasons.push("active work exists");
  return {
    eligible: reasons.length === 0,
    reasons,
    paths: [...paths],
    capabilities: resolvedCapabilities,
    specialistRoles,
    basis: fastPathBasis(run, contract, requirements)
  };
}

const FAST_PATH_PROFILE_VERSION = 2;
const FAST_PATH_SOURCE = "bounded-fast-path";
const FAST_PATH_V2_SOURCE = "bounded-fast-path-v2";

function fastPathRecordIds(runId, profileVersion = FAST_PATH_PROFILE_VERSION) {
  const prefix = profileVersion === 1 ? `fast-path-${runId}` : `fast-path-v2-${runId}`;
  return profileVersion === 1
    ? {
      profileVersion,
      artifactIds: [`${prefix}-discovery`, `${prefix}-research`, `${prefix}-design`, `${prefix}-plan`, `${prefix}-plan-review`],
      milestoneId: `${prefix}-milestone`,
      taskIds: [`${prefix}-implementation`, `${prefix}-integration-review`, `${prefix}-verification`, `${prefix}-adversarial-review`, `${prefix}-curation`]
    }
    : {
      profileVersion,
      artifactIds: [`${prefix}-discovery`, `${prefix}-research`, `${prefix}-design`, `${prefix}-plan`, `${prefix}-plan-review`],
      milestoneId: `${prefix}-milestone`,
      taskIds: [`${prefix}-implementation`, `${prefix}-verification`]
    };
}

function fastPathProfileFromPlan(planArtifact) {
  if (!planArtifact) return null;
  const content = parsedArtifact(planArtifact);
  const metadataVersion = Number(planArtifact.metadata?.fastPathProfileVersion);
  const draftVersion = Number(content.planDraft?.fastPathProfileVersion);
  const source = String(planArtifact.metadata?.source ?? content.source ?? "");
  if (metadataVersion === FAST_PATH_PROFILE_VERSION
      && (source === FAST_PATH_V2_SOURCE || source === FAST_PATH_SOURCE)) return FAST_PATH_PROFILE_VERSION;
  if (draftVersion === FAST_PATH_PROFILE_VERSION && source === FAST_PATH_V2_SOURCE) return FAST_PATH_PROFILE_VERSION;
  if (source === FAST_PATH_SOURCE) return 1;
  return null;
}

function materializedFastPathProfile(db, projectRoot, runId) {
  const plan = latestArtifact(db, projectRoot, runId, "plan", ["verified", "stale"]);
  return fastPathProfileFromPlan(plan);
}

export function isFastPathV2(db, projectRoot, runId) {
  try {
    const run = getRun(db, runId);
    if (run.route?.lifecycleProfile !== "fast") return false;
    const ids = fastPathRecordIds(run.id, FAST_PATH_PROFILE_VERSION);
    const plan = latestArtifact(db, projectRoot, run.id, "plan", ["verified"]);
    const review = latestArtifact(db, projectRoot, run.id, "plan-review", ["verified"]);
    const planData = parsedArtifact(plan);
    const reviewData = parsedArtifact(review);
    if (!plan || !review
        || plan.id !== ids.artifactIds[3]
        || review.id !== ids.artifactIds[4]
        || plan.metadata?.source !== FAST_PATH_V2_SOURCE
        || review.metadata?.source !== FAST_PATH_V2_SOURCE
        || Number(plan.metadata?.fastPathProfileVersion) !== FAST_PATH_PROFILE_VERSION
        || Number(review.metadata?.fastPathProfileVersion) !== FAST_PATH_PROFILE_VERSION
        || plan.metadata?.immutable !== true
        || planData.source !== FAST_PATH_V2_SOURCE
        || Number(planData.fastPathProfileVersion) !== FAST_PATH_PROFILE_VERSION
        || reviewData.source !== FAST_PATH_V2_SOURCE
        || reviewData.fastPathProfileVersion !== FAST_PATH_PROFILE_VERSION
        || reviewData.deterministic !== true
        || reviewData.verdict !== "APPROVED"
        || reviewData.reviewerTaskId !== null
        || reviewData.planArtifactId !== plan.id
        || reviewData.planContentRef !== plan.content_ref
        || plan.metadata.planHash !== planData.planHash
        || plan.metadata.planDraftHash !== sha256(stableStringify(planData.planDraft))) return false;
    const { planHash: ignoredPlanHash, ...planWithoutHash } = planData;
    if (sha256(stableStringify(planWithoutHash)) !== planData.planHash) return false;
    const taskSpecs = Array.isArray(planData.tasks) ? planData.tasks : [];
    const planTaskIds = taskSpecs.map((task) => task?.id).sort();
    if (taskSpecs.length !== ids.taskIds.length
        || stableStringify(planTaskIds) !== stableStringify([...ids.taskIds].sort())
        || Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id)?.count ?? 0) !== ids.taskIds.length) return false;
    const worker = taskSpecs.find((task) => task.role === "worker");
    const verifier = taskSpecs.find((task) => task.role === "verifier");
    if (!worker || !verifier
        || worker.runPhase !== "execute" || worker.readOnly !== false
        || verifier.runPhase !== "review" || verifier.readOnly !== true
        || stableStringify(worker.dependsOn ?? []) !== stableStringify([])
        || stableStringify(verifier.dependsOn ?? []) !== stableStringify([worker.id])) return false;
    const taskRows = db.prepare("SELECT id, role, phase, read_only FROM tasks WHERE run_id = ? ORDER BY id").all(run.id);
    if (taskRows.length !== ids.taskIds.length
        || taskRows.some((task) => !ids.taskIds.includes(task.id)
          || (task.id === worker.id && (task.role !== "worker" || task.phase !== "execute" || Number(task.read_only) !== 0))
          || (task.id === verifier.id && (task.role !== "verifier" || task.phase !== "review" || Number(task.read_only) !== 1)))) return false;
    const packetBindings = normalizedPacketBindings(reviewData.packetBindings);
    const metadataBindings = normalizedPacketBindings(review.metadata?.packetBindings);
    const packetTaskIds = packetBindings?.map((binding) => binding.taskId).sort() ?? [];
    const expectedTaskIds = [...ids.taskIds].sort();
    if (!packetBindings
        || packetBindings.length !== expectedTaskIds.length
        || new Set(packetTaskIds).size !== packetTaskIds.length
        || stableStringify(packetTaskIds) !== stableStringify(expectedTaskIds)
        || stableStringify(packetBindings) !== stableStringify(metadataBindings)
        || reviewData.packetSetHash !== sha256(stableStringify(packetBindings))
        || review.metadata?.packetSetHash !== reviewData.packetSetHash) return false;
    // verifier의 동적 artifact context는 dispatch 때 해석하므로 여기서는 sealed packet identity만 인증한다.
    for (const binding of packetBindings) {
      const task = db.prepare("SELECT id, role, compiled_packet_id FROM tasks WHERE id = ? AND run_id = ?")
        .get(binding.taskId, run.id);
      let packet = db.prepare("SELECT id, task_id, version, status, packet_hash, blueprint_hash, packet_ref FROM task_packets WHERE id = ?")
        .get(binding.packetId);
      if (!task || !packet
          || binding.packetBlueprintHash !== binding.blueprintHash
          || binding.compiledBlueprintHash !== binding.blueprintHash
          || packet.task_id !== binding.taskId
          || packet.version !== binding.version
          || packet.packet_ref !== binding.packetRef
          || packet.packet_hash !== binding.packetHash
          || packet.blueprint_hash !== binding.compiledBlueprintHash) return false;
      packet = db.prepare("SELECT status FROM task_packets WHERE id = ?").get(binding.packetId);
      const currentPacket = db.prepare(`
        SELECT id, status FROM task_packets
        WHERE task_id = ? ORDER BY version DESC LIMIT 1
      `).get(binding.taskId);
      if (task.compiled_packet_id === binding.packetId) {
        if (currentPacket?.id !== binding.packetId || currentPacket.status !== "ready" || packet?.status !== "ready") return false;
        continue;
      }
      // 통합 후보 생성에 따른 verifier packet 재컴파일만 허용한다. 조회 중 packet 상태는 변경하지 않는다.
      const integrationCandidate = latestArtifact(db, projectRoot, run.id, "integration-candidate", ["verified"]);
      if (task.role !== "verifier" || !integrationCandidate
          || currentPacket?.id !== task.compiled_packet_id || currentPacket.status !== "ready"
          || packet?.status !== "stale") return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function materializeFastPathPrerequisites(db, projectRoot, runId, credentials, config, options = {}) {
  const run = getRun(db, runId);
  // 기존 sealed fast 계획은 다섯 역할을 보존하고 새 materialization에만 v2를 적용한다.
  const existingProfile = materializedFastPathProfile(db, projectRoot, run.id);
  const profileVersion = existingProfile ?? FAST_PATH_PROFILE_VERSION;
  const ids = fastPathRecordIds(run.id, profileVersion);
  assertController(db, run.id, credentials);
  const priorExecutionSettings = previousPlanExecutionSettings(db, run);
  invariant(!priorExecutionSettings || Object.hasOwn(options, "executionSettings"),
    "FAST_PATH_EXECUTION_SETTINGS_REAPPROVAL", "이전 fast plan 승인 설정이 있으므로 새 실행 설정 승인이 필요합니다.");
  invariant(run.route?.executionApprovalRequired !== true || Object.hasOwn(options, "executionSettings"),
    "FAST_PATH_EXECUTION_SETTINGS_REQUIRED", "실행 승인 대상 fast plan을 materialize하려면 명시적인 실행 설정 승인이 필요합니다.");
  const contract = activeContract(db, run.id);
  const requirements = db.prepare("SELECT * FROM requirements WHERE run_id = ? AND status = 'active' ORDER BY id").all(run.id);
  const basis = fastPathBasis(run, contract, requirements);
  const expectedBasis = options?.expectedBasis
    ?? options?.basis
    ?? (options?.runRevision !== undefined ? options : null);
  if (expectedBasis) {
    invariant(stableStringify(expectedBasis) === stableStringify(basis),
      "FAST_PATH_BASIS_STALE", "Fast path eligibility basis is stale before materialization.");
  }
  const materialized = run.phase === "plan"
    && Boolean(db.prepare("SELECT 1 FROM artifacts WHERE run_id = ? AND id = ? AND status = 'verified'").get(run.id, ids.artifactIds[3]))
    && Boolean(db.prepare("SELECT 1 FROM artifacts WHERE run_id = ? AND id = ? AND status = 'verified'").get(run.id, ids.artifactIds[4]))
    && Number(db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id IN (${ids.taskIds.map(() => "?").join(",")})`).get(run.id, ...ids.taskIds)?.count ?? 0) === ids.taskIds.length;
  if (materialized) {
    if (options && Object.hasOwn(options, "executionSettings")) {
      const existingPlan = latestArtifact(db, projectRoot, run.id, "plan", ["verified"]);
      const existingSettings = parsedArtifact(existingPlan).executionSettings;
      const taskTargets = db.prepare("SELECT id, role FROM tasks WHERE run_id = ? ORDER BY created_at").all(run.id);
      const requestedSettings = normalizePlanExecutionSettings(options, run, taskTargets);
      const sameSettings = existingSettings?.mode === "exact"
        && Array.isArray(existingSettings.entries)
        && existingSettings.entries.length === requestedSettings.entries.length
        && requestedSettings.entries.every((entry) => {
          const currentEntry = existingSettings.entries.find((item) => item?.taskId === entry.taskId);
          return currentEntry?.model === entry.model
            && String(currentEntry?.requestedEffort ?? "").toLowerCase() === entry.requestedEffort
            && currentEntry?.userApproval?.status === "approved";
        });
      invariant(sameSettings, "FAST_PATH_EXECUTION_SETTINGS_REAPPROVAL", "기존 fast 계획의 실행 설정이 달라졌습니다. plan을 다시 열고 새 설정을 승인해야 합니다.");
    }
    // Replay is only idempotent when the exact deterministic plan approval and
    // every approved packet identity still describe the current task graph.
    // This also marks a ready packet stale when its blueprint has drifted.
    const current = planCurrent(db, projectRoot, run.id, config);
    invariant(current.pass, "FAST_PATH_PREREQUISITES_STALE", current.reason);
    invariant(current.plan?.id === ids.artifactIds[3] && current.review?.id === ids.artifactIds[4],
      "FAST_PATH_PREREQUISITES_STALE", "Fast path deterministic plan approval is no longer current.");
    const planTaskIds = (Array.isArray(current.planData?.tasks) ? current.planData.tasks : [])
      .map((task) => task?.id).sort();
    invariant(stableStringify(planTaskIds) === stableStringify([...ids.taskIds].sort()),
      "FAST_PATH_PREREQUISITES_STALE", "Fast path deterministic plan task set is no longer current.");
    return {
      run, artifactIds: ids.artifactIds, taskId: ids.taskIds[0], taskIds: ids.taskIds, milestoneId: ids.milestoneId
    };
  }
  const staleCanonicalPlan = db.prepare("SELECT id FROM artifacts WHERE run_id = ? AND id = ? AND kind = 'plan' AND status = 'stale'")
    .get(run.id, ids.artifactIds[3]);
  const rematerializing = Boolean(staleCanonicalPlan);
  const staleTaskIds = rematerializing ? ids.taskIds : [];
  const staleCheckpointIds = rematerializing
    ? db.prepare("SELECT id FROM checkpoints WHERE run_id = ? AND id LIKE ? AND status = 'pending'")
      .all(run.id, `planned-execution-${run.id}-%`).map((item) => item.id)
    : [];
  const eligibility = fastPathEligibility(db, run.id, {
    config,
    ...(rematerializing ? { ignoreTaskIds: staleTaskIds, ignoreCheckpointIds: staleCheckpointIds } : {})
  });
  invariant(eligibility.eligible, "FAST_PATH_INELIGIBLE", `Fast path is not eligible: ${eligibility.reasons.join("; ")}`);
  const requirement = requirements.length === 1 ? requirements[0] : null;
  const acceptance = parseJson(requirement.acceptance_json, []);
  invariant(Array.isArray(acceptance) && acceptance.length > 0, "FAST_PATH_ACCEPTANCE", "Fast path requirement acceptance criteria are missing.");
  const timestamp = now();
  return transaction(db, () => {
    assertController(db, run.id, credentials);
    const current = getRun(db, run.id);
    assertFastPathBasis(db, current, basis);
    invariant(current.phase === "discover", "FAST_PATH_PHASE", "Fast path prerequisites can only be materialized from discover.");
    validateMutableOwnershipPaths(projectRoot, eligibility.paths);
    const discovery = {
      version: 1, source: "bounded-fast-path", scope: eligibility.paths,
      knownFacts: ["The frozen contract explicitly bounds this change to the listed local paths."],
      unknowns: [], relevantPaths: eligibility.paths, interfaces: [], risks: []
    };
    const design = {
      version: 1, source: "bounded-fast-path", decision: "Reuse the existing lifecycle after one local implementation task.",
      requirementIds: [requirement.id], paths: eligibility.paths, interfaces: [], verification: ["Existing integration and adversarial review gates remain mandatory."]
    };
    const { artifactIds, milestoneId, taskIds } = ids;
    const taskSpecs = profileVersion === FAST_PATH_PROFILE_VERSION
      ? [
        {
          id: taskIds[0], title: "Implement the bounded local change", goal: contract.objective,
          role: "worker", taskKind: "implementation", phase: "execute", wave: 1, readOnly: false,
          targetPaths: eligibility.paths, scope: eligibility.paths, verificationModes: ["test"],
          acceptance, requiredEvidence: ["Current test evidence and owned-file references"],
          contextRefs: ["artifact:goal-contract", "artifact:discovery", "artifact:design", "artifact:plan"],
          expectedOutputs: ["implementation"], authority: "local-write-assigned-paths", dependsOn: []
        },
        {
          id: taskIds[1], title: "Independently verify the integrated change", goal: "Verify the bounded requirement against the immutable integrated candidate without modifying it.",
          role: "verifier", taskKind: "verification", phase: "review", wave: 1, readOnly: true,
          targetPaths: [], scope: eligibility.paths, verificationModes: ["test", "semantic"], acceptance,
          requiredEvidence: ["Current independent verification evidence", "Immutable integrated-candidate reference"],
          contextRefs: ["artifact:plan", "artifact:integration-candidate"],
          expectedOutputs: ["verification-evidence"], authority: "local-read", dependsOn: [taskIds[0]]
        }
      ]
      : [
        {
          id: taskIds[0], title: "Implement the bounded local change", goal: contract.objective,
          role: "worker", taskKind: "implementation", phase: "execute", wave: 1, readOnly: false,
          targetPaths: eligibility.paths, scope: eligibility.paths, verificationModes: ["test"],
          acceptance, requiredEvidence: ["Current test evidence and owned-file references"],
          contextRefs: ["artifact:goal-contract", "artifact:discovery", "artifact:design", "artifact:plan"],
          expectedOutputs: ["implementation"], authority: "local-write-assigned-paths", dependsOn: []
        },
        {
          id: taskIds[1], title: "Independently review the integrated change", goal: "Review the integrated bounded change without modifying it.",
          role: "reviewer", taskKind: "review", phase: "review", wave: 1, readOnly: true,
          targetPaths: [], scope: eligibility.paths, verificationModes: [], acceptance: ["Return an explicit integration-review verdict with current evidence."],
          requiredEvidence: ["Current integrated repository fingerprint and source references"], contextRefs: ["artifact:plan"],
          expectedOutputs: ["integration-review-result"], authority: "local-read", reviewKind: "integration", dependsOn: [taskIds[0]]
        },
        {
          id: taskIds[2], title: "Independently verify the requirement", goal: "Verify the bounded requirement against the integrated repository.",
          role: "verifier", taskKind: "verification", phase: "review", wave: 1, readOnly: true,
          targetPaths: [], scope: eligibility.paths, verificationModes: ["test", "semantic"], acceptance,
          requiredEvidence: ["Current independent verification evidence"], contextRefs: ["artifact:plan"],
          expectedOutputs: ["verification-evidence"], authority: "local-read", dependsOn: [taskIds[0]]
        },
        {
          id: taskIds[3], title: "Adversarially review the completion candidate", goal: "Challenge the current verification candidate for hidden failures.",
          role: "adversarial-reviewer", taskKind: "review", phase: "verify", wave: 2, readOnly: true,
          targetPaths: [], scope: eligibility.paths, verificationModes: [], acceptance: ["Return an explicit completion-review verdict with evidence-backed findings."],
          requiredEvidence: ["Current verification-candidate fingerprint"], contextRefs: ["artifact:verification-candidate"],
          expectedOutputs: ["completion-review-result"], authority: "local-read", reviewKind: "completion", dependsOn: [taskIds[1], taskIds[2]]
        },
        {
          id: taskIds[4], title: "Curate verified final knowledge", goal: "Synchronize project knowledge using only verified final behavior.",
          role: "curator", taskKind: "curation", phase: "curate", wave: 1, readOnly: true,
          targetPaths: [], scope: eligibility.paths, verificationModes: [], acceptance: ["Knowledge synchronization reflects only verified final behavior."],
          requiredEvidence: ["Current verification and completion-review evidence"], contextRefs: ["artifact:verification-candidate", "artifact:completion-review"],
          expectedOutputs: ["artifact:knowledge-sync"], authority: "local-read", dependsOn: [taskIds[3]]
        }
      ];
    for (const task of taskSpecs) {
      task.capabilities = resolveTaskCapabilities(db, run.id, {
        role: task.role,
        taskKind: task.taskKind,
        targetPaths: task.targetPaths,
        requirementIds: [requirement.id],
        verificationModes: task.verificationModes
      });
    }
    invariant(
      specialistRolesForCapabilities(taskSpecs[0].capabilities).length === 0,
      "FAST_PATH_SPECIALIST_REVIEW",
      "Fast path implementation resolved a required specialist review."
    );
    const executionSettings = normalizePlanExecutionSettings(options, current, taskSpecs);
    invariant(current.route?.executionApprovalRequired !== true || executionSettings,
      "FAST_PATH_EXECUTION_SETTINGS_REQUIRED", "실행 승인 대상 fast plan을 materialize하려면 명시적인 실행 설정 승인이 필요합니다.");
    const deterministicPlanDraft = {
      version: 1,
      source: profileVersion === FAST_PATH_PROFILE_VERSION ? FAST_PATH_V2_SOURCE : FAST_PATH_SOURCE,
      ...(profileVersion === FAST_PATH_PROFILE_VERSION ? { fastPathProfileVersion: FAST_PATH_PROFILE_VERSION } : {}),
      parallelism: {
        eligible: false,
        minimumSameWaveImplementationTasks: 4,
        independentSlices: 1,
        desiredWidth: 1,
        rationale: "The frozen fast profile has one bounded mutable implementation slice."
      },
      verificationParallelism: {
        eligible: false,
        rationale: "The requirement acceptance list is one bounded verifier evidence boundary.",
        evidenceRefs: [`requirement:${requirement.id}`]
      },
      plannedTaskIds: [...taskIds]
    };
    const plan = {
      version: 1, source: profileVersion === FAST_PATH_PROFILE_VERSION ? FAST_PATH_V2_SOURCE : FAST_PATH_SOURCE,
      ...(profileVersion === FAST_PATH_PROFILE_VERSION ? { fastPathProfileVersion: FAST_PATH_PROFILE_VERSION } : {}),
      interfaces: [],
      milestones: [{ id: milestoneId, title: "Bounded implementation", objective: contract.objective,
        userVisibleOutcome: contract.successCriteria[0], exitCriteria: acceptance, requirementIds: [requirement.id] }],
      tasks: taskSpecs.map((task) => ({
        id: task.id, title: task.title, goal: task.goal, role: task.role, taskKind: task.taskKind,
        runPhase: task.phase, wave: task.wave, readOnly: task.readOnly, targetPaths: task.targetPaths,
        scope: task.scope, verificationModes: task.verificationModes, requirementIds: [requirement.id],
        acceptanceCriteria: task.acceptance, requiredEvidence: task.requiredEvidence,
        expectedOutputs: task.expectedOutputs, capabilities: task.capabilities.map((item) => item.name),
        reviewKind: task.reviewKind ?? null, dependsOn: task.dependsOn
      })),
      planDraft: deterministicPlanDraft,
      ...(executionSettings ? { executionSettings } : {})
    };
    const fastSource = profileVersion === FAST_PATH_PROFILE_VERSION ? FAST_PATH_V2_SOURCE : FAST_PATH_SOURCE;
    const fastMetadata = {
      source: fastSource,
      ...(profileVersion === FAST_PATH_PROFILE_VERSION ? { fastPathProfileVersion: FAST_PATH_PROFILE_VERSION } : {})
    };
    putArtifact(db, projectRoot, run.id, "discovery", { ...discovery, source: fastSource }, { id: artifactIds[0], status: "verified", metadata: { ...fastMetadata, immutable: true } });
    putArtifact(db, projectRoot, run.id, "research", { source: fastSource, waived: true }, { id: artifactIds[1], status: "waived", metadata: fastMetadata });
    putArtifact(db, projectRoot, run.id, "design", { ...design, source: fastSource }, { id: artifactIds[2], status: "verified", metadata: { ...fastMetadata, immutable: true } });
    db.prepare(`INSERT OR IGNORE INTO milestones(
      id, run_id, title, objective, status, sequence, acceptance_json, entry_criteria_json,
      exit_criteria_json, user_visible_outcome, requirement_ids_json, created_at, updated_at
    ) VALUES(?, ?, ?, ?, 'pending', 1, ?, '[]', ?, ?, ?, ?, ?)`).run(
      milestoneId, run.id, "Bounded implementation", contract.objective, json(acceptance),
      json(acceptance), contract.successCriteria[0], json([requirement.id]), timestamp, timestamp
    );
    const insertTask = db.prepare(`INSERT OR IGNORE INTO tasks(
      id, run_id, milestone_id, title, goal, role, task_kind, wave, phase, status, priority,
      read_only, complexity, risk, effort, slice_type, verification_modes_json, scope_json,
      capabilities_json, non_goals_json, constraints_json, target_paths_json, context_refs_json, expected_outputs_json,
      acceptance_json, required_evidence_json, requirement_ids_json, review_kind, auto_generated,
      authority, max_attempts, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 50, ?, 'low', 'low', 'small', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
    for (const task of taskSpecs) {
      insertTask.run(
        task.id, run.id, milestoneId, task.title, task.goal, task.role, task.taskKind, task.wave, task.phase,
        task.readOnly ? 1 : 0, task.taskKind === "review" ? "review" : task.taskKind === "verification" ? "verification" : task.taskKind === "curation" ? "curation" : "vertical",
        json(task.verificationModes), json(task.scope), json(task.capabilities.map((item) => item.name)), json(contract.nonGoals), json(contract.constraints),
        json(task.targetPaths), json(task.contextRefs), json(task.expectedOutputs), json(task.acceptance),
        json(task.requiredEvidence), json([requirement.id]), task.reviewKind ?? null, task.authority,
        Number(config?.orchestration?.maxRetries ?? 2) + 1, timestamp, timestamp
      );
      const route = selectModelRoute(config, task.role, { host: run.host, complexity: "low" });
      db.prepare(`
        UPDATE tasks SET model_tier = ?, selected_model = ?, model_source = ?,
          requested_effort = ?, effective_effort = ?, effort_source = ?,
          supported_efforts_json = ?, capability_status = ?, reasoning_effort = ?
        WHERE run_id = ? AND id = ?
      `).run(
        route.tier, route.model, route.modelSource,
        route.requestedEffort, route.effectiveEffort, route.effortSource,
        json(route.supportedEfforts ?? []), route.capabilityStatus ?? "known", route.reasoningEffort,
        run.id, task.id
      );
      bindTaskCapabilities(db, task.id, task.capabilities);
    }
    if (executionSettings) applyPlanExecutionSettings(db, current, taskSpecs, executionSettings, config);
    const routeRows = db.prepare(`SELECT id, model_tier, selected_model, model_source,
      requested_effort, effective_effort, effort_source, supported_efforts_json, capability_status, reasoning_effort
      FROM tasks WHERE run_id = ? ORDER BY created_at`).all(run.id);
    const routeByTaskId = new Map(routeRows.map((row) => [row.id, row]));
    plan.tasks = plan.tasks.map((task) => {
      const route = routeByTaskId.get(task.id);
      return {
        ...task,
        model: route?.selected_model ?? null,
        requestedEffort: route?.requested_effort ?? null,
        effectiveEffort: route?.effective_effort ?? null,
        effortStatus: route?.capability_status ?? "unknown",
        effortSource: route?.effort_source ?? null,
        supportedEfforts: parseJson(route?.supported_efforts_json, []),
        reasoningEffort: route?.reasoning_effort ?? null
      };
    });
    if (executionSettings) {
      plan.executionSettings = {
        ...executionSettings,
        entries: plan.tasks.map((task) => ({
          taskId: task.id,
          host: executionSettings.host,
          model: task.model,
          requestedEffort: task.requestedEffort,
          effectiveEffort: task.effectiveEffort,
          effortStatus: task.effortStatus,
          effortSource: task.effortSource,
          supportedEfforts: task.supportedEfforts,
          userApproval: executionSettings.entries.find((entry) => entry.taskId === task.id)?.userApproval
        }))
      };
    }
    plan.planHash = sha256(stableStringify(plan));
    const planArtifact = putArtifact(db, projectRoot, run.id, "plan", plan, {
      id: artifactIds[3],
      status: "verified",
      metadata: {
        ...fastMetadata,
        planHash: plan.planHash,
        planDraftHash: sha256(stableStringify(deterministicPlanDraft)),
        immutable: true
      }
    });
    for (const task of taskSpecs) {
      for (const dependency of task.dependsOn) db.prepare("INSERT OR IGNORE INTO task_dependencies(task_id, depends_on) VALUES(?, ?)").run(task.id, dependency);
      db.prepare(`INSERT INTO trace_links(id, run_id, requirement_id, target_type, target_id, relation, status, evidence_refs_json, created_at, updated_at)
        VALUES(?, ?, ?, 'task', ?, 'planned-by', 'current', '[]', ?, ?)
        ON CONFLICT(run_id, requirement_id, target_type, target_id, relation) DO UPDATE SET status = 'current', updated_at = excluded.updated_at`)
        .run(makeId("trace"), run.id, requirement.id, task.id, timestamp, timestamp);
    }
    validateGraph(db, run.id);
    validateMilestoneGraph(db, run.id);
    const packetBindings = taskIds.map((taskId) => {
      const packet = compileTaskPacket(db, projectRoot, taskId, config);
      invariant(packet.status === "ready" && packet.id && packet.packetHash && packet.blueprintHash,
        "FAST_PATH_PACKET_NOT_READY", `Fast path task ${taskId} did not produce a ready deterministic packet.`);
      return {
        taskId,
        packetId: packet.id,
        packetHash: packet.packetHash,
        packetBlueprintHash: packet.blueprintHash,
        blueprintHash: packet.blueprintHash,
        compiledBlueprintHash: packet.blueprintHash,
        packetRef: packet.packetRef,
        version: packet.version
      };
    });
    const packetSetHash = sha256(stableStringify(normalizedPacketBindings(packetBindings)));
    const deterministicReview = {
      version: 5,
      ...(contract.route.executionApprovalRequired === true ? { executionApprovalEpoch: makeId("execution-approval") } : {}),
      source: fastSource,
      ...(profileVersion === FAST_PATH_PROFILE_VERSION ? { fastPathProfileVersion: FAST_PATH_PROFILE_VERSION } : {}),
      deterministic: true,
      planArtifactId: planArtifact.id,
      planContentRef: planArtifact.content_ref,
      planHash: plan.planHash,
      contractVersion: run.contract_version,
      packetBindings,
      packetSetHash,
      reviewerTaskId: null,
      verdict: "APPROVED",
      findings: [],
      reviewedAt: timestamp
    };
    putArtifact(db, projectRoot, run.id, "plan-review", deterministicReview, {
      id: artifactIds[4],
      status: "verified",
      metadata: {
        source: fastSource,
        ...(profileVersion === FAST_PATH_PROFILE_VERSION ? { fastPathProfileVersion: FAST_PATH_PROFILE_VERSION } : {}),
        deterministic: true,
        planArtifactId: planArtifact.id,
        planContentRef: planArtifact.content_ref,
        planHash: plan.planHash,
        contractVersion: run.contract_version,
        packetBindings,
        packetSetHash,
        verdict: "APPROVED",
        blockingFindings: 0
      }
    });
    recordEvent(db, run.id, "plan.reviewed", "info", {
      artifactId: artifactIds[4],
      reviewerTaskId: null,
      planHash: plan.planHash,
      packetBindings,
      packetSetHash,
      verdict: "APPROVED",
      blockingFindings: 0,
      source: fastSource,
      ...(profileVersion === FAST_PATH_PROFILE_VERSION ? { fastPathProfileVersion: FAST_PATH_PROFILE_VERSION } : {})
    });
    const moved = db.prepare(`UPDATE runs SET phase = 'plan', updated_at = ?, revision = revision + 1
      WHERE id = ? AND phase = 'discover' AND controller_session_id = ? AND controller_owner = ?
        AND controller_token = ? AND controller_fencing_token = ?`).run(
      timestamp, run.id, credentials.sessionId, credentials.owner, credentials.token, Number(credentials.fencingToken)
    );
    invariant(moved.changes === 1, "CONTROLLER_FENCED", "Fast path materialization lost controller ownership.");
    ensurePlannedExecutionCheckpoint(db, projectRoot, run.id, config);
    recordEvent(db, run.id, "fast-path.materialized", "info", { taskIds, paths: eligibility.paths, controllerFencingToken: credentials.fencingToken });
    return {
      run: getRun(db, run.id), artifactIds,
      taskId: taskIds[0], taskIds, milestoneId
    };
  });
}

export function startRun(db, projectRoot, config, goal, options = {}) {
  invariant(goal?.trim(), "GOAL_REQUIRED", "A non-empty goal is required.");
  const normalizedGoal = goal.trim();
  const existing = activeRun(db);
  if (existing) {
    if (existing.goal_hash !== sha256(normalizedGoal)) {
      throw new MetisError("ACTIVE_RUN_EXISTS", `Run ${existing.id} already controls this repository. Pause or complete it before starting another goal.`, { runId: existing.id });
    }
    invariant(options.planOnly !== true || parseJson(existing.route_json, {}).executionApprovalRequired === true,
      "RUN_PLAN_ONLY_MISMATCH", "기존 일반 실행을 plan-only 시작으로 재사용할 수 없습니다. 명시적으로 계약을 변경해야 합니다.");
    const supplied = options.controller ?? null;
    const same = supplied
      && supplied.sessionId === existing.controller_session_id
      && supplied.owner === existing.controller_owner
      && supplied.token === existing.controller_token
      && Number(supplied.fencingToken) === Number(existing.controller_fencing_token);
    if (same && Date.parse(existing.controller_expires_at) > Date.now()) {
      return { run: getRun(db, existing.id), resumed: true, controller: controllerCredentials(existing) };
    }
    if (options.takeover === true && Date.parse(existing.controller_expires_at) <= Date.now()) {
      const controller = takeoverController(db, existing.id, {
        sessionId: options.controllerSessionId,
        owner: options.controllerOwner,
        leaseSeconds: config.controller?.leaseSeconds
      });
      return { run: getRun(db, existing.id), resumed: true, takeover: true, controller };
    }
    throw new MetisError("RUN_ALREADY_CONTROLLED", `Run ${existing.id} is already controlled by another Main session.`, {
      runId: existing.id,
      controllerOwner: existing.controller_owner,
      controllerSessionId: existing.controller_session_id,
      controllerExpiresAt: existing.controller_expires_at
    });
  }

  syncRepository(db, projectRoot, config, null);
  const timestamp = now();
  const id = makeId("run");
  const lease = newControllerLease({
    sessionId: options.controllerSessionId,
    owner: options.controllerOwner,
    leaseSeconds: config.controller?.leaseSeconds
  });
  const result = transaction(db, () => {
    try {
      db.prepare(`
        INSERT INTO runs(
          id, goal, goal_hash, controller, controller_session_id, controller_owner,
          controller_fencing_token, controller_token, controller_expires_at,
          phase, status, host, approval_policy, project_root, baseline_ref,
          contract_version, complexity, route_json, last_progress_at, created_at, updated_at
        ) VALUES(?, ?, ?, 'metis', ?, ?, ?, ?, ?, 'intake', 'active', ?, ?, ?, ?, 0, 'standard', '{}', ?, ?, ?)
      `).run(
        id, normalizedGoal, sha256(normalizedGoal), lease.sessionId, lease.owner,
        lease.fencingToken, lease.token, lease.expiresAt,
        options.host ?? config.host, options.approvalPolicy ?? config.approvalPolicy,
        projectRoot, currentGitRef(projectRoot), timestamp, timestamp, timestamp
      );
    } catch (error) {
      if (String(error?.message ?? "").includes("UNIQUE")) {
        throw new MetisError("ACTIVE_RUN_RACE", "Another controller started a run concurrently.");
      }
      throw error;
    }
    if (options.planOnly === true) {
      db.prepare("UPDATE runs SET route_json = ? WHERE id = ?").run(json({ executionApprovalRequired: true }), id);
    }
    initializeBudget(db, id, config);
    recordEvent(db, id, "run.started", "info", {
      goal: normalizedGoal, phase: "intake", controller: "metis",
      controllerSessionId: lease.sessionId, controllerFencingToken: lease.fencingToken
    });
    return { run: getRun(db, id), resumed: false, controller: lease };
  });
  const baseline = {
    gitRef: result.run.baseline_ref,
    codeFingerprint: repositoryCodeFingerprint(db),
    preexistingChanges: currentGitChanges(projectRoot, config).paths
  };
  const artifact = putArtifact(db, projectRoot, result.run.id, "workspace-baseline", baseline, {
    status: "verified", metadata: { immutable: true }
  });
  return { ...result, run: getRun(db, result.run.id), baselineArtifactId: artifact.id };
}

export function recordEvent(db, runId, type, severity = "info", payload = {}) {
  const timestamp = now();
  const safePayload = redactValue(payload);
  const fingerprint = sha256(stableStringify({ type, payload: safePayload }));
  db.prepare(`
    INSERT INTO events(run_id, type, severity, payload_json, fingerprint, count, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(run_id, fingerprint) DO UPDATE SET
      count = events.count + 1,
      severity = excluded.severity,
      updated_at = excluded.updated_at
  `).run(runId, type, severity, json(safePayload), fingerprint, timestamp, timestamp);
  appendJournal(db, runId, type, safePayload, {
    actor: "runtime",
    entityType: safePayload.taskId ? "task" : safePayload.requirementId ? "requirement" : safePayload.artifactId ? "artifact" : "run",
    entityId: safePayload.taskId ?? safePayload.requirementId ?? safePayload.artifactId ?? runId
  });
  return db.prepare("SELECT * FROM events WHERE run_id IS ? AND fingerprint = ?").get(runId, fingerprint);
}

export function putArtifact(db, projectRoot, runId, kind, content, options = {}) {
  const run = getRun(db, runId);
  const timestamp = now();
  const id = options.id ?? makeId("art");
  const existingSource = db.prepare(`SELECT a.path FROM artifacts a WHERE a.id = ? AND EXISTS (
    SELECT 1 FROM goal_contracts c WHERE json_extract(c.route_json, '$.sourceDocument.artifactId') = a.id
  )`).get(id);
  invariant(!existingSource || existingSource.path === (options.path ?? null), "GOAL_SOURCE_PATH_IMMUTABLE",
    "계약에 연결된 source artifact 경로는 바꿀 수 없습니다. 새 PRD snapshot과 명시적인 contract amend를 사용하세요.");
  const contentRef = content === undefined || content === null
    ? null
    : storeObject(db, projectRoot, `artifact:${kind}`, typeof content === "string" ? content : stableStringify(content), { redact: true });
  db.prepare(`
    INSERT INTO artifacts(id, run_id, task_id, kind, path, status, content_ref, metadata_json, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path = excluded.path,
      status = excluded.status,
      content_ref = excluded.content_ref,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(
    id,
    run.id,
    options.taskId ?? null,
    kind,
    options.path ?? null,
    options.status ?? "verified",
    contentRef,
    json(options.metadata ?? {}),
    timestamp,
    timestamp
  );
  touchRun(db, run.id);
  recordEvent(db, run.id, "artifact.updated", "info", { id, artifactId: id, kind, status: options.status ?? "verified" });
  return getArtifact(db, projectRoot, id);
}

export function waiveArtifact(db, projectRoot, runId, kind, reason) {
  invariant(reason?.trim(), "WAIVER_REASON_REQUIRED", "A waiver needs a reason.");
  return putArtifact(db, projectRoot, runId, kind, { reason: reason.trim() }, { status: "waived" });
}

export function getArtifact(db, projectRoot, artifactId) {
  const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId);
  invariant(row, "ARTIFACT_NOT_FOUND", `Artifact ${artifactId} was not found.`);
  return {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
    content: row.content_ref ? readObject(db, projectRoot, row.content_ref) : null
  };
}

export function latestArtifact(db, projectRoot, runId, kind, statuses = ["verified", "waived"]) {
  const placeholders = statuses.map(() => "?").join(",");
  const row = db.prepare(`
    SELECT * FROM artifacts
    WHERE run_id = ? AND kind = ? AND status IN (${placeholders})
    ORDER BY updated_at DESC LIMIT 1
  `).get(runId, kind, ...statuses);
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
    content: row.content_ref ? readObject(db, projectRoot, row.content_ref) : null
  };
}

export function touchRun(db, runId) {
  db.prepare("UPDATE runs SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(now(), runId);
}

function parsedArtifact(artifact) {
  if (!artifact?.content) return {};
  try { return JSON.parse(artifact.content); } catch { return { text: artifact.content }; }
}

const PROTECTED_LIFECYCLE_ARTIFACT_KINDS = new Set([
  "goal-contract",
  "design-seal",
  "design-review",
  "plan",
  "plan-review",
  "integration-candidate",
  "integration-review",
  "verification-candidate",
  "completion-review",
  "knowledge-sync",
  "self-evaluation"
]);

export function isProtectedLifecycleArtifactKind(kind) {
  const value = String(kind ?? "");
  return PROTECTED_LIFECYCLE_ARTIFACT_KINDS.has(value) || value.startsWith("review-approval:");
}

function approvalTasksAreCompleted(db, runId, data, reviewKind) {
  const ids = Array.isArray(data?.reviewerTaskIds)
    ? [...new Set(data.reviewerTaskIds.map((id) => String(id).trim()).filter(Boolean))]
    : [];
  if (data?.verdict !== "APPROVED" || ids.length === 0) return false;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, role, review_kind, status, result_json FROM tasks
    WHERE run_id = ? AND id IN (${placeholders})
  `).all(runId, ...ids);
  if (rows.length !== ids.length) return false;
  return rows.every((task) => {
    const effectiveKind = task.review_kind ?? (task.role === "adversarial-reviewer" ? "completion" : "integration");
    const result = parseJson(task.result_json, {});
    const correctRole = reviewKind === "completion"
      ? task.role === "adversarial-reviewer"
      : REVIEW_ROLES.has(task.role) && task.role !== "adversarial-reviewer";
    return correctRole
      && task.status === "completed"
      && effectiveKind === reviewKind
      && String(result?.Verdict ?? "REJECTED").toUpperCase() === "APPROVED";
  });
}

function requireArtifact(db, projectRoot, runId, kind, statuses = ["verified", "waived"]) {
  const artifact = latestArtifact(db, projectRoot, runId, kind, statuses);
  invariant(artifact, "GATE_ARTIFACT_REQUIRED", `The ${kind} artifact is required before this phase transition.`);
  return artifact;
}

function routeForRun(db, runId) {
  const row = db.prepare(`
    SELECT route_json FROM goal_contracts
    WHERE run_id = ? AND status = 'active'
    ORDER BY version DESC LIMIT 1
  `).get(runId);
  return lifecycleRoute(parseJson(row?.route_json, {}));
}

function normalizedPacketBindings(bindings) {
  if (!Array.isArray(bindings)) return null;
  return bindings.map((binding) => ({
    taskId: binding?.taskId ?? null,
    packetId: binding?.packetId ?? null,
    packetHash: binding?.packetHash ?? null,
    packetBlueprintHash: binding?.packetBlueprintHash ?? binding?.blueprintHash ?? null,
    blueprintHash: binding?.blueprintHash ?? binding?.packetBlueprintHash ?? null,
    compiledBlueprintHash: binding?.compiledBlueprintHash
      ?? binding?.packetBlueprintHash
      ?? binding?.blueprintHash
      ?? null,
    packetRef: binding?.packetRef ?? null,
    version: binding?.version ?? null
  })).sort((left, right) => String(left.taskId).localeCompare(String(right.taskId)));
}

function fastPlanPacketsCurrent(db, runId, planData, review, reviewData, config) {
  const bindings = normalizedPacketBindings(reviewData.packetBindings);
  const metadataBindings = normalizedPacketBindings(review.metadata?.packetBindings);
  if (!bindings || bindings.length === 0) return { pass: false, reason: "Deterministic plan approval has no compiled task packet bindings." };
  if (!metadataBindings || stableStringify(bindings) !== stableStringify(metadataBindings)) {
    return { pass: false, reason: "Deterministic plan approval packet bindings do not match its metadata." };
  }
  const packetSetHash = sha256(stableStringify(bindings));
  if (reviewData.packetSetHash !== packetSetHash || review.metadata?.packetSetHash !== packetSetHash) {
    return { pass: false, reason: "Deterministic plan approval packet set hash is invalid." };
  }
  const planTaskIds = (Array.isArray(planData.tasks) ? planData.tasks : []).map((task) => task?.id).sort();
  const bindingTaskIds = bindings.map((binding) => binding.taskId).sort();
  if (planTaskIds.length !== bindingTaskIds.length
      || planTaskIds.some((taskId, index) => taskId !== bindingTaskIds[index])
      || new Set(bindingTaskIds).size !== bindingTaskIds.length) {
    return { pass: false, reason: "Deterministic plan approval does not bind exactly the sealed plan task set." };
  }
  for (const binding of bindings) {
    let current;
    try {
      current = taskPacketStatus(db, binding.taskId, config);
    } catch {
      return { pass: false, reason: `Deterministic plan task packet ${binding.taskId} is missing.` };
    }
    if (!current.current) {
      return { pass: false, reason: `Deterministic plan task packet ${binding.taskId} is missing or stale.` };
    }
    if (current.packetId !== binding.packetId
        || current.packetHash !== binding.packetHash
        || current.blueprintHash !== binding.blueprintHash
        || current.compiledBlueprintHash !== binding.compiledBlueprintHash) {
      return { pass: false, reason: `Deterministic plan task packet ${binding.taskId} differs from the approved packet set.` };
    }
    const row = db.prepare("SELECT task_id, version, packet_ref FROM task_packets WHERE id = ? AND status = 'ready'").get(binding.packetId);
    if (!row || row.task_id !== binding.taskId || row.version !== binding.version || row.packet_ref !== binding.packetRef) {
      return { pass: false, reason: `Deterministic plan task packet ${binding.taskId} differs from the approved packet identity.` };
    }
  }
  return { pass: true };
}

export function lifecycleRoute(route) {
  const canonical = route ?? {};
  invariant(!Object.hasOwn(canonical, "independentReviewRequired"), "LIFECYCLE_ROUTE_OBSOLETE", "Route field independentReviewRequired is obsolete; lifecycleProfile controls mandatory review gates.");
  invariant(!Object.hasOwn(canonical, "adversarialReviewRequired"), "LIFECYCLE_ROUTE_OBSOLETE", "Route field adversarialReviewRequired is obsolete; lifecycleProfile controls mandatory review gates.");
  invariant(!Object.hasOwn(canonical, "executionApprovalRequired") || typeof canonical.executionApprovalRequired === "boolean",
    "LIFECYCLE_EXECUTION_APPROVAL_BOOLEAN", "route.executionApprovalRequired는 boolean이어야 합니다.");
  const profile = canonical.lifecycleProfile;
  if (profile === "fast") {
    return { ...canonical, researchRequired: false, designRequired: false, specialistReviewRequired: false };
  }
  if (profile === "full") {
    return {
      ...canonical,
      researchRequired: true,
      designRequired: true
    };
  }
  return canonical;
}

export function lifecycleReviewRequired(route, config, kind) {
  // Every lifecycle profile requires independent integration review and
  // adversarial completion review. Verification is gated separately by the
  // required verification artifact and is likewise never configurable off.
  const profile = lifecycleRoute(route).lifecycleProfile;
  invariant(LIFECYCLE_PROFILES.has(profile), "LIFECYCLE_PROFILE_REQUIRED", "A lifecycleProfile is required to evaluate lifecycle review gates.");
  return true;
}

function nonTerminalTasks(db, runId, phase) {
  return db.prepare(`
    SELECT id, role, status FROM tasks
    WHERE run_id = ? AND phase = ? AND status NOT IN ('completed','waived')
    ORDER BY priority DESC, created_at
  `).all(runId, phase);
}

function completedTaskCount(db, runId, phase) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND phase = ? AND status = 'completed'").get(runId, phase)?.count ?? 0);
}

function addPhaseTaskFailures(db, runId, phase, failures) {
  const pending = nonTerminalTasks(db, runId, phase);
  if (pending.length > 0) failures.push(`${phase} tasks are not terminal: ${pending.map((task) => `${task.id}:${task.status}`).join(", ")}`);
}

function activeContract(db, runId) {
  const row = db.prepare(`
    SELECT * FROM goal_contracts WHERE run_id = ? AND status = 'active'
    ORDER BY version DESC LIMIT 1
  `).get(runId);
  return row ? {
    ...row,
    scope: parseJson(row.scope_json, []),
    nonGoals: parseJson(row.non_goals_json, []),
    constraints: parseJson(row.constraints_json, []),
    successCriteria: parseJson(row.success_criteria_json, []),
    route: lifecycleRoute(parseJson(row.route_json, {}))
  } : null;
}

function planCurrent(db, projectRoot, runId, config, validatePackets = true) {
  const plan = latestArtifact(db, projectRoot, runId, "plan", ["verified"]);
  if (!plan) return { pass: false, reason: "Sealed plan is missing." };
  const planData = parsedArtifact(plan);
  const deterministicFastPlan = ["bounded-fast-path", "bounded-fast-path-v2"].includes(planData.source)
    || ["bounded-fast-path", "bounded-fast-path-v2"].includes(plan.metadata?.source);
  const requireReview = config?.orchestration?.requirePlanCritic !== false || deterministicFastPlan;
  const review = requireReview ? latestArtifact(db, projectRoot, runId, "plan-review", ["verified"]) : null;
  if (!review) {
    if (!requireReview) return { pass: true, plan, review: null, planData, reviewData: null };
    return { pass: false, reason: "Plan review is missing." };
  }
  const reviewData = parsedArtifact(review);
  if (reviewData.verdict !== "APPROVED") return { pass: false, reason: "Plan review is not approved." };
  if (reviewData.planArtifactId !== plan.id || reviewData.planContentRef !== plan.content_ref) {
    return { pass: false, reason: "Plan review does not reference the current sealed plan." };
  }
  if (reviewData.planHash && planData.planHash && reviewData.planHash !== planData.planHash) {
    return { pass: false, reason: "Plan review hash does not match the current plan." };
  }
  if (deterministicFastPlan && validatePackets) {
    const packets = fastPlanPacketsCurrent(db, runId, planData, review, reviewData, config);
    if (!packets.pass) return { pass: false, reason: packets.reason };
  }
  return { pass: true, plan, review, planData, reviewData };
}

function executionTaskRouteBinding(db, projectRoot, runId, planData) {
  const executionPhases = new Set(["execute", "review", "verify", "curate"]);
  const plannedTaskIds = (Array.isArray(planData?.tasks) ? planData.tasks : [])
    .filter((task) => executionPhases.has(task?.runPhase))
    .map((task) => String(task.id));
  const currentTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE run_id = ? AND phase IN ('execute', 'review', 'verify', 'curate')
    ORDER BY id
  `).all(runId);
  const currentTaskIds = currentTasks.map((task) => String(task.id));
  const sameTaskSet = plannedTaskIds.length === currentTaskIds.length
    && new Set(plannedTaskIds).size === plannedTaskIds.length
    && new Set(currentTaskIds).size === currentTaskIds.length
    && plannedTaskIds.every((taskId) => currentTaskIds.includes(taskId));
  if (!sameTaskSet) {
    return {
      pass: false,
      reason: "현재 execution task set이 sealed plan과 일치하지 않습니다.",
      plannedTaskIds,
      currentTaskIds
    };
  }
  for (const task of currentTasks) {
    const binding = taskPlanExecutionSettingStatus(db, projectRoot, runId, task);
    if (!binding.pass) {
      return {
        pass: false,
        taskId: task.id,
        reason: binding.reason,
        current: binding.current ?? null,
        approved: binding.entry ?? null
      };
    }
  }
  return { pass: true, plannedTaskIds, currentTaskIds };
}

// 실행 허가는 검토 결과가 아니라 현재 계약과 계획 seal에 묶인 별도 사용자 결정입니다.
export function plannedExecutionApprovalStatus(db, projectRoot, runId, config = null) {
  const run = getRun(db, runId);
  const contract = activeContract(db, run.id);
  const required = contract?.route.executionApprovalRequired === true || run.route.executionApprovalRequired === true;
  const empty = { required, pass: !required, checkpointId: null, checkpoint: null, basis: null };
  if (!required) return empty;
  const effectiveConfig = config ?? loadConfig(projectRoot);
  const hasReview = Boolean(db.prepare("SELECT 1 FROM artifacts WHERE run_id = ? AND kind = 'plan-review' AND status = 'verified'").get(run.id));
  const current = planCurrent(db, projectRoot, run.id, {
    ...effectiveConfig,
    orchestration: { ...effectiveConfig.orchestration, ...(hasReview ? { requirePlanCritic: true } : {}) }
  }, false); // 실행 중 packet 갱신은 정상입니다. packet 검증은 기존 execute 진입 gate가 담당합니다.
  if (!current.pass) return { ...empty, reason: current.reason };
  const contractMatches = current.planData.contract?.contractHash === contract?.contract_hash
    || Number(current.reviewData?.contractVersion) === Number(contract?.version);
  if (!contract || !contractMatches) {
    return { ...empty, reason: "현재 계약에 해당하는 계획 seal이 필요합니다." };
  }
  const basis = {
    contractVersion: contract.version,
    contractHash: contract.contract_hash,
    planArtifactId: current.plan.id,
    planContentRef: current.plan.content_ref,
    planHash: current.planData.planHash ?? null,
    planUpdatedAt: current.plan.updated_at,
    reviewArtifactId: current.review?.id ?? null,
    reviewContentRef: current.review?.content_ref ?? null
  };
  const checkpointId = `planned-execution-${run.id}-${sha256(stableStringify(basis))}`;
  const row = db.prepare("SELECT id FROM checkpoints WHERE id = ? AND run_id = ?").get(checkpointId, run.id);
  const checkpoint = row ? getCheckpoint(db, checkpointId) : null;
  const settings = planExecutionSettings(db, projectRoot, run.id);
  if (settings.invalid || !settings.explicit) {
    return {
      required, pass: false, checkpointId, checkpoint, basis,
      routeBinding: { pass: false, reason: settings.reason },
      reason: settings.reason ?? "실행 승인 대상 plan에는 명시적인 실행 설정 승인이 필요합니다."
    };
  }
  const routeBinding = executionTaskRouteBinding(db, projectRoot, run.id, current.planData);
  if (!routeBinding.pass) {
    return { required, pass: false, checkpointId, checkpoint, basis, routeBinding, reason: routeBinding.reason };
  }
  const pass = checkpoint?.kind === "authority" && checkpoint.blocking && checkpoint.status === "resolved";
  return { required, pass: Boolean(pass), checkpointId, checkpoint, basis, routeBinding,
    reason: pass ? null : "계획이 준비되었습니다. 명시적인 run 요청으로 현재 계획의 실행을 승인해야 합니다." };
}

export function ensurePlannedExecutionCheckpoint(db, projectRoot, runId, config = null) {
  return transaction(db, () => {
    const approval = plannedExecutionApprovalStatus(db, projectRoot, runId, config);
    if (!approval.required) return approval;
    // 이전 seal의 미결 gate는 폐기하되 실행 허가로 간주하지 않습니다.
    const obsolete = db.prepare("SELECT id FROM checkpoints WHERE run_id = ? AND status = 'pending'").all(runId)
      .filter((item) => item.id.startsWith(`planned-execution-${runId}-`) && item.id !== approval.checkpointId);
    for (const item of obsolete) {
      db.prepare("UPDATE checkpoints SET status = 'waived', resolution = ?, resolved_by = 'metis', resolved_at = ? WHERE id = ?")
        .run("계약 또는 계획 seal 변경으로 폐기된 실행 승인입니다.", now(), item.id);
      recordEvent(db, runId, "planned-execution.superseded", "info", { checkpointId: item.id });
    }
    if (!approval.basis || approval.checkpoint) return approval;
    addCheckpoint(db, runId, {
      id: approval.checkpointId, kind: "authority", blocking: true,
      reason: "계획 전용 요청: 현재 계획의 실행에는 명시적인 run 승인이 필요합니다.",
      requiredEvidence: [`artifact:${approval.basis.planArtifactId}`]
    });
    return plannedExecutionApprovalStatus(db, projectRoot, runId, config);
  });
}

function designCurrent(db, projectRoot, runId, config) {
  const seal = latestArtifact(db, projectRoot, runId, "design-seal", ["verified"]);
  if (!seal) return { pass: false, reason: "Sealed design is missing." };
  const sealData = parsedArtifact(seal);
  if (config?.orchestration.requireDesignCritic === false) {
    return { pass: true, seal, review: null, sealData, reviewData: null };
  }
  const review = latestArtifact(db, projectRoot, runId, "design-review", ["verified"]);
  if (!review) return { pass: false, reason: "Design review is missing." };
  const reviewData = parsedArtifact(review);
  if (reviewData.verdict !== "APPROVED") return { pass: false, reason: "Design review is not approved." };
  if (reviewData.designSealArtifactId !== seal.id || reviewData.designHash !== sealData.designHash) {
    return { pass: false, reason: "Design review does not reference the current sealed design." };
  }
  return { pass: true, seal, review, sealData, reviewData };
}

function normalizedAcceptanceValue(value) {
  return String(value ?? "").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function acceptanceResultsAreCurrent(db, projectRoot, task, result) {
  const criteria = parseJson(task.acceptance_json, []);
  const results = asArray(result?.AcceptanceResults ?? result?.acceptanceResults);
  if (!Array.isArray(criteria) || criteria.length === 0 || results.length < criteria.length) return false;
  const topEvidence = asArray(result?.EvidenceRefs ?? result?.evidenceRefs);
  if (topEvidence.length === 0 || !topEvidence.some((ref) => evidenceRefIsVerifiable(ref) && evidenceRefIsCurrent(db, projectRoot, ref))) return false;
  const used = new Set();
  return criteria.every((criterion, index) => {
    const criterionValue = normalizedAcceptanceValue(typeof criterion === "string" ? criterion : criterion?.id ?? criterion?.criterion ?? criterion?.Criterion);
    const foundIndex = results.findIndex((item, resultIndex) => {
      if (used.has(resultIndex)) return false;
      const resultCriterion = normalizedAcceptanceValue(typeof item === "string"
        ? item
        : item?.id ?? item?.criterionId ?? item?.criterion ?? item?.Criterion ?? (criteria.length === results.length ? criteria[resultIndex] : ""));
      const status = normalizedAcceptanceValue(typeof item === "object" ? item?.status ?? item?.Status : "");
      return (resultCriterion === criterionValue || (criteria.length === results.length && resultIndex === index))
        && ["pass", "passed", "approved", "complete", "completed", "verified", "ok"].includes(status);
    });
    if (foundIndex < 0) return false;
    used.add(foundIndex);
    return true;
  });
}

function fastPathV2TaskContext(db, projectRoot, runId, candidateKind = "integration-candidate") {
  if (!isFastPathV2(db, projectRoot, runId)) return { pass: false, reason: "The run is not an authenticated fast-v2 materialization." };
  const plan = latestArtifact(db, projectRoot, runId, "plan", ["verified"]);
  const planData = parsedArtifact(plan);
  const taskSpecs = Array.isArray(planData.tasks) ? planData.tasks : [];
  const workerSpec = taskSpecs.find((task) => task?.role === "worker" && task?.runPhase === "execute");
  const verifierSpec = taskSpecs.find((task) => task?.role === "verifier" && ["review", "verify"].includes(task?.runPhase));
  if (!workerSpec || !verifierSpec || taskSpecs.length !== 2) return { pass: false, reason: "Fast-v2 plan must bind exactly one worker and one verifier." };
  const worker = db.prepare("SELECT * FROM tasks WHERE run_id = ? AND id = ?").get(runId, workerSpec.id);
  const verifier = db.prepare("SELECT * FROM tasks WHERE run_id = ? AND id = ?").get(runId, verifierSpec.id);
  const candidate = latestArtifact(db, projectRoot, runId, candidateKind, ["verified"]);
  if (!worker || !verifier || !candidate) return { pass: false, reason: `Fast-v2 ${candidateKind} or bound task is missing.` };
  const workerResult = parseJson(worker.result_json, {});
  const verifierResult = parseJson(verifier.result_json, {});
  const workerAck = db.prepare(`SELECT attempt_fence, host_receipt, acknowledged_at FROM task_spawn_acks
    WHERE task_id = ? AND attempt_fence = ? AND host_receipt IS NOT NULL AND length(trim(host_receipt)) > 0
    ORDER BY acknowledged_at DESC LIMIT 1`).get(worker.id, Number(worker.attempt_fence));
  const verifierAck = db.prepare(`SELECT attempt_fence, host_receipt, acknowledged_at FROM task_spawn_acks
    WHERE task_id = ? AND attempt_fence = ? AND host_receipt IS NOT NULL AND length(trim(host_receipt)) > 0
    ORDER BY acknowledged_at DESC LIMIT 1`).get(verifier.id, Number(verifier.attempt_fence));
  const workerRequirements = parseJson(worker.requirement_ids_json, []);
  const verifierRequirements = parseJson(verifier.requirement_ids_json, []);
  const workerScope = parseJson(worker.scope_json, []);
  const verifierScope = parseJson(verifier.scope_json, []);
  const candidateData = parsedArtifact(candidate);
  const verifierBaselineKind = candidateKind === "verification-candidate" ? "integration-candidate" : candidateKind;
  const verifierBaseline = latestArtifact(db, projectRoot, runId, `task-baseline:${verifier.id}`, ["verified"]);
  const integratedCandidate = latestArtifact(db, projectRoot, runId, "integration-candidate", ["verified"]);
  const expectedBaseline = candidateKind === "verification-candidate" ? integratedCandidate : candidate;
  const verifierBaselineData = parsedArtifact(verifierBaseline);
  const currentFingerprint = repositoryCodeFingerprint(db);
  const evidenceRefs = Array.isArray(verifierResult.EvidenceRefs) ? verifierResult.EvidenceRefs : [];
  const acceptanceResults = Array.isArray(verifierResult.AcceptanceResults) ? verifierResult.AcceptanceResults : [];
  const candidateVerifier = asArray(candidateData.verifierTasks).find((item) => item?.id === verifier.id);
  const candidateEvidence = evidenceRefs.some((ref) => ref?.type === "artifact"
    && ref.id === candidate.id && ref.contentRef === candidate.content_ref)
    || (candidateKind === "verification-candidate"
      && candidateVerifier
      && candidateVerifier.status === "completed"
      && stableStringify(asArray(candidateVerifier.acceptanceResults)) === stableStringify(acceptanceResults)
      && stableStringify(asArray(candidateVerifier.evidenceRefs)) === stableStringify(evidenceRefs));
  const checks = {
    workerCompleted: worker.status === "completed" && String(workerResult.Status ?? "").toUpperCase() === "COMPLETED",
    verifierCompleted: verifier.status === "completed" && String(verifierResult.Status ?? "").toUpperCase() === "COMPLETED",
    workerReceipt: Boolean(workerAck?.host_receipt?.trim()),
    verifierReceipt: Boolean(verifierAck?.host_receipt?.trim()),
    distinctReceipts: Boolean(workerAck?.host_receipt && verifierAck?.host_receipt && workerAck.host_receipt !== verifierAck.host_receipt),
    requirementsMatch: stableStringify(workerRequirements) === stableStringify(verifierRequirements),
    scopeMatch: stableStringify(workerScope) === stableStringify(verifierScope),
    testMode: asArray(parseJson(verifier.verification_modes_json, [])).includes("test"),
    acceptance: acceptanceResultsAreCurrent(db, projectRoot, verifier, verifierResult),
    evidence: evidenceRefs.length > 0 && evidenceRefs.every((ref) => evidenceRefIsVerifiable(ref) && evidenceRefIsCurrent(db, projectRoot, ref)),
    candidateEvidence,
    baselineKind: verifierBaselineData.subject?.kind === verifierBaselineKind,
    baselineArtifact: verifierBaselineData.subject?.artifactId === expectedBaseline?.id,
    baselineContent: verifierBaselineData.subject?.contentRef === expectedBaseline?.content_ref,
    baselineFingerprint: verifierBaselineData.subject?.codeFingerprint === candidateData.codeFingerprint,
    verificationCandidateBinding: candidateKind !== "verification-candidate"
      || (candidateData.integrationReview?.artifactId === integratedCandidate?.id
        && candidateData.integrationReview?.contentRef === integratedCandidate?.content_ref),
    currentFingerprint: candidateData.codeFingerprint === currentFingerprint
  };
  const pass = Object.values(checks).every(Boolean);
  return {
    pass,
    reason: pass ? null : "Fast-v2 requires completed worker and independent verifier receipts, test/acceptance evidence, matching scope and requirements, and a current candidate.",
    checks,
    plan,
    planData,
    worker,
    verifier,
    workerResult,
    verifierResult,
    workerAck,
    verifierAck,
    candidate,
    candidateData,
    currentFingerprint,
    evidenceRefs,
    acceptanceResults,
    workerSpec,
    verifierSpec
  };
}

export function fastPathV2ApprovalCurrent(db, projectRoot, runId, reviewKind) {
  const kind = reviewKind === "completion" ? "completion-review" : "integration-review";
  const artifact = latestArtifact(db, projectRoot, runId, kind, ["verified"]);
  if (!artifact) return { pass: false, reason: `${kind} approval is missing.` };
  const data = parsedArtifact(artifact);
  const candidateKind = reviewKind === "completion" ? "verification-candidate" : "integration-candidate";
  const context = fastPathV2TaskContext(db, projectRoot, runId, candidateKind);
  const fingerprint = data.fingerprint ?? {};
  const valid = context.pass
    && data.source === FAST_PATH_V2_SOURCE
    && data.policy === "combined-independent-verification"
    && data.fastPathProfileVersion === FAST_PATH_PROFILE_VERSION
    && data.reviewKind === reviewKind
    && data.verdict === "APPROVED"
    && data.verifierTaskId === context.verifier.id
    && fingerprint.artifactId === context.candidate.id
    && fingerprint.contentRef === context.candidate.content_ref
    && fingerprint.codeFingerprint === context.currentFingerprint;
  return valid ? { pass: true, artifact, data } : { pass: false, reason: `Fast-v2 ${kind} approval is stale, unbound, or lacks independent verifier evidence.` };
}

export function materializeFastPathV2Approval(db, projectRoot, runId, reviewKind = "integration") {
  invariant(["integration", "completion"].includes(reviewKind), "FAST_PATH_APPROVAL_KIND", "Fast-v2 approval kind must be integration or completion.");
  const candidateKind = reviewKind === "completion" ? "verification-candidate" : "integration-candidate";
  const existing = fastPathV2ApprovalCurrent(db, projectRoot, runId, reviewKind);
  if (existing.pass) return existing;
  const context = fastPathV2TaskContext(db, projectRoot, runId, candidateKind);
  invariant(context.pass, "FAST_PATH_APPROVAL_EVIDENCE", context.reason, {
    candidateId: context.candidate?.id ?? null,
    verifierTaskId: context.verifier?.id ?? null,
    workerTaskId: context.worker?.id ?? null,
    checks: context.checks ?? {}
  });
  const fingerprint = {
    artifactId: context.candidate.id,
    contentRef: context.candidate.content_ref,
    codeFingerprint: context.currentFingerprint
  };
  const content = {
    version: 1,
    source: FAST_PATH_V2_SOURCE,
    fastPathProfileVersion: FAST_PATH_PROFILE_VERSION,
    policy: "combined-independent-verification",
    reviewKind,
    verdict: "APPROVED",
    derivedApproval: true,
    separateReviewerPerformed: false,
    subject: { kind: candidateKind, ...fingerprint },
    fingerprint,
    workerTaskId: context.worker.id,
    verifierTaskId: context.verifier.id,
    workerReceipt: { attemptFence: Number(context.workerAck.attempt_fence), hostReceipt: context.workerAck.host_receipt, acknowledgedAt: context.workerAck.acknowledged_at },
    verifierReceipt: { attemptFence: Number(context.verifierAck.attempt_fence), hostReceipt: context.verifierAck.host_receipt, acknowledgedAt: context.verifierAck.acknowledged_at },
    verifierEvidenceRefs: context.evidenceRefs,
    acceptanceResults: context.acceptanceResults,
    recordedAt: now()
  };
  const artifact = putArtifact(db, projectRoot, runId, reviewKind === "completion" ? "completion-review" : "integration-review", content, {
    status: "verified",
    metadata: {
      source: FAST_PATH_V2_SOURCE,
      fastPathProfileVersion: FAST_PATH_PROFILE_VERSION,
      policy: "combined-independent-verification",
      reviewKind,
      derivedApproval: true,
      separateReviewerPerformed: false,
      verifierTaskId: context.verifier.id,
      ...fingerprint
    }
  });
  recordEvent(db, runId, "fast-path-v2.approval-created", "info", {
    artifactId: artifact.id, reviewKind, verifierTaskId: context.verifier.id, ...fingerprint
  });
  return { pass: true, artifact, context, data: content };
}

function integrationReviewCurrent(db, projectRoot, runId) {
  if (isFastPathV2(db, projectRoot, runId)) return fastPathV2ApprovalCurrent(db, projectRoot, runId, "integration");
  const artifact = latestArtifact(db, projectRoot, runId, "integration-review", ["verified"]);
  if (!artifact) return { pass: false, reason: "Integration review approval is missing." };
  const data = parsedArtifact(artifact);
  const candidate = latestArtifact(db, projectRoot, runId, "integration-candidate", ["verified"]);
  if (!candidate) return { pass: false, reason: "Integration candidate is missing or stale." };
  const candidateData = parsedArtifact(candidate);
  const expected = repositoryCodeFingerprint(db);
  const actual = data.fingerprint?.codeFingerprint ?? artifact.metadata.codeFingerprint;
  if (!approvalTasksAreCompleted(db, runId, data, "integration")
      || actual !== expected
      || candidateData.codeFingerprint !== expected
      || data.fingerprint?.artifactId !== candidate.id
      || data.fingerprint?.contentRef !== candidate.content_ref) {
    return { pass: false, reason: "Integration review is stale for the current repository state." };
  }
  return { pass: true, artifact, candidate, data };
}

function completionReviewCurrent(db, projectRoot, runId) {
  if (isFastPathV2(db, projectRoot, runId)) return fastPathV2ApprovalCurrent(db, projectRoot, runId, "completion");
  const candidate = latestArtifact(db, projectRoot, runId, "verification-candidate", ["verified"]);
  const review = latestArtifact(db, projectRoot, runId, "completion-review", ["verified"]);
  if (!candidate || !review) return { pass: false, reason: "Verification candidate or adversarial completion review is missing." };
  const data = parsedArtifact(review);
  const fingerprint = data.fingerprint ?? {};
  if (!approvalTasksAreCompleted(db, runId, data, "completion")
      || fingerprint.artifactId !== candidate.id || fingerprint.contentRef !== candidate.content_ref) {
    return { pass: false, reason: "Completion review is stale for the current verification candidate." };
  }
  return { pass: true, candidate, review, data };
}

function governanceSnapshot(db, runId, config) {
  const assumptions = db.prepare("SELECT * FROM assumptions WHERE run_id = ?").all(runId);
  const invariants = db.prepare("SELECT * FROM invariants WHERE run_id = ?").all(runId);
  const risks = db.prepare("SELECT * FROM risks WHERE run_id = ?").all(runId);
  const openHighAssumptions = assumptions.filter((item) => item.status === "open" && ["high", "critical"].includes(item.impact));
  const violated = invariants.filter((item) => item.status === "violated");
  const unverifiedCritical = invariants.filter((item) => ["error", "critical"].includes(item.severity) && item.status === "active");
  const openCriticalRisks = risks.filter((item) => item.status === "open" && item.severity === "critical");
  return {
    assumptions,
    invariants,
    risks,
    openHighAssumptions,
    violated,
    unverifiedCritical,
    openCriticalRisks,
    passForExecution: openHighAssumptions.length <= Number(config.orchestration.maxOpenHighImpactAssumptions ?? 0) && violated.length === 0,
    passForCompletion: openHighAssumptions.length === 0 && violated.length === 0 && unverifiedCritical.length === 0
      && openCriticalRisks.length <= Number(config.orchestration.maxOpenCriticalRisks ?? 0)
  };
}

function traceSnapshot(db, runId) {
  const requirements = db.prepare("SELECT * FROM requirements WHERE run_id = ? AND status <> 'superseded'").all(runId);
  const tasks = db.prepare("SELECT id, role, status, requirement_ids_json FROM tasks WHERE run_id = ?").all(runId);
  const checks = db.prepare("SELECT id, status, requirement_ids_json FROM checks WHERE run_id = ?").all(runId);
  const links = db.prepare("SELECT * FROM trace_links WHERE run_id = ? AND status = 'current'").all(runId);
  const route = routeForRun(db, runId);
  const rows = requirements.map((requirement) => {
    const relatedTasks = tasks.filter((task) => parseJson(task.requirement_ids_json, []).includes(requirement.id));
    const relatedChecks = checks.filter((check) => parseJson(check.requirement_ids_json, []).includes(requirement.id));
    const relatedLinks = links.filter((link) => link.requirement_id === requirement.id);
    const designed = route.designRequired === false || relatedLinks.some((link) => ["designed-by", "constrained-by"].includes(link.relation));
    const planned = relatedTasks.length > 0 || relatedLinks.some((link) => link.relation === "planned-by");
    const implemented = relatedTasks.some((task) => task.status === "completed" && ["worker", "integrator", "curator"].includes(task.role))
      || relatedLinks.some((link) => link.relation === "implemented-by");
    const verified = relatedChecks.some((check) => check.status === "passed")
      || relatedLinks.some((link) => link.relation === "verified-by");
    const gaps = [];
    if (!designed) gaps.push("design");
    if (!planned) gaps.push("plan");
    if (!implemented) gaps.push("implementation");
    if (!verified) gaps.push("verification");
    return { id: requirement.id, priority: requirement.priority, designed, planned, implemented, verified, gaps };
  });
  return {
    requirements: rows,
    must: rows.filter((item) => item.priority === "must"),
    pass: rows.filter((item) => item.priority === "must" && item.gaps.length > 0).length === 0
  };
}

function blockingReviewFindings(db, runId, reviewKind = null) {
  const rows = reviewKind
    ? db.prepare("SELECT * FROM review_findings WHERE run_id = ? AND review_kind = ?").all(runId, reviewKind)
    : db.prepare("SELECT * FROM review_findings WHERE run_id = ?").all(runId);
  return rows.filter((item) => BLOCKING_SEVERITIES.has(item.severity) && !["resolved", "accepted", "rejected"].includes(item.status));
}

function requiredChecksSnapshot(db, runId) {
  const checks = db.prepare("SELECT * FROM checks WHERE run_id = ? AND required = 1").all(runId);
  return { checks, failed: checks.filter((check) => check.status !== "passed") };
}

export function gateReport(db, projectRoot, runId, targetPhase = null) {
  const run = getRun(db, runId);
  const config = loadConfig(projectRoot);
  syncRepository(db, projectRoot, config, run.id);
  refreshMilestoneStatuses(db, run.id);
  const target = targetPhase ?? PHASES[PHASES.indexOf(run.phase) + 1];
  const failures = [];
  const details = {};
  const route = routeForRun(db, run.id);
  try {
    if (["plan", "execute", "review", "verify", "curate", "complete"].includes(target) && config.index?.allowTruncated !== true) {
      const scan = db.prepare("SELECT * FROM repository_scans WHERE run_id IS ? OR run_id IS NULL ORDER BY created_at DESC LIMIT 1").get(run.id);
      if (scan?.truncated) failures.push(`Repository discovery was truncated at ${scan.indexed_files} of ${scan.discovered_files ?? "unknown"} files.`);
    }
    if (["verify", "curate", "complete"].includes(target)) {
      const checkpoints = db.prepare("SELECT id, kind FROM checkpoints WHERE run_id = ? AND blocking = 1 AND status = 'pending'").all(run.id);
      if (checkpoints.length > 0) failures.push(`Blocking checkpoints remain: ${checkpoints.map((item) => `${item.id}:${item.kind}`).join(", ")}`);
    }
    if (target === "discover") {
      const contract = activeContract(db, run.id);
      if (!contract) failures.push("Freeze a Goal Contract before discovery.");
      else {
        details.contractVersion = contract.version;
        if (contract.successCriteria.length === 0) failures.push("Goal Contract needs success criteria.");
        const requirements = db.prepare("SELECT id FROM requirements WHERE run_id = ? AND status = 'active'").all(run.id);
        if (requirements.length === 0) failures.push("Goal Contract needs at least one active requirement.");
      }
    }

    if (target === "research") {
      const discovery = requireArtifact(db, projectRoot, run.id, "discovery", ["verified"]);
      const data = parsedArtifact(discovery);
      if (!Array.isArray(data.scope) || data.scope.length === 0) failures.push("Discovery must define scope.");
      if (!Array.isArray(data.knownFacts)) failures.push("Discovery must define knownFacts.");
      if (!Array.isArray(data.unknowns)) failures.push("Discovery must define unknowns.");
      addPhaseTaskFailures(db, run.id, "discover", failures);
    }

    if (target === "design") {
      requireArtifact(db, projectRoot, run.id, "discovery", ["verified"]);
      if (route.researchRequired !== false) {
        requireArtifact(db, projectRoot, run.id, "research", ["verified"]);
      } else if (!latestArtifact(db, projectRoot, run.id, "research", ["verified", "waived"])) {
        failures.push("Research must be completed or explicitly waived.");
      }
      addPhaseTaskFailures(db, run.id, "research", failures);
    }

    if (target === "plan") {
      if (route.designRequired === false) {
        if (!latestArtifact(db, projectRoot, run.id, "design", ["verified", "waived"])) {
          failures.push("Design must be completed or explicitly waived.");
        }
      } else {
        const design = designCurrent(db, projectRoot, run.id, config);
        if (!design.pass) failures.push(design.reason);
      }
      addPhaseTaskFailures(db, run.id, "design", failures);
      const governance = governanceSnapshot(db, run.id, config);
      details.governance = {
        openHighAssumptions: governance.openHighAssumptions.map((item) => item.id),
        violatedInvariants: governance.violated.map((item) => item.id)
      };
      if (!governance.passForExecution) failures.push("Governance blockers must be resolved before planning execution.");
    }

    if (["execute", "review", "verify", "curate", "complete"].includes(target)) {
      const approval = plannedExecutionApprovalStatus(db, projectRoot, run.id, config);
      if (approval.required) details.executionApproval = approval;
      if (!approval.pass) failures.push(approval.reason);
    }
    if (target === "execute") {
      const current = planCurrent(db, projectRoot, run.id, config);
      if (!current.pass) failures.push(current.reason);
      addPhaseTaskFailures(db, run.id, "plan", failures);
      try { validateGraph(db, run.id); } catch (error) { failures.push(error.message); }
      try { validateMilestoneGraph(db, run.id); } catch (error) { failures.push(error.message); }
      if (config.productDelivery?.requireMilestoneExitCriteria !== false) {
        const incompleteMilestones = db.prepare("SELECT id FROM milestones WHERE run_id = ? AND (exit_criteria_json = '[]' OR trim(user_visible_outcome) = '')").all(run.id);
        if (incompleteMilestones.length > 0) failures.push(`Milestones need observable outcomes and exit criteria: ${incompleteMilestones.map((item) => item.id).join(", ")}`);
      }
      const incomplete = db.prepare(`
        SELECT id FROM tasks WHERE run_id = ? AND phase IN ('execute','review','verify','curate')
          AND (acceptance_json = '[]' OR required_evidence_json = '[]' OR requirement_ids_json = '[]')
      `).all(run.id);
      if (incomplete.length > 0) failures.push(`Tasks need acceptance, evidence, and requirement links: ${incomplete.map((item) => item.id).join(", ")}`);
      const trace = traceSnapshot(db, run.id);
      const planGaps = trace.must.filter((item) => !item.planned || (route.designRequired !== false && !item.designed));
      if (planGaps.length > 0) failures.push(`Must requirements are not fully designed and planned: ${planGaps.map((item) => `${item.id}:${item.gaps.join("+")}`).join(", ")}`);
      const governance = governanceSnapshot(db, run.id, config);
      if (!governance.passForExecution) failures.push("High-impact assumptions or invariant violations block execution.");
    }

    if (target === "review") {
      addPhaseTaskFailures(db, run.id, "execute", failures);
      const unsettledBatches = db.prepare("SELECT id, status FROM scheduler_batches WHERE run_id = ? AND status IN ('claimed','prepared','partially-spawned','spawned')").all(run.id);
      if (unsettledBatches.length > 0) failures.push(`Scheduler batches remain active: ${unsettledBatches.map((item) => `${item.id}:${item.status}`).join(", ")}`);
      const activeWorktrees = db.prepare("SELECT task_id FROM worktrees WHERE run_id = ? AND status = 'active'").all(run.id);
      if (activeWorktrees.length > 0) failures.push(`Active worktrees remain: ${activeWorktrees.map((item) => item.task_id).join(", ")}`);
      if (completedTaskCount(db, run.id, "execute") === 0) failures.push("No implementation task completed.");
    }

    if (target === "verify") {
      addPhaseTaskFailures(db, run.id, "review", failures);
      if (lifecycleReviewRequired(route, config, "integration")) {
        const current = integrationReviewCurrent(db, projectRoot, run.id);
        if (!current.pass) failures.push(current.reason);
        const blocking = blockingReviewFindings(db, run.id, "integration");
        if (blocking.length > 0) failures.push(`Blocking integration review findings remain: ${blocking.map((item) => item.id).join(", ")}`);
      }
      const specReviews = db.prepare(`
        SELECT id, review_kind, status, result_json FROM tasks
        WHERE run_id = ? AND review_kind LIKE 'task-spec:%'
      `).all(run.id);
      for (const review of specReviews) {
        if (review.status !== "completed") {
          failures.push(`Task specification review ${review.id} must complete and is ${review.status}.`);
          continue;
        }
        const result = parseJson(review.result_json, {});
        if (String(result?.Verdict ?? "REJECTED").toUpperCase() !== "APPROVED") failures.push(`Task specification review ${review.id} did not approve its target.`);
        const approval = latestArtifact(db, projectRoot, run.id, `review-approval:${review.review_kind}`, ["verified"]);
        const approvalData = parsedArtifact(approval);
        const candidate = latestArtifact(db, projectRoot, run.id, "integration-candidate", ["verified"]);
        const candidateData = parsedArtifact(candidate);
        const fingerprint = approvalData.fingerprint ?? {};
        if (!approval
            || !candidate
            || !approvalTasksAreCompleted(db, run.id, approvalData, review.review_kind)
            || !approvalData.reviewerTaskIds.includes(review.id)
            || fingerprint.artifactId !== candidate.id
            || fingerprint.contentRef !== candidate.content_ref
            || fingerprint.codeFingerprint !== candidateData.codeFingerprint) {
          failures.push(`Task specification review ${review.id} has no authenticated reconciled approval.`);
        }
      }
      const blockingSpec = db.prepare(`
        SELECT id FROM review_findings
        WHERE run_id = ? AND review_kind LIKE 'task-spec:%'
          AND status NOT IN ('resolved','accepted','rejected')
          AND severity IN ('error','critical')
      `).all(run.id);
      if (blockingSpec.length > 0) failures.push(`Blocking task specification findings remain: ${blockingSpec.map((item) => item.id).join(", ")}`);
    }

    if (target === "curate") {
      addPhaseTaskFailures(db, run.id, "verify", failures);
      const required = requiredChecksSnapshot(db, run.id);
      const browserFailures = db.prepare(`
        SELECT s.id, s.name FROM browser_scenarios s
        WHERE s.run_id = ? AND s.required = 1 AND NOT EXISTS (
          SELECT 1 FROM browser_evidence e
          WHERE e.scenario_id = s.id AND e.status = 'passed'
            AND e.code_fingerprint = ?
        )
      `).all(run.id, repositoryCodeFingerprint(db));
      if (browserFailures.length > 0) failures.push(`Required browser evidence is missing or stale: ${browserFailures.map((item) => item.name).join(", ")}`);
      const verification = latestArtifact(db, projectRoot, run.id, "verification", ["verified"]);
      if (required.checks.length === 0 && !verification) failures.push("No deterministic checks or verification artifact exists.");
      if (required.failed.length > 0) failures.push(`Required checks are not current: ${required.failed.map((item) => `${item.name}:${item.status}`).join(", ")}`);
      const candidate = latestArtifact(db, projectRoot, run.id, "verification-candidate", ["verified"]);
      if (!candidate) failures.push("Create a verification-candidate artifact before adversarial completion review.");
      if (lifecycleReviewRequired(route, config, "completion")) {
        const current = completionReviewCurrent(db, projectRoot, run.id);
        if (!current.pass) failures.push(current.reason);
        const blocking = blockingReviewFindings(db, run.id, "completion");
        if (blocking.length > 0) failures.push(`Blocking completion review findings remain: ${blocking.map((item) => item.id).join(", ")}`);
      }
    }

    if (target === "complete") {
      requireArtifact(db, projectRoot, run.id, "knowledge-sync", ["verified"]);
      requireArtifact(db, projectRoot, run.id, "self-evaluation", ["verified"]);
      addPhaseTaskFailures(db, run.id, "curate", failures);
      const nonTerminal = db.prepare("SELECT id, status FROM tasks WHERE run_id = ? AND status NOT IN ('completed','waived')").all(run.id);
      if (nonTerminal.length > 0) failures.push(`Tasks remain non-terminal: ${nonTerminal.map((item) => `${item.id}:${item.status}`).join(", ")}`);
      const trace = traceSnapshot(db, run.id);
      if (!trace.pass) failures.push(`Requirement traceability gaps remain: ${trace.must.filter((item) => item.gaps.length).map((item) => `${item.id}:${item.gaps.join("+")}`).join(", ")}`);
      const governance = governanceSnapshot(db, run.id, config);
      if (!governance.passForCompletion) failures.push("Assumptions, invariants, or critical risks block completion.");
      const pendingDocs = db.prepare("SELECT path FROM document_impacts WHERE run_id = ? AND status = 'pending'").all(run.id);
      if (pendingDocs.length > 0) failures.push(`Documentation impacts remain: ${pendingDocs.map((item) => item.path).join(", ")}`);
      const stale = db.prepare("SELECT id FROM findings WHERE run_id = ? AND status = 'stale'").all(run.id);
      if (stale.length > 0) failures.push(`Stale findings remain: ${stale.map((item) => item.id).join(", ")}`);
      const blockers = db.prepare("SELECT id FROM findings WHERE run_id = ? AND status = 'valid' AND kind = 'blocker'").all(run.id);
      if (blockers.length > 0) failures.push(`Open blockers remain: ${blockers.map((item) => item.id).join(", ")}`);
      const decisions = db.prepare("SELECT id FROM decisions WHERE run_id = ? AND status = 'needs-review'").all(run.id);
      if (decisions.length > 0) failures.push(`Decisions need review: ${decisions.map((item) => item.id).join(", ")}`);
      const reviewBlockers = blockingReviewFindings(db, run.id);
      if (reviewBlockers.length > 0) failures.push(`Review findings remain: ${reviewBlockers.map((item) => item.id).join(", ")}`);
      if (lifecycleReviewRequired(route, config, "integration")) {
        const current = integrationReviewCurrent(db, projectRoot, run.id);
        if (!current.pass) failures.push(current.reason);
      }
      if (lifecycleReviewRequired(route, config, "completion")) {
        const current = completionReviewCurrent(db, projectRoot, run.id);
        if (!current.pass) failures.push(current.reason);
      }
      const required = requiredChecksSnapshot(db, run.id);
      if (required.failed.length > 0) failures.push(`Final required checks are stale or failed: ${required.failed.map((item) => item.name).join(", ")}`);
      const incompleteMilestones = db.prepare("SELECT id, status FROM milestones WHERE run_id = ? AND status NOT IN ('completed','waived')").all(run.id);
      if (incompleteMilestones.length > 0) failures.push(`Milestones remain incomplete: ${incompleteMilestones.map((item) => `${item.id}:${item.status}`).join(", ")}`);
      const activeWorktrees = db.prepare("SELECT task_id FROM worktrees WHERE run_id = ? AND status = 'active'").all(run.id);
      if (activeWorktrees.length > 0) failures.push(`Active task worktrees remain: ${activeWorktrees.map((item) => item.task_id).join(", ")}`);
      try {
        const budget = budgetStatus(db, run.id);
        details.budget = budget;
      } catch {}
    }
  } catch (error) {
    if (error instanceof MetisError) failures.push(error.message);
    else throw error;
  }
  return { runId: run.id, from: run.phase, to: target, pass: failures.length === 0, failures, details };
}

export function advancePhase(db, projectRoot, runId, targetPhase = null) {
  const run = getRun(db, runId);
  invariant(run.status === "active", "RUN_NOT_ACTIVE", `Run ${run.id} is ${run.status}. Resume it before advancing.`);
  const currentIndex = PHASES.indexOf(run.phase);
  invariant(currentIndex >= 0, "INVALID_PHASE", `Run has invalid phase ${run.phase}.`);
  const target = targetPhase ?? PHASES[currentIndex + 1];
  invariant(target, "ALREADY_COMPLETE", "The run is already complete.");
  const targetIndex = PHASES.indexOf(target);
  invariant(targetIndex === currentIndex + 1, "INVALID_PHASE_TRANSITION", `Cannot transition from ${run.phase} to ${target}.`);
  const report = gateReport(db, projectRoot, run.id, target);
  if (!report.pass) throw new MetisError("PHASE_GATE_FAILED", `Cannot enter ${target}.`, report);
  const status = target === "complete" ? "completed" : "active";
  const changed = db.prepare("UPDATE runs SET phase = ?, status = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND phase = ? AND revision = ?")
    .run(target, status, now(), run.id, run.phase, run.revision);
  invariant(changed.changes === 1, "PHASE_TRANSITION_RACE", "Run phase or revision changed concurrently.");
  if (target === "review") {
    const codeFingerprint = repositoryCodeFingerprint(db);
    const artifact = putArtifact(db, projectRoot, run.id, "integration-candidate", {
      version: 1,
      runId: run.id,
      contractVersion: run.contract_version,
      codeFingerprint,
      source: "post-integration",
      frozenAt: now()
    }, {
      status: "verified",
      metadata: { codeFingerprint, immutable: true, source: "post-integration" }
    });
    recordEvent(db, run.id, "integration.candidate-created", "info", {
      artifactId: artifact.id,
      contentRef: artifact.content_ref,
      codeFingerprint
    });
  }
  recordEvent(db, run.id, "phase.changed", "info", { from: run.phase, to: target });
  if (target === "complete") recordEvent(db, run.id, "run.completed", "info", { runId: run.id });
  return { run: getRun(db, run.id), gate: report };
}

export function reopenPhase(db, runId, targetPhase, reason) {
  const run = getRun(db, runId);
  const normalizedReason = reason?.trim();
  invariant(normalizedReason, "REOPEN_REASON_REQUIRED", "Reopening a phase needs a reason.");
  invariant(run.status !== "completed", "RUN_COMPLETED", "Start a new goal instead of reopening a completed run.");
  const currentIndex = PHASES.indexOf(run.phase);
  const targetIndex = PHASES.indexOf(targetPhase);
  invariant(targetIndex >= 0 && targetPhase !== "complete", "INVALID_PHASE", `Unknown reopen phase ${targetPhase}.`);
  invariant(targetIndex < currentIndex, "REOPEN_DIRECTION", `Reopen target ${targetPhase} must precede ${run.phase}.`);
  const running = db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status = 'running'").all(run.id);
  invariant(running.length === 0, "REOPEN_RUNNING_TASKS", `Finish or block running tasks before reopening: ${running.map((task) => task.id).join(", ")}`);
  const previousReopen = db.prepare(`
    SELECT sequence, payload_json
    FROM journal
    WHERE run_id = ? AND event_type = 'phase.reopened'
    ORDER BY sequence DESC LIMIT 1
  `).get(run.id);
  if (previousReopen) {
    const previousPayload = parseJson(previousReopen.payload_json, {});
    const evidence = db.prepare(`
      SELECT sequence FROM journal
      WHERE run_id = ? AND sequence > ?
        AND event_type NOT IN ('phase.reopened', 'phase.changed', 'progress.stalled', 'performance.repository-sync')
      LIMIT 1
    `).get(run.id, previousReopen.sequence);
    invariant(
      previousPayload.to !== targetPhase
        || previousPayload.reason !== normalizedReason
        || Boolean(evidence),
      "REOPEN_DUPLICATE",
      "Rejecting an identical reopen until new durable evidence is recorded."
    );
  }
  const timestamp = now();
  transaction(db, () => {
    const staleByTarget = {
      intake: ["goal-contract", "discovery", "research", "design", "design-seal", "design-review", "plan", "plan-review", "integration-review", "verification", "verification-candidate", "completion-review", "knowledge-sync", "self-evaluation"],
      discover: ["discovery", "research", "design", "design-seal", "design-review", "plan", "plan-review", "integration-review", "verification", "verification-candidate", "completion-review", "knowledge-sync", "self-evaluation"],
      research: ["research", "design", "design-seal", "design-review", "plan", "plan-review", "integration-review", "verification", "verification-candidate", "completion-review", "knowledge-sync", "self-evaluation"],
      design: ["design", "design-seal", "design-review", "plan", "plan-review", "integration-review", "verification", "verification-candidate", "completion-review", "knowledge-sync", "self-evaluation"],
      plan: ["plan", "plan-review", "integration-review", "verification", "verification-candidate", "completion-review", "knowledge-sync", "self-evaluation"],
      execute: ["integration-candidate", "integration-review", "verification", "verification-candidate", "completion-review", "knowledge-sync", "self-evaluation"],
      review: ["integration-candidate", "integration-review", "verification", "verification-candidate", "completion-review", "knowledge-sync", "self-evaluation"],
      verify: ["verification", "verification-candidate", "completion-review", "knowledge-sync", "self-evaluation"],
      curate: ["knowledge-sync", "self-evaluation"]
    };
    for (const kind of staleByTarget[targetPhase] ?? []) {
      db.prepare("UPDATE artifacts SET status = 'stale', updated_at = ? WHERE run_id = ? AND kind = ? AND status = 'verified'")
        .run(timestamp, run.id, kind);
    }
    if (targetIndex <= PHASES.indexOf("review")) {
      db.prepare("UPDATE artifacts SET status = 'stale', updated_at = ? WHERE run_id = ? AND kind LIKE 'review-result:%' AND status = 'verified'")
        .run(timestamp, run.id);
    }
    if (targetIndex <= PHASES.indexOf("verify")) {
      db.prepare("UPDATE artifacts SET status = 'stale', updated_at = ? WHERE run_id = ? AND kind LIKE 'requirement-verification:%' AND status = 'verified'")
        .run(timestamp, run.id);
    }
    if (targetIndex <= PHASES.indexOf("execute")) {
      db.prepare("UPDATE checks SET status = 'stale', updated_at = ? WHERE run_id = ? AND status = 'passed'").run(timestamp, run.id);
      db.prepare("UPDATE trace_links SET status = 'stale', updated_at = ? WHERE run_id = ? AND relation IN ('implemented-by','verified-by','reviewed-by','documented-by')")
        .run(timestamp, run.id);
    }
    // Stall counts are phase-local. Remove samples for the reopened phase and
    // every downstream phase so returning through the recovered lifecycle
    // cannot immediately re-trigger a prior STALLED_REPLAN action.
    const invalidatedProgressPhases = PHASES.slice(targetIndex, -1);
    if (invalidatedProgressPhases.length > 0) {
      const placeholders = invalidatedProgressPhases.map(() => "?").join(",");
      db.prepare(`DELETE FROM progress_samples WHERE run_id = ? AND phase IN (${placeholders})`)
        .run(run.id, ...invalidatedProgressPhases);
    }
    const downstream = PHASES.slice(targetIndex + 1).filter((phase) => phase !== "complete");
    if (downstream.length > 0) {
      const placeholders = downstream.map(() => "?").join(",");
      db.prepare(`
        UPDATE tasks SET status = 'pending', owner = NULL, attempts = 0, result_json = NULL, updated_at = ?
        WHERE run_id = ? AND phase IN (${placeholders}) AND status IN ('completed','blocked','failed')
      `).run(timestamp, run.id, ...downstream);
    }
    db.prepare("DELETE FROM leases WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)").run(run.id);
    const changed = db.prepare("UPDATE runs SET phase = ?, status = 'active', stalled_count = 0, updated_at = ?, revision = revision + 1 WHERE id = ? AND phase = ? AND revision = ?")
      .run(targetPhase, timestamp, run.id, run.phase, run.revision);
    invariant(changed.changes === 1, "PHASE_TRANSITION_RACE", "Run phase or revision changed concurrently.");
    recordEvent(db, run.id, "phase.reopened", "warning", { from: run.phase, to: targetPhase, reason: normalizedReason });
  });
  return getRun(db, run.id);
}

export function blockRun(db, runId, reason) {
  const run = getRun(db, runId);
  invariant(reason?.trim(), "BLOCK_REASON_REQUIRED", "Blocking a run needs a reason.");
  const timestamp = now();
  db.prepare("UPDATE runs SET status = 'blocked', updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, run.id);
  recordEvent(db, run.id, "run.blocked", "error", { reason });
  return getRun(db, run.id);
}

export function pauseRun(db, runId, reason) {
  const run = getRun(db, runId);
  invariant(reason?.trim(), "PAUSE_REASON_REQUIRED", "Pausing a run needs a reason.");
  const running = db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status = 'running'").all(run.id);
  invariant(running.length === 0, "PAUSE_RUNNING_TASKS", `Finish running tasks before pausing: ${running.map((item) => item.id).join(", ")}`);
  const changed = db.prepare("UPDATE runs SET status = 'paused', updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
    .run(now(), run.id, run.revision);
  invariant(changed.changes === 1, "RUN_STATE_RACE", "Run state changed concurrently.");
  recordEvent(db, run.id, "run.paused", "warning", { reason: reason.trim() });
  return getRun(db, run.id);
}

export function resumeRun(db, runId) {
  const run = getRun(db, runId);
  invariant(["blocked", "paused"].includes(run.status), "RUN_RESUME_STATUS", `Cannot resume a ${run.status} run.`);
  db.prepare("UPDATE runs SET status = 'active', updated_at = ?, revision = revision + 1 WHERE id = ?").run(now(), run.id);
  recordEvent(db, run.id, "run.resumed", "info", {});
  return getRun(db, run.id);
}
