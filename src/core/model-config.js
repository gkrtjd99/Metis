import { EFFORT_ORDER } from "./model-routing.js";
import { DEFAULT_CONFIG, writeConfig } from "./config.js";
import { invariant } from "./errors.js";
import { MODEL_ROUTE_GROUPS, ROLES } from "./metadata.js";

const HOSTS = new Set(["codex", "claude", "opencode"]);
const INPUT_KEYS = new Set(["host", "main", "subagents", "roles", "capabilities"]);
const SPEC_KEYS = new Set(["model", "effort", "reasoningEffort"]);
const SUBAGENT_KEYS = new Set(["default", "ordinary", "strong"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, code, label) {
  invariant(plainObject(value), code, `${label} must be an object.`);
  for (const key of Object.keys(value)) invariant(allowed.has(key), code, `${label} contains unsupported field ${key}.`);
}

function normalizedHost(value) {
  const host = String(value ?? "").trim().toLowerCase();
  invariant(HOSTS.has(host), "MODEL_HOST_INVALID", `Unsupported model host: ${host || "(missing)"}.`);
  return host;
}

function routeSpec(value, label) {
  exactKeys(value, SPEC_KEYS, "MODEL_SPEC_INVALID", label);
  const output = {};
  if (Object.prototype.hasOwnProperty.call(value, "model")) {
    invariant(value.model === null || typeof value.model === "string" && value.model.trim(), "MODEL_NAME_INVALID", `${label}.model must be a non-empty string or null.`);
    output.model = value.model === null ? null : value.model.trim();
  }
  const suppliedEffort = Object.prototype.hasOwnProperty.call(value, "reasoningEffort")
    ? value.reasoningEffort
    : value.effort;
  if (suppliedEffort !== undefined) {
    invariant(suppliedEffort === null || EFFORT_ORDER.includes(String(suppliedEffort).trim().toLowerCase()), "MODEL_EFFORT_INVALID", `${label}.effort must be one of ${EFFORT_ORDER.join(", ")} or null.`);
    output.reasoningEffort = suppliedEffort === null ? null : String(suppliedEffort).trim().toLowerCase();
  }
  invariant(Object.keys(output).length > 0, "MODEL_SPEC_EMPTY", `${label} must select a model or effort.`);
  return output;
}

function applyRouteSpec(route, spec) {
  return {
    ...route,
    ...(Object.prototype.hasOwnProperty.call(spec, "model") ? { model: spec.model } : {}),
    ...(Object.prototype.hasOwnProperty.call(spec, "reasoningEffort") ? { reasoningEffort: spec.reasoningEffort } : {})
  };
}

function normalizedCapabilities(value) {
  if (value === undefined) return null;
  invariant(plainObject(value), "MODEL_CAPABILITIES_INVALID", "capabilities must map model names to supported effort arrays.");
  const output = {};
  for (const [model, efforts] of Object.entries(value)) {
    invariant(model.trim(), "MODEL_NAME_INVALID", "Capability model names cannot be empty.");
    invariant(Array.isArray(efforts), "MODEL_CAPABILITIES_INVALID", `Capability ${model} must be an effort array.`);
    const normalized = [...new Set(efforts.map((effort) => String(effort).trim().toLowerCase()))];
    invariant(normalized.every((effort) => EFFORT_ORDER.includes(effort)), "MODEL_CAPABILITIES_INVALID", `Capability ${model} contains an unsupported effort.`);
    output[model.trim()] = normalized;
  }
  return output;
}

function selectedModels(routes) {
  return [...new Set(Object.values(routes).map((route) => route?.model).filter(Boolean))].sort();
}

export function modelConfigView(config, requestedHost = null) {
  const host = normalizedHost(requestedHost ?? config.host);
  const routes = Object.fromEntries(ROLES.map((role) => [role, {
    model: config.models?.routes?.[role]?.model ?? null,
    reasoningEffort: config.models?.routes?.[role]?.reasoningEffort ?? null
  }]));
  const capabilities = config.models?.capabilities?.[host]?.models ?? {};
  return {
    host,
    main: config.models?.main?.[host] ?? { model: null, reasoningEffort: null },
    subagents: {
      defaultWorkerModel: config.models?.defaults?.[host]?.worker ?? null,
      groups: Object.fromEntries(Object.entries(MODEL_ROUTE_GROUPS).map(([group, roles]) => [group, roles.map((role) => ({ role, ...routes[role] }))])),
      routes
    },
    capabilities,
    warnings: selectedModels(routes)
      .filter((model) => !Object.prototype.hasOwnProperty.call(capabilities, model))
      .map((model) => `No configured effort capability evidence exists for ${model}; provider effort remains deferred until the host supplies evidence.`)
  };
}

export function configureModels(projectRoot, currentConfig, input) {
  exactKeys(input, INPUT_KEYS, "MODEL_CONFIG_INVALID", "model configuration");
  const host = normalizedHost(input.host ?? currentConfig.host);
  invariant(host === normalizedHost(currentConfig.host), "MODEL_HOST_MISMATCH", `This project is attached to ${currentConfig.host}; configure that host or reattach explicitly.`);

  const routes = { ...currentConfig.models.routes };
  const main = { ...currentConfig.models.main };
  const defaults = { ...currentConfig.models.defaults };
  const capabilities = { ...currentConfig.models.capabilities };

  if (input.main !== undefined) main[host] = applyRouteSpec(main[host] ?? { model: null, reasoningEffort: null }, routeSpec(input.main, "main"));

  if (input.subagents !== undefined) {
    exactKeys(input.subagents, SUBAGENT_KEYS, "MODEL_SUBAGENTS_INVALID", "subagents");
    const applyGroup = (roles, value, label) => {
      if (value === undefined) return;
      const spec = routeSpec(value, label);
      for (const role of roles) routes[role] = applyRouteSpec(routes[role] ?? DEFAULT_CONFIG.models.routes[role], spec);
    };
    applyGroup(ROLES, input.subagents.default, "subagents.default");
    applyGroup(MODEL_ROUTE_GROUPS.ordinary, input.subagents.ordinary, "subagents.ordinary");
    applyGroup(MODEL_ROUTE_GROUPS.strong, input.subagents.strong, "subagents.strong");
    const ordinary = input.subagents.ordinary ?? input.subagents.default;
    if (ordinary && Object.prototype.hasOwnProperty.call(ordinary, "model")) {
      defaults[host] = { ...(defaults[host] ?? {}), worker: ordinary.model === null ? null : ordinary.model.trim() };
    }
  }

  if (input.roles !== undefined) {
    invariant(plainObject(input.roles), "MODEL_ROLES_INVALID", "roles must map canonical role names to model specs.");
    for (const [role, value] of Object.entries(input.roles)) {
      invariant(ROLES.includes(role), "MODEL_ROLE_INVALID", `Unsupported model role: ${role}.`);
      routes[role] = applyRouteSpec(routes[role] ?? DEFAULT_CONFIG.models.routes[role], routeSpec(value, `roles.${role}`));
    }
  }

  const configuredCapabilities = normalizedCapabilities(input.capabilities);
  if (configuredCapabilities) capabilities[host] = {
    ...(capabilities[host] ?? {}),
    models: { ...(capabilities[host]?.models ?? {}), ...configuredCapabilities }
  };

  const config = writeConfig(projectRoot, {
    ...currentConfig,
    models: { ...currentConfig.models, main, defaults, routes, capabilities }
  });
  return { updated: true, configPath: `${projectRoot}/.metis/config.json`, ...modelConfigView(config, host) };
}

export function resetModels(projectRoot, currentConfig) {
  const host = normalizedHost(currentConfig.host);
  const main = { ...currentConfig.models.main, [host]: { model: null, reasoningEffort: null } };
  const defaults = { ...currentConfig.models.defaults, [host]: { ...(currentConfig.models.defaults?.[host] ?? {}), worker: null } };
  const capabilities = { ...currentConfig.models.capabilities, [host]: { ...(currentConfig.models.capabilities?.[host] ?? {}), models: {} } };
  const routes = Object.fromEntries(ROLES.map((role) => [role, { ...DEFAULT_CONFIG.models.routes[role] }]));
  const config = writeConfig(projectRoot, { ...currentConfig, models: { ...currentConfig.models, main, defaults, routes, capabilities } });
  return { reset: true, configPath: `${projectRoot}/.metis/config.json`, ...modelConfigView(config, host) };
}
