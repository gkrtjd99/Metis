import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { databasePath, openDatabase } from "../src/core/db.js";
import { SCHEMA_VERSION } from "../src/core/metadata.js";
import { EFFORT_ORDER, escalateModelRoute, negotiateEffort, selectModelRoute } from "../src/core/model-routing.js";
import { SCHEMA_SQL } from "../src/core/schema.js";
import { addTask, getTask, retryTask } from "../src/core/tasks.js";
import { forcePhase, makeProject, startTestRun } from "./helpers.js";

function config(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    models: {
      ...DEFAULT_CONFIG.models,
      ...(overrides.models ?? {}),
      defaults: {
        ...DEFAULT_CONFIG.models.defaults,
        ...(overrides.models?.defaults ?? {})
      },
      routes: {
        ...DEFAULT_CONFIG.models.routes,
        ...(overrides.models?.routes ?? {})
      }
    }
  };
}

test("ordinary workers remain model-neutral until the host selects a model", () => {
  const codex = config({ host: "codex" });
  const route = selectModelRoute(codex, "worker");

  assert.deepEqual(route, {
    complexity: "medium",
    tier: "worker",
    model: null,
    modelSource: "none",
    requestedEffort: "high",
    effectiveEffort: "high",
    supportedEfforts: [],
    effortSource: "no-model",
    capabilityStatus: "deferred",
    reasoningEffort: "high"
  });
  for (const role of ["scout", "researcher", "coordinator", "curator"]) {
    const workerRoute = selectModelRoute(codex, role, { modelTier: "worker" });
    assert.equal(workerRoute.tier, "worker", role);
    assert.equal(workerRoute.model, null, role);
    assert.equal(workerRoute.modelSource, "none", role);
  }
});

test("benchmark-only effort policy permits schema-safe low effort for strong orchestration roles", () => {
  const codex = config({
    host: "codex",
    models: {
      benchmark: { enabled: true, efforts: { synthesizer: "low", planner: "medium", "plan-critic": "low" } },
      routes: {
        synthesizer: { tier: "strong", model: null, reasoningEffort: "low" },
        planner: { tier: "strong", model: null, reasoningEffort: "medium" },
        "plan-critic": { tier: "strong", model: null, reasoningEffort: "low" }
      }
    }
  });
  assert.equal(selectModelRoute(codex, "synthesizer").requestedEffort, "low");
  assert.equal(selectModelRoute(codex, "synthesizer").effectiveEffort, "low");
  assert.equal(selectModelRoute(codex, "planner").effectiveEffort, "medium");
  assert.equal(selectModelRoute(codex, "plan-critic").effectiveEffort, "low");
  const production = config({ host: "codex", models: { routes: { "plan-critic": { tier: "strong", model: null, reasoningEffort: "low" } } } });
  assert.equal(selectModelRoute(production, "plan-critic").effectiveEffort, "high");
});

test("an explicit task model overrides the role and host defaults", () => {
  const route = selectModelRoute(config({
    host: "codex",
    models: { routes: { worker: { tier: "worker", model: "role-model", reasoningEffort: "medium" } } }
  }), "worker", { model: "task-model" });

  assert.equal(route.model, "task-model");
  assert.equal(route.modelSource, "task");
});

test("an explicit role model overrides the host default", () => {
  const route = selectModelRoute(config({
    host: "codex",
    models: { routes: { worker: { tier: "worker", model: "role-model", reasoningEffort: "medium" } } }
  }), "worker");

  assert.equal(route.model, "role-model");
  assert.equal(route.modelSource, "role");
});

test("complexity escalation happens before the host default is selected", () => {
  const route = selectModelRoute(config({ host: "codex" }), "worker", { complexity: "high" });

  assert.equal(route.tier, "strong");
  assert.equal(route.model, null);
  assert.equal(route.modelSource, "none");
  assert.equal(route.reasoningEffort, "high");
});

