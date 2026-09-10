import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeProject } from "./helpers.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const model = "process-crash-fixture-model";
const criterion = "the crash fixture preserves its execution contract";
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
    cwd: root, env: cleanEnvironment, encoding: "utf8", timeout: 30000
  });
  const text = child.stdout || child.stderr;
  let result;
  try { result = JSON.parse(text); }
  catch { assert.fail(`${args.slice(0, 2).join(" ")}: JSON 응답이 없습니다(status=${child.status}).`); }
  assert.equal(child.status, expected, `${args.slice(0, 2).join(" ")}: ${result.error?.code ?? result.code ?? "unexpected status"}`);
  return result;
}

function rejected(root, args, controller, code) {
  const result = invoke(root, args, controller, 1);
  assert.equal(result.error?.code, code, `${args.slice(0, 2).join(" ")}: unexpected rejection`);
  return result;
}

function contract() {
  return {
    objective: "the crash fixture preserves its execution contract",
    scope: ["src/parser.js"],
    nonGoals: ["unrelated changes"],
    constraints: [],
    successCriteria: [criterion],
    complexity: "trivial",
    route: {
      lifecycleProfile: "fast",
      researchRequired: false,
      designRequired: false,
      specialistReviewRequired: false,
      documentationRequired: false
    },
    requirements: [{ id: "REQ-CRASH-001", title: criterion, acceptance: [criterion] }]
  };
}

// 강제 종료 대상 process가 공개 CLI로 직접 controller 권한을 행사한다.
const controllerProcessSource = String.raw`
  import { spawnSync } from "node:child_process";
  import { writeFileSync } from "node:fs";
  const [cli, root, readyPath, model, contractJson] = process.argv.slice(1);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|METIS_CONTROLLER/iu.test(key)));
  process.on("uncaughtException", (error) => {
    writeFileSync(readyPath, JSON.stringify({ error: String(error?.message ?? "fixture failure").slice(0, 200) }) + "\n", { mode: 0o600 });
    process.exit(1);
  });
  function call(args, expected = 0) {
    const child = spawnSync(process.execPath, ["--no-warnings", cli, ...args, "--root", root], { cwd: root, env, encoding: "utf8", timeout: 30000 });
    const text = child.stdout || child.stderr;
    let value;
    try { value = JSON.parse(text); } catch { throw new Error("fixture command returned non-JSON"); }
    if (child.status !== expected) throw new Error(value.error?.code || "fixture command failed");
    return value;
  }
  const started = call(["start", "parser crash recovery", "--host", "claude", "--plan-only", "--controller-session", "crash-parent-session", "--controller-owner", "crash-parent-owner"]);
  const controller = started.controller;
  const auth = ["--controller-session", controller.sessionId, "--controller-owner", controller.owner, "--controller-fence", String(controller.fencingToken), "--controller-token", controller.token];
  const withAuth = (args, expected = 0) => call([...args, ...auth], expected);
  withAuth(["contract", "freeze", "--data", contractJson]);
  withAuth(["advance", "discover"]);
  const executionSettings = { host: "claude", model, requestedEffort: "high", confirmed: true, evidence: "explicit crash-process approval fixture" };
  const awaitingApproval = withAuth(["drive", "--data", JSON.stringify({ executionSettings })]);
  if (awaitingApproval.type !== "USER_OR_AUTHORITY_REQUIRED") throw new Error("fixture did not stop for execution approval");
  withAuth(["plan", "execute", "--reason", "explicit crash-process execution approval"]);
  withAuth(["advance", "execute"]);
  const action = withAuth(["drive"]);
  if (action.type !== "SPAWN_BATCH") throw new Error("fixture did not produce a spawn batch");
  const claimed = withAuth(["schedule", "claim", "--owner", "crash-fixture-worker", "--limit", "1"]);
  if (claimed.batch.length !== 1) throw new Error("fixture did not claim a real task");
  const plan = withAuth(["artifact", "latest", "plan"]);
  const planContent = typeof plan.content === "string" ? JSON.parse(plan.content) : plan.content;
  const readiness = JSON.stringify({
    plan: { id: plan.id, contentRef: plan.content_ref, executionSettings: planContent.executionSettings },
    runId: started.run.id,
    controller,
    executionSettings,
    action: { type: action.type, taskIds: action.action.tasks.map((item) => item.taskId) },
    batchId: claimed.batchId,
    taskId: claimed.batch[0].taskId
  }) + "\n";
  writeFileSync(readyPath, readiness, { mode: 0o600 });
  process.stdout.write(readiness);
  const heartbeat = setInterval(() => {
    try { withAuth(["controller", "heartbeat"]); } catch { clearInterval(heartbeat); process.exitCode = 1; }
  }, 100);
  process.on("SIGTERM", () => { clearInterval(heartbeat); process.exit(0); });
`;

