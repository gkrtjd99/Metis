import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/core/db.js";
import { restoreGoalContext } from "../src/core/goal-recovery.js";
import { buildMainContext } from "../src/core/context.js";
import { amendGoalContract, freezeGoalContract } from "../src/core/contracts.js";
import { addDecision } from "../src/core/evidence.js";
import { addCheckpoint } from "../src/core/checkpoints.js";
import { addTask } from "../src/core/tasks.js";
import { ensurePlannedExecutionCheckpoint, putArtifact, recordEvent, startRun } from "../src/core/state.js";
import { storeObject } from "../src/core/objects.js";
import { runtimeArea } from "../src/core/paths.js";
import { makeProject } from "./helpers.js";

const originalGoal = "원래 요청: 대화 없이 내구성 목표를 복원한다";
const sourceBody = "PRD_SNAPSHOT_BODY_DO_NOT_INLINE_7c48\n" + "세부 원본 요구사항\n".repeat(300);

function fixture() {
  const project = makeProject({ config: { budgets: { mainContextTokens: 1000 } } });
  const { root, db, config } = project;
  const { run } = startRun(db, root, config, originalGoal, { planOnly: true });
  const sourcePath = path.join(root, "request.txt");
  writeFileSync(sourcePath, sourceBody);
  const source = putArtifact(db, root, run.id, "prd", sourceBody, { path: sourcePath, metadata: { controllerToken: "PRIVATE_METADATA" } });
  const { contract } = freezeGoalContract(db, root, run.id, {
    objective: "현재 계약 목표", scope: ["src/local.js"], successCriteria: ["목표 복원이 가능하다"],
    complexity: "standard",
    route: { sourceDocument: { artifactId: source.id, contentRef: source.content_ref }, executionApprovalRequired: true },
    requirements: [{ title: "복원 요구사항", acceptance: ["원래 목표와 현재 상태를 복원한다"] }]
  });
  return { ...project, run, source, sourcePath, contract };
}

