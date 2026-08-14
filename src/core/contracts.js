import { transaction } from "./db.js";
import { MetisError, invariant } from "./errors.js";
import { normalizeEvidenceRefs } from "./provenance.js";
import { getRun, putArtifact, recordEvent, touchRun } from "./state.js";
import { asArray, json, makeId, now, sha256, stableStringify } from "./util.js";
import { REQUIREMENT_KINDS as REQUIREMENT_KIND_LIST } from "./metadata.js";

const COMPLEXITIES = new Set(["trivial", "standard", "complex"]);
const REQUIREMENT_KINDS = new Set(REQUIREMENT_KIND_LIST);
const REQUIREMENT_PRIORITIES = new Set(["must", "should", "could"]);
const REQUIREMENT_STATUSES = new Set(["active", "implemented", "verified", "waived", "superseded"]);
const LIFECYCLE_PROFILES = new Set(["fast", "balanced", "full"]);
const OBSOLETE_ROUTE_FIELDS = new Set(["independentReviewRequired", "adversarialReviewRequired"]);
const HIGH_RISK_SEGMENTS = new Set([
  "auth", "authentication", "authorization", "security", "session", "sessions", "oauth", "crypto", "permissions",
  "db", "database", "schema", "schemas", "sql", "queries", "models", "migration", "migrations", "backfill", "rollout",
  "performance", "perf", "cache", "caches", "queue", "queues", "stream", "streams", "worker", "workers",
  "deploy", "deployment", "deployments", "release", "releases", "production", "infrastructure"
]);
const HIGH_RISK_REQUIREMENT_KINDS = new Set(["security", "database", "migration", "performance", "accessibility"]);
const UI_REQUIREMENT_KINDS = new Set(["ui", "ux", "frontend", "user-facing", "user-interface", "user-experience", "accessibility"]);

function strings(value) {
  return [...new Set(asArray(value).map((item) => String(item).trim()).filter(Boolean))];
}

function normalizedPaths(scope) {
  return strings(scope).map((item) => item.replaceAll("\\", "/").toLowerCase());
}

function hasEntries(value) {
  return asArray(value).some((item) => (typeof item === "string" ? item.trim() : item && typeof item === "object"));
}

function validateRoute(route) {
  for (const field of OBSOLETE_ROUTE_FIELDS) {
    invariant(!Object.hasOwn(route, field), "CONTRACT_OBSOLETE_ROUTE_FIELD", `Route field ${field} is obsolete; lifecycleProfile controls mandatory review gates.`);
  }
}

function lifecycleSignals(input, route, complexity, requirements, scope) {
  const paths = normalizedPaths(scope);
  const pathSegments = new Set(paths.flatMap((item) => item.split("/").filter(Boolean)));
  const requirementKinds = new Set(requirements.map((item) => item.kind));
  const extensions = new Set(paths.map((item) => item.match(/\.[^.\/]+$/u)?.[0]).filter(Boolean));
  const highRiskReasons = [];
  for (const segment of [...pathSegments].sort()) {
    if (HIGH_RISK_SEGMENTS.has(segment)) highRiskReasons.push(`high-risk surface: ${segment}`);
  }
  if ([...extensions].some((item) => [".tsx", ".jsx", ".vue", ".svelte", ".html", ".css", ".scss"].includes(item))) {
    highRiskReasons.push("high-risk surface: user-facing interface");
  }
  for (const kind of [...requirementKinds].sort()) {
    if (HIGH_RISK_REQUIREMENT_KINDS.has(kind) || UI_REQUIREMENT_KINDS.has(kind)) highRiskReasons.push(`high-risk requirement: ${kind}`);
  }
  if (complexity === "complex") highRiskReasons.push("complexity is complex");

  const externalCurrentFact = route.externalCurrentFact === true
    || route.externalCurrent === true
    || route.requiresExternalResearch === true
    || route.externalResearchRequired === true
    || hasEntries(input.externalCurrentFacts ?? input.externalCurrentFact ?? input.currentExternalFacts ?? input.externalFacts ?? input.currentFacts);
  const sharedInterfaceDecision = route.sharedInterfaceRequired === true
    || route.architectureDecisionRequired === true
    || hasEntries(input.sharedInterfaces ?? input.interfaces ?? input.architectureDecisions ?? input.architectureDecision)
    || hasEntries(route.sharedInterfaces ?? route.interfaces ?? route.architectureDecisions ?? route.architectureDecision);
  const exactlyFastShape = complexity === "trivial"
    && requirements.length === 1
    && requirements[0].kind === "functional"
    && requirements[0].priority === "must"
    && paths.length >= 1 && paths.length <= 3
    && paths.every((item) => item !== "." && !item.startsWith("../") && !item.includes("/../") && !item.startsWith("/"))
    && highRiskReasons.length === 0
    && !externalCurrentFact
    && !sharedInterfaceDecision;
  return { externalCurrentFact, sharedInterfaceDecision, highRiskReasons: [...new Set(highRiskReasons)], exactlyFastShape };
}