const recoveryProcessSource = String.raw`
  import { spawnSync } from "node:child_process";
  const [cli, root, runId] = process.argv.slice(1);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|METIS_CONTROLLER/iu.test(key)));
  function call(args, expected = 0) {
    const child = spawnSync(process.execPath, ["--no-warnings", cli, ...args, "--root", root], { cwd: root, env, encoding: "utf8", timeout: 30000 });
    const text = child.stdout || child.stderr;
    let value;
    try { value = JSON.parse(text); } catch { throw new Error("recovery command returned non-JSON"); }
    if (child.status !== expected) throw new Error(value.error?.code || "recovery command failed");
    return value;
  }
  const takeover = call(["controller", "takeover", "--run", runId, "--controller-session", "crash-recovery-session", "--controller-owner", "crash-recovery-owner"]);
  const auth = ["--controller-session", takeover.sessionId, "--controller-owner", takeover.owner, "--controller-fence", String(takeover.fencingToken), "--controller-token", takeover.token];
  const restored = call(["goal", "restore", "--run", runId, ...auth]);
  const driven = call(["drive", "--run", runId, ...auth]);
  const plan = call(["artifact", "latest", "plan", ...auth]);
  const planContent = typeof plan.content === "string" ? JSON.parse(plan.content) : plan.content;
  process.stdout.write(JSON.stringify({
    plan: { id: plan.id, contentRef: plan.content_ref, executionSettings: planContent.executionSettings },
    takeover: { sessionId: takeover.sessionId, owner: takeover.owner, fencingToken: takeover.fencingToken },
    restored: {
      run: restored.run,
      executionApproval: restored.executionApproval,
      planSeal: restored.planSeal,
      tasks: restored.tasks.items,
      controller: restored.controller
    },
    driven: {
      type: driven.type,
      schedulerBatchIds: driven.action.schedulerBatchIds,
      taskIds: driven.action.taskIds,
      ownerManagedChildren: driven.action.ownerManagedChildren
    }
  }) + "\n");
`;

function spawnController(root, readyPath) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", controllerProcessSource,
    cliPath, root, readyPath, model, JSON.stringify(contract())], {
    cwd: root, env: cleanEnvironment, stdio: ["ignore", "pipe", "pipe"]
  });
  return child;
}

async function readReady(child, readyPath) {
  let buffered = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("controller readiness timeout")), 30000);
    const onData = (chunk) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      child.stdout.off("data", onData);
      clearTimeout(timer);
      try { resolve(JSON.parse(buffered.slice(0, newline))); }
      catch { reject(new Error("controller fixture did not publish a valid readiness record")); }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      let detail = "";
      if (existsSync(readyPath)) {
        try { detail = JSON.parse(readFileSync(readyPath, "utf8")).error ?? ""; } catch { detail = ""; }
      }
      reject(new Error(`controller fixture exited before readiness (${code ?? signal})${detail ? `: ${detail}` : ""}`));
    });
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

