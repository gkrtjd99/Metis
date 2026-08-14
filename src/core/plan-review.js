import path from "node:path";
import { invariant } from "./errors.js";
import { getRun, latestArtifact, lifecycleReviewRequired, lifecycleRoute, putArtifact, recordEvent } from "./state.js";
import { getTask, listTasks } from "./tasks.js";
import { listMilestones } from "./milestones.js";
import { currentPlanDraftBinding } from "./plan-ingest.js";
import { verificationParallelismReport } from "./verification.js";
import { requiredSpecialistRoles } from "./reviews.js";
import { evidenceRefIsCurrent, normalizeEvidenceRefs } from "./provenance.js";
import { asArray, now, parseJson, pathsOverlap, sha256, stableStringify } from "./util.js";
import { REVIEW_ROLES as REVIEW_ROLE_NAMES } from "./metadata.js";
import { taskPacketStatus } from "./task-packets.js";
import { budgetStatus } from "./budget.js";

const BLOCKING_SEVERITIES = new Set(["error", "critical"]);
const PLANNED_PHASES = new Set(["execute", "review", "verify", "curate"]);
const REVIEW_ROLES = new Set(REVIEW_ROLE_NAMES);

function dependencyClosure(tasks) {
  const dependencies = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]));
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const dependency of dependencies.get(from) ?? []) {
      if (dependency === target || reaches(dependency, target, seen)) return true;
    }
    return false;
  };
  return reaches;
}

function activeRequirements(db, runId) {
  return db.prepare("SELECT id, priority FROM requirements WHERE run_id = ? AND status <> 'superseded'").all(runId);
}

function plannerParallelismDeclaration(db, projectRoot, runId) {
  if (!projectRoot) return { error: "Planner draft validation requires the project root." };

  try {
    const sealedPlan = latestArtifact(db, projectRoot, runId, "plan", ["verified"]);
    let binding;
    if (sealedPlan) {
      const sealedContent = parseJson(sealedPlan.content, null);
      const deterministicDraft = sealedContent?.planDraft;
      const deterministicDraftHash = String(sealedPlan.metadata?.planDraftHash ?? "").trim();
      if (sealedPlan.metadata?.source === "bounded-fast-path" && deterministicDraftHash) {
        invariant(deterministicDraft?.source === "bounded-fast-path", "PLAN_DRAFT_BINDING_INVALID", "The bounded fast-path PlanDraft source is invalid.");
        invariant(sha256(stableStringify(deterministicDraft)) === deterministicDraftHash,
          "PLAN_DRAFT_BINDING_MISMATCH", "The bounded fast-path PlanDraft no longer matches its authenticated hash.");
        const sealedTaskIds = asArray(sealedContent.tasks).map((task) => task?.id).filter(Boolean).sort();
        const declaredTaskIds = asArray(deterministicDraft.plannedTaskIds).map(String).sort();
        invariant(stableStringify(sealedTaskIds) === stableStringify(declaredTaskIds),
          "PLAN_DRAFT_GRAPH_MISMATCH", "The bounded fast-path PlanDraft task set does not match the sealed plan.");
        return {
          declaration: deterministicDraft.parallelism ?? null,
          verificationDeclaration: deterministicDraft.verificationParallelism ?? null,
          draftArtifactId: sealedPlan.id,
          receiptArtifactId: sealedPlan.id
        };
      }
      const draftArtifactId = String(sealedPlan.metadata?.planDraftArtifactId ?? "").trim();
      const receiptArtifactId = String(sealedPlan.metadata?.planDraftIngestedArtifactId ?? "").trim();
      const draftContentRef = String(sealedPlan.metadata?.planDraftContentRef ?? "").trim();
      const plannedGraphFingerprint = String(sealedPlan.metadata?.plannedGraphFingerprint ?? "").trim();
      if (!draftArtifactId || !receiptArtifactId || !draftContentRef || !plannedGraphFingerprint) {
        return { error: "The current sealed plan is not bound to an authenticated ingested planner draft." };
      }
      binding = currentPlanDraftBinding(db, projectRoot, runId, {
        draftArtifactId,
        receiptArtifactId,
        draftContentRef,
        plannedGraphFingerprint
      });
    } else {
      binding = currentPlanDraftBinding(db, projectRoot, runId);
    }
    if (!binding) return { error: "No authenticated ingested planner draft is bound to the current plan." };
    const draft = parseJson(binding.draftArtifact.content, null);
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
      return { error: "The authenticated planner draft is not a valid object." };
    }
    return {
      declaration: draft.parallelism ?? draft.Parallelism ?? null,
      verificationDeclaration: draft.verificationParallelism
        ?? draft.VerificationParallelism
        ?? draft.parallelism?.verification
        ?? draft.parallelism?.Verification
        ?? draft.parallelism?.verificationParallelism
        ?? null,
      draftArtifactId: binding.draftArtifactId,
      receiptArtifactId: binding.receiptArtifactId
    };
  } catch (error) {
    return { error: error?.message ?? "The planner draft binding is invalid." };
  }
}