test("reasoning failures advance high to xhigh to max before changing tier", () => {
  const codex = config({
    host: "codex",
    models: {
      defaults: { codex: { worker: "gpt-5.6-luna" } },
      capabilities: { codex: { models: { "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"] } } }
    }
  });
  const task = {
    role: "worker",
    model_tier: "worker",
    selected_model: "gpt-5.6-luna",
    model_source: "host-default",
    reasoning_effort: "high",
    escalation_level: 0
  };
  const first = escalateModelRoute(codex, task, "reasoning", { host: "codex" });
  assert.equal(first.tier, "worker");
  assert.equal(first.model, "gpt-5.6-luna");
  assert.equal(first.effectiveEffort, "xhigh");
  const second = escalateModelRoute(codex, { ...task, ...first }, "reasoning", { host: "codex" });
  assert.equal(second.tier, "worker");
  assert.equal(second.requestedEffort, "max");
  assert.equal(second.effectiveEffort, "max");
  const exhausted = escalateModelRoute(codex, {
    ...task,
    ...second,
    reasoning_effort: "max",
    effectiveEffort: "max",
    escalation_level: 2
  }, "reasoning", { host: "codex" });

  assert.equal(exhausted.tier, "strong");
  assert.equal(exhausted.model, null);
  // The strong route is model-neutral until an adapter supplies concrete
  // model evidence. The requested policy remains deferred for the adapter,
  // while the guessed host-wide model is discarded.
  assert.equal(exhausted.effectiveEffort, "max");
  assert.equal(exhausted.capabilityStatus, "deferred");
});

test("effort negotiation maps unsupported requests to the strongest safe value", () => {
  assert.deepEqual(EFFORT_ORDER, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(negotiateEffort("max", { supportedEfforts: ["low", "medium", "high", "xhigh"] }), {
    requestedEffort: "max",
    effectiveEffort: "xhigh",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    source: "model-capability",
    capabilityStatus: "known"
  });
  assert.equal(negotiateEffort("max").effectiveEffort, null);
});

test("transient, contract, dependency, and plan failures hold effort and model", () => {
  const task = {
    role: "worker", model_tier: "worker", selected_model: "gpt-5.6-luna", model_source: "host-default",
    reasoning_effort: "high", escalation_level: 0
  };
  for (const cause of ["transient", "contract", "dependency", "plan"]) {
    const route = escalateModelRoute(config({ host: "codex" }), task, cause, { host: "codex" });
    assert.equal(route.tier, "worker", cause);
    assert.equal(route.model, "gpt-5.6-luna", cause);
    assert.equal(route.effectiveEffort, "high", cause);
    assert.equal(route.escalationLevel, 0, cause);
  }
});

test("concrete task and role models retain precedence across policy escalation", () => {
  const codex = config({
    host: "codex",
    models: {
      routes: { worker: { tier: "worker", model: "role-model", reasoningEffort: "medium" } }
    }
  });

  assert.equal(selectModelRoute(codex, "worker", { model: "task-model" }).model, "task-model");
  assert.equal(escalateModelRoute(codex, {
    role: "worker", model_tier: "worker", selected_model: "task-model", model_source: "task", reasoning_effort: "medium", escalation_level: 0
  }, "reasoning").model, "task-model");
  assert.equal(escalateModelRoute(codex, {
    role: "worker", model_tier: "worker", selected_model: "role-model", model_source: "role", reasoning_effort: "medium", escalation_level: 0
  }, "reasoning").model, "role-model");
  assert.equal(escalateModelRoute(codex, {
    role: "worker", model_tier: "worker", selected_model: "task-model", model_source: "task", reasoning_effort: "medium", escalation_level: 0
  }, "review").model, "role-model");
});

test("strong roles remain model-neutral unless explicitly configured", () => {
  const codex = config({ host: "codex" });
  for (const role of ["designer", "reviewer", "verifier", "security-reviewer", "database-reviewer"]) {
    const route = selectModelRoute(codex, role);
    assert.equal(route.tier, "strong", role);
    assert.equal(route.model, null, role);
  }
});

test("strong and specialist roles cannot be downgraded through a worker-tier override", () => {
  const codex = config({ host: "codex" });
  for (const role of ["designer", "diagnostician", "reviewer", "verifier", "security-reviewer", "database-reviewer"]) {
    const route = selectModelRoute(codex, role, { modelTier: "worker" });
    assert.equal(route.tier, "strong", role);
    assert.equal(route.model, null, role);
  }
  const explicit = selectModelRoute(codex, "reviewer", { modelTier: "worker", model: "task-model" });
  assert.equal(explicit.tier, "strong");
  assert.equal(explicit.model, "task-model");
  assert.equal(explicit.modelSource, "task");
});

test("strong and specialist role floors override role config downgrades", () => {
  const configuredWorker = config({
    host: "codex",
    models: {
      routes: { reviewer: { tier: "worker", model: null, reasoningEffort: "medium" } }
    }
  });

  const selected = selectModelRoute(configuredWorker, "reviewer");
  assert.equal(selected.tier, "strong");
  assert.equal(selected.model, null);
  const escalated = escalateModelRoute(configuredWorker, {
    role: "reviewer",
    model_tier: "strong",
    selected_model: null,
    model_source: "none",
    reasoning_effort: "high",
    escalation_level: 0
  }, "reasoning");
  assert.equal(escalated.tier, "strong");
  assert.equal(escalated.model, null);
});

test("no host receives an implicit worker model", () => {
  for (const host of ["codex", "claude", "opencode", "unknown-host"]) {
    const route = selectModelRoute(config({ host }), "worker");
    assert.equal(route.tier, "worker", host);
    assert.equal(route.model, null, host);
  }
});

test("configs without optional defaults normalize to a null model", () => {
  const legacy = {
    host: "codex",
    models: { routes: { worker: { tier: "worker", model: null, reasoningEffort: "medium" } } }
  };
  const route = selectModelRoute(legacy, "worker");

  assert.equal(route.model, null);
});

test("the model provenance schema rejects an existing v7 database before production writes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-model-schema-"));
  const file = databasePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const legacy = new DatabaseSync(file);
  legacy.exec(SCHEMA_SQL.replace(
    "  model_source TEXT NOT NULL DEFAULT 'none' CHECK(model_source IN ('none','task','role','host-default','escalation')),\n",
    ""
  ));
  legacy.prepare("INSERT INTO meta(key, value) VALUES('schema_version', '7')").run();
  legacy.close();

  assert.ok(SCHEMA_VERSION >= 9);
  assert.throws(
    () => openDatabase(root),
    (error) => new RegExp(`schema 7 is not compatible with schema ${SCHEMA_VERSION}`, "u").test(error.message)
  );
});