function requestedLifecycleProfile(input, route) {
  const requested = input.lifecycleProfile ?? input.profile ?? route.lifecycleProfile ?? route.profile;
  if (requested !== undefined && requested !== null && String(requested).trim()) return String(requested).trim().toLowerCase();
  return null;
}

export function selectLifecycleProfile(input = {}, complexity, requirements = [], scope = []) {
  const route = input.route && typeof input.route === "object" && !Array.isArray(input.route) ? input.route : {};
  validateRoute(route);
  const signals = lifecycleSignals(input, route, complexity, requirements, scope);
  const requested = requestedLifecycleProfile(input, route);
  invariant(!requested || LIFECYCLE_PROFILES.has(requested), "CONTRACT_LIFECYCLE_PROFILE", `Unsupported lifecycle profile: ${requested}.`);
  if (requested === "full") {
    return { lifecycleProfile: "full", lifecycleProfileReasons: ["explicit user full override"], signals };
  }
  if (signals.highRiskReasons.length > 0) {
    if (requested === "fast") {
      throw new MetisError("CONTRACT_LIFECYCLE_PROFILE", `Fast lifecycle profile is unsafe: ${signals.highRiskReasons.join("; ")}.`, { reasons: signals.highRiskReasons });
    }
    return { lifecycleProfile: "full", lifecycleProfileReasons: signals.highRiskReasons, signals };
  }
  if (requested === "fast" && !signals.exactlyFastShape) {
    const reasons = [];
    if (complexity !== "trivial") reasons.push("complexity is not trivial");
    if (requirements.length !== 1 || requirements[0]?.kind !== "functional" || requirements[0]?.priority !== "must") reasons.push("requirements are not exactly one functional must requirement");
    if (signals.externalCurrentFact) reasons.push("external-current fact requires research");
    if (signals.sharedInterfaceDecision) reasons.push("shared interface or architecture decision requires design");
    if (scope.length < 1 || scope.length > 3) reasons.push("scope is not 1-3 local paths");
    throw new MetisError("CONTRACT_LIFECYCLE_PROFILE", `Fast lifecycle profile is unsafe: ${reasons.join("; ") || "contract does not satisfy exact fast conditions"}.`, { reasons });
  }
  if (requested === "balanced") {
    return {
      lifecycleProfile: "balanced",
      lifecycleProfileReasons: [
        "explicit user balanced profile",
        ...(signals.externalCurrentFact ? ["external-current fact requires research"] : ["no external-current fact; external research is waived"]),
        ...(signals.sharedInterfaceDecision ? ["shared interface or architecture decision requires separate design"] : ["no shared interface or architecture decision; separate design is skipped"])
      ],
      signals
    };
  }
  if (requested === "fast" || signals.exactlyFastShape) {
    const reasons = requested === "fast" ? ["explicit user fast profile"] : ["auto: exact bounded local change"];
    return { lifecycleProfile: "fast", lifecycleProfileReasons: reasons, signals };
  }
  const reasons = [];
  if (signals.externalCurrentFact) reasons.push("external-current fact requires research");
  else reasons.push("no external-current fact; external research is waived");
  if (signals.sharedInterfaceDecision) reasons.push("shared interface or architecture decision requires separate design");
  else reasons.push("no shared interface or architecture decision; separate design is skipped");
  if (requested === "balanced") reasons.unshift("explicit user balanced profile");
  else reasons.unshift("auto: bounded change is not eligible for fast profile");
  return { lifecycleProfile: "balanced", lifecycleProfileReasons: reasons, signals };
}

