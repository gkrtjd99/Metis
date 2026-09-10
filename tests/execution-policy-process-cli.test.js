import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main } from "../src/cli.js";
import { jsonIo, makeProject } from "./helpers.js";
import { openDatabase } from "../src/core/db.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const criterion = "parser exports the number 42";
const model = "process-fixture-model";
const cleanEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|METIS_CONTROLLER/iu.test(key)));

function invoke(root, args, controller = null, expected = 0) {
  const auth = controller ? [
    "--controller-session", controller.sessionId, "--controller-owner", controller.owner,
    "--controller-fence", String(controller.fencingToken), "--controller-token", controller.token
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

function artifactContent(artifact) {
  return typeof artifact.content === "string" ? JSON.parse(artifact.content) : artifact.content;
}

function preparePlan() {
  const project = makeProject({ config: {
    host: "claude",
    orchestration: { requirePlanCritic: true, requireDesignCritic: true, specialistReviews: { enabled: true } },
    models: { capabilities: { claude: { models: { [model]: ["low", "medium", "high"] } } } }
  } });
  project.db.close();
  const { root } = project;
  const entry = invoke(root, ["entry", "resolve", "--input", 'plan "parser exports 42"']);
  assert.equal(entry.mode, "plan");
  assert.equal(entry.objective, "parser exports 42");
  const started = invoke(root, ["start", "parser exports 42", "--host", "claude", "--plan-only",
    "--controller-session", "process-cli-main", "--controller-owner", "main"]);
  const controller = started.controller;
  const contract = {
    objective: "parser exports 42", scope: ["src/parser.js"], nonGoals: ["Other files"], constraints: [],
    successCriteria: [criterion], complexity: "trivial",
    route: { lifecycleProfile: "fast", researchRequired: false, designRequired: false,
      specialistReviewRequired: false, documentationRequired: false },
    requirements: [{ id: "REQ-001", title: criterion, acceptance: [criterion] }]
  };
  invoke(root, ["contract", "freeze", "--data", JSON.stringify(contract)], controller);
  invoke(root, ["advance", "discover"], controller);
  const executionSettings = { host: "claude", model, requestedEffort: "high", confirmed: true,
    evidence: "자동 인수 테스트의 명시적 사용자 승인 fixture" };
  const planned = invoke(root, ["drive", "--data", JSON.stringify({ executionSettings })], controller);
  assert.equal(planned.type, "USER_OR_AUTHORITY_REQUIRED");
  const plan = artifactContent(invoke(root, ["artifact", "latest", "plan"]));
  assert.equal(plan.executionSettings.entries.length, 2);
  for (const setting of plan.executionSettings.entries) {
    assert.equal(setting.model, model);
    assert.equal(setting.requestedEffort, "high");
    assert.equal(setting.effectiveEffort, "high");
  }
  return { root, controller, runId: started.run.id, executionSettings, plan };
}

function assertDescriptor(item) {
  assert.deepEqual(item.spawn.args.slice(0, 4), ["--model", model, "--effort", "high"]);
  assert.equal(item.spawn.effort_exact_required, true);
  assert.equal(item.spawn.effort_launch_ready, true);
}

function acknowledge(root, batch, item, pid, controller) {
  // 실제 Node fixture process의 PID이며 native Claude/Codex session receipt는 아니다.
  const receipts = { [item.taskId]: { receipt: `node-fixture:${pid}`, batchId: batch.batchId,
    taskId: item.taskId, attemptFence: item.attemptFence } };
  invoke(root, ["schedule", "ack", batch.batchId, "--tasks", item.taskId, "--receipts", JSON.stringify(receipts)], controller);
}

for (const actualValue of [42, 41]) {
  test(`공개 CLI 재기동·승인·resume 후 실제 산출물 ${actualValue}를 독립 process로 검증한다`, () => {
    const { root, controller, runId, plan } = preparePlan();
    invoke(root, ["advance", "execute"], controller, 1);
    invoke(root, ["pause", "계획 승인 이전 process 복원"], controller);
    invoke(root, ["resume"], controller);
    const pending = invoke(root, ["goal", "restore"], controller);
    assert.equal(pending.executionApproval.pass, false);
    invoke(root, ["plan", "execute", "--reason", "자동 테스트 사용자 실행 승인"], controller);
    invoke(root, ["advance", "execute"], controller);
    invoke(root, ["pause", "승인 설정을 유지하는 process 복원"], controller);
    invoke(root, ["resume"], controller);
    const restored = invoke(root, ["goal", "restore"], controller);
    assert.equal(restored.run.id, runId);
    assert.equal(restored.executionApproval.pass, true);
    assert.equal(JSON.stringify(restored).includes(controller.token), false);
    assert.deepEqual(artifactContent(invoke(root, ["artifact", "latest", "plan"])).executionSettings, plan.executionSettings);

    const workerBatch = invoke(root, ["schedule", "claim", "--owner", "fixture-worker", "--limit", "1"], controller);
    assert.equal(workerBatch.batch.length, 1);
    const worker = workerBatch.batch[0];
    assertDescriptor(worker);
    const writer = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
      writeFileSync(path.join(process.cwd(), 'src/parser.js'), 'export const parser = ' + process.argv[1] + ';\\n');
    `, String(actualValue)], { cwd: worker.workspacePath, env: cleanEnvironment, encoding: "utf8", timeout: 10000 });
    assert.equal(writer.status, 0);
    acknowledge(root, workerBatch, worker, writer.pid, controller);
    // worker의 성공 주장을 신뢰하지 않고 verifier가 파일을 별도 process에서 실행한다.
    invoke(root, ["task", "finish", worker.taskId, "--lease", worker.leaseToken, "--data", JSON.stringify({
      Status: "COMPLETED", Files: ["src/parser.js"], Summary: "Worker claims parser exports 42.",
      EvidenceRefs: ["src/parser.js:1"], AcceptanceResults: [{ criterion, status: "passed" }], Blockers: []
    })]);

    assert.equal(invoke(root, ["drive"], controller).type, "SPAWN_BATCH");
    const verifierBatch = invoke(root, ["schedule", "claim", "--owner", "fixture-verifier", "--limit", "1"], controller);
    assert.equal(verifierBatch.batch.length, 1);
    const verifier = verifierBatch.batch[0];
    assertDescriptor(verifier);
    assert.notEqual(verifier.taskId, worker.taskId);
    const observation = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { pathToFileURL } from 'node:url';
      import path from 'node:path';
      const { parser } = await import(pathToFileURL(path.join(process.cwd(), 'src/parser.js')));
      console.log(JSON.stringify({ actual: parser, passed: parser === 42 }));
    `], { cwd: verifier.workspacePath, env: cleanEnvironment, encoding: "utf8", timeout: 10000 });
    assert.equal(observation.status, 0);
    const measured = JSON.parse(observation.stdout);
    assert.equal(measured.actual, actualValue);
    assert.equal(measured.passed, actualValue === 42);
    acknowledge(root, verifierBatch, verifier, observation.pid, controller);
    const candidate = invoke(root, ["artifact", "latest", "integration-candidate"]);
    const result = {
      Status: measured.passed ? "COMPLETED" : "FAILED", Files: [],
      Summary: `독립 process에서 관측한 parser 값: ${measured.actual}`,
      EvidenceRefs: [{ type: "artifact", id: candidate.id, contentRef: candidate.content_ref }],
      AcceptanceResults: [{
        criterion,
        status: measured.passed ? "passed" : "failed",
        EvidenceRefs: [{ type: "artifact", id: candidate.id, contentRef: candidate.content_ref }]
      }],
      Blockers: measured.passed ? [] : ["parser does not export 42"],
      ...(measured.passed ? {} : { FailureClass: "verification" })
    };
    invoke(root, ["task", "finish", verifier.taskId, "--lease", verifier.leaseToken, "--data", JSON.stringify(result)]);
    const terminal = invoke(root, ["drive"], controller);
    const final = invoke(root, ["goal", "restore"], controller);
    if (measured.passed) {
      assert.equal(terminal.type, "COMPLETE");
      assert.equal(final.run.status, "completed");
      assert.equal(final.run.phase, "complete");
    } else {
      assert.notEqual(terminal.type, "COMPLETE");
      assert.notEqual(final.run.status, "completed");
    }
  });
}

