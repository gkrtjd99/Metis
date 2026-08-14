import { MODEL_ROUTE_GROUPS } from "./metadata.js";

// Effort is a policy value shared by every host.  Host adapters negotiate it
// against their model's capabilities before rendering a host-specific spawn.
export const EFFORT_ORDER = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const EFFORT_INDEX = new Map(EFFORT_ORDER.map((value, index) => [value, index]));
const COMPLEXITY_EFFORT = Object.freeze({ low: "low", medium: "medium", high: "high" });
const DEFAULT_EFFORT = "medium";

const ORDINARY_WORKER_ROLES = new Set(MODEL_ROUTE_GROUPS.ordinary);
const STRONG_ROLE_FLOOR = new Set(MODEL_ROUTE_GROUPS.strong);
const HOLD_CAUSES = new Set(["transient", "external", "contract", "dependency", "plan"]);

export function normalizeEffort(value, fallback = DEFAULT_EFFORT) {
  const candidate = String(value ?? "").trim().toLowerCase();
  if (EFFORT_INDEX.has(candidate)) return candidate;
  const safeFallback = String(fallback ?? DEFAULT_EFFORT).trim().toLowerCase();
  return EFFORT_INDEX.has(safeFallback) ? safeFallback : DEFAULT_EFFORT;
}

export function isSupportedEffort(value, supportedEfforts) {
  const candidate = String(value ?? "").trim().toLowerCase();
  return EFFORT_INDEX.has(candidate)
    && Array.isArray(supportedEfforts)
    && supportedEfforts.some((item) => String(item ?? "").trim().toLowerCase() === candidate);
}

function normalizedSupportedEfforts(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value
    .map((item) => String(item ?? "").trim().toLowerCase())
    .filter((item) => EFFORT_INDEX.has(item)))].sort((a, b) => EFFORT_INDEX.get(a) - EFFORT_INDEX.get(b));
}

/**
 * Negotiate a requested policy value without knowing anything about a host.
 * Unknown capabilities fail closed: callers must not render an effort value.
 */
export function negotiateEffort(requestedEffort, capability = {}) {
  if (requestedEffort && typeof requestedEffort === "object" && !Array.isArray(requestedEffort)) {
    const request = requestedEffort;
    return negotiateEffort(request.requestedEffort ?? request.effort, request.capability ?? request);
  }
  const requested = normalizeEffort(requestedEffort, DEFAULT_EFFORT);
  const supportedEfforts = normalizedSupportedEfforts(
    Array.isArray(capability) ? capability : capability.supportedEfforts
  );
  const source = typeof capability === "object" && capability?.source
    ? String(capability.source)
    : "model-capability";

  if (!supportedEfforts) {
    const safeDefault = normalizeEffort(capability?.safeDefault, "");
    if (capability?.safeDefaultAccepted === true && safeDefault) {
      return {
        requestedEffort: requested,
        effectiveEffort: safeDefault,
        supportedEfforts: [],
        source: "adapter-safe-default",
        capabilityStatus: "safe-default"
      };
    }
    return {
      requestedEffort: requested,
      effectiveEffort: null,
      supportedEfforts: [],
      source: "unknown",
      capabilityStatus: "unknown"
    };
  }

  if (supportedEfforts.length === 0) {
    return {
      requestedEffort: requested,
      effectiveEffort: null,
      supportedEfforts,
      source,
      capabilityStatus: "unsupported"
    };
  }

  // Pick the strongest value that does not exceed the requested value. This
  // prevents a low request from being silently upgraded, while max can map to
  // the strongest value the model actually supports (for example xhigh).
  const requestedIndex = EFFORT_INDEX.get(requested);
  const effective = supportedEfforts.filter((value) => EFFORT_INDEX.get(value) <= requestedIndex).at(-1)
    ?? supportedEfforts[0];
  return {
    requestedEffort: requested,
    effectiveEffort: effective,
    supportedEfforts,
    source,
    capabilityStatus: "known"
  };
}

// Explicitly named alias for callers that treat this as capability
// negotiation rather than an effort utility.
export const negotiateEffortCapability = negotiateEffort;