function pathsAreExclusive(left, right, canonicalPaths) {
  const leftPaths = canonicalPaths.get(left.id) ?? [];
  const rightPaths = canonicalPaths.get(right.id) ?? [];
  return leftPaths.length > 0 && rightPaths.length > 0
    && !leftPaths.some((leftPath) => rightPaths.some((rightPath) => pathsOverlap(leftPath, rightPath)));
}

function hasCompatibleSubset(tasks, minimum, compatible) {
  const search = (selected, candidates) => {
    if (selected.length >= minimum) return true;
    if (selected.length + candidates.length < minimum) return false;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!selected.every((item) => compatible(item, candidate))) continue;
      const remaining = candidates.slice(index + 1).filter((item) => compatible(candidate, item));
      if (search([...selected, candidate], remaining)) return true;
    }
    return false;
  };
  return search([], tasks);
}

function maximumCompatibleSubset(tasks, compatible) {
  let maximum = 0;
  const search = (selected, candidates) => {
    maximum = Math.max(maximum, selected.length);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!selected.every((item) => compatible(item, candidate))) continue;
      search([...selected, candidate], candidates.slice(index + 1));
    }
  };
  search([], tasks);
  return maximum;
}

function declaredInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function couplingRationale(rationale) {
  return /coupl|depend|shared|serial|atomic|contention|interface/iu.test(rationale);
}

function independentlyRunnable(left, right, taskReaches, milestoneReaches) {
  if (taskReaches(left.id, right.id) || taskReaches(right.id, left.id)) return false;
  const leftMilestone = left.milestone_id;
  const rightMilestone = right.milestone_id;
  if (!leftMilestone || !rightMilestone || leftMilestone === rightMilestone) return true;
  return !milestoneReaches(leftMilestone, rightMilestone) && !milestoneReaches(rightMilestone, leftMilestone);
}

function canonicalPlanPath(value) {
  if (typeof value !== "string") return { valid: false, canonical: null };
  const raw = value.trim().replaceAll("\\", "/");
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw)) return { valid: false, canonical: null };
  const canonical = path.posix.normalize(raw);
  if (canonical === "." || canonical === ".." || canonical.startsWith("../")) return { valid: false, canonical: null };
  return { valid: raw === canonical, canonical };
}

function canonicalTaskPaths(task, push) {
  const paths = [];
  const seen = new Set();
  for (const targetPath of task.targetPaths) {
    const normalized = canonicalPlanPath(targetPath);
    if (!normalized.valid) {
      push("critical", "TASK_PATH_NONCANONICAL", `Task ${task.id} has a non-canonical target path: ${String(targetPath)}.`);
      continue;
    }
    if (seen.has(normalized.canonical)) {
      push("critical", "TASK_PATH_DUPLICATE", `Task ${task.id} declares duplicate target path ${normalized.canonical}.`);
      continue;
    }
    seen.add(normalized.canonical);
    paths.push(normalized.canonical);
  }
  return paths;
}

function normalizedAcceptance(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US") : "";
}

function verificationParallelismFindings(db, runId, declaration, push, config = null) {
  const report = verificationParallelismReport(db, runId, {
    declaration,
    hostCapacity: config?.orchestration?.maxConcurrent
  });
  if (!report.enforced) return;
  for (const finding of report.findings) push("critical", finding.code, finding.claim);
}

function capabilityNames(task) {
  return new Set((task.capabilities ?? []).map((item) => typeof item === "string" ? item : item.name));
}

