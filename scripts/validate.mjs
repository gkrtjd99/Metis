#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityRegistryManifest } from "../src/core/capabilities.js";
import {
  CHECKPOINT_KINDS,
  CLEANUP_SCOPES,
  CONFIG_VERSION,
  PHASES,
  REQUIREMENT_KINDS,
  ROLES,
  RUNTIME_LAYOUT_VERSION,
  SCHEMA_VERSION,
  TASK_KINDS
} from "../src/core/metadata.js";
import { RUNTIME_AREAS } from "../src/core/paths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const absolute = (relative) => path.join(root, relative);
const read = (relative) => readFileSync(absolute(relative), "utf8");
const parse = (relative) => JSON.parse(read(relative));
const packageJson = parse("package.json");
const version = packageJson.version;

function filesBelow(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesBelow(item));
    else if (entry.isFile()) output.push(item);
  }
  return output;
}

function assertMirror(canonical, mirrors) {
  const content = read(canonical);
  for (const mirror of mirrors) assert.equal(read(mirror), content, `${mirror} differs from ${canonical}`);
}

assert.equal(version, "1.0.1");
assert.equal(packageJson.engines.node, ">=22.16.0");
assert.deepEqual(packageJson.exports, {
  ".": "./src/index.js",
  "./package.json": "./package.json"
});
assert.deepEqual(packageJson.os, ["darwin", "linux"]);
assert.deepEqual(packageJson.bin, { metis: "src/cli.js" });
assert.equal(packageJson.scripts.prepublishOnly, "npm run check");
assert.equal(packageJson.repository.url, "git+https://github.com/gkrtjd99/Metis.git");
assert.equal(packageJson.bugs.url, "https://github.com/gkrtjd99/Metis/issues");
assert.equal(packageJson.homepage, "https://github.com/gkrtjd99/Metis#readme");
assert.match(packageJson.scripts.check, /generate-reference\.mjs --check/);
assert.match(packageJson.scripts.check, /tests\/\*\.test\.js/);

const codex = parse(".codex-plugin/plugin.json");
assert.equal(codex.name, "metis");
assert.equal(codex.version, version);
assert.equal(codex.skills, "./skills/");
assert.equal(codex.commands, undefined, "Metis must not shadow Codex native /goal.");
assert.match(JSON.stringify(codex.interface), /\/goal \$metis/);
assert.equal(existsSync(absolute("plugin.json")), false, "A root plugin manifest would change Codex discovery semantics.");

const claude = parse(".claude-plugin/plugin.json");
assert.equal(claude.name, "metis");
assert.equal(claude.version, version);
assert.equal(parse("adapters/claude/.claude-plugin/plugin.json").version, version);

assert.equal(existsSync(absolute("skills/goal")), false);
assert.equal(existsSync(absolute("commands/goal.md")), false);

const skillPath = "skills/metis/SKILL.md";
const discoverableSkillFiles = filesBelow(absolute("skills/metis"))
  .filter((file) => path.basename(file) === "SKILL.md")
  .map((file) => path.relative(root, file))
  .sort();
assert.deepEqual(discoverableSkillFiles, [skillPath], "The managed-goal skill subtree must keep capabilities non-discoverable.");
const capabilityDocuments = capabilityRegistryManifest().map((capability) => `skills/metis/${capability.skillPath}`).sort();
const discoveredCapabilityDocuments = filesBelow(absolute("skills/metis"))
  .filter((file) => path.basename(file) === "CAPABILITY.md")
  .map((file) => path.relative(root, file))
  .sort();
assert.deepEqual(discoveredCapabilityDocuments, capabilityDocuments, "Nested capability procedures must be CAPABILITY.md documents.");
const skill = read(skillPath);
assert.match(skill, /^---\n[\s\S]*?\n---\n/);
assert.match(skill, /^name: metis$/m);
assert.match(skill, /literal `\$metis`/);
assert.match(skill, /Main is an orchestrator/i);
assert.match(skill, /Fresh subagents perform discovery, research, synthesis, design, planning, task compilation, implementation, diagnosis, review, verification, and curation/i);
assert.match(skill, /Goal Contract/);
assert.match(skill, /controller credentials/i);
assert.match(skill, /Task Packets/);
assert.match(skill, /task-compiler/);
assert.match(skill, /frozen interface/i);
assert.match(skill, /schedule claim/);
assert.match(skill, /schedule ack/);
assert.match(skill, /schedule heartbeat/);
assert.match(skill, /no shared workspace fallback/i);
assert.match(skill, /browser evidence/i);
assert.match(skill, /capabilit/i);
assert.match(skill, /orchestration boundary/i);
assert.match(skill, /diagnostician/i);
assert.match(skill, /adversarial-reviewer/);
assert.match(skill, /journal replay/);
assert.ok(skill.split(/\r?\n/u).length <= 500, "SKILL.md must stay below 500 lines.");