function runRecovery(root, runId) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", recoveryProcessSource,
    cliPath, root, runId], { cwd: root, env: cleanEnvironment, encoding: "utf8", timeout: 30000 });
  assert.equal(child.status, 0, "recovery process failed");
  try { return JSON.parse(child.stdout); }
  catch { assert.fail("recovery process returned non-JSON"); }
}

test("controller SIGKILL 후 승인·설정을 복원하고 이전 controller의 재승인·dispatch를 차단한다", async () => {
  const project = makeProject({ config: {
    controller: { leaseSeconds: 1, heartbeatSeconds: 1 },
    host: "claude",
    orchestration: { requirePlanCritic: true, requireDesignCritic: true, specialistReviews: { enabled: true } },
    models: { capabilities: { claude: { models: { [model]: ["low", "medium", "high"] } } } }
  } });
  const { root } = project;
  project.db.close();
  const readyPath = `${root}/controller-ready.json`;
  const parent = spawnController(root, readyPath);
  let ready;
  try {
    ready = await readReady(parent, readyPath);
    assert.equal(ready.action.type, "SPAWN_BATCH");
    assert.equal(ready.action.taskIds.includes(ready.taskId), true);
    assert.equal(ready.executionSettings.model, model);
    assert.equal(ready.executionSettings.requestedEffort, "high");

    rejected(root, ["controller", "takeover", "--run", ready.runId,
      "--controller-session", "rogue-live-session", "--controller-owner", "rogue-live-owner"], null, "CONTROLLER_ACTIVE");

    parent.kill("SIGKILL");
    await waitForExit(parent);
    assert.equal(parent.signalCode, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1300));

    const recovered = runRecovery(root, ready.runId);
    assert.deepEqual(recovered.takeover, {
      sessionId: "crash-recovery-session",
      owner: "crash-recovery-owner",
      fencingToken: ready.controller.fencingToken + 1
    });
    assert.deepEqual(recovered.plan, ready.plan);
    assert.ok(recovered.plan.executionSettings.entries.length > 0);
    assert.ok(recovered.plan.executionSettings.entries.every((entry) =>
      entry.model === model && entry.requestedEffort === "high" && entry.effectiveEffort === "high"));
    assert.equal(recovered.restored.run.id, ready.runId);
    assert.equal(recovered.restored.run.phase, "execute");
    assert.equal(recovered.restored.run.status, "active");
    assert.equal(recovered.restored.executionApproval.required, true);
    assert.equal(recovered.restored.executionApproval.pass, true);
    assert.equal(recovered.restored.planSeal !== null, true);
    assert.equal(recovered.restored.tasks.some((task) => task.id === ready.taskId && task.status === "running"), true);
    assert.equal(recovered.restored.controller.takeoverPerformed, false);
    assert.equal(recovered.driven.type, "WAIT_FOR_AGENTS");
    assert.deepEqual(recovered.driven.schedulerBatchIds, [ready.batchId]);
    assert.equal(recovered.driven.taskIds.includes(ready.taskId), true);

    rejected(root, ["controller", "heartbeat", "--run", ready.runId], ready.controller, "CONTROLLER_FENCED");
    rejected(root, ["plan", "execute", "--run", ready.runId, "--reason", "stale approval"], ready.controller, "CONTROLLER_FENCED");
    rejected(root, ["drive", "--run", ready.runId], ready.controller, "CONTROLLER_FENCED");
    rejected(root, ["schedule", "claim", "--run", ready.runId, "--owner", "stale-worker", "--limit", "1"], ready.controller, "CONTROLLER_FENCED");

    const currentStatus = invoke(root, ["controller", "status", "--run", ready.runId]);
    assert.equal(currentStatus.sessionId, recovered.takeover.sessionId);
    assert.equal(currentStatus.owner, recovered.takeover.owner);
    assert.equal(currentStatus.fencingToken, recovered.takeover.fencingToken);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await waitForExit(parent);
    if (project.db.isOpen) project.db.close();
  }
});
