import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeProject } from "./helpers.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const cleanEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|METIS_CONTROLLER/iu.test(key)));

function invoke(root, args, controller = null, expected = 0) {
  const auth = controller ? [
    "--controller-session", controller.sessionId,
    "--controller-owner", controller.owner,
    "--controller-fence", String(controller.fencingToken),
    "--controller-token", controller.token
  ] : [];
  const child = spawnSync(process.execPath, ["--no-warnings", cliPath, ...args, ...auth, "--root", root], {
    cwd: root,
    env: cleanEnvironment,
    encoding: "utf8",
    timeout: 60_000
  });
  const text = (child.stdout || child.stderr || "").trim();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    assert.fail(`CLI returned no JSON for ${args.slice(0, 2).join(" ")} (status ${child.status}).`);
  }
  assert.equal(child.status, expected, result.error?.code ?? result.code ?? "unexpected CLI status");
  return result;
}

function writeCodexCap(root, value) {
  mkdirSync(path.join(root, ".codex"), { recursive: true });
  writeFileSync(path.join(root, ".codex", "config.toml"),
    `[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = ${value}\n`);
}

function task(id) {
  return {
    id,
    title: `Scout ${id}`,
    goal: "Inspect the bounded repository input and return discovery evidence.",
    role: "scout",
    taskKind: "discovery",
    runPhase: "discover",
    wave: 1,
    readOnly: true,
    scope: ["package.json"],
    nonGoals: ["Do not modify repository files."],
    constraints: ["Use local-read authority only."],
    targetPaths: [],
    requirementIds: ["REQ-CAPACITY"],
    acceptanceCriteria: ["Return bounded discovery evidence."],
    requiredEvidence: ["Current repository evidence"],
    expectedOutputs: ["discovery"],
    dependsOn: []
  };
}

function prepareProject(host, codexCap) {
  const project = makeProject({
    config: {
      host,
      orchestration: { maxConcurrent: 8 }
    }
  });
  project.db.close();
  if (codexCap !== null) writeCodexCap(project.root, codexCap);

  const started = invoke(project.root, [
    "start", "Verify host capacity dispatch", "--host", host,
    "--controller-session", `host-capacity-${host}`,
    "--controller-owner", "main"
  ]);
  const controller = started.controller;
  const contract = {
    objective: "Verify host capacity dispatch",
    scope: ["package.json"],
    nonGoals: ["Unrelated changes"],
    constraints: ["Keep dispatch bounded by the selected host."],
    successCriteria: ["Only host-supported concurrency is dispatched."],
    complexity: "trivial",
    route: {
      lifecycleProfile: "balanced",
      researchRequired: false,
      designRequired: false,
      specialistReviewRequired: false,
      documentationRequired: false
    },
    requirements: [{
      id: "REQ-CAPACITY",
      title: "Bound host dispatch capacity",
      description: "Dispatch must respect the selected host capacity.",
      kind: "functional",
      priority: "must",
      acceptance: ["Only host-supported concurrency is dispatched."]
    }]
  };
  invoke(project.root, ["contract", "freeze", "--data", JSON.stringify(contract)], controller);
  invoke(project.root, ["advance", "discover"], controller);
  for (let index = 1; index <= 8; index += 1) {
    invoke(project.root, ["task", "add", "--data", JSON.stringify(task(`scout-${index}`))], controller);
  }
  return { ...project, controller };
}

function taskCounts(root) {
  const tasks = invoke(root, ["task", "list"]);
  return {
    total: tasks.length,
    running: tasks.filter((item) => item.status === "running").length,
    pending: tasks.filter((item) => item.status === "pending").length
  };
}

test("공개 CLI Codex는 project cap 4를 적용하고 동일 실행의 반복 claim을 막는다", () => {
  const { root, controller } = prepareProject("codex", 4);
  const first = invoke(root, ["schedule", "claim", "--owner", "fixture-codex", "--limit", "8"], controller);
  assert.equal(first.batch.length, 4);
  assert.equal(first.diagnostics.selected, 4);
  assert.equal(first.diagnostics.freeSlots, 4);
  assert.deepEqual(taskCounts(root), { total: 8, running: 4, pending: 4 });

  const repeated = invoke(root, ["schedule", "claim", "--owner", "fixture-codex", "--limit", "8"], controller);
  assert.equal(repeated.batch.length, 0);
  assert.equal(repeated.action, "NO_RUNNABLE_TASKS");
  assert.equal(repeated.diagnostics.freeSlots, 0);
  assert.deepEqual(taskCounts(root), { total: 8, running: 4, pending: 4 });
});

test("공개 CLI Claude는 같은 Codex project cap을 무시하고 runtime cap 8을 적용한다", () => {
  const { root, controller } = prepareProject("claude", 4);
  const claimed = invoke(root, ["schedule", "claim", "--owner", "fixture-claude", "--limit", "8"], controller);
  assert.equal(claimed.batch.length, 8);
  assert.equal(claimed.diagnostics.selected, 8);
  assert.equal(claimed.diagnostics.freeSlots, 8);
  assert.deepEqual(taskCounts(root), { total: 8, running: 8, pending: 0 });
});

test("공개 CLI Codex는 invalid project cap에서 dispatch를 fail closed 한다", () => {
  const { root, controller } = prepareProject("codex", "4.0");
  const blocked = invoke(root, ["schedule", "claim", "--owner", "fixture-invalid", "--limit", "8"], controller);
  assert.equal(blocked.batch.length, 0);
  assert.equal(blocked.action, "NO_RUNNABLE_TASKS");
  assert.equal(blocked.diagnostics.selected, 0);
  assert.equal(blocked.diagnostics.freeSlots, 0);
  assert.deepEqual(taskCounts(root), { total: 8, running: 0, pending: 8 });
});
