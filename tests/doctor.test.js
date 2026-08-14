import assert from "node:assert/strict";
import test from "node:test";
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
