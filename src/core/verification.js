import { invariant } from "./errors.js";
import { governanceReport } from "./governance.js";
import { repositoryCodeFingerprint, syncRepository } from "./repository.js";
import { reviewReport } from "./reviews.js";
import { getRun, latestArtifact, lifecycleReviewRequired, lifecycleRoute, putArtifact, recordEvent } from "./state.js";
import { listTasks } from "./tasks.js";
import { listMilestones } from "./milestones.js";
import { currentPlanDraftBinding } from "./plan-ingest.js";
import { traceabilityReport } from "./traceability.js";
import { listChecks } from "./checks.js";
import { asArray, now, parseJson, sha256, stableStringify } from "./util.js";
import { budgetStatus } from "./budget.js";

function parsed(artifact) {
  try { return artifact?.content ? JSON.parse(artifact.content) : null; } catch { return null; }
}

function integrationReviewIsCurrent(db, projectRoot, runId) {
  const artifact = latestArtifact(db, projectRoot, runId, "integration-review", ["verified"]);
  if (!artifact) return { pass: false, reason: "Integration review approval is missing." };
  const content = parsed(artifact) ?? {};
  const candidate = latestArtifact(db, projectRoot, runId, "integration-candidate", ["verified"]);
  if (!candidate) return { pass: false, reason: "Integration candidate is missing or stale." };
  const candidateContent = parsed(candidate) ?? {};
  const expected = repositoryCodeFingerprint(db);
  const actual = content.fingerprint?.codeFingerprint ?? artifact.metadata?.codeFingerprint;
  const bound = content.fingerprint?.artifactId === candidate.id
    && content.fingerprint?.contentRef === candidate.content_ref;
  return actual === expected && candidateContent.codeFingerprint === expected && bound
    ? { pass: true, artifact, candidate, codeFingerprint: expected }
    : { pass: false, reason: "Integration review is stale for the current repository state.", expected, actual };
}

function routeForRun(db, runId) {
  return lifecycleRoute(parseJson(db.prepare("SELECT route_json FROM runs WHERE id = ?").get(runId)?.route_json, {}));
}

export function verificationDimensionReport(tasks) {
  const verifiers = tasks.filter((task) => ["review", "verify"].includes(task.phase) && task.role === "verifier");
  const earliestWave = verifiers.length > 0 ? Math.min(...verifiers.map((task) => Number(task.wave))) : null;
  const dimensions = verifiers
    .filter((task) => Number(task.wave) === earliestWave)
    .map((task) => ({
      id: task.id,
      wave: Number(task.wave),
      acceptanceCriteria: [...task.acceptanceCriteria],
      verificationModes: [...task.verificationModes],
      requirementIds: [...task.requirementIds].sort(),
      acceptanceResults: asArray(task.result?.AcceptanceResults ?? task.result?.acceptanceResults)
    }));
  return {
    earliestWave,
    dimensions,
    dimensionCount: dimensions.length,
    verifierCount: verifiers.length
  };
}