function normalizeRoute(input, complexity, requirements, scope) {
  const route = input?.route && typeof input.route === "object" && !Array.isArray(input.route) ? input.route : {};
  const selected = selectLifecycleProfile({ ...input, route }, complexity, requirements, scope);
  const { lifecycleProfile, lifecycleProfileReasons, signals } = selected;
  return {
    lifecycleProfile,
    lifecycleProfileReasons,
    researchRequired: lifecycleProfile === "full" || (lifecycleProfile === "balanced" && signals.externalCurrentFact),
    designRequired: lifecycleProfile === "full" || (lifecycleProfile === "balanced" && signals.sharedInterfaceDecision),
    specialistReviewRequired: lifecycleProfile === "full" && (route.specialistReviewRequired ?? complexity === "complex"),
    documentationRequired: route.documentationRequired ?? true
  };
}

function normalizeRequirement(raw, index) {
  const item = typeof raw === "string" ? { title: raw, description: raw } : raw ?? {};
  const id = String(item.id ?? `REQ-${String(index + 1).padStart(3, "0")}`).trim();
  const title = String(item.title ?? item.description ?? "").trim();
  const description = String(item.description ?? title).trim();
  const kind = String(item.kind ?? "functional").toLowerCase();
  const priority = String(item.priority ?? "must").toLowerCase();
  invariant(/^REQ-[A-Za-z0-9._-]+$/u.test(id), "REQUIREMENT_ID", `Invalid requirement ID: ${id}.`);
  invariant(title && description, "REQUIREMENT_FIELDS", `Requirement ${id} needs a title and description.`);
  invariant(REQUIREMENT_KINDS.has(kind), "REQUIREMENT_KIND", `Unsupported requirement kind: ${kind}.`);
  invariant(REQUIREMENT_PRIORITIES.has(priority), "REQUIREMENT_PRIORITY", `Unsupported requirement priority: ${priority}.`);
  const acceptance = strings(item.acceptance ?? item.acceptanceCriteria ?? []);
  invariant(acceptance.length > 0, "REQUIREMENT_ACCEPTANCE", `Requirement ${id} needs acceptance criteria.`);
  return { id, title, description, kind, priority, acceptance };
}

function normalizeContract(run, input, version, parentVersion = null, amendmentReason = null) {
  const objective = String(input.objective ?? run.goal).trim();
  const scope = strings(input.scope);
  const nonGoals = strings(input.nonGoals);
  const constraints = strings(input.constraints);
  const successCriteria = strings(input.successCriteria);
  const complexity = String(input.complexity ?? "standard").toLowerCase();
  invariant(objective, "CONTRACT_OBJECTIVE", "Goal contract needs an objective.");
  invariant(scope.length > 0, "CONTRACT_SCOPE", "Goal contract needs a non-empty scope.");
  invariant(successCriteria.length > 0, "CONTRACT_SUCCESS", "Goal contract needs measurable success criteria.");
  invariant(COMPLEXITIES.has(complexity), "CONTRACT_COMPLEXITY", `Unsupported complexity: ${complexity}.`);
  const rawRequirements = asArray(input.requirements);
  const requirements = (rawRequirements.length ? rawRequirements : successCriteria)
    .map((item, index) => normalizeRequirement(item, index));
  const requirementIds = new Set();
  for (const requirement of requirements) {
    invariant(!requirementIds.has(requirement.id), "REQUIREMENT_DUPLICATE", `Duplicate requirement ID: ${requirement.id}.`);
    requirementIds.add(requirement.id);
  }
  const route = normalizeRoute(input, complexity, requirements, scope);
  const payload = {
    version,
    objective,
    scope,
    nonGoals,
    constraints,
    successCriteria,
    complexity,
    route,
    requirements,
    parentVersion,
    amendmentReason
  };
  return { ...payload, contractHash: sha256(stableStringify(payload)) };
}