function taskQualityFindings(task, tasks, push) {
  const capabilities = capabilityNames(task);
  if (task.verificationModes.length === 0 && !REVIEW_ROLES.has(task.role) && task.role !== "curator") {
    push("error", "TASK_VERIFICATION_MODE_MISSING", `Task ${task.id} has no verification mode.`);
  }
  if (!task.readOnly && (task.targetPaths.includes(".") || task.targetPaths.length > 12)) {
    push("error", "TASK_PATH_SCOPE_EXCESSIVE", `Task ${task.id} owns an excessive path scope.`);
  }
  if (task.requirementIds.length > 6) {
    push("error", "TASK_REQUIREMENT_SCOPE_EXCESSIVE", `Task ${task.id} spans ${task.requirementIds.length} requirements.`);
  } else if (task.requirementIds.length > 3) {
    push("warning", "TASK_REQUIREMENT_SCOPE_BROAD", `Task ${task.id} spans ${task.requirementIds.length} requirements.`);
  }
  if (task.effort === "large") push("error", "TASK_EFFORT_LARGE", `Task ${task.id} is too large for one bounded worker contract.`);
  if (capabilities.has("frontend-ui") && task.sliceType !== "vertical") {
    push("error", "UI_TASK_NOT_VERTICAL", `UI task ${task.id} must be an independently observable vertical slice.`);
  }
  if (capabilities.has("frontend-ui") && !task.verificationModes.includes("browser")) {
    push("critical", "UI_TASK_BROWSER_MISSING", `UI task ${task.id} must use browser verification.`);
  }
  if (task.verificationModes.includes("browser") && !capabilities.has("browser-testing")) {
    push("critical", "BROWSER_CAPABILITY_MISSING", `Task ${task.id} uses browser verification without browser-testing capability.`);
  }
  const concernCount = ["frontend-ui", "database", "migration", "security"].filter((name) => capabilities.has(name)).length;
  if (!task.readOnly && concernCount >= 3) push("critical", "TASK_MIXED_CONCERNS", `Task ${task.id} mixes too many independent product and infrastructure concerns.`);
  else if (!task.readOnly && concernCount === 2 && task.effort !== "small") push("error", "TASK_MIXED_CONCERNS", `Task ${task.id} mixes multiple high-change concerns and should be split.`);
  if (["high", "critical"].includes(task.risk) && !task.readOnly && task.phase === "execute") {
    const specReview = tasks.some((candidate) => REVIEW_ROLES.has(candidate.role) && candidate.review_kind === `task-spec:${task.id}` && candidate.dependsOn.includes(task.id));
    if (!specReview) push("critical", "TASK_SPEC_REVIEW_MISSING", `High-risk task ${task.id} needs a dependent task-spec review.`);
  }
}