function dependencyClosure(items) {
  const dependencies = new Map(items.map((item) => [item.id, new Set(item.dependsOn ?? [])]));
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

function normalizedValues(values) {
  return new Set(asArray(values)
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"))
    .filter(Boolean));
}

function independentVerifierPair(left, right, taskReaches, milestoneReaches) {
  if (taskReaches(left.id, right.id) || taskReaches(right.id, left.id)) return false;
  if (left.milestone_id && right.milestone_id && left.milestone_id !== right.milestone_id
      && (milestoneReaches(left.milestone_id, right.milestone_id)
        || milestoneReaches(right.milestone_id, left.milestone_id))) return false;
  const leftAcceptance = normalizedValues(left.acceptanceCriteria);
  const rightAcceptance = normalizedValues(right.acceptanceCriteria);
  const leftModes = normalizedValues(left.verificationModes);
  const rightModes = normalizedValues(right.verificationModes);
  return leftAcceptance.size > 0
    && rightAcceptance.size > 0
    && leftModes.size > 0
    && rightModes.size > 0
    && ![...leftAcceptance].some((criterion) => rightAcceptance.has(criterion))
    && ![...leftModes].some((mode) => rightModes.has(mode));
}

function atomicRationaleIsConcrete(declaration, verifierTasks) {
  const rationale = String(declaration?.rationale ?? declaration?.Rationale ?? "").trim();
  if (rationale.length < 24) return false;
  const normalizedRationale = rationale.replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  if (/^(atomic|single verifier|not safe|n\/a)[.! ]*$/u.test(normalizedRationale)) return false;
  const evidenceRefs = asArray(declaration?.evidenceRefs ?? declaration?.EvidenceRefs ?? declaration?.evidence ?? declaration?.Evidence)
    .filter((ref) => (typeof ref === "string" && ref.trim()) || (ref && typeof ref === "object" && !Array.isArray(ref)));
  if (evidenceRefs.length > 0) return true;
  const evidenceTerms = verifierTasks.flatMap((task) => [
    ...asArray(task.acceptanceCriteria),
    ...asArray(task.verificationModes),
    ...asArray(task.requirementIds),
    ...asArray(task.scope)
  ]).map((value) => String(value).trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"))
    .filter((value) => value.length >= 4);
  return evidenceTerms.some((term) => normalizedRationale.includes(term));
}

function maximumIndependentSubset(tasks, compatible) {
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

export function verificationParallelismReport(db, runId, options = {}) {
  const declaration = options.declaration ?? null;
  const verifierTasks = listTasks(db, runId).filter((task) => ["review", "verify"].includes(task.phase) && task.role === "verifier");
  if (!declaration) return { enforced: false, pass: verifierTasks.every((task) => task.readOnly), verifierTasks, pairs: [], findings: verifierTasks.filter((task) => !task.readOnly).map((task) => ({ code: "VERIFICATION_CANDIDATE_MUTABLE", claim: `Verifier task ${task.id} must be immutable/read-only.` })) };

  const findings = [];
  const fail = (code, claim) => findings.push({ code, claim });
  for (const task of verifierTasks) {
    if (!task.readOnly) fail("VERIFICATION_CANDIDATE_MUTABLE", `Verifier task ${task.id} must be immutable/read-only when declaring parallel verification dimensions.`);
  }
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    fail("VERIFICATION_PARALLELISM_DECLARATION_INVALID", "The verification parallelism declaration must be an object.");
    return { enforced: true, pass: false, verifierTasks, pairs: [], findings };
  }
  const eligible = declaration.eligible ?? declaration.Eligible;
  const rationale = String(declaration.rationale ?? declaration.Rationale ?? "").trim();
  if (typeof eligible !== "boolean") fail("VERIFICATION_PARALLELISM_ELIGIBILITY_INVALID", "The verification parallelism declaration must set eligible to true or false.");
  if (!rationale) fail("VERIFICATION_PARALLELISM_RATIONALE_MISSING", "The verification parallelism declaration needs a rationale.");

  const minimum = Number(declaration.minimumSameWaveVerifierTasks ?? declaration.MinimumSameWaveVerifierTasks ?? 2);
  if (!Number.isInteger(minimum) || minimum < 2) {
    fail("VERIFICATION_PARALLELISM_MINIMUM_INVALID", "Verification parallelism must require at least two same-wave verifier tasks.");
  }

  const earliestWave = verifierTasks.length > 0 ? Math.min(...verifierTasks.map((task) => Number(task.wave))) : null;
  const earliest = earliestWave === null ? [] : verifierTasks.filter((task) => Number(task.wave) === earliestWave);
  const taskReaches = dependencyClosure(listTasks(db, runId));
  const milestoneReaches = dependencyClosure(listMilestones(db, runId));
  const pairs = [];
  for (let left = 0; left < earliest.length; left += 1) {
    for (let right = left + 1; right < earliest.length; right += 1) {
      if (independentVerifierPair(earliest[left], earliest[right], taskReaches, milestoneReaches)) {
        pairs.push([earliest[left].id, earliest[right].id]);
      }
    }
  }

  if (eligible === true) {
    const independentSlices = Number(declaration.independentSlices ?? declaration.IndependentSlices);
    const desiredWidth = Number(declaration.desiredWidth ?? declaration.DesiredWidth);
    if (!Number.isInteger(independentSlices) || independentSlices < 2) {
      fail("VERIFICATION_INDEPENDENT_SLICES_MISSING", "An eligible verification plan must declare independentSlices of at least two.");
    }
    if (!Number.isInteger(desiredWidth) || desiredWidth < 2) {
      fail("VERIFICATION_DESIRED_WIDTH_MISSING", "An eligible verification plan must declare desiredWidth of at least two.");
    }
    const safeSlices = maximumIndependentSubset(earliest, (left, right) => independentVerifierPair(left, right, taskReaches, milestoneReaches));
    const hostCapacity = Number.isInteger(options.hostCapacity) && options.hostCapacity > 0 ? options.hostCapacity : Number.POSITIVE_INFINITY;
    const remainingSpawnBudget = Number.isFinite(options.remainingSpawnBudget)
      ? Math.max(0, Number(options.remainingSpawnBudget))
      : (() => { try { return budgetStatus(db, runId).remaining.agentSpawns ?? Number.POSITIVE_INFINITY; } catch { return Number.POSITIVE_INFINITY; } })();
    const expectedWidth = Math.min(hostCapacity, safeSlices, remainingSpawnBudget);
    if (Number.isInteger(independentSlices) && independentSlices !== safeSlices) {
      fail("VERIFICATION_INDEPENDENT_SLICES_MISMATCH", `Declared independentSlices ${independentSlices} does not match the ${safeSlices} safe verifier dimensions.`);
    }
    if (Number.isInteger(desiredWidth) && desiredWidth !== expectedWidth) {
      fail("VERIFICATION_DESIRED_WIDTH_MISMATCH", `Declared desiredWidth ${desiredWidth} must equal min(host capacity ${hostCapacity}, safe independent slices ${safeSlices}, remaining spawn budget ${remainingSpawnBudget}) = ${expectedWidth}.`);
    }
    if (earliest.length < minimum) {
      fail("VERIFICATION_PARALLELISM_MINIMUM_NOT_MET", `The earliest verification wave has ${earliest.length} verifier dimensions; ${minimum} are required.`);
    } else if (pairs.length === 0) {
      fail("VERIFICATION_PARALLELISM_DIMENSIONS_NOT_INDEPENDENT", "The earliest verifier dimensions are not independent with disjoint acceptance criteria and verification modes.");
    }
    for (let left = 0; left < earliest.length; left += 1) {
      for (let right = left + 1; right < earliest.length; right += 1) {
        if (!independentVerifierPair(earliest[left], earliest[right], taskReaches, milestoneReaches)) {
          fail("VERIFICATION_DIMENSIONS_NOT_DISJOINT", `Verifier dimensions ${earliest[left].id} and ${earliest[right].id} are not independent with disjoint acceptance criteria and modes.`);
        }
      }
    }
  } else if (eligible === false) {
    if (verifierTasks.length !== 1) {
      fail("VERIFICATION_PARALLELISM_ATOMIC_ONLY", "An ineligible verification plan may contain only one atomic verifier task.");
    }
    if (pairs.length > 0) {
      fail("VERIFICATION_PARALLELISM_FALSE_SAFE", "The earliest verification wave contains independent verifier dimensions that can be run in parallel.");
    }
    if (!atomicRationaleIsConcrete(declaration, earliest)) {
      fail("VERIFICATION_PARALLELISM_ATOMIC_EVIDENCE_MISSING", "A single or coupled verifier requires a concrete rationale grounded in its acceptance criteria, verification modes, or explicit evidence references.");
    }
  }

  return {
    enforced: true,
    pass: findings.length === 0,
    eligible,
    rationale,
    minimum,
    verifierTasks,
    earliestWave,
    earliestVerifierTaskIds: earliest.map((task) => task.id),
    pairs,
    findings
  };
}

function verificationDeclarationFromDraft(draft) {
  return draft?.verificationParallelism
    ?? draft?.VerificationParallelism
    ?? draft?.parallelism?.verification
    ?? draft?.parallelism?.Verification
    ?? draft?.parallelism?.verificationParallelism
    ?? null;
}

function currentVerificationParallelism(db, projectRoot, runId) {
  const draftCount = Number(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind LIKE 'plan-draft:%' AND kind NOT LIKE 'plan-draft-ingested:%' AND status = 'verified'").get(runId)?.count ?? 0);
  if (draftCount === 0 || !projectRoot) return null;
  const binding = currentPlanDraftBinding(db, projectRoot, runId);
  return verificationDeclarationFromDraft(parseJson(binding?.draftArtifact?.content, null));
}

export function createVerificationCandidate(db, projectRoot, runId, config) {
  const run = getRun(db, runId);
  invariant(run.phase === "verify", "VERIFICATION_CANDIDATE_PHASE", "Create the verification candidate during verify.");
  syncRepository(db, projectRoot, config, run.id);

  const tasks = listTasks(db, run.id);
  const prerequisiteTasks = tasks.filter((task) => task.role === "verifier" && ["review", "verify"].includes(task.phase));
  const verificationDimensions = verificationDimensionReport(tasks);
  const verificationParallelism = verificationParallelismReport(db, run.id, {
    declaration: currentVerificationParallelism(db, projectRoot, run.id)
  });
  invariant(verificationParallelism.pass, "VERIFICATION_PARALLELISM", "Verification dimensions are not safely decomposed.", verificationParallelism.findings);
  invariant(prerequisiteTasks.length > 0, "VERIFICATION_TASKS_REQUIRED", "At least one independent verifier task is required.");
  const incomplete = prerequisiteTasks.filter((task) => task.status !== "completed");
  invariant(incomplete.length === 0, "VERIFICATION_TASKS_INCOMPLETE", "Every independent verifier task must complete; verification evidence cannot be waived.", {
    tasks: incomplete.map((task) => ({ id: task.id, status: task.status }))
  });
  const integrationCandidate = latestArtifact(db, projectRoot, run.id, "integration-candidate", ["verified"]);
  const integrationCandidateContent = parsed(integrationCandidate) ?? {};
  const staleVerifierSubjects = prerequisiteTasks
    .filter((task) => task.phase === "review" && task.status === "completed")
    .filter((task) => {
      const baseline = latestArtifact(db, projectRoot, run.id, `task-baseline:${task.id}`, ["verified"]);
      const subject = parsed(baseline)?.subject;
      return !integrationCandidate
        || subject?.kind !== "integration-candidate"
        || subject?.artifactId !== integrationCandidate.id
        || subject?.contentRef !== integrationCandidate.content_ref
        || subject?.codeFingerprint !== integrationCandidateContent.codeFingerprint;
    });
  invariant(staleVerifierSubjects.length === 0, "VERIFICATION_INTEGRATION_CANDIDATE_STALE", "Verifier tasks did not consume the current immutable integration candidate.", {
    tasks: staleVerifierSubjects.map((task) => task.id)
  });

  const checks = listChecks(db, run.id);
  const requiredChecks = checks.filter((check) => Boolean(check.required));
  const failedRequired = requiredChecks.filter((check) => check.status !== "passed");
  invariant(failedRequired.length === 0, "VERIFICATION_CHECKS", "Required checks are stale or failed.", {
    checks: failedRequired.map((check) => ({ id: check.id, name: check.name, status: check.status }))
  });

  const route = routeForRun(db, run.id);
  const reviewRequired = lifecycleReviewRequired(route, config, "integration");
  const integration = reviewRequired
    ? integrationReviewIsCurrent(db, projectRoot, run.id)
    : { pass: true, artifact: null, codeFingerprint: repositoryCodeFingerprint(db), waived: true };
  invariant(integration.pass, "VERIFICATION_INTEGRATION_REVIEW", integration.reason, integration);
  const reviews = reviewReport(db, run.id);
  const blockingIntegration = reviews.blocking.filter((item) => item.review_kind === "integration");
  invariant(blockingIntegration.length === 0, "VERIFICATION_REVIEW_FINDINGS", "Blocking integration review findings remain.", {
    findings: blockingIntegration.map((item) => item.id)
  });

  const traceability = traceabilityReport(db, run.id, { refreshStatuses: true });
  invariant(traceability.pass, "VERIFICATION_TRACEABILITY", "Must requirements are not fully implemented and verified.", traceability.summary);
  const governance = governanceReport(db, run.id, config);
  invariant(governance.passForCompletion, "VERIFICATION_GOVERNANCE", "Governance blockers remain before completion review.", governance.blockers);

  const staleFindings = db.prepare("SELECT id FROM findings WHERE run_id = ? AND status = 'stale'").all(run.id);
  invariant(staleFindings.length === 0, "VERIFICATION_STALE_FINDINGS", "Stale findings remain before completion review.", {
    findings: staleFindings.map((item) => item.id)
  });
  const staleDecisions = db.prepare("SELECT id FROM decisions WHERE run_id = ? AND status = 'needs-review'").all(run.id);
  invariant(staleDecisions.length === 0, "VERIFICATION_STALE_DECISIONS", "Decisions need revalidation before completion review.", {
    decisions: staleDecisions.map((item) => item.id)
  });

  const codeFingerprint = integration.codeFingerprint;
  const content = {
    version: 1,
    runId: run.id,
    contractVersion: run.contract_version,
    codeFingerprint,
    integrationReview: integration.artifact ? {
      artifactId: integration.artifact.id,
      contentRef: integration.artifact.content_ref
    } : { waived: true },
    requirements: traceability.requirements.map((item) => ({
      id: item.id,
      title: item.title,
      priority: item.priority,
      designed: item.designed,
      planned: item.planned,
      implemented: item.implemented,
      verified: item.verified,
      gaps: item.gaps
    })),
    checks: checks.map((check) => ({
      id: check.id,
      name: check.name,
      required: Boolean(check.required),
      status: check.status,
      exitCode: check.exit_code,
      codeFingerprint: check.code_fingerprint,
      outputRef: check.output_ref
    })),
    verifierTasks: prerequisiteTasks.map((task) => ({
      id: task.id,
      role: task.role,
      status: task.status,
      acceptanceCriteria: [...task.acceptanceCriteria],
      verificationModes: [...task.verificationModes],
      acceptanceResults: asArray(task.result?.AcceptanceResults ?? task.result?.acceptanceResults),
      evidenceRefs: task.result?.EvidenceRefs ?? []
    })),
    verificationDimensions,
    verificationParallelism: verificationParallelism.enforced ? {
      eligible: verificationParallelism.eligible,
      earliestWave: verificationParallelism.earliestWave,
      verifierTaskIds: verificationParallelism.earliestVerifierTaskIds,
      pairs: verificationParallelism.pairs,
      rationale: verificationParallelism.rationale
    } : null,
    governance: {
      assumptions: governance.assumptions.map((item) => ({ id: item.id, status: item.status, impact: item.impact })),
      invariants: governance.invariants.map((item) => ({ id: item.id, status: item.status, severity: item.severity })),
      risks: governance.risks.map((item) => ({ id: item.id, status: item.status, severity: item.severity }))
    },
    activeDecisions: db.prepare("SELECT id, decision, status FROM decisions WHERE run_id = ? AND status = 'active' ORDER BY id").all(run.id),
    residualReviewFindings: reviews.findings
      .filter((item) => !["resolved", "accepted", "rejected"].includes(item.status))
      .map((item) => ({ id: item.id, severity: item.severity, status: item.status, reviewKind: item.review_kind })),
    generatedAt: now()
  };
  const candidateHash = sha256(stableStringify(content));
  const candidate = { ...content, candidateHash };

  const verificationArtifact = putArtifact(db, projectRoot, run.id, "verification", {
    version: 1,
    codeFingerprint,
    candidateHash,
    traceability: traceability.summary,
    checks: candidate.checks,
    verifierTasks: candidate.verifierTasks,
    verificationDimensions: candidate.verificationDimensions,
    verificationParallelism: candidate.verificationParallelism,
    generatedAt: candidate.generatedAt
  }, {
    status: "verified",
    metadata: { codeFingerprint, candidateHash, deterministic: true }
  });
  const artifact = putArtifact(db, projectRoot, run.id, "verification-candidate", candidate, {
    status: "verified",
    metadata: {
      codeFingerprint,
      candidateHash,
      verificationArtifactId: verificationArtifact.id,
      deterministic: true
    }
  });
  recordEvent(db, run.id, "verification.candidate-created", "info", {
    artifactId: artifact.id,
    candidateHash,
    codeFingerprint
  });
  return { candidate, artifact, verificationArtifact };
}

export function getVerificationCandidate(db, projectRoot, runId) {
  const run = getRun(db, runId);
  const artifact = latestArtifact(db, projectRoot, run.id, "verification-candidate", ["verified", "stale"]);
  if (!artifact) return null;
  return { artifact, candidate: parsed(artifact), metadata: parseJson(artifact.metadata_json, artifact.metadata ?? {}) };
}