function activeContractRow(db, runId) {
  return db.prepare(`
    SELECT * FROM goal_contracts
    WHERE run_id = ? AND status = 'active'
    ORDER BY version DESC LIMIT 1
  `).get(runId);
}

function mapContract(row) {
  if (!row) return null;
  return {
    ...row,
    scope: JSON.parse(row.scope_json),
    nonGoals: JSON.parse(row.non_goals_json),
    constraints: JSON.parse(row.constraints_json),
    successCriteria: JSON.parse(row.success_criteria_json),
    route: JSON.parse(row.route_json)
  };
}

function upsertRequirements(db, runId, requirements) {
  const timestamp = now();
  const incoming = new Set(requirements.map((item) => item.id));
  const existing = db.prepare("SELECT id FROM requirements WHERE run_id = ? AND status <> 'superseded'").all(runId);
  for (const row of existing) {
    if (!incoming.has(row.id)) {
      db.prepare("UPDATE requirements SET status = 'superseded', updated_at = ? WHERE run_id = ? AND id = ?").run(timestamp, runId, row.id);
    }
  }
  for (const requirement of requirements) {
    db.prepare(`
      INSERT INTO requirements(
        id, run_id, title, description, kind, priority, status,
        acceptance_json, source, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'active', ?, 'goal-contract', ?, ?)
      ON CONFLICT(run_id, id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        kind = excluded.kind,
        priority = excluded.priority,
        status = CASE WHEN requirements.status = 'verified' THEN 'verified' ELSE 'active' END,
        acceptance_json = excluded.acceptance_json,
        updated_at = excluded.updated_at
    `).run(
      requirement.id,
      runId,
      requirement.title,
      requirement.description,
      requirement.kind,
      requirement.priority,
      json(requirement.acceptance),
      timestamp,
      timestamp
    );
  }
}