export function lintPlan(db, runId, config = null, projectRoot = null) {
  const tasks = listTasks(db, runId).filter((task) => PLANNED_PHASES.has(task.phase));
  const milestones = listMilestones(db, runId);
  const requirements = activeRequirements(db, runId);
  const route = lifecycleRoute(parseJson(db.prepare("SELECT route_json FROM runs WHERE id = ?").get(runId)?.route_json, {}));
  const findings = [];
  const push = (severity, code, claim, evidenceRefs = []) => findings.push({ severity, code, claim, evidenceRefs });
  const canonicalPaths = new Map();

  if (tasks.length === 0) push("critical", "NO_TASKS", "The plan has no execution lifecycle tasks.");
  if (milestones.length === 0) push("error", "NO_MILESTONES", "The plan has no milestones.");
  if (requirements.length === 0) push("critical", "NO_REQUIREMENTS", "The Goal Contract has no active requirements.");
  for (const milestone of milestones) {
    if (!milestone.userVisibleOutcome?.trim()) push("critical", "MILESTONE_OUTCOME_MISSING", `Milestone ${milestone.id} has no observable outcome.`);
    if (milestone.exitCriteria.length === 0) push("critical", "MILESTONE_EXIT_MISSING", `Milestone ${milestone.id} has no exit criteria.`);
  }

  const milestoneIds = new Set(milestones.map((item) => item.id));
  const taskIds = new Set(tasks.map((item) => item.id));
  for (const task of tasks) {
    if (!task.milestone_id || !milestoneIds.has(task.milestone_id)) push("error", "TASK_NO_MILESTONE", `Task ${task.id} is not assigned to a valid milestone.`);
    if (task.acceptanceCriteria.length === 0) push("error", "TASK_NO_ACCEPTANCE", `Task ${task.id} has no acceptance criteria.`);
    if (task.requiredEvidence.length === 0) push("error", "TASK_NO_EVIDENCE", `Task ${task.id} has no required evidence.`);
    if (task.requirementIds.length === 0) push("critical", "TASK_NO_REQUIREMENT", `Task ${task.id} is not linked to a requirement.`);
    if (!task.readOnly && task.targetPaths.length === 0) push("critical", "TASK_NO_OWNERSHIP", `Mutable task ${task.id} has no owned paths.`);
    if (task.parent_task_id && !taskIds.has(task.parent_task_id)) push("critical", "TASK_PARENT_MISSING", `Task ${task.id} references missing parent ${task.parent_task_id}.`);
    if (task.parent_task_id) {
      const parent = tasks.find((item) => item.id === task.parent_task_id);
      if (parent && parent.role !== "coordinator") push("error", "TASK_PARENT_ROLE", `Task ${task.id} parent ${parent.id} is not a coordinator.`);
    }
    if (config && task.delegation_depth > Number(config.orchestration.maxDelegationDepth ?? 2)) {
      push("critical", "DELEGATION_DEPTH", `Task ${task.id} exceeds the maximum delegation depth.`);
    }
    invariant(Number.isInteger(task.wave) && task.wave > 0, "TASK_WAVE", `Task ${task.id} has an invalid wave.`);
    for (const dependency of task.dependsOn) {
      const dependencyTask = listTasks(db, runId).find((item) => item.id === dependency);
      if (!taskIds.has(dependency) && !dependencyTask) {
        push("critical", "DEPENDENCY_MISSING", `Task ${task.id} depends on missing task ${dependency}.`);
      }
      if (dependencyTask && dependencyTask.phase === task.phase && Number(dependencyTask.wave) > Number(task.wave)) {
        push("critical", "TASK_WAVE_DEPENDENCY", `Task ${task.id} in wave ${task.wave} depends on later wave ${dependencyTask.wave}.`);
      }
    }
    for (const contract of task.interfaceContracts ?? []) {
      if (contract.status !== "frozen") push("critical", "TASK_INTERFACE_NOT_FROZEN", `Task ${task.id} references ${contract.name} v${contract.version} before it is frozen.`);
    }
    if (config && config.delegation?.requireReadyTaskPacket !== false) {
      const packet = taskPacketStatus(db, task.id, config);
      if (!packet.current) push("critical", "TASK_PACKET_NOT_READY", `Task ${task.id} has no current compiled task packet.`);
    }
    if (REVIEW_ROLES.has(task.role) && !task.readOnly) push("critical", "REVIEWER_MUTABLE", `Review task ${task.id} must be read-only.`);
    if (REVIEW_ROLES.has(task.role) && !task.review_kind) push("error", "REVIEW_KIND_MISSING", `Review task ${task.id} needs reviewKind.`);
    if (!task.readOnly) canonicalPaths.set(task.id, canonicalTaskPaths(task, push));
    taskQualityFindings(task, tasks, push);
  }

  const reaches = dependencyClosure(tasks);
  const milestoneReaches = dependencyClosure(milestones);
  const implementationTasks = tasks.filter((task) => task.phase === "execute"
    && !task.readOnly && ["worker", "integrator"].includes(task.role));
  const parallelismState = plannerParallelismDeclaration(db, projectRoot, runId);
  const parallelism = parallelismState.declaration;
  const verificationDeclaration = parallelismState.verificationDeclaration;
  if (parallelismState.error) {
    push("critical", "PARALLELISM_DRAFT_UNBOUND", parallelismState.error);
  } else {
    if (!parallelism || typeof parallelism !== "object" || Array.isArray(parallelism)) {
      push("critical", "PARALLELISM_DECLARATION_MISSING", "The current planner draft must include a parallelism declaration.");
    } else {
      const parallelismEligible = parallelism.eligible ?? parallelism.Eligible;
      const rationale = String(parallelism.rationale ?? parallelism.Rationale ?? "").trim();
      if (typeof parallelismEligible !== "boolean") {
        push("critical", "PARALLELISM_ELIGIBILITY_INVALID", "The parallelism declaration must set eligible to true or false.");
      }
      if (!rationale) {
        push("critical", "PARALLELISM_RATIONALE_MISSING", "The parallelism declaration must include a non-empty rationale.");
      }
      if (parallelismEligible === true) {
        const minimum = Number(parallelism.minimumSameWaveImplementationTasks ?? parallelism.MinimumSameWaveImplementationTasks);
        if (!Number.isInteger(minimum) || minimum < 4) {
          push("critical", "PARALLELISM_DECLARATION_INVALID", "An eligible parallel plan must declare a minimumSameWaveImplementationTasks value of at least 4.");
        } else {
          const executeTasks = tasks.filter((task) => task.phase === "execute");
          const earliestWave = executeTasks.length > 0 ? Math.min(...executeTasks.map((task) => Number(task.wave))) : null;
          const sameWave = executeTasks.filter((task) => Number(task.wave) === earliestWave
            && !task.readOnly && ["worker", "integrator"].includes(task.role));
          if (sameWave.length === 0) {
            push("critical", "PARALLELISM_IMPLEMENTATION_TASKS_MISSING", "An eligible parallel plan has no worker or integrator execute tasks.");
          } else {
            const independentSlices = declaredInteger(parallelism.independentSlices ?? parallelism.IndependentSlices);
            const desiredWidth = declaredInteger(parallelism.desiredWidth ?? parallelism.DesiredWidth);
            if (!independentSlices) push("critical", "PARALLELISM_INDEPENDENT_SLICES_MISSING", "An eligible parallel plan must declare independentSlices.");
            if (!desiredWidth) push("critical", "PARALLELISM_DESIRED_WIDTH_MISSING", "An eligible parallel plan must declare desiredWidth.");
            if (sameWave.length < minimum) {
              push("critical", "PARALLELISM_MINIMUM_NOT_MET", `Eligible parallel plan has ${sameWave.length} worker or integrator tasks in its earliest execution wave; ${minimum} are required.`);
            } else if (!hasCompatibleSubset(sameWave, minimum, (left, right) => (
              independentlyRunnable(left, right, reaches, milestoneReaches)
            ))) {
              push("critical", "PARALLELISM_DEPENDENCY_COUPLED", `Eligible parallel plan does not have ${minimum} dependency-independent implementation tasks in its earliest execution wave.`);
            }
            const acceptanceCompatible = (left, right) => {
              const leftCriteria = new Set(left.acceptanceCriteria.map(normalizedAcceptance).filter(Boolean));
              const rightCriteria = new Set(right.acceptanceCriteria.map(normalizedAcceptance).filter(Boolean));
              return ![...leftCriteria].some((criterion) => rightCriteria.has(criterion));
            };
            const safeCompatible = (left, right) => independentlyRunnable(left, right, reaches, milestoneReaches)
              && pathsAreExclusive(left, right, canonicalPaths)
              && acceptanceCompatible(left, right);
            const safeSlices = maximumCompatibleSubset(sameWave, safeCompatible);
            const hostCapacity = declaredInteger(config?.orchestration?.maxConcurrent) ?? Number.POSITIVE_INFINITY;
            let remainingSpawnBudget = Number.POSITIVE_INFINITY;
            try {
              remainingSpawnBudget = budgetStatus(db, runId).remaining.agentSpawns ?? Number.POSITIVE_INFINITY;
            } catch {
              // Low-level callers may lint an uninitialized fixture; host capacity still applies.
            }
            const expectedWidth = Math.min(hostCapacity, safeSlices, remainingSpawnBudget);
            if (independentSlices && independentSlices !== safeSlices) {
              push("critical", "PARALLELISM_INDEPENDENT_SLICES_MISMATCH", `Declared independentSlices ${independentSlices} does not match the ${safeSlices} safe independent slices in the earliest execution wave.`);
            }
            if (desiredWidth && desiredWidth !== expectedWidth) {
              const underutilized = desiredWidth < expectedWidth && !couplingRationale(rationale);
              push("critical", underutilized ? "PARALLELISM_WIDTH_UNDERUTILIZED" : "PARALLELISM_DESIRED_WIDTH_MISMATCH", `Declared desiredWidth ${desiredWidth} must equal min(host capacity ${hostCapacity}, safe independent slices ${safeSlices}, remaining spawn budget ${remainingSpawnBudget}) = ${expectedWidth}.`);
            }
            const acceptanceOwners = new Map();
            for (const task of sameWave) {
              const criteria = task.acceptanceCriteria.map(normalizedAcceptance).filter(Boolean);
              if (criteria.length === 0 || criteria.length !== task.acceptanceCriteria.length) {
                push("critical", "PARALLELISM_ACCEPTANCE_MISSING", `Same-wave implementation task ${task.id} has no independent acceptance criteria.`);
              }
              for (const criterion of new Set(criteria)) {
                const owner = acceptanceOwners.get(criterion);
                if (owner && owner !== task.id) {
                  push("critical", "PARALLELISM_ACCEPTANCE_DUPLICATED", `Same-wave implementation tasks ${owner} and ${task.id} duplicate acceptance criterion: ${criterion}.`);
                } else {
                  acceptanceOwners.set(criterion, task.id);
                }
              }
            }
            for (let left = 0; left < sameWave.length; left += 1) {
              for (let right = left + 1; right < sameWave.length; right += 1) {
                const a = sameWave[left];
                const b = sameWave[right];
                const aPaths = canonicalPaths.get(a.id) ?? [];
                const bPaths = canonicalPaths.get(b.id) ?? [];
                if (aPaths.length === 0 || bPaths.length === 0) {
                  push("critical", "PARALLELISM_PATH_MISSING", `Same-wave implementation tasks ${a.id} and ${b.id} need non-empty canonical target paths.`);
                } else if (aPaths.some((aPath) => bPaths.some((bPath) => pathsOverlap(aPath, bPath)))) {
                  push("critical", "PARALLELISM_SAME_WAVE_OVERLAP", `Same-wave implementation tasks ${a.id} and ${b.id} do not have exclusive target paths.`);
                }
              }
            }
          }
        }
      } else if (parallelismEligible === false && rationale) {
        if (implementationTasks.length !== 1 && !couplingRationale(rationale)) {
          push("critical", "PARALLELISM_ATOMIC_ONLY", "An ineligible parallel plan must keep implementation work to one atomic task unless its rationale names the coupling that prevents fan-out.");
        }
        const bundled = implementationTasks.find((task) => (canonicalPaths.get(task.id) ?? []).length >= 4);
        if (bundled) {
          push("critical", "PARALLELISM_FALSE_BUNDLED_PATHS", `Task ${bundled.id} bundles at least four canonical mutable target paths; the plan cannot declare parallelism ineligible.`);
        }
        if (hasCompatibleSubset(implementationTasks, 4, (left, right) => (
          independentlyRunnable(left, right, reaches, milestoneReaches)
          && pathsAreExclusive(left, right, canonicalPaths)
        ))) {
          push("critical", "PARALLELISM_FALSE_DECOMPOSABLE", "The materialized graph already contains at least four dependency-independent, non-overlapping mutable implementation slices.");
        }
      }
    }
  }

  if (!parallelismState.error) {
    const verifierTasks = tasks.filter((task) => ["review", "verify"].includes(task.phase) && task.role === "verifier");
    for (const verifier of verifierTasks) {
      if (!verifier.readOnly) push("critical", "VERIFICATION_CANDIDATE_MUTABLE", `Verifier task ${verifier.id} must be immutable/read-only.`);
    }
    if (verifierTasks.length === 1 && !verificationDeclaration) {
      push("critical", "VERIFICATION_PARALLELISM_DECLARATION_MISSING", "A single verifier requires a verificationParallelism declaration with a concrete atomic rationale.");
    }
    verificationParallelismFindings(
      db,
      runId,
      verificationDeclaration,
      push,
      config
    );
  }

  const mutable = tasks.filter((task) => !task.readOnly);
  for (let left = 0; left < mutable.length; left += 1) {
    for (let right = left + 1; right < mutable.length; right += 1) {
      const a = mutable[left];
      const b = mutable[right];
      const aPaths = canonicalPaths.get(a.id) ?? [];
      const bPaths = canonicalPaths.get(b.id) ?? [];
      const overlaps = aPaths.some((aPath) => bPaths.some((bPath) => pathsOverlap(aPath, bPath)));
      if (!overlaps) continue;
      if (!reaches(a.id, b.id) && !reaches(b.id, a.id)) {
        push("critical", "PARALLEL_OWNERSHIP_OVERLAP", `Tasks ${a.id} and ${b.id} can run concurrently but own overlapping paths.`);
      }
    }
  }

  const mustIds = requirements.filter((item) => item.priority === "must").map((item) => item.id);
  for (const requirementId of mustIds) {
    const linked = tasks.filter((task) => task.requirementIds.includes(requirementId));
    if (!linked.some((task) => ["execute", "curate"].includes(task.phase) && ["worker", "integrator", "curator"].includes(task.role))) {
      push("critical", "REQUIREMENT_NOT_IMPLEMENTED", `Must requirement ${requirementId} has no implementation or curation task.`);
    }
    if (!linked.some((task) => task.phase === "verify" || task.role === "verifier" || task.role === "adversarial-reviewer")) {
      push("critical", "REQUIREMENT_NOT_VERIFIED", `Must requirement ${requirementId} has no verification task.`);
    }
  }

  const integrationReviews = tasks.filter((task) => REVIEW_ROLES.has(task.role) && task.review_kind === "integration");
  if (lifecycleReviewRequired(route, config, "integration") && integrationReviews.length === 0) {
    push("critical", "NO_INTEGRATION_REVIEW", "The plan has no independent integration review task.");
  }
  const adversarial = tasks.filter((task) => task.role === "adversarial-reviewer" && task.review_kind === "completion");
  if (lifecycleReviewRequired(route, config, "completion") && adversarial.length === 0) {
    push("critical", "NO_ADVERSARIAL_REVIEW", "The plan has no adversarial completion review task.");
  }
  const verifierTasks = tasks.filter((task) => ["review", "verify"].includes(task.phase) && task.role === "verifier");
  if (verifierTasks.length === 0) push("critical", "NO_VERIFIER_TASK", "The plan has no independent verifier task.");

  const uiExecuteTasks = tasks.filter((task) => task.phase === "execute" && capabilityNames(task).has("frontend-ui"));
  if (uiExecuteTasks.length > 0) {
    const visualReviews = integrationReviews.filter((task) => capabilityNames(task).has("visual-review"));
    if (visualReviews.length === 0) {
      push("critical", "UI_VISUAL_REVIEW_MISSING", "UI work requires an independent integration reviewer with the visual-review capability.");
    }
    const browserVerifiers = verifierTasks.filter((task) => capabilityNames(task).has("browser-testing"));
    if (browserVerifiers.length === 0) {
      push("critical", "UI_BROWSER_VERIFIER_MISSING", "UI work requires an independent verifier with the browser-testing capability.");
    }
  }
  const curatorTasks = tasks.filter((task) => task.phase === "curate" && task.role === "curator");
  if (route.documentationRequired !== false && curatorTasks.length === 0) push("error", "NO_CURATOR_TASK", "The plan has no curator task for documentation and knowledge consistency.");

  if (config) {
    const required = requiredSpecialistRoles(tasks.filter((task) => task.phase === "execute"), config);
    const present = new Set(tasks.map((task) => task.role));
    for (const role of required) {
      if (!present.has(role)) push("critical", "SPECIALIST_REVIEW_MISSING", `The change surface requires a ${role} task.`);
    }
  }

  return {
    verdict: findings.some((finding) => BLOCKING_SEVERITIES.has(finding.severity)) ? "REJECTED" : "APPROVED",
    findings,
    summary: {
      tasks: tasks.length,
      milestones: milestones.length,
      requirements: requirements.length,
      integrationReviews: integrationReviews.length,
      adversarialReviews: adversarial.length
    }
  };
}