test("requirements are scoped by run so REQ-001 cannot overwrite another run", () => {
  const { root, db, config } = makeProject();
  const first = startTestRun(db, root, config, "First run", {
    contract: {
      requirements: [{
        id: "REQ-001",
        title: "First requirement",
        description: "The first run keeps its own requirement row.",
        acceptance: ["First evidence exists."]
      }]
    }
  });
  db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(first.run.id);
  const second = startTestRun(db, root, config, "Second run", {
    contract: {
      requirements: [{
        id: "REQ-001",
        title: "Second requirement",
        description: "The second run keeps its own requirement row.",
        acceptance: ["Second evidence exists."]
      }]
    }
  });

  const rows = db.prepare("SELECT run_id, id, title FROM requirements WHERE id = ? ORDER BY run_id").all("REQ-001");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.title).sort(), ["First requirement", "Second requirement"]);
  assert.notEqual(rows[0].run_id, rows[1].run_id);
  assert.equal(db.prepare("SELECT title FROM requirements WHERE run_id = ? AND id = ?").get(first.run.id, "REQ-001").title, "First requirement");
  assert.equal(db.prepare("SELECT title FROM requirements WHERE run_id = ? AND id = ?").get(second.run.id, "REQ-001").title, "Second requirement");

  const insertLink = db.prepare(`
    INSERT INTO trace_links(
      id, run_id, requirement_id, target_type, target_id, relation,
      status, evidence_refs_json, created_at, updated_at
    ) VALUES(?, ?, ?, 'artifact', 'shared-target', 'verified-by', 'current', '[]', ?, ?)
  `);
  const timestamp = new Date().toISOString();
  insertLink.run("trace-first", first.run.id, "REQ-001", timestamp, timestamp);
  insertLink.run("trace-second", second.run.id, "REQ-001", timestamp, timestamp);
  assert.throws(
    () => insertLink.run("trace-duplicate", first.run.id, "REQ-001", timestamp, timestamp),
    /UNIQUE constraint failed/u
  );
});