test("공개 CLI는 승인 없는 설정 변경을 거부하고 reopen 뒤 새 실행 승인을 요구한다", () => {
  const { root, controller, executionSettings, plan } = preparePlan();
  invoke(root, ["plan", "execute", "--reason", "첫 번째 실행 승인"], controller);
  const changed = { ...executionSettings, requestedEffort: "medium" };
  const rejection = invoke(root, ["drive", "--data", JSON.stringify({ executionSettings: changed })], controller);
  assert.equal(rejection.type, "UNRECOVERABLE_BLOCKER");
  assert.equal(rejection.blocker.code, "DRIVE_EXECUTION_SETTINGS_UNEXPECTED");
  assert.equal(rejection.action.type, "ADVANCE_PHASE");
  assert.deepEqual(rejection.applied, []);
  const beforeReopen = invoke(root, ["goal", "restore"], controller);
  assert.equal(beforeReopen.run.phase, "plan");
  assert.equal(beforeReopen.executionApproval.pass, true);
  assert.deepEqual(artifactContent(invoke(root, ["artifact", "latest", "plan"])).executionSettings, plan.executionSettings);

  invoke(root, ["reopen", "discover", "자동 테스트 사용자가 effort를 medium으로 변경"], controller);
  const reopened = invoke(root, ["goal", "restore"], controller);
  assert.equal(reopened.run.phase, "discover");
  assert.equal(reopened.executionApproval.pass, false);

  const missing = invoke(root, ["drive"], controller);
  assert.equal(missing.type, "UNRECOVERABLE_BLOCKER");
  assert.equal(missing.action.type, "MATERIALIZE_FAST_PATH_PREREQUISITES");
  assert.equal(missing.blocker.code, "FAST_PATH_EXECUTION_SETTINGS_REAPPROVAL");
  assert.deepEqual(missing.applied, []);

  const unconfirmed = invoke(root, ["drive", "--data", JSON.stringify({ executionSettings: { ...changed, confirmed: false } })], controller);
  assert.equal(unconfirmed.type, "UNRECOVERABLE_BLOCKER");
  assert.equal(unconfirmed.action.type, "MATERIALIZE_FAST_PATH_PREREQUISITES");
  assert.equal(unconfirmed.blocker.code, "PLAN_EXECUTION_SETTINGS_CONFIRMATION");
  assert.deepEqual(unconfirmed.applied, []);
  const stillReopened = invoke(root, ["goal", "restore"], controller);
  assert.equal(stillReopened.run.phase, "discover");
  assert.equal(stillReopened.executionApproval.pass, false);

  const rematerialized = invoke(root, ["drive", "--data", JSON.stringify({ executionSettings: changed })], controller);
  assert.equal(rematerialized.type, "USER_OR_AUTHORITY_REQUIRED");
  assert.deepEqual(rematerialized.applied.map((item) => item.type), ["MATERIALIZE_FAST_PATH_PREREQUISITES"]);
  const replacement = artifactContent(invoke(root, ["artifact", "latest", "plan"]));
  assert.notEqual(replacement.planHash, plan.planHash);
  assert.ok(replacement.executionSettings.entries.every((entry) => entry.requestedEffort === "medium"));
  assert.ok(replacement.executionSettings.entries.every((entry) => entry.effectiveEffort === "medium"));
  assert.ok(replacement.executionSettings.entries.every((entry) => entry.userApproval?.status === "approved"));
  const awaitingApproval = invoke(root, ["goal", "restore"], controller);
  assert.equal(awaitingApproval.executionApproval.pass, false);

  invoke(root, ["plan", "execute", "--reason", "새 effort 실행 승인"], controller);
  invoke(root, ["advance", "execute"], controller);
  const executed = invoke(root, ["goal", "restore"], controller);
  assert.equal(executed.run.phase, "execute");
  assert.equal(executed.executionApproval.pass, true);
  const claimed = invoke(root, ["schedule", "claim", "--owner", "reapproved-worker", "--limit", "1"], controller);
  assert.equal(claimed.batch.length, 1);
  assert.deepEqual(claimed.batch[0].spawn.args.slice(0, 4), ["--model", model, "--effort", "medium"]);
  assert.equal(claimed.batch[0].spawn.effort_exact_required, true);
  assert.equal(claimed.batch[0].spawn.effort_launch_ready, true);
});