function normalizeFinding(db, projectRoot, finding) {
  return {
    severity: String(finding.severity ?? finding.Severity ?? "warning").toLowerCase(),
    code: String(finding.code ?? finding.Code ?? "AGENT_REVIEW").trim(),
    claim: String(finding.claim ?? finding.Claim ?? finding.description ?? finding.Description ?? "").trim(),
    evidenceRefs: normalizeEvidenceRefs(db, projectRoot, finding.evidenceRefs ?? finding.EvidenceRefs ?? [])
  };
}

function requireCurrentPlanCritic(db, projectRoot, run, plan, reviewer) {
  invariant(reviewer?.run_id === run.id, "PLAN_CRITIC_RUN", "Plan critic task belongs to another run.");
  invariant(reviewer.role === "plan-critic", "PLAN_CRITIC_ROLE", "Plan review must come from a plan-critic task.");
  invariant(reviewer.status === "completed", "PLAN_CRITIC_STATUS", "Plan critic task must be completed.");
  invariant(reviewer.result?.Status === "COMPLETED", "PLAN_CRITIC_RESULT", "The plan critic's current result is not completed.");

  const attemptArtifact = latestArtifact(db, projectRoot, run.id, `task-changes:${reviewer.id}`, ["verified"]);
  const attempt = parseJson(attemptArtifact?.content, null);
  invariant(
    reviewer.attempts > 0
      && attemptArtifact?.task_id === reviewer.id
      && Number(attemptArtifact.metadata?.attempt) === Number(reviewer.attempts)
      && attempt?.taskId === reviewer.id
      && Number(attempt?.attempt) === Number(reviewer.attempts)
      && attempt?.resultStatus === "COMPLETED",
    "PLAN_CRITIC_ATTEMPT",
    "The plan critic result is not attested by its current completed attempt."
  );

  const planEvidence = asArray(reviewer.result?.EvidenceRefs).some((ref) => (
    ref?.type === "artifact"
      && ref.id === plan.id
      && ref.contentRef === plan.content_ref
      && evidenceRefIsCurrent(db, projectRoot, ref)
  ));
  invariant(planEvidence, "PLAN_CRITIC_EVIDENCE", "The plan critic must cite the current sealed plan artifact.");
}