// 허용된 context/object/token 기록 외 모든 테이블이 그대로인지 비교한다.
function durableState(db) {
  const allowed = new Set(["context_snapshots", "objects", "token_calibrations"]);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.filter(({ name }) => !allowed.has(name)).map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

function task(db, runId, config, id) {
  return addTask(db, runId, {
    id, title: `복원 작업 ${id}`, goal: "복원 검증", role: "scout", taskKind: "discovery", runPhase: "discover",
    readOnly: true, scope: ["src/local.js"], acceptanceCriteria: ["검증 완료"], requiredEvidence: []
  }, config);
}

test("DB 재open 후 대화 없이 현재 계약·원래 목표·결정·작업·승인 대기를 복원한다", () => {
  const f = fixture();
  let db = f.db;
  try {
    addDecision(db, f.run.id, { title: "내구성 결정", decision: "SNAPSHOT_DECISION", rationale: "원래 경로에 의존하지 않는다" });
    db.prepare("UPDATE runs SET phase = 'discover' WHERE id = ?").run(f.run.id);
    task(db, f.run.id, f.config, "recovery_task");
    db.prepare("UPDATE tasks SET status = 'blocked', result_json = ? WHERE id = ?").run(JSON.stringify({ RawOutput: "RAW_WORKER_OUTPUT" }), "recovery_task");
    addCheckpoint(db, f.run.id, { id: "restore_pending", kind: "authority", reason: "사용자의 계획 실행 승인이 필요하다" });
    db.prepare(`INSERT INTO task_attempts(id, task_id, run_id, attempt_fence, attempt_number, host, role, tier, model_source, start_at)
      VALUES('restore_attempt', 'recovery_task', ?, 1, 1, 'test', 'scout', 'standard', 'test', datetime('now'))`).run(f.run.id);
    recordEvent(db, f.run.id, "recovery.private", "info", { rawOutput: "PRIVATE_JOURNAL_PAYLOAD", controllerToken: "PRIVATE_CONTROLLER_EVENT" });
    putArtifact(db, f.root, f.run.id, "discovery", { raw: "PRIVATE_PHASE_ARTIFACT" }, { metadata: { leaseToken: "PRIVATE_LEASE_METADATA" } });
    unlinkSync(f.sourcePath);
    db.close();
    db = openDatabase(f.root);
    const before = durableState(db);
    const restored = restoreGoalContext(db, f.root, f.run.id, f.config);
    const again = restoreGoalContext(db, f.root, f.run.id, f.config);
    assert.equal(restored.protocol, "metis.goal-recovery.v1");
    assert.equal(restored.status, "restored");
    assert.equal(restored.originalRequest.goal, originalGoal);
    assert.match(restored.context.content, /현재 계약 목표/);
    assert.equal(restored.decisions.items[0].decision, "SNAPSHOT_DECISION");
    assert.equal(restored.tasks.items[0].id, "recovery_task");
    assert.equal(restored.failedOrBlockedTasks.items[0].status, "blocked");
    assert.equal(restored.activeAttempts.items[0].id, "restore_attempt");
    assert.equal(restored.pendingCheckpoints.items[0].id, "restore_pending");
    assert.equal(restored.executionApproval.required, true);
    assert.equal(restored.executionApproval.pass, false);
    assert.equal(restored.originalRequest.sourceDocument.contentRef, f.source.content_ref);
    assert.equal(restored.context.contentRef, again.context.contentRef);
    assert.deepEqual(durableState(db), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM context_snapshots").get().n, 2);
    const serialized = JSON.stringify(restored);
    for (const privateValue of [sourceBody.slice(0, 35), "RAW_WORKER_OUTPUT", "PRIVATE_JOURNAL_PAYLOAD", "PRIVATE_CONTROLLER_EVENT", "PRIVATE_METADATA", "PRIVATE_PHASE_ARTIFACT", "PRIVATE_LEASE_METADATA", f.run.controller_token]) {
      if (privateValue) assert.ok(!serialized.includes(privateValue), privateValue);
    }
    assert.doesNotMatch(serialized, /controller_token|lease_token|metadata_json|payload_json/);
  } finally { db.close(); }
});

test("오래된 목표는 current contract로 복원하고 compact context에도 immutable source handle이 남는다", () => {
  const f = fixture();
  try {
    amendGoalContract(f.db, f.root, f.run.id, { objective: "수정된 현재 목표", reason: "승인된 범위 조정", approvedByUser: true });
    writeFileSync(f.sourcePath, "변경된 파일은 snapshot 기준이 아니다");
    const restored = restoreGoalContext(f.db, f.root, f.run.id, f.config);
    assert.equal(restored.contract.version, 2);
    assert.equal(restored.originalRequest.goal, originalGoal);
    assert.match(restored.context.content, /수정된 현재 목표/);
    const context = buildMainContext(f.db, f.root, f.run.id, f.config, { tokenBudget: 300 });
    assert.equal(context.sourceDocument.contentRef, f.source.content_ref);
    assert.equal(context.sourceDocument.loadInstructions.artifact, `metis artifact get ${f.source.id}`);
    assert.deepEqual(context.originalRequest, { runId: f.run.id, field: "runs.goal" });
    assert.ok(!JSON.stringify(context).includes(sourceBody.slice(0, 35)));
  } finally { f.db.close(); }
});

test("연결된 원본의 누락·foreign·stale·ref 변경을 복원 전에 거절한다", () => {
  for (const mutation of ["missing", "foreign", "stale", "kind", "ref"]) {
    const f = fixture();
    try {
      if (mutation === "missing") f.db.prepare("DELETE FROM artifacts WHERE id = ?").run(f.source.id);
      if (mutation === "stale") f.db.prepare("UPDATE artifacts SET status = 'stale' WHERE id = ?").run(f.source.id);
      if (mutation === "kind") f.db.prepare("UPDATE artifacts SET kind = 'discovery' WHERE id = ?").run(f.source.id);
      if (mutation === "ref") {
        const ref = storeObject(f.db, f.root, "artifact:prd", "replacement");
        f.db.prepare("UPDATE artifacts SET content_ref = ? WHERE id = ?").run(ref, f.source.id);
      }
      if (mutation === "foreign") {
        f.db.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(f.run.id);
        const other = startRun(f.db, f.root, f.config, "다른 run").run;
        f.db.prepare("UPDATE artifacts SET run_id = ? WHERE id = ?").run(other.id, f.source.id);
      }
      assert.throws(() => restoreGoalContext(f.db, f.root, f.run.id, f.config), { code: "CONTRACT_SOURCE_DOCUMENT_BINDING" }, mutation);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM context_snapshots").get().n, 0);
    } finally { f.db.close(); }
  }
});

test("저장 object의 암호문 변조와 누락은 typed error로 실패한다", () => {
  for (const mutation of ["tamper", "missing"]) {
    const f = fixture();
    try {
      const row = f.db.prepare("SELECT path FROM objects WHERE hash = ?").get(f.source.content_ref.slice(4));
      const file = path.join(runtimeArea(f.root, "objects"), row.path.replace(/^objects\//u, ""));
      if (mutation === "missing") unlinkSync(file);
      else {
        const bytes = readFileSync(file);
        bytes[bytes.length - 1] ^= 1;
        writeFileSync(file, bytes);
      }
      assert.throws(() => restoreGoalContext(f.db, f.root, f.run.id, f.config), { code: "GOAL_SOURCE_AUTH_FAILED" });
    } finally { f.db.close(); }
  }
});

test("현재 계획 seal에 연결된 pending 실행 승인 gate는 복원으로 해제되지 않는다", () => {
  const f = fixture();
  try {
    const plan = putArtifact(f.db, f.root, f.run.id, "plan", {
      contract: { contractHash: f.contract.contract_hash }, planHash: "sealed-plan-hash"
    });
    ensurePlannedExecutionCheckpoint(f.db, f.root, f.run.id, f.config);
    const checkpoint = f.db.prepare("SELECT id FROM checkpoints WHERE run_id = ? AND status = 'pending'").get(f.run.id);
    assert.ok(checkpoint);
    const before = durableState(f.db);
    const restored = restoreGoalContext(f.db, f.root, f.run.id, f.config);
    assert.equal(restored.planSeal.artifactId, plan.id);
    assert.equal(restored.planSeal.contentRef, plan.content_ref);
    assert.equal(restored.executionApproval.checkpointId, checkpoint.id);
    assert.equal(restored.executionApproval.pass, false);
    assert.equal(restored.pendingCheckpoints.items[0].id, checkpoint.id);
    assert.deepEqual(durableState(f.db), before);
  } finally { f.db.close(); }
});

test("복원은 외부 tokenizer 명령도 실행하지 않는다", () => {
  const f = fixture();
  try {
    const marker = path.join(f.root, "tokenizer-executed");
    const config = { ...f.config, budgets: { ...f.config.budgets, tokenizer: {
      mode: "external", command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); console.log(100)`]
    } } };
    const restored = restoreGoalContext(f.db, f.root, f.run.id, config);
    assert.equal(existsSync(marker), false);
    assert.match(restored.context.tokenMethod, /estimate/);
  } finally { f.db.close(); }
});

test("인증된 snapshot 내용 hash가 ref와 다르면 복원을 거절한다", () => {
  const f = fixture();
  try {
    const ref = storeObject(f.db, f.root, "artifact:prd", Buffer.from([0xff, 0xfe, 0x61]));
    // 인증된 binary object를 잘못된 UTF-8 메타데이터로 읽으면 반환 내용의 hash가 달라진다.
    f.db.prepare("UPDATE objects SET content_encoding = 'utf8' WHERE hash = ?").run(ref.slice(4));
    f.db.prepare("UPDATE artifacts SET content_ref = ? WHERE id = ?").run(ref, f.source.id);
    const route = { ...f.contract.route, sourceDocument: { artifactId: f.source.id, contentRef: ref } };
    f.db.prepare("UPDATE goal_contracts SET route_json = ? WHERE id = ?").run(JSON.stringify(route), f.contract.id);
    assert.throws(() => restoreGoalContext(f.db, f.root, f.run.id, f.config), { code: "CONTRACT_SOURCE_DOCUMENT_INTEGRITY" });
  } finally { f.db.close(); }
});

test("계약 없는 run은 intake-required이고 리스트와 문자열은 bounded projection이다", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startRun(db, root, config, "짧은 목표", { planOnly: true });
    for (let index = 0; index < 5; index += 1) addDecision(db, run.id, {
      title: `결정 ${index}`, decision: "x".repeat(1000), rationale: "복원 크기를 제한한다"
    });
    const before = durableState(db);
    const restored = restoreGoalContext(db, root, run.id, config, { limit: 2, textLimit: 80 });
    assert.equal(restored.status, "intake-required");
    assert.equal(restored.contract, null);
    assert.equal(restored.next.type, "INTAKE_REQUIRED");
    assert.equal(restored.executionApproval.required, true);
    assert.equal(restored.decisions.limit, 2);
    assert.equal(restored.decisions.omitted, 3);
    assert.ok(restored.decisions.items.every((item) => item.decision.length <= 80));
    for (const key of ["tasks", "activeAttempts", "failedOrBlockedTasks", "pendingCheckpoints"]) {
      assert.equal(restored[key].limit, 2);
      assert.equal(restored[key].omitted, 0);
    }
    assert.deepEqual(durableState(db), before);
    assert.ok(JSON.stringify(restored).length < 18000);
  } finally { db.close(); }
});