function productionTask(id, overrides = {}) {
  return {
    id,
    title: id,
    goal: `Complete ${id}`,
    role: "worker",
    taskKind: "implementation",
    runPhase: "execute",
    readOnly: false,
    scope: [`src/${id}.js`],
    targetPaths: [`src/${id}.js`],
    acceptanceCriteria: [`${id} completes.`],
    requiredEvidence: ["Current evidence"],
    expectedOutputs: ["implementation"],
    requirementIds: ["REQ-001"],
    complexity: "low",
    risk: "low",
    effort: "small",
    ...overrides
  };
}

test("production task creation prioritizes the active run host over a shared Codex config", () => {
  for (const host of ["claude", "opencode"]) {
    const { root, db, config: codexConfig } = makeProject({ config: { host: "codex" } });
    try {
      const { run } = startTestRun(db, root, codexConfig, `${host} shared-host routing`, { host });
      forcePhase(db, root, codexConfig, run.id, "plan");
      const task = addTask(db, run.id, productionTask(`${host}-worker`), codexConfig);
      assert.equal(task.selected_model, null, host);
      assert.equal(task.model_source, "none", host);
    } finally {
      db.close();
    }
  }
});

test("production active-run task creation preserves the strong specialist tier floor", () => {
  const { root, db, config: codexConfig } = makeProject({ config: { host: "codex" } });
  try {
    const { run } = startTestRun(db, root, codexConfig, "Specialist tier floor");
    forcePhase(db, root, codexConfig, run.id, "plan");
    const task = addTask(db, run.id, {
      id: "security-floor",
      title: "Security review",
      goal: "Review the security boundary.",
      role: "security-reviewer",
      taskKind: "review",
      runPhase: "review",
      readOnly: true,
      scope: ["security boundary"],
      requirementIds: ["REQ-001"],
      acceptanceCriteria: ["The security boundary is reviewed."],
      expectedOutputs: ["review-result"],
      modelTier: "worker"
    }, codexConfig);

    assert.equal(task.model_tier, "strong");
    assert.equal(task.selected_model, null);
    assert.equal(task.model_source, "none");
  } finally {
    db.close();
  }
});

test("production active-run retry advances effort and preserves model provenance", () => {
  const { root, db, config: codexConfig } = makeProject({ config: { host: "codex" } });
  try {
    const { run } = startTestRun(db, root, codexConfig, "Production escalation routing");
    forcePhase(db, root, codexConfig, run.id, "plan");
    addTask(db, run.id, productionTask("default-worker"), codexConfig);
    addTask(db, run.id, productionTask("explicit-worker", { model: "task-model" }), codexConfig);
    addTask(db, run.id, productionTask("explicit-luna-worker", { model: "gpt-5.6-luna" }), codexConfig);
    db.prepare("UPDATE tasks SET status = 'failed' WHERE id IN ('default-worker', 'explicit-worker', 'explicit-luna-worker')").run();

    assert.equal(getTask(db, "default-worker").model_source, "none");
    assert.equal(getTask(db, "explicit-worker").model_source, "task");
    assert.equal(getTask(db, "explicit-luna-worker").model_source, "task");

    retryTask(db, run.id, "default-worker", "Needs stronger reasoning", codexConfig, "reasoning");
    retryTask(db, run.id, "explicit-worker", "Needs stronger reasoning", codexConfig, "reasoning");
    retryTask(db, run.id, "explicit-luna-worker", "Needs stronger reasoning", codexConfig, "reasoning");

    assert.equal(getTask(db, "default-worker").model_tier, "worker");
    assert.equal(getTask(db, "default-worker").selected_model, null);
    assert.equal(getTask(db, "default-worker").model_source, "none");
    assert.equal(getTask(db, "default-worker").reasoning_effort, "xhigh");
    assert.equal(getTask(db, "explicit-worker").selected_model, "task-model");
    assert.equal(getTask(db, "explicit-worker").model_source, "task");
    assert.equal(getTask(db, "explicit-luna-worker").model_tier, "worker");
    assert.equal(getTask(db, "explicit-luna-worker").selected_model, "gpt-5.6-luna");
    assert.equal(getTask(db, "explicit-luna-worker").model_source, "task");
  } finally {
    db.close();
  }
});
