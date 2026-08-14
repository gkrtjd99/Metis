import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { installAdapters, uninstallAdapters } from "../src/adapters/install.js";
import { capabilityRegistryManifest } from "../src/core/capabilities.js";
import { doctor } from "../src/core/doctor.js";
import { makeProject } from "./helpers.js";

const INSTALLED_SKILL_TREES = [
  ".agents/skills/metis",
  "plugins/metis/skills/metis",
  ".claude/skills/metis",
  ".opencode/skills/metis",
  ".agents/metis/runtime/skills/metis"
];

function filesBelow(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesBelow(item));
    else if (entry.isFile()) output.push(item);
  }
  return output;
}

function assertInstalledSkillTree(root, relative) {
  const skillRoot = path.join(root, relative);
  const discoverable = filesBelow(skillRoot)
    .filter((file) => path.basename(file) === "SKILL.md")
    .map((file) => path.relative(root, file))
    .sort();
  assert.deepEqual(discoverable, [`${relative}/SKILL.md`]);

  const capabilities = filesBelow(skillRoot)
    .filter((file) => path.basename(file) === "CAPABILITY.md")
    .map((file) => path.relative(root, file))
    .sort();
  assert.deepEqual(capabilities, capabilityRegistryManifest()
    .map((item) => `${relative}/${item.skillPath}`)
    .sort());
}

test("installed Metis skill trees have one root entrypoint and CAPABILITY.md procedures", () => {
  const { root, db } = makeProject();
  try {
    installAdapters(root, ["codex", "claude", "opencode"], false);
    for (const tree of INSTALLED_SKILL_TREES) assertInstalledSkillTree(root, tree);
  } finally {
    db.close();
  }
});

