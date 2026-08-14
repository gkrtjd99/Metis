// Host adapters own capability evidence.  The core policy may request a value,
// but an adapter must prove that its concrete host/model can accept it.
const EFFORT_ORDER = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const EFFORTS = new Set(EFFORT_ORDER);

function values(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map((item) => String(item ?? "").trim().toLowerCase()).filter((item) => EFFORTS.has(item)))];
}

function evidenceValues(evidence, host, model) {
  if (!evidence || typeof evidence !== "object" || !model) return null;
  const hosts = evidence.hosts?.[host] ?? evidence[host];
  const modelEvidence = hosts?.models?.[model] ?? hosts?.[model];
  return values(modelEvidence?.supportedEfforts ?? modelEvidence?.efforts ?? modelEvidence)
    ?? values(evidence.models?.[model]?.supportedEfforts ?? evidence.models?.[model]?.efforts);
}

/**
 * Resolve concrete host/model capability evidence. Runtime evidence wins over
 * installed/configured evidence; absent evidence is intentionally unknown.
 */
export function resolveModelCapabilities({ host, model, requestedEffort, runtime, installed, configured } = {}) {
  const normalizedHost = String(host ?? "").trim().toLowerCase() || null;
  const normalizedModel = typeof model === "string" && model.trim() ? model.trim() : null;
  const requested = String(requestedEffort ?? "medium").trim().toLowerCase();
  // A direct list is useful only when the caller has already tied it to a
  // concrete model. Host-wide defaults are deliberately not sufficient.
  const runtimeValues = (normalizedModel && values(runtime?.supportedEfforts ?? runtime?.efforts))
    ?? evidenceValues(runtime, normalizedHost, normalizedModel);
  const installedValues = (normalizedModel && values(installed?.supportedEfforts ?? installed?.efforts))
    ?? evidenceValues(installed, normalizedHost, normalizedModel);
  const configuredValues = (normalizedModel && values(configured?.supportedEfforts ?? configured?.efforts))
    ?? evidenceValues(configured, normalizedHost, normalizedModel);
  const supported = runtimeValues ?? installedValues ?? configuredValues;
  const source = runtimeValues ? "runtime" : installedValues ? "installed" : configuredValues ? "configured" : "unknown";
  const ordered = supported ? [...supported].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)) : [];
  const requestedKnown = EFFORTS.has(requested) ? requested : "medium";
  const effective = ordered.length
    ? ordered.filter((item) => EFFORT_ORDER.indexOf(item) <= EFFORT_ORDER.indexOf(requestedKnown)).at(-1) ?? ordered[0]
    : null;
  return {
    host: normalizedHost,
    model: normalizedModel,
    requested: requestedKnown,
    requestedEffort: requestedKnown,
    effective: effective,
    effectiveEffort: effective,
    supported: ordered,
    supportedEfforts: ordered,
    source,
    capabilityStatus: supported ? (ordered.length ? "known" : "unsupported") : "unknown"
  };
}

export const resolveCapabilities = resolveModelCapabilities;