const agentMetadata = read("skills/metis/agents/openai.yaml");
assert.match(agentMetadata, /default_prompt: ".*\/goal \$metis/);
assert.match(agentMetadata, /allow_implicit_invocation:\s*false/);

const referenceDir = absolute("skills/metis/references");
const referenceFiles = readdirSync(referenceDir).sort();
assert.deepEqual(referenceFiles, [
  "approval.md",
  "contracts.md",
  "curation.md",
  "delegation.md",
  "lifecycle.md",
  "operations.md",
  "recovery.md",
  "token-policy.md"
]);
for (const match of skill.matchAll(/\]\(references\/([^)]+)\)/gu)) {
  assert.ok(existsSync(path.join(referenceDir, match[1])), `Missing reference ${match[1]}`);
}
for (const file of referenceFiles) {
  assert.doesNotMatch(read(`skills/metis/references/${file}`), /\]\(references\//, "References must remain one level deep.");
  assertMirror(`skills/metis/references/${file}`, [
    `adapters/claude/skills/metis/references/${file}`,
    `adapters/opencode/.opencode/skills/metis/references/${file}`
  ]);
}

assertMirror(skillPath, [
  "adapters/claude/skills/metis/SKILL.md",
  "adapters/opencode/.opencode/skills/metis/SKILL.md"
]);
assertMirror("skills/metis/agents/openai.yaml", [
  "adapters/claude/skills/metis/agents/openai.yaml",
  "adapters/opencode/.opencode/skills/metis/agents/openai.yaml"
]);
assertMirror("skills/metis/scripts/metis.mjs", [
  "adapters/claude/skills/metis/scripts/metis.mjs",
  "adapters/opencode/.opencode/skills/metis/scripts/metis.mjs"
]);

const modelSkillPath = "skills/model/SKILL.md";
const modelSkill = read(modelSkillPath);
assert.match(modelSkill, /^---\n[\s\S]*?\n---\n/);
assert.match(modelSkill, /^name: model$/m);
assert.match(modelSkill, /\$metis:model/);
assert.match(modelSkill, /model configure/);
assert.match(modelSkill, /Do not estimate or display cost/);
assert.match(read("skills/model/agents/openai.yaml"), /allow_implicit_invocation:\s*false/);
assertMirror(modelSkillPath, [
  "adapters/claude/skills/model/SKILL.md",
  "adapters/opencode/.opencode/skills/model/SKILL.md"
]);
assertMirror("skills/model/agents/openai.yaml", [
  "adapters/claude/skills/model/agents/openai.yaml",
  "adapters/opencode/.opencode/skills/model/agents/openai.yaml"
]);

const command = read("commands/metis.md");
assert.match(command, /^---\ndescription:/);
assert.match(command, /\$ARGUMENTS/);
assert.match(command, /\$metis/);
assert.match(command, /subagent-first/i);
assertMirror("commands/metis.md", [
  "adapters/claude/commands/metis.md",
  "adapters/opencode/.opencode/commands/metis.md"
]);

for (const role of ROLES) {
  const codexRole = `agents/metis-${role}.toml`;
  assert.ok(existsSync(absolute(codexRole)), `Missing Codex role ${role}`);
  assert.match(read(codexRole), new RegExp(`^name = "metis-${role}"`, "m"));
  assert.match(read(codexRole), /^description = ".+"$/m);
  assert.match(read(codexRole), /^developer_instructions\s*=\s*"""/m);
  assert.ok(existsSync(absolute(`adapters/claude/agents/${role}.md`)), `Missing Claude role ${role}`);
  assert.ok(existsSync(absolute(`adapters/opencode/.opencode/agents/metis-${role}.md`)), `Missing OpenCode role ${role}`);
}
assert.equal(ROLES.length, 21);
assert.ok(ROLES.includes("synthesizer"));
assert.ok(ROLES.includes("task-compiler"));
assert.ok(ROLES.includes("diagnostician"));

for (const capability of capabilityRegistryManifest()) {
  const relative = `skills/metis/${capability.skillPath}`;
  assert.ok(existsSync(absolute(relative)), `Missing capability document ${capability.name}`);
  const content = read(relative);
  assert.match(content, /^---\n[\s\S]*?\n---\n/);
  assert.match(content, new RegExp(`^name: ${capability.name}$`, "m"));
}

for (const relative of [
  "src/core/browser.js",
  "src/core/capabilities.js",
  "src/core/checkpoints.js",
  "src/core/contracts.js",
  "src/core/design-review.js",
  "src/core/interfaces.js",
  "src/core/metadata.js",
  "src/core/ownership.js",
  "src/core/plan-ingest.js",
  "src/core/prompt-protocols.js",
  "src/core/scheduler.js",
  "src/core/task-packets.js",
  "src/core/tasks.js",
  "src/core/tokens.js",
  "src/core/worktrees.js"
]) assert.ok(existsSync(absolute(relative)), `Missing required runtime module ${relative}`);

assert.equal(SCHEMA_VERSION, 11);
assert.equal(CONFIG_VERSION, 6);
assert.equal(RUNTIME_LAYOUT_VERSION, 4);
assert.deepEqual(PHASES, ["intake", "discover", "research", "design", "plan", "execute", "review", "verify", "curate", "complete"]);
assert.deepEqual(TASK_KINDS, ["discovery", "research", "synthesis", "design", "planning", "compilation", "implementation", "integration", "diagnosis", "repair", "review", "verification", "curation"]);
assert.deepEqual(CLEANUP_SCOPES, ["cache", "worktrees", "generated", "benchmarks", "all"]);
assert.ok(REQUIREMENT_KINDS.includes("ui"));
assert.ok(REQUIREMENT_KINDS.includes("database"));
assert.deepEqual(CHECKPOINT_KINDS, ["decision", "human-verify", "authority", "external", "release"]);
assert.equal(RUNTIME_AREAS.analytics, undefined);

const generated = read("docs/REFERENCE.md");
assert.match(generated, new RegExp(`"version": "${version.replaceAll(".", "\\.")}"`));
assert.match(generated, /"schemaVersion": 11/);
assert.match(generated, /## Canonical task kinds/);
assert.match(generated, /task-compiler/);
assert.match(generated, /\.metis\/state\/state\.db/);
assert.match(generated, /metis clean --scope cache --dry-run --pretty/);
assert.match(generated, /metis schedule ack/);

const readme = read("README.md");
assert.match(readme, /^# Metis 1\.0\.1/m);
assert.match(readme, /current public release/i);
assert.match(readme, /## Quick start/i);
assert.match(readme, /Codex/i);
assert.match(readme, /Claude Code/i);
assert.match(readme, /OpenCode/i);
assert.match(readme, /\/goal \$metis "<objective>"/i);
assert.match(readme, /No model setup is required after installation/i);
assert.match(readme, /Use `\$metis:model` only/i);
assert.match(readme, /Main uses the model selected by the current host session/i);
assert.match(readme, /Task Packet/);
assert.match(readme, /frozen interface/i);
assert.match(readme, /metis clean --scope cache --dry-run/);
assert.match(readme, /\.metis\/state\/state\.db/);

const korean = read("docs/README.ko.md");
assert.match(korean, /Metis 1\.0\.1/);
assert.match(korean, /현재 public release/i);
assert.match(korean, /## 빠른 시작/i);
assert.match(korean, /Codex, Claude Code, OpenCode/i);
assert.match(korean, /\/goal \$metis "<목표>"/i);
assert.match(korean, /별도의 model 설정은 필요하지 않습니다/i);
assert.match(korean, /`\$metis:model`을 사용합니다/i);
assert.match(korean, /Main/);
assert.match(korean, /Task Packet/);
assert.match(korean, /frozen interface|고정된 interface/i);
assert.match(korean, /metis clean --scope cache --dry-run/);
assert.match(korean, /\.metis\/state\/state\.db/);

const architecture = read("docs/ARCHITECTURE.md");
assert.match(architecture, /schema version 11/i);
assert.match(architecture, /ten phases/i);
assert.match(architecture, /universal task graph/i);
assert.match(architecture, /Task Packet pipeline/i);
assert.match(architecture, /Discovery and research fan-out/i);
assert.match(architecture, /diagnosis/i);

const operations = read("docs/OPERATIONS.md");
assert.match(operations, /Main must not replace a requested subagent action/i);
assert.match(operations, /Task Packets/);
assert.match(operations, /Diagnosis before retry/);
assert.match(operations, /STALLED_REPLAN/);
assert.match(operations, /--allow-repository-exec/);
assert.match(operations, /There is no `--apply` flag/);

const verification = read("docs/VERIFICATION.md");
assert.match(verification, /Metis 1\.0\.1/);
assert.match(verification, /separate Node\.js processes/i);
assert.match(verification, /native Codex, Claude Code, and OpenCode end-to-end tests/i);
assert.match(verification, /Task Packet compilation/i);
assert.match(verification, /Failure diagnosis/i);

const prohibited = [
  { pattern: /metis-api-reviewer/u, label: "obsolete API reviewer" },
  { pattern: /metis-operations-reviewer/u, label: "obsolete operations reviewer" },
  { pattern: /\.metis\/state\.db\b/u, label: "obsolete database path" },
  { pattern: /metis clean[^\n]*--apply/u, label: "obsolete cleanup command" },
  { pattern: /worktrees\.mode\s*[=:]\s*["']auto["']/u, label: "obsolete worktree fallback default" },
  { pattern: /shell:\s*true/u, label: "shell execution" },
  { pattern: /run untrusted repositories? in a separate container or virtual machine/iu, label: "obsolete sandbox prerequisite" },
  { pattern: /external isolation required/iu, label: "obsolete isolation prerequisite" }
];
for (const directory of ["src", "skills", "commands", "adapters", "docs", "scripts"]) {
  for (const file of filesBelow(absolute(directory))) {
    if (/\.(?:tgz|gz|zip|db)$/u.test(file)) continue;
    const relative = path.relative(root, file);
    if (relative === "scripts/validate.mjs") continue;
    const content = readFileSync(file, "utf8");
    for (const item of prohibited) assert.doesNotMatch(content, item.pattern, `${item.label} in ${relative}`);
  }
}

for (const file of filesBelow(root).filter((item) => /\.(?:js|mjs)$/u.test(item) && !item.includes(`${path.sep}node_modules${path.sep}`))) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

console.log("Metis 1.0.1 package structure is valid.");