test("공개 next는 controller credentials 없이 호출할 수 없고 durable 상태를 변경하지 않는다", async () => {
  const { root, runId } = preparePlan();
  const beforeDb = openDatabase(root);
  const before = {
    run: beforeDb.prepare("SELECT revision, phase, status FROM runs WHERE id = ?").get(runId),
    checkpoints: beforeDb.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE run_id = ?").get(runId).count,
    journal: beforeDb.prepare("SELECT COUNT(*) AS count FROM journal WHERE run_id = ?").get(runId).count,
    snapshots: beforeDb.prepare("SELECT COUNT(*) AS count FROM context_snapshots WHERE run_id = ?").get(runId).count
  };
  beforeDb.close();

  const denied = jsonIo();
  assert.notEqual(await main(["--root", root, "next"], denied), 0);
  assert.match(denied.stderrText, /CONTROLLER_REQUIRED/u);

  const afterDb = openDatabase(root);
  try {
    assert.deepEqual({
      run: afterDb.prepare("SELECT revision, phase, status FROM runs WHERE id = ?").get(runId),
      checkpoints: afterDb.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE run_id = ?").get(runId).count,
      journal: afterDb.prepare("SELECT COUNT(*) AS count FROM journal WHERE run_id = ?").get(runId).count,
      snapshots: afterDb.prepare("SELECT COUNT(*) AS count FROM context_snapshots WHERE run_id = ?").get(runId).count
    }, before);
  } finally { afterDb.close(); }
});