export function recordPlanReview(db, projectRoot, runId, input, config) {
  const run = getRun(db, runId);
  invariant(run.phase === "plan", "PLAN_REVIEW_PHASE", "Plan review must occur during the plan phase.");
  const plan = latestArtifact(db, projectRoot, run.id, "plan", ["verified"]);
  invariant(plan, "PLAN_REVIEW_PLAN", "Seal the plan before recording its review.");
  const planData = JSON.parse(plan.content ?? "{}");

  const reviewerTaskId = input.reviewerTaskId ?? input.ReviewerTaskId ?? null;
  let reviewer = reviewerTaskId ? getTask(db, reviewerTaskId) : null;
  if (!reviewer) {
    const row = db.prepare(`
      SELECT id FROM tasks WHERE run_id = ? AND role = 'plan-critic' AND status = 'completed'
      ORDER BY updated_at DESC LIMIT 1
    `).get(run.id);
    reviewer = row ? getTask(db, row.id) : null;
  }
  if (config.orchestration.requirePlanCritic || reviewerTaskId) {
    invariant(reviewer, "PLAN_CRITIC_REQUIRED", "A completed plan-critic task is required.");
    requireCurrentPlanCritic(db, projectRoot, run, plan, reviewer);
  }

  const deterministic = lintPlan(db, run.id, config, projectRoot);
  const agentFindings = asArray(input.findings ?? input.Findings ?? reviewer?.result?.Findings)
    .map((finding) => normalizeFinding(db, projectRoot, finding))
    .filter((finding) => finding.claim);
  const findings = [...deterministic.findings, ...agentFindings];
  const requestedVerdict = String(input.verdict ?? input.Verdict ?? reviewer?.result?.Verdict ?? deterministic.verdict).toUpperCase();
  invariant(["APPROVED", "REJECTED"].includes(requestedVerdict), "PLAN_REVIEW_VERDICT", "Plan review verdict must be APPROVED or REJECTED.");
  const blocking = findings.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity));
  const verdict = blocking.length > Number(config.orchestration.maxPlanCriticalFindings ?? 0) ? "REJECTED" : requestedVerdict;
  invariant(!(verdict === "APPROVED" && blocking.length > Number(config.orchestration.maxPlanCriticalFindings ?? 0)), "PLAN_REVIEW_BLOCKING", "A plan with blocking findings cannot be approved.");

  const review = {
    version: 5,
    planArtifactId: plan.id,
    planContentRef: plan.content_ref,
    planHash: planData.planHash ?? null,
    contractVersion: run.contract_version,
    reviewerTaskId: reviewer?.id ?? null,
    verdict,
    findings,
    reviewedAt: now()
  };
  const artifact = putArtifact(db, projectRoot, run.id, "plan-review", review, {
    taskId: reviewer?.id ?? null,
    status: "verified",
    metadata: {
      planArtifactId: plan.id,
      planContentRef: plan.content_ref,
      planHash: review.planHash,
      contractVersion: review.contractVersion,
      verdict,
      blockingFindings: blocking.length
    }
  });
  recordEvent(db, run.id, "plan.reviewed", verdict === "APPROVED" ? "info" : "warning", {
    artifactId: artifact.id,
    reviewerTaskId: reviewer?.id ?? null,
    planHash: review.planHash,
    verdict,
    blockingFindings: blocking.length
  });
  return { ...review, artifactId: artifact.id };
}
