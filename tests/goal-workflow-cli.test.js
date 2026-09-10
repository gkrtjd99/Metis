import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/cli.js";
import { jsonIo, makeProject } from "./helpers.js";
import { openDatabase } from "../src/core/db.js";

async function cli(root, args, credentials = [], expected = 0) {
  const io = jsonIo();
  const code = await main([...args, ...credentials, "--root", root], io);
  const result = JSON.parse(io.stdoutText || io.stderrText);
  assert.equal(code, expected, JSON.stringify(result));
  return result;
}

function auth(controller) {
  return [
    "--controller-session", controller.sessionId, "--controller-owner", controller.owner,
    "--controller-fence", String(controller.fencingToken), "--controller-token", controller.token
  ];
}

test("CLI 계획·PRD 연결·복원·명시 실행은 같은 run을 유지하며 resume는 승인하지 않는다", async () => {
  const model = "goal-cli-model";
  const project = makeProject({ config: {
    host: "claude",
    models: { capabilities: { claude: { models: { [model]: ["low", "medium", "high"] } } } }
  } });
  project.db.close();
  const { root } = project;
  const started = await cli(root, ["start", "parser의 작은 동작 개선", "--host", "claude", "--plan-only", "--controller-session", "goal-cli-main", "--controller-owner", "main"]);
  const credentials = auth(started.controller);
  const intake = await cli(root, ["goal", "restore"], credentials);
  assert.equal(intake.status, "intake-required");
  assert.equal(intake.executionApproval.required, true);
  await cli(root, ["goal", "restore"], [], 1);

  const sourceBody = "# PRD\nPRIVATE_PRD_BODY_5cad\nREQ-001: parser의 작은 동작 개선";
  const source = await cli(root, ["artifact", "put", "prd", "--data", sourceBody], credentials);
  const contract = {
    objective: "parser의 작은 동작 개선", scope: ["src/parser.js"], nonGoals: ["다른 기능"],
    constraints: [], successCriteria: ["parser 사례 통과"], complexity: "trivial",
    route: { lifecycleProfile: "fast", sourceDocument: { artifactId: source.id, contentRef: source.content_ref } },
    requirements: [{ id: "REQ-001", title: "parser 사례", acceptance: ["새 사례 통과"] }]
  };
  await cli(root, ["contract", "freeze", "--data", JSON.stringify(contract)], credentials);
  const frozen = await cli(root, ["contract", "get"]);
  assert.equal(frozen.route.executionApprovalRequired, true);
  await cli(root, ["advance", "discover"], credentials);
  await cli(root, ["drive", "--max-iterations", "4", "--data", JSON.stringify({ executionSettings: {
    host: "claude", model, requestedEffort: "high", confirmed: true,
    evidence: "CLI workflow의 명시적 실행 설정 승인 fixture"
  } })], credentials);
  let restored = await cli(root, ["goal", "restore"], credentials);
  assert.equal(restored.run.id, started.run.id);
  assert.equal(restored.run.phase, "plan");
  assert.equal(restored.executionApproval.pass, false);
  assert.equal(restored.originalRequest.sourceDocument.contentRef, source.content_ref);
  assert.ok(!JSON.stringify(restored).includes("PRIVATE_PRD_BODY_5cad"));
  assert.ok(!JSON.stringify(restored).includes(started.controller.token));
  await cli(root, ["advance", "execute"], credentials, 1);

  await cli(root, ["pause", "재개 경계 검증"], credentials);
  await cli(root, ["resume"], credentials);
  restored = await cli(root, ["goal", "restore"], credentials);
  assert.equal(restored.executionApproval.pass, false);
  await cli(root, ["plan", "execute", "--reason", "명시적 실행"], [], 1);
  await cli(root, ["plan", "execute"], credentials, 1);
  await cli(root, ["plan", "execute", "--reason", "사용자가 현재 계획 실행을 명시적으로 요청함"], credentials);
  restored = await cli(root, ["goal", "restore"], credentials);
  assert.equal(restored.executionApproval.pass, true);
  assert.equal(restored.run.phase, "plan");
  await cli(root, ["advance", "execute"], credentials);
  const db = openDatabase(root);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_spawn_acks").get().n, 0);
  } finally { db.close(); }
});

test("CLI plan-only 옵션의 오타와 계획 없는 실행 승인을 거부한다", async () => {
  const { root, db } = makeProject();
  db.close();
  await cli(root, ["start", "목표", "--plan-only=invalid"], [], 1);
  const started = await cli(root, ["start", "목표", "--plan-only"]);
  const credentials = auth(started.controller);
  await cli(root, ["plan", "execute", "--reason", "계획 없는 미래 승인"], credentials, 1);
  const recovered = await cli(root, ["goal", "restore"], credentials);
  assert.equal(recovered.status, "intake-required");
  assert.equal(recovered.executionApproval.pass, false);
});