function storeContract(db, projectRoot, run, contract, options = {}) {
  const timestamp = now();
  const id = makeId("contract");
  transaction(db, () => {
    db.prepare("UPDATE goal_contracts SET status = 'superseded' WHERE run_id = ? AND status = 'active'").run(run.id);
    db.prepare(`
      INSERT INTO goal_contracts(
        id, run_id, version, objective, scope_json, non_goals_json,
        constraints_json, success_criteria_json, complexity, route_json,
        status, parent_version, amendment_reason, approved_by_user,
        contract_hash, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(
      id,
      run.id,
      contract.version,
      contract.objective,
      json(contract.scope),
      json(contract.nonGoals),
      json(contract.constraints),
      json(contract.successCriteria),
      contract.complexity,
      json(contract.route),
      contract.parentVersion,
      contract.amendmentReason,
      options.approvedByUser ? 1 : 0,
      contract.contractHash,
      timestamp
    );
    upsertRequirements(db, run.id, contract.requirements);
    db.prepare(`
      UPDATE runs SET contract_version = ?, complexity = ?, route_json = ?,
        updated_at = ?, revision = revision + 1
      WHERE id = ?
    `).run(contract.version, contract.complexity, json(contract.route), timestamp, run.id);
  });
  const artifact = putArtifact(db, projectRoot, run.id, "goal-contract", contract, {
    status: "verified",
    metadata: {
      contractId: id,
      version: contract.version,
      contractHash: contract.contractHash,
      approvedByUser: Boolean(options.approvedByUser),
      immutable: true
    }
  });
  recordEvent(db, run.id, contract.version === 1 ? "contract.frozen" : "contract.amended", "info", {
    contractId: id,
    version: contract.version,
    contractHash: contract.contractHash,
    amendmentReason: contract.amendmentReason
  });
  return { contract: getGoalContract(db, run.id), artifact };
}

export function freezeGoalContract(db, projectRoot, runId, input) {
  const run = getRun(db, runId);
  invariant(run.phase === "intake", "CONTRACT_PHASE", "Freeze the goal contract during intake.");
  invariant(!activeContractRow(db, run.id), "CONTRACT_EXISTS", "The goal contract is already frozen. Use contract amend.");
  const contract = normalizeContract(run, input, 1);
  return storeContract(db, projectRoot, run, contract, { approvedByUser: true });
}

function materialChange(previous, next) {
  const basis = (contract) => ({
    objective: contract.objective,
    scope: contract.scope,
    nonGoals: contract.nonGoals,
    constraints: contract.constraints,
    successCriteria: contract.successCriteria,
    complexity: contract.complexity,
    route: contract.route,
    requirements: contract.requirements.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      kind: item.kind,
      priority: item.priority,
      acceptance: item.acceptance ?? item.acceptanceCriteria
    }))
  });
  return stableStringify(basis(previous)) !== stableStringify(basis(next));
}

function invalidateDownstream(db, runId, material = true) {
  const timestamp = now();
  const kinds = [
    "discovery", "research", "design", "design-seal", "design-review",
    "plan", "plan-review", "integration-review", "verification",
    "verification-candidate", "integration-candidate", "completion-review", "knowledge-sync", "self-evaluation"
  ];
  for (const kind of kinds) {
    db.prepare("UPDATE artifacts SET status = 'stale', updated_at = ? WHERE run_id = ? AND kind = ? AND status = 'verified'")
      .run(timestamp, runId, kind);
  }
  db.prepare("UPDATE artifacts SET status = 'stale', updated_at = ? WHERE run_id = ? AND kind LIKE 'review-approval:%' AND status = 'verified'")
    .run(timestamp, runId);
  db.prepare("UPDATE decisions SET status = 'needs-review', updated_at = ? WHERE run_id = ? AND status = 'active'")
    .run(timestamp, runId);
  db.prepare("UPDATE checks SET status = 'stale', updated_at = ? WHERE run_id = ? AND status = 'passed'")
    .run(timestamp, runId);
  db.prepare("UPDATE trace_links SET status = 'stale', updated_at = ? WHERE run_id = ? AND status = 'current'")
    .run(timestamp, runId);

  if (material) {
    // A material contract change invalidates completed work as well as its
    // artifacts. Resetting the current task route prevents old fast-path
    // completions from satisfying the amended contract. Task packets are
    // explicitly stale so deterministic recompilation cannot reuse the old
    // execution basis.
    db.prepare(`
      UPDATE task_packets SET status = 'stale', updated_at = ?
      WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)
        AND status = 'ready'
    `).run(timestamp, runId);
    db.prepare(`
      UPDATE tasks SET status = 'pending', owner = NULL, attempts = 0,
        result_json = NULL, contract_status = 'stale', compiled_packet_id = NULL,
        updated_at = ?
      WHERE run_id = ? AND status IN ('completed', 'waived', 'blocked', 'failed')
    `).run(timestamp, runId);
  }
}

export function amendGoalContract(db, projectRoot, runId, input) {
  return transaction(db, () => {
    const run = getRun(db, runId);
    const running = db.prepare("SELECT id FROM tasks WHERE run_id = ? AND status = 'running' ORDER BY id").all(run.id);
    invariant(running.length === 0, "CONTRACT_AMEND_RUNNING_TASKS",
      `Finish or block running tasks before amending the goal contract: ${running.map((task) => task.id).join(", ")}`);
    const current = getGoalContract(db, run.id);
    invariant(current, "CONTRACT_MISSING", "Freeze the goal contract before amending it.");
    const reason = String(input.reason ?? "").trim();
    invariant(reason, "CONTRACT_AMEND_REASON", "A goal amendment needs a reason.");
    const merged = {
      objective: input.objective ?? current.objective,
      scope: input.scope ?? current.scope,
      nonGoals: input.nonGoals ?? current.nonGoals,
      constraints: input.constraints ?? current.constraints,
      successCriteria: input.successCriteria ?? current.successCriteria,
      complexity: input.complexity ?? current.complexity,
      route: input.route ?? current.route,
      requirements: input.requirements ?? listRequirements(db, run.id).filter((item) => item.status !== "superseded").map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        kind: item.kind,
        priority: item.priority,
        acceptance: item.acceptanceCriteria
      }))
    };
    const next = normalizeContract(run, merged, current.version + 1, current.version, reason);
    const material = materialChange({ ...current, requirements: merged.requirements }, next);
    invariant(!material || input.approvedByUser === true, "CONTRACT_AMEND_APPROVAL", "A material goal amendment requires approvedByUser: true.");
    invalidateDownstream(db, run.id, material);
    if (run.phase !== "intake") {
      db.prepare("UPDATE runs SET phase = 'discover', status = 'active', updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now(), run.id);
    }
    return storeContract(db, projectRoot, run, next, { approvedByUser: input.approvedByUser === true });
  });
}

export function getGoalContract(db, runId) {
  const row = activeContractRow(db, runId);
  if (!row) return null;
  return {
    ...mapContract(row),
    requirements: listRequirements(db, runId).filter((item) => item.status !== "superseded")
  };
}

export function listRequirements(db, runId, status = null) {
  const rows = status
    ? db.prepare("SELECT * FROM requirements WHERE run_id = ? AND status = ? ORDER BY id").all(runId, status)
    : db.prepare("SELECT * FROM requirements WHERE run_id = ? ORDER BY id").all(runId);
  return rows.map((row) => ({ ...row, acceptanceCriteria: JSON.parse(row.acceptance_json) }));
}

export function setRequirementStatus(db, runId, requirementId, status, evidenceRefs = [], projectRoot = null) {
  invariant(REQUIREMENT_STATUSES.has(status), "REQUIREMENT_STATUS", `Unsupported requirement status: ${status}.`);
  const requirement = db.prepare("SELECT * FROM requirements WHERE id = ? AND run_id = ?").get(requirementId, runId);
  invariant(requirement, "REQUIREMENT_NOT_FOUND", `Requirement ${requirementId} was not found.`);
  let refs = [];
  if (status === "verified") {
    invariant(projectRoot, "REQUIREMENT_EVIDENCE_ROOT", "Verifying a requirement needs the project root.");
    refs = normalizeEvidenceRefs(db, projectRoot, evidenceRefs);
    invariant(refs.length > 0, "REQUIREMENT_EVIDENCE", `Requirement ${requirementId} needs verification evidence.`);
  }
  const timestamp = now();
  db.prepare("UPDATE requirements SET status = ?, updated_at = ? WHERE run_id = ? AND id = ?").run(status, timestamp, runId, requirementId);
  if (status === "verified") {
    const artifact = putArtifact(db, projectRoot, runId, `requirement-verification:${requirementId}`, {
      requirementId,
      evidenceRefs: refs,
      verifiedAt: timestamp
    }, {
      status: "verified",
      metadata: { requirementId }
    });
    const artifactRef = [{
      type: "artifact",
      id: artifact.id,
      kind: artifact.kind,
      status: artifact.status,
      contentRef: artifact.content_ref
    }];
    db.prepare(`
      INSERT INTO trace_links(
        id, run_id, requirement_id, target_type, target_id, relation,
        status, evidence_refs_json, created_at, updated_at
      ) VALUES(?, ?, ?, 'artifact', ?, 'verified-by', 'current', ?, ?, ?)
      ON CONFLICT(run_id, requirement_id, target_type, target_id, relation) DO UPDATE SET
        status = 'current', evidence_refs_json = excluded.evidence_refs_json, updated_at = excluded.updated_at
    `).run(makeId("trace"), runId, requirementId, artifact.id, json([...refs, ...artifactRef]), timestamp, timestamp);
  }
  touchRun(db, runId);
  recordEvent(db, runId, "requirement.status", "info", { requirementId, status });
  return listRequirements(db, runId).find((item) => item.id === requirementId);
}
