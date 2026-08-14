import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { loadConfig } from "../src/core/config.js";
import { configureModels, modelConfigView, resetModels } from "../src/core/model-config.js";
import { MODEL_ROUTE_GROUPS, ROLES } from "../src/core/metadata.js";
import { makeProject, jsonIo, startTestRun } from "./helpers.js";

test("model configuration expands one subagent selection across every canonical role", () => {
  const { root, config, db } = makeProject({ config: { host: "codex" } });
  try {
    const result = configureModels(root, config, {
      host: "codex",
      main: { model: "sol", effort: "xhigh" },
      subagents: { default: { model: "luna", effort: "max" } },
      capabilities: { luna: ["low", "medium", "high", "xhigh", "max"] }
    });
    const saved = loadConfig(root);
    assert.deepEqual(saved.models.main.codex, { model: "sol", reasoningEffort: "xhigh" });
    assert.equal(saved.models.defaults.codex.worker, "luna");
    for (const role of ROLES) {
      assert.equal(saved.models.routes[role].model, "luna", role);
      assert.equal(saved.models.routes[role].reasoningEffort, "max", role);
    }
    assert.deepEqual(saved.models.capabilities.codex.models.luna, ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(result.warnings, []);
    assert.equal(statSync(path.join(root, ".metis", "config.json")).mode & 0o777, 0o600);
  } finally { db.close(); }
});

test("model group and role selections override the default in deterministic order", () => {
  const { root, config, db } = makeProject({ config: { host: "claude" } });
  try {
    configureModels(root, config, {
      host: "claude",
      subagents: {
        default: { model: "sonnet", effort: "medium" },
        strong: { model: "opus", effort: "high" }
      },
      roles: { reviewer: { model: "review-opus", effort: "xhigh" } }
    });
    const saved = loadConfig(root);
    for (const role of MODEL_ROUTE_GROUPS.ordinary) assert.equal(saved.models.routes[role].model, "sonnet", role);
    for (const role of MODEL_ROUTE_GROUPS.strong.filter((role) => role !== "reviewer")) assert.equal(saved.models.routes[role].model, "opus", role);
    assert.deepEqual(saved.models.routes.reviewer, { tier: "strong", model: "review-opus", reasoningEffort: "xhigh" });
    assert.equal(saved.models.defaults.claude.worker, "sonnet");
    assert.deepEqual(modelConfigView(saved).warnings.sort(), ["No configured effort capability evidence exists for opus; provider effort remains deferred until the host supplies evidence.", "No configured effort capability evidence exists for review-opus; provider effort remains deferred until the host supplies evidence.", "No configured effort capability evidence exists for sonnet; provider effort remains deferred until the host supplies evidence."].sort());
  } finally { db.close(); }
});

test("model configuration rejects unsupported hosts, roles, efforts, and fields", () => {
  const { root, config, db } = makeProject({ config: { host: "opencode" } });
  try {
    assert.throws(() => configureModels(root, config, { host: "codex", subagents: { default: { model: "m" } } }), (error) => error.code === "MODEL_HOST_MISMATCH");
    assert.throws(() => configureModels(root, config, { roles: { ghost: { model: "m" } } }), (error) => error.code === "MODEL_ROLE_INVALID");
    assert.throws(() => configureModels(root, config, { subagents: { default: { model: "m", effort: "ultra" } } }), (error) => error.code === "MODEL_EFFORT_INVALID");
    assert.throws(() => configureModels(root, config, { price: true }), (error) => error.code === "MODEL_CONFIG_INVALID");
  } finally { db.close(); }
});

test("model reset restores host-neutral routes", () => {
  const { root, config, db } = makeProject({ config: { host: "codex" } });
  try {
    const configured = configureModels(root, config, { subagents: { default: { model: "luna", effort: "max" } }, capabilities: { luna: ["max"] } });
    assert.equal(configured.subagents.routes.worker.model, "luna");
    const reset = resetModels(root, loadConfig(root));
    assert.equal(reset.main.model, null);
    assert.equal(reset.subagents.defaultWorkerModel, null);
    assert.equal(reset.subagents.routes.worker.model, null);
    assert.deepEqual(reset.capabilities, {});
  } finally { db.close(); }
});

test("CLI freezes model mutation while a run is active", async () => {
  const { root, config, db } = makeProject({ config: { host: "codex" } });
  try {
    startTestRun(db, root, config, "Active model freeze");
  } finally { db.close(); }
  const io = jsonIo();
  const exitCode = await main(["--root", root, "model", "configure", "--data", JSON.stringify({ subagents: { default: { model: "luna" } } })], io);
  assert.equal(exitCode, 1);
  assert.match(io.stderrText, /MODEL_CONFIG_ACTIVE_RUN/);
  assert.equal(loadConfig(root).models.routes.worker.model, null);
});

test("model config file remains private when repairing an existing mode", () => {
  const { root, config, db } = makeProject({ config: { host: "codex" } });
  try {
    const file = path.join(root, ".metis", "config.json");
    chmodSync(file, 0o644);
    configureModels(root, config, { subagents: { default: { model: "luna" } } });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(readFileSync(file, "utf8"), /"luna"/);
  } finally { db.close(); }
});