function normalizedComplexity(value) {
  const complexity = String(value ?? "medium").toLowerCase();
  return ["low", "medium", "high"].includes(complexity) ? complexity : "medium";
}

function concreteModel(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function hostDefaultModel(config, host, role, tier) {
  if (tier !== "worker" || !ORDINARY_WORKER_ROLES.has(role)) return null;
  const normalizedHost = String(host ?? config.host ?? "").trim().toLowerCase();
  return concreteModel(config.models?.defaults?.[normalizedHost]?.[tier]);
}

function resolveModelSelection(config, host, role, tier, taskModel, roleModel) {
  const explicitTaskModel = concreteModel(taskModel);
  if (explicitTaskModel) return { model: explicitTaskModel, modelSource: "task" };
  const explicitRoleModel = concreteModel(roleModel);
  if (explicitRoleModel) return { model: explicitRoleModel, modelSource: "role" };
  const hostModel = hostDefaultModel(config, host, role, tier);
  if (hostModel) return { model: hostModel, modelSource: "host-default" };
  return { model: null, modelSource: "none" };
}

function capabilityFor(config, host, model, input = {}) {
  const direct = input.capability ?? input.modelCapability;
  if (Array.isArray(input.supportedEfforts)) return { supportedEfforts: input.supportedEfforts, source: "model-capability" };
  if (direct) return Array.isArray(direct) ? { supportedEfforts: direct, source: "model-capability" } : direct;
  const hostCapabilities = config.models?.capabilities?.[String(host ?? config.host ?? "").toLowerCase()];
  if (!hostCapabilities) return {};
  const modelCapabilities = hostCapabilities.models?.[model];
  if (modelCapabilities) return { supportedEfforts: modelCapabilities, source: "model-capability" };
  // A host-wide default is not model evidence.  Applying it to an explicit
  // model would make an unknown model look negotiated and could cause an
  // adapter to pass an unsafe effort flag.  Model-neutral routes are deferred
  // until the adapter supplies concrete evidence.
  return {};
}

function routeResult(route, requested, negotiated) {
  return {
    ...route,
    requestedEffort: requested,
    effectiveEffort: negotiated.effectiveEffort,
    supportedEfforts: negotiated.supportedEfforts,
    effortSource: negotiated.source,
    capabilityStatus: negotiated.capabilityStatus,
    // Existing persistence and scheduler contracts use this canonical field.
    // It is the negotiated value, never the unverified request.
    reasoningEffort: negotiated.effectiveEffort
  };
}

function deferModelNeutralEffort(model, requested, negotiated) {
  if (negotiated.effectiveEffort !== null || model !== null) return negotiated;
  return {
    ...negotiated,
    effectiveEffort: requested,
    source: "no-model",
    capabilityStatus: "deferred"
  };
}

export function selectModelRoute(config, role, input = {}) {
  const complexity = normalizedComplexity(input.complexity);
  const base = config.models?.routes?.[role] ?? { tier: "worker", model: null, reasoningEffort: "high" };
  let route = { ...base };
  if (complexity === "high" && route.tier === "worker") route = { ...route, tier: "strong", reasoningEffort: "high" };
  if (input.modelTier && (input.modelTier !== "worker" || ORDINARY_WORKER_ROLES.has(role))) route.tier = input.modelTier;
  if (STRONG_ROLE_FLOOR.has(role)) route.tier = "strong";

  const policy = config.models?.effortPolicy?.ordinaryWorker;
  const configuredEffort = input.reasoningEffort ?? route.reasoningEffort
    ?? (route.tier === "worker" && ORDINARY_WORKER_ROLES.has(role) ? policy?.initial : null)
    ?? (route.tier === "strong" ? config.models?.effortPolicy?.strongRole?.initial : null)
    ?? COMPLEXITY_EFFORT[complexity] ?? DEFAULT_EFFORT;
  let requested = normalizeEffort(configuredEffort, DEFAULT_EFFORT);
  // Benchmark fixtures may carry an authenticated, host-local effort policy.
  // It is intentionally opt-in so production strong-role floors remain
  // unchanged while bounded benchmark critics can run at their schema-safe
  // minimum effort.
  const benchmarkEffortPolicy = config.models?.benchmark?.enabled === true
    ? config.models?.benchmark?.efforts?.[role]
    : null;
  if (benchmarkEffortPolicy) requested = normalizeEffort(benchmarkEffortPolicy, requested);
  if (STRONG_ROLE_FLOOR.has(role) && !benchmarkEffortPolicy) requested = EFFORT_INDEX.get(requested) < EFFORT_INDEX.get("high") ? "high" : requested;

  const tier = route.tier ?? "worker";
  const selection = resolveModelSelection(config, input.host, role, tier, input.model, base.model);
  let negotiated = negotiateEffort(requested, capabilityFor(config, input.host, selection.model, input));
  // A model-neutral strong route is persisted before an adapter chooses its
  // concrete model. There is no effort argument to render yet, so retain the
  // policy value while marking capability negotiation as deferred.
  negotiated = deferModelNeutralEffort(selection.model, requested, negotiated);
  return routeResult({
    complexity,
    tier,
    model: selection.model,
    modelSource: selection.modelSource
  }, requested, negotiated);
}

function holdRoute(task) {
  const requested = normalizeEffort(task.requested_effort ?? task.requestedEffort ?? task.reasoning_effort, DEFAULT_EFFORT);
  return {
    tier: task.model_tier,
    model: task.selected_model,
    modelSource: task.model_source,
    requestedEffort: requested,
    effectiveEffort: task.effective_effort ?? task.effectiveEffort ?? task.reasoning_effort ?? null,
    supportedEfforts: task.supported_efforts ?? [],
    effortSource: task.effort_source ?? "persisted",
    capabilityStatus: task.capability_status ?? "known",
    reasoningEffort: task.reasoning_effort,
    escalationLevel: Number(task.escalation_level ?? 0)
  };
}

function nextReasoningEffort(current) {
  const index = EFFORT_INDEX.get(normalizeEffort(current, "high"));
  return EFFORT_ORDER[index + 1] ?? null;
}

export function escalateModelRoute(config, task, cause, options = {}) {
  if (HOLD_CAUSES.has(cause)) return holdRoute(task);

  const currentRequested = normalizeEffort(task.requested_effort ?? task.requestedEffort ?? task.reasoning_effort, "high");
  const currentEffective = normalizeEffort(task.effective_effort ?? task.effectiveEffort ?? task.reasoning_effort, currentRequested);
  const currentLevel = Number(task.escalation_level ?? 0);
  let requested = currentRequested;
  let tier = task.model_tier;
  let model = task.selected_model;
  let modelSource = task.model_source;
  let level = currentLevel;

  if (cause === "reasoning") {
    requested = nextReasoningEffort(currentEffective) ?? currentEffective;
    const advanced = requested !== currentEffective;
    level = advanced ? currentLevel + 1 : currentLevel;
    // Keep ordinary workers cheap until their progressive effort ladder is
    // exhausted; only then use the configured strong route.
    if (!advanced) {
      tier = "strong";
      const roleModel = concreteModel(config.models?.routes?.[task.role]?.model);
      const inheritedConcreteModel = task.model_source === "host-default" ? null : concreteModel(task.selected_model);
      const fallback = resolveModelSelection(config, options.host, task.role, tier, null, roleModel);
      model = inheritedConcreteModel ?? fallback.model;
      modelSource = inheritedConcreteModel ? task.model_source : fallback.modelSource;
    }
  } else if (cause === "integration" || cause === "review") {
    requested = EFFORT_INDEX.get(currentRequested) < EFFORT_INDEX.get("xhigh") ? "xhigh" : currentRequested;
    tier = "strong";
    level = currentLevel + 1;
    const roleModel = concreteModel(config.models?.routes?.[task.role]?.model);
    const fallback = resolveModelSelection(config, options.host, task.role, tier, null, roleModel);
    model = fallback.model;
    modelSource = fallback.modelSource;
  } else {
    return holdRoute(task);
  }

  const negotiated = deferModelNeutralEffort(
    model,
    requested,
    negotiateEffort(requested, capabilityFor(config, options.host, model, options))
  );
  return routeResult({ tier, model, modelSource, escalationLevel: level }, requested, negotiated);
}

// Kept exported for focused tests without exposing the mutable implementation
// details of the route table.
export { STRONG_ROLE_FLOOR };
