import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hostConcurrencyLimit, projectCodexConfig } from "../src/core/host-capacity.js";
import { mergeCodexConfigLayers, parseCodexConfigText } from "../src/core/doctor.js";

test("Codex nested multi-agent v2 configuration is parsed", () => {
  const parsed = parseCodexConfigText(`
model_provider = "openai"

[features]
goals = true

[features.multi_agent_v2]
enabled = true
max_concurrent_threads_per_session = 8
hide_spawn_agent_metadata = false
tool_namespace = "agents"
expose_spawn_agent_model_overrides = true
wait_agent_enabled = true
`);
  assert.equal(parsed.goals, true);
  assert.equal(parsed.multiAgentV2, true);
  assert.equal(parsed.maxConcurrentV2, 8);
  assert.equal(parsed.hideSpawnAgentMetadata, false);
  assert.equal(parsed.toolNamespace, "agents");
  assert.equal(parsed.exposeSpawnAgentModelOverrides, true);
  assert.equal(parsed.waitAgentEnabled, true);
  assert.equal(parsed.provider, "openai");
});

test("Codex flat feature configuration remains detectable", () => {
  const parsed = parseCodexConfigText(`
[features]
goals = false
multi_agent = true
multi_agent_v2 = false
`);
  assert.equal(parsed.goals, false);
  assert.equal(parsed.multiAgentV1, true);
  assert.equal(parsed.multiAgentV2, false);
});


test("Codex concurrency parsing supports quoted sections and root fallback without accepting decimal integers", () => {
  const quoted = parseCodexConfigText(`model_provider = "openai#local"
[features."multi_agent_v2"]
max_concurrent_threads_per_session = 4 # bounded
 tool_namespace = "agents#local"
`);
  assert.equal(quoted.maxConcurrentV2, 4);
  const spaced = parseCodexConfigText(`[ features . "multi_agent_v2" ]
max_concurrent_threads_per_session = 6
`);
  assert.equal(spaced.maxConcurrentV2, 6);
  const literal = parseCodexConfigText(`["features.multi_agent_v2"]
max_concurrent_threads_per_session = 9
`);
  assert.equal(literal.maxConcurrentV2, null);
  const quotedFeatures = parseCodexConfigText(`["features"]
goals = true
`);
  assert.equal(quotedFeatures.goals, true);
  assert.equal(quoted.provider, "openai#local");
  assert.equal(quoted.toolNamespace, "agents#local");
  const root = parseCodexConfigText("max_concurrent_threads_per_session = 5\n");
  assert.equal(root.maxConcurrentV2, 5);
  const decimal = parseCodexConfigText("max_concurrent_threads_per_session = 4.0\n");
  assert.equal(decimal.maxConcurrentV2, null);
  assert.equal(decimal.maxConcurrentV2Invalid, true);
});

test("host concurrency fails closed for invalid values and keeps Claude independent", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-host-cap-"));
  mkdirSync(path.join(root, ".codex"));
  writeFileSync(path.join(root, ".codex", "config.toml"), "[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 4\n");
  assert.equal(hostConcurrencyLimit(root, "codex", 8), 4);
  assert.equal(hostConcurrencyLimit(root, "claude", 8), 8);
  assert.equal(hostConcurrencyLimit(root, "codex", 0), 0);
  assert.equal(hostConcurrencyLimit(root, "codex", Number.MAX_SAFE_INTEGER + 1), 0);
  writeFileSync(path.join(root, ".codex", "config.toml"), "max_concurrent_threads_per_session = 4.0\n");
  assert.equal(hostConcurrencyLimit(root, "codex", 8), 0);
  writeFileSync(path.join(root, ".codex", "config.toml"), "max_concurrent_threads_per_session = 9007199254740992\n");
  assert.equal(hostConcurrencyLimit(root, "codex", 8), 0);
});

test("host concurrency refuses project Codex symlinks and directories", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-host-cap-safe-"));
  mkdirSync(path.join(root, ".codex"));
  mkdirSync(path.join(root, ".codex", "config.toml"));
  assert.equal(projectCodexConfig(root).invalid, true);
  assert.equal(hostConcurrencyLimit(root, "codex", 8), 0);
  const linkedRoot = mkdtempSync(path.join(os.tmpdir(), "metis-host-cap-link-"));
  symlinkSync(root, path.join(linkedRoot, ".codex"));
  assert.equal(projectCodexConfig(linkedRoot).invalid, true);
  assert.equal(hostConcurrencyLimit(linkedRoot, "codex", 8), 0);
});

test("project Codex configuration overrides user configuration", () => {
  const user = parseCodexConfigText(`
model_provider = "openai"
[features]
goals = true
[features.multi_agent_v2]
enabled = true
max_concurrent_threads_per_session = 8
`, "/home/user/.codex/config.toml");
  const project = parseCodexConfigText(`
[features.multi_agent_v2]
max_concurrent_threads_per_session = 4
tool_namespace = "agents"
`, "/repo/.codex/config.toml");
  const merged = mergeCodexConfigLayers(user, project);
  assert.equal(merged.provider, "openai");
  assert.equal(merged.goals, true);
  assert.equal(merged.multiAgentV2, true);
  assert.equal(merged.maxConcurrentV2, 4);
  assert.equal(merged.toolNamespace, "agents");
  assert.deepEqual(merged.files, ["/home/user/.codex/config.toml", "/repo/.codex/config.toml"]);
});