test("Codex installation extends native Goal mode with a skill and runtime", () => {
  const { root, config, db } = makeProject();
  try {
    const result = installAdapters(root, ["codex"], false);
    assert.equal(existsSync(path.join(root, "plugins/metis/commands/metis.md")), true);
    assert.ok(existsSync(path.join(root, "plugins/metis/skills/metis/SKILL.md")));
    assert.ok(existsSync(path.join(root, "plugins/metis/skills/model/SKILL.md")));
    assert.ok(existsSync(path.join(root, "plugins/metis/agents/metis-worker.toml")));
    assert.ok(existsSync(path.join(root, ".agents/skills/metis/SKILL.md")));
    assert.ok(existsSync(path.join(root, ".agents/skills/metis-model/SKILL.md")));
    assert.ok(existsSync(path.join(root, ".codex/config.toml")));
    const codexConfig = readFileSync(path.join(root, ".codex/config.toml"), "utf8");
    assert.match(codexConfig, /goals = true/);
    assert.match(codexConfig, /max_concurrent_threads_per_session = 8/);
    assert.ok(existsSync(path.join(root, ".codex/agents/metis-worker.toml")));
    assert.ok(existsSync(path.join(root, ".codex/agents/metis-synthesizer.toml")));
    assert.ok(existsSync(path.join(root, ".codex/agents/metis-task-compiler.toml")));
    assert.ok(existsSync(path.join(root, ".codex/agents/metis-diagnostician.toml")));
    assert.ok(existsSync(result.runtime.launcher));
    assert.match(result.stateIgnore.replaceAll("\\", "/"), /\.git\/info\/exclude$/);
    assert.match(readFileSync(result.stateIgnore, "utf8"), /^\/\.codex\/config\.toml$/m);
    assert.equal(existsSync(path.join(root, ".gitignore")), false);
    const marketplace = JSON.parse(readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
    assert.ok(marketplace.plugins.some((item) => item.name === "metis"));
    const skill = readFileSync(path.join(root, ".agents/skills/metis/SKILL.md"), "utf8");
    assert.match(skill, /\.agents\/metis\/metis\.mjs/);
    assert.match(skill, /Terminal child handoff \(Codex host\)/);
    assert.match(skill, /\$METIS task finish <task-id> --lease <lease-token> --file <result-file> --pretty/);
    assert.match(skill, /INGEST_PLAN_DRAFT/);
    assert.match(skill, /\$METIS plan ingest <planner-task-id> --pretty/);
    assert.match(skill, /cannot replace Main actions/);
    assert.match(readFileSync(path.join(root, ".agents/skills/metis/agents/openai.yaml"), "utf8"), /allow_implicit_invocation: false/);
    assert.match(readFileSync(path.join(root, ".agents/skills/metis-model/agents/openai.yaml"), "utf8"), /allow_implicit_invocation: false/);
    const help = execFileSync(process.execPath, ["--no-warnings", result.runtime.launcher, "--help"], { cwd: root, encoding: "utf8" });
    assert.match(help, /Metis CLI/);
    const diagnosis = doctor(root, config);
    assert.equal(diagnosis.adapters.codex.installed, true);
    assert.equal(diagnosis.capabilities.codex.adapterInstalled, true);
    assert.equal(diagnosis.capabilities.codex.roleRouting, true);
    assert.equal(diagnosis.codex.roles.expected.length, 21);
    assert.ok(diagnosis.codex.roles.installed.includes("metis-synthesizer"));
    assert.ok(diagnosis.codex.roles.installed.includes("metis-task-compiler"));
    assert.ok(diagnosis.codex.roles.installed.includes("metis-diagnostician"));
  } finally {
    db.close();
  }
});

test("OpenCode installation merges Metis without deleting existing configuration", () => {
  const { root, db } = makeProject();
  try {
    mkdirSync(path.join(root, ".opencode"), { recursive: true });
    writeFileSync(path.join(root, ".opencode", "opencode.json"), "{\"existing\":true}\n");
    installAdapters(root, ["opencode"], true);
    assert.equal(readFileSync(path.join(root, ".opencode", "opencode.json"), "utf8"), "{\"existing\":true}\n");
    assert.ok(existsSync(path.join(root, ".opencode", "commands", "metis.md")));
    assert.ok(existsSync(path.join(root, ".opencode", "agents", "metis-worker.md")));
    assert.ok(existsSync(path.join(root, ".opencode", "skills", "metis", "SKILL.md")));
    assert.ok(existsSync(path.join(root, ".opencode", "skills", "metis-model", "SKILL.md")));
  } finally {
    db.close();
  }
});

test("Codex installation preserves existing project config and role overrides unless forced", () => {
  const { root, db } = makeProject();
  try {
    mkdirSync(path.join(root, ".codex", "agents"), { recursive: true });
    writeFileSync(path.join(root, ".codex", "config.toml"), "model = \"custom\"\n");
    writeFileSync(path.join(root, ".codex", "agents", "metis-worker.toml"), "name = \"metis-worker\"\ndescription = \"custom\"\n");
    installAdapters(root, ["codex"], false);
    assert.equal(readFileSync(path.join(root, ".codex", "config.toml"), "utf8"), "model = \"custom\"\n");
    assert.match(readFileSync(path.join(root, ".codex", "agents", "metis-worker.toml"), "utf8"), /description = "custom"/);
    installAdapters(root, ["codex"], true);
    assert.equal(readFileSync(path.join(root, ".codex", "config.toml"), "utf8"), "model = \"custom\"\n");
    assert.match(readFileSync(path.join(root, ".codex", "agents", "metis-worker.toml"), "utf8"), /Implement one bounded task inside exclusive mutable paths/);
  } finally {
    db.close();
  }
});


test("forced installation restores the original host file on uninstall", () => {
  const { root, db } = makeProject();
  try {
    const role = path.join(root, ".codex", "agents", "metis-worker.toml");
    mkdirSync(path.dirname(role), { recursive: true });
    const original = 'name = "metis-worker"\ndescription = "project-owned worker"\n';
    writeFileSync(role, original);

    installAdapters(root, ["codex"], true);
    assert.notEqual(readFileSync(role, "utf8"), original);

    const result = uninstallAdapters(root, ["all"]);
    assert.equal(result.applied, true);
    assert.equal(readFileSync(role, "utf8"), original);
    assert.ok(result.files.some((item) => item.path === ".codex/agents/metis-worker.toml" && item.status === "restored"));
  } finally {
    db.close();
  }
});
