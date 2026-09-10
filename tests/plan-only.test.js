import assert from "node:assert/strict";
import test from "node:test";
import { amendGoalContract, freezeGoalContract, getGoalContract, validateSourceDocument } from "../src/core/contracts.js";
import { approvePlannedExecution, listCheckpoints, resolveCheckpoint } from "../src/core/checkpoints.js";
import { driveController, nextControllerAction } from "../src/core/controller.js";
import { advancePhase, ensurePlannedExecutionCheckpoint, fastPathEligibility, gateReport, getRun, latestArtifact, materializeFastPathPrerequisites, plannedExecutionApprovalStatus, putArtifact, startRun } from "../src/core/state.js";
import { addTask, claimTask, releaseTaskClaim, sealPlan } from "../src/core/tasks.js";
import { openDatabase } from "../src/core/db.js";
import { makeProject, sealAndApprovePlan } from "./helpers.js";
import { restoreGoalContext } from "../src/core/goal-recovery.js";

function contractInput(route = {}) {
  return { objective: "로컬 parser 변경", scope: ["src/parser.js"], nonGoals: ["다른 변경"], constraints: [],
    successCriteria: ["새 parser 사례 통과"], complexity: "trivial", route: { lifecycleProfile: "fast", ...route },
    requirements: [{ id: "REQ-001", title: "parser 사례", acceptance: ["새 사례 통과"] }] };
}

const fixtureModel = "plan-only-fixture-model";
const fixtureExecutionSettings = {
  model: fixtureModel,
  requestedEffort: "high",
  confirmed: true,
  evidence: "plan-only 실행 설정 fixture 승인"
};

function fixture(options = {}) {
  const route = options.route ?? { executionApprovalRequired: true };
  const project = makeProject({ config: {
    models: { capabilities: { codex: { models: { [fixtureModel]: ["low", "medium", "high"] } } } }
  } });
  const started = startRun(project.db, project.root, project.config, "로컬 parser 변경", { planOnly: options.planOnly });
  freezeGoalContract(project.db, project.root, started.run.id, contractInput(route));
  advancePhase(project.db, project.root, started.run.id, "discover");
  const materialized = materializeFastPathPrerequisites(project.db, project.root, started.run.id, started.controller, project.config,
    route.executionApprovalRequired === true ? { executionSettings: fixtureExecutionSettings } : {});
  return {
    ...project, ...started, materialized, runId: started.run.id,
    executionSettings: fixtureExecutionSettings
  };
}

function generalFixture(options = {}) {
  const f = fixture(options);
  const integrationId = `plan-integration-${f.runId}`;
  const adversarialId = `plan-adversarial-${f.runId}`;
  const curatorId = `plan-curation-${f.runId}`;
  addTask(f.db, f.runId, {
    id: integrationId, title: "Review integrated change", goal: "Independently review the integrated candidate",
    role: "reviewer", taskKind: "review", runPhase: "review", wave: 1, readOnly: true,
    scope: ["src/parser.js"], targetPaths: [], requirementIds: ["REQ-001"], acceptanceCriteria: ["Approve the integrated change."],
    requiredEvidence: ["Current integration candidate"], dependsOn: [f.materialized.taskIds[0]]
  }, f.config);
  addTask(f.db, f.runId, {
    id: adversarialId, title: "Adversarially review completion", goal: "Challenge the verification candidate",
    role: "adversarial-reviewer", taskKind: "review", runPhase: "verify", wave: 1, readOnly: true,
    scope: ["src/parser.js"], targetPaths: [], requirementIds: ["REQ-001"], acceptanceCriteria: ["No blocking completion gap remains."],
    requiredEvidence: ["Current verification candidate"], dependsOn: [integrationId, f.materialized.taskIds[1]]
  }, f.config);
  addTask(f.db, f.runId, {
    id: curatorId, title: "Curate verified knowledge", goal: "Record the verified documentation outcome",
    role: "curator", taskKind: "curation", runPhase: "curate", wave: 1, readOnly: true,
    scope: ["src/parser.js"], targetPaths: [], requirementIds: ["REQ-001"], acceptanceCriteria: ["Knowledge remains consistent."],
    requiredEvidence: ["Current completion review"], dependsOn: [adversarialId]
  }, f.config);
  sealAndApprovePlan(f.db, f.root, f.runId, { ...f.config, delegation: { ...f.config.delegation, requireReadyTaskPacket: false } }, {
    plannerId: `planner-initial-${f.runId}`,
    executionSettings: f.executionSettings
  });
  f.generalPlanFixture = true;
  return f;
}

function approve(f) {
  return approvePlannedExecution(f.db, f.root, f.runId, { controller: f.controller, resolution: "명시적 run 요청" });
}

test("plan-only fast 경로는 gate를 영구 생성하고 명시 승인 전 drive/advance를 멈춘다", () => {
  const f = fixture();
  try {
    const before = plannedExecutionApprovalStatus(f.db, f.root, f.runId);
    assert.equal(before.required, true);
    assert.equal(before.pass, false);
    assert.equal(before.checkpoint.kind, "authority");
    assert.equal(before.checkpoint.blocking, true);
    assert.equal(before.checkpoint.status, "pending");
    assert.equal(getGoalContract(f.db, f.runId).approved_by_user, 1);
    assert.equal(nextControllerAction(f.db, f.root, f.runId, f.config).type, "USER_OR_AUTHORITY_REQUIRED");
    driveController(f.db, f.root, f.runId, f.controller, f.config);
    assert.equal(getRun(f.db, f.runId).phase, "plan");
    assert.throws(() => advancePhase(f.db, f.root, f.runId, "execute"));
    materializeFastPathPrerequisites(f.db, f.root, f.runId, f.controller, f.config, {
      executionSettings: f.executionSettings
    });
    assert.equal(listCheckpoints(f.db, f.runId).length, 1);
    assert.equal(ensurePlannedExecutionCheckpoint(f.db, f.root, f.runId).checkpointId, before.checkpointId);
    assert.throws(() => resolveCheckpoint(f.db, f.runId, before.checkpointId, { resolution: "approvedByUser", approvedByUser: true }), /plan execute/);
    assert.throws(() => approvePlannedExecution(f.db, f.root, f.runId, { resolution: "run" }));
    approve(f);
    assert.equal(plannedExecutionApprovalStatus(f.db, f.root, f.runId).pass, true);
    advancePhase(f.db, f.root, f.runId, "execute");
    assert.equal(getRun(f.db, f.runId).phase, "execute");
    const claim = claimTask(f.db, f.runId, f.materialized.taskId, "worker", f.config);
    releaseTaskClaim(f.db, f.root, claim.task.id, claim.attemptFence);
  } finally { f.db.close(); }
});

test("DB 재개 후에도 현재 seal의 pending/승인 상태를 복구한다", () => {
  const f = fixture();
  const checkpointId = plannedExecutionApprovalStatus(f.db, f.root, f.runId).checkpointId;
  f.db.close();
  f.db = openDatabase(f.root);
  try {
    assert.equal(plannedExecutionApprovalStatus(f.db, f.root, f.runId).checkpointId, checkpointId);
    assert.equal(plannedExecutionApprovalStatus(f.db, f.root, f.runId).pass, false);
    assert.throws(() => approvePlannedExecution(f.db, f.root, f.runId, {
      controller: { ...f.controller, fencingToken: f.controller.fencingToken + 1 }, resolution: "run"
    }));
    approve(f);
    advancePhase(f.db, f.root, f.runId, "execute");
    // 실행 이후 정상적인 packet 재컴파일은 승인된 계획 seal 자체를 바꾸지 않습니다.
    f.db.prepare("UPDATE task_packets SET status = 'stale' WHERE task_id = ?").run(f.materialized.taskId);
    assert.equal(plannedExecutionApprovalStatus(f.db, f.root, f.runId).pass, true);
    f.db.close();
    f.db = openDatabase(f.root);
    assert.equal(plannedExecutionApprovalStatus(f.db, f.root, f.runId).pass, true);
  } finally { f.db.close(); }
});

for (const status of ["pending", "waived", "rejected", "missing"]) {
  test(`plan-only ${status} gate는 직접 claim/phase 변경으로 우회할 수 없다`, () => {
    const f = fixture();
    try {
      const approval = plannedExecutionApprovalStatus(f.db, f.root, f.runId);
      if (status === "missing") f.db.prepare("DELETE FROM checkpoints WHERE id = ?").run(approval.checkpointId);
      else if (status !== "pending") resolveCheckpoint(f.db, f.runId, approval.checkpointId, { status, resolution: "테스트 종결" });
      assert.equal(gateReport(f.db, f.root, f.runId, "execute").pass, false);
      f.db.prepare("UPDATE runs SET phase = 'execute' WHERE id = ?").run(f.runId);
      assert.throws(() => claimTask(f.db, f.runId, f.materialized.taskId, "worker", f.config), /명시적인 run/);
      assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id = ?").get(f.materialized.taskId).status, "pending");
      assert.equal(nextControllerAction(f.db, f.root, f.runId, f.config).type, "USER_OR_AUTHORITY_REQUIRED");
      if (["waived", "rejected"].includes(status)) assert.throws(() => approve(f), /already/);
    } finally { f.db.close(); }
  });
}

test("일반 plan critic 승인 경로도 새 seal마다 별도 실행 gate를 만든다", () => {
  const f = generalFixture();
  try {
    approve(f);
    const oldId = plannedExecutionApprovalStatus(f.db, f.root, f.runId).checkpointId;
    // fast 경로로 구성한 작업 그래프를 일반 planner/critic 경로로 새로 봉인합니다.
    const reviewed = sealAndApprovePlan(f.db, f.root, f.runId, { ...f.config, delegation: { ...f.config.delegation, requireReadyTaskPacket: false } }, {
      plannerId: `planner-renewed-${f.runId}`,
      criticId: `critic-renewed-${f.runId}`,
      executionSettings: f.executionSettings
    });
    assert.equal(reviewed.review.verdict, "APPROVED", JSON.stringify(reviewed.review.findings));
    const approval = plannedExecutionApprovalStatus(f.db, f.root, f.runId);
    assert.ok(approval.basis, approval.reason);
    assert.notEqual(approval.checkpointId, oldId);
    assert.equal(approval.checkpoint.status, "pending");
    assert.equal(approval.pass, false);
    approve(f);
    assert.equal(plannedExecutionApprovalStatus(f.db, f.root, f.runId).pass, true);
  } finally { f.db.close(); }
});

test("contract amend는 plan-only를 보존하고 이전 실행 허가를 재사용하지 않는다", () => {
  const f = generalFixture();
  try {
    approve(f);
    const oldId = plannedExecutionApprovalStatus(f.db, f.root, f.runId).checkpointId;
    assert.throws(() => amendGoalContract(f.db, f.root, f.runId, { reason: "해제", approvedByUser: true, route: { executionApprovalRequired: false } }), /해제/);
    amendGoalContract(f.db, f.root, f.runId, { reason: "새 계약", approvedByUser: true, route: { lifecycleProfile: "fast" } });
    assert.equal(getGoalContract(f.db, f.runId).route.executionApprovalRequired, true);
    assert.equal(plannedExecutionApprovalStatus(f.db, f.root, f.runId).pass, false);
    // 변경 후 재계획은 기존 fast task graph를 새 일반 seal로 봉인합니다.
    f.db.prepare("UPDATE runs SET phase = 'plan' WHERE id = ?").run(f.runId);
    sealAndApprovePlan(f.db, f.root, f.runId, { ...f.config, delegation: { ...f.config.delegation, requireReadyTaskPacket: false } }, {
      plannerId: `planner-amended-${f.runId}`,
      criticId: `critic-amended-${f.runId}`,
      executionSettings: f.executionSettings
    });
    const approval = plannedExecutionApprovalStatus(f.db, f.root, f.runId);
    assert.ok(approval.basis, approval.reason);
    assert.equal(approval.checkpoint.status, "pending");
    assert.notEqual(approval.checkpointId, oldId);
    assert.equal(approval.pass, false);
  } finally { f.db.close(); }
});

test("fast deterministic ID 재사용도 새 검토 epoch의 승인을 재사용하지 않는다", () => {
  const f = fixture();
  try {
    approve(f);
    const before = plannedExecutionApprovalStatus(f.db, f.root, f.runId);
    f.db.prepare("DELETE FROM tasks WHERE run_id = ?").run(f.runId);
    f.db.prepare("DELETE FROM milestones WHERE run_id = ?").run(f.runId);
    for (const id of f.materialized.artifactIds) f.db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
    f.db.prepare("UPDATE runs SET phase = 'discover' WHERE id = ?").run(f.runId);
    materializeFastPathPrerequisites(f.db, f.root, f.runId, f.controller, f.config, {
      executionSettings: f.executionSettings
    });
    const after = plannedExecutionApprovalStatus(f.db, f.root, f.runId);
    assert.equal(after.basis.planArtifactId, before.basis.planArtifactId);
    assert.notEqual(after.basis.reviewContentRef, before.basis.reviewContentRef);
    assert.notEqual(after.checkpointId, before.checkpointId);
    assert.equal(after.checkpoint.status, "pending");
    assert.equal(after.pass, false);
  } finally { f.db.close(); }
});

test("execution approval 대상 plan은 settings 없는 seal/materialization을 거부한다", () => {
  const materializationProject = makeProject();
  try {
    const started = startRun(materializationProject.db, materializationProject.root, materializationProject.config, "settings 없는 fast plan", { planOnly: true });
    freezeGoalContract(materializationProject.db, materializationProject.root, started.run.id, contractInput());
    advancePhase(materializationProject.db, materializationProject.root, started.run.id, "discover");
    assert.throws(
      () => materializeFastPathPrerequisites(
        materializationProject.db, materializationProject.root, started.run.id, started.controller, materializationProject.config
      ),
      (error) => error.code === "FAST_PATH_EXECUTION_SETTINGS_REQUIRED"
    );
    assert.equal(materializationProject.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(started.run.id).count, 0);
    assert.equal(materializationProject.db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind = 'plan'").get(started.run.id).count, 0);
  } finally { materializationProject.db.close(); }

  const sealingProject = makeProject();
  try {
    const started = startRun(sealingProject.db, sealingProject.root, sealingProject.config, "settings 없는 sealed plan");
    freezeGoalContract(sealingProject.db, sealingProject.root, started.run.id, contractInput({ executionApprovalRequired: true }));
    sealingProject.db.prepare("UPDATE runs SET phase = 'plan' WHERE id = ?").run(started.run.id);
    addTask(sealingProject.db, started.run.id, {
      id: "settings-required-worker", title: "Implement the bounded change", goal: "Implement the bounded change",
      role: "worker", taskKind: "implementation", runPhase: "execute", readOnly: false,
      scope: ["src/parser.js"], targetPaths: ["src/parser.js"], requirementIds: ["REQ-001"],
      acceptanceCriteria: ["The bounded change is implemented."], requiredEvidence: ["Current implementation evidence"], dependsOn: []
    }, sealingProject.config);
    assert.throws(
      () => sealPlan(sealingProject.db, started.run.id, sealingProject.config),
      (error) => error.code === "PLAN_EXECUTION_SETTINGS_REQUIRED"
    );
    assert.equal(sealingProject.db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind = 'plan'").get(started.run.id).count, 0);
  } finally { sealingProject.db.close(); }
});

test("settings 없는 approval plan은 approval/claim으로 진행되지 않는다", () => {
  const f = fixture({ route: { executionApprovalRequired: false } });
  try {
    const route = JSON.parse(f.db.prepare("SELECT route_json FROM goal_contracts WHERE run_id = ? AND status = 'active'").get(f.runId).route_json);
    route.executionApprovalRequired = true;
    f.db.prepare("UPDATE goal_contracts SET route_json = ? WHERE run_id = ? AND status = 'active'").run(JSON.stringify(route), f.runId);
    f.db.prepare("UPDATE runs SET route_json = ? WHERE id = ?").run(JSON.stringify(route), f.runId);

    const status = plannedExecutionApprovalStatus(f.db, f.root, f.runId);
    assert.equal(status.required, true);
    assert.equal(status.pass, false);
    assert.match(status.reason, /명시적인 실행 설정 승인/);
    assert.throws(
      () => approvePlannedExecution(f.db, f.root, f.runId, { controller: f.controller, resolution: "실행 승인" }),
      (error) => error.code === "PLAN_EXECUTION_SETTINGS_REAPPROVAL"
    );
    const restored = restoreGoalContext(f.db, f.root, f.runId, f.config);
    assert.equal(restored.executionApproval.required, true);
    assert.equal(restored.executionApproval.pass, false);
    f.db.prepare("UPDATE runs SET phase = 'execute' WHERE id = ?").run(f.runId);
    assert.throws(
      () => claimTask(f.db, f.runId, f.materialized.taskId, "legacy-worker", f.config),
      (error) => error.code === "PLANNED_EXECUTION_APPROVAL_REQUIRED"
    );
  } finally { f.db.close(); }
});

test("seal 이후 execution route drift는 approval과 restore 전에 fail closed 된다", () => {
  const driftCases = [
    ["selected_model", "drifted-model"],
    ["requested_effort", "medium"],
    ["effective_effort", "medium"],
    ["capability_status", "unknown"],
    ["effort_source", "drifted-source"],
    ["supported_efforts_json", JSON.stringify(["low"])]
  ];
  for (const [column, value] of driftCases) {
    const f = fixture();
    try {
      const { db, root, runId, materialized, config, controller } = f;
      const workerId = materialized.taskIds[0];
      db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(value, workerId);
      const status = plannedExecutionApprovalStatus(db, root, runId, config);
      assert.equal(status.pass, false, column);
      assert.equal(status.routeBinding.pass, false, column);
      assert.throws(
        () => approvePlannedExecution(db, root, runId, {
          controller, resolution: "현재 실행 route 확인"
        }),
        (error) => error.code === "PLAN_EXECUTION_SETTINGS_REAPPROVAL"
      );
      assert.equal(db.prepare("SELECT status FROM checkpoints WHERE id = ?").get(status.checkpointId).status, "pending");
      const restored = restoreGoalContext(db, root, runId, config);
      assert.equal(restored.executionApproval.pass, false, column);
      db.prepare("UPDATE runs SET phase = 'execute' WHERE id = ?").run(runId);
      assert.throws(
        () => claimTask(db, runId, workerId, "drift-check-worker", config),
        (error) => error.code === "PLANNED_EXECUTION_APPROVAL_REQUIRED"
      );
      assert.equal(db.prepare("SELECT attempts FROM tasks WHERE id = ?").get(workerId).attempts, 0);
    } finally { f.db.close(); }
  }
});

test("일반 no-flag run은 기존 fast 자동 진행을 유지한다", () => {
  const f = fixture({ route: {} });
  try {
    assert.equal(plannedExecutionApprovalStatus(f.db, f.root, f.runId).required, false);
    assert.equal(listCheckpoints(f.db, f.runId).length, 0);
    assert.equal(nextControllerAction(f.db, f.root, f.runId, f.config).type, "ADVANCE_PHASE");
    advancePhase(f.db, f.root, f.runId, "execute");
  } finally { f.db.close(); }
});

test("start planOnly 의도는 intake부터 저장되고 freeze omission/false로 사라지지 않는다", () => {
  const { db, root, config } = makeProject();
  try {
    const started = startRun(db, root, config, "계획만", { planOnly: true });
    assert.equal(plannedExecutionApprovalStatus(db, root, started.run.id).required, true);
    assert.throws(() => freezeGoalContract(db, root, started.run.id, contractInput({ executionApprovalRequired: false })), /해제/);
    freezeGoalContract(db, root, started.run.id, contractInput());
    assert.equal(getGoalContract(db, started.run.id).route.executionApprovalRequired, true);
    advancePhase(db, root, started.run.id, "discover");
    assert.equal(fastPathEligibility(db, started.run.id).eligible, true);
  } finally { db.close(); }
});

for (const value of ["true", "false", 1, 0, null]) {
  test(`freeze/amend invalid executionApprovalRequired ${JSON.stringify(value)}를 거부한다`, () => {
    const { db, root, config } = makeProject();
    try {
      const { run } = startRun(db, root, config, "계획만");
      assert.throws(() => freezeGoalContract(db, root, run.id, contractInput({ executionApprovalRequired: value })), /boolean/);
      freezeGoalContract(db, root, run.id, contractInput({ executionApprovalRequired: true }));
      assert.throws(() => amendGoalContract(db, root, run.id, { reason: "변경", approvedByUser: true, route: { executionApprovalRequired: value } }), /boolean/);
    } finally { db.close(); }
  });
}

test("PRD sourceDocument는 인증된 same-run ref를 보존하고 foreign/hash/stale 참조를 거부한다", () => {
  const { db, root, config } = makeProject();
  try {
    const { run } = startRun(db, root, config, "문서 기반 계획");
    const prd = putArtifact(db, root, run.id, "prd", "# 요구사항\n명령으로 실행하지 않는 원문");
    const sourceDocument = { artifactId: prd.id, contentRef: prd.content_ref };
    assert.deepEqual(validateSourceDocument(db, root, run.id, sourceDocument), sourceDocument);
    assert.throws(() => validateSourceDocument(db, root, "foreign-run", sourceDocument));
    assert.throws(() => freezeGoalContract(db, root, run.id, contractInput({ sourceDocument: { ...sourceDocument, contentRef: "obj_bad" } })));
    freezeGoalContract(db, root, run.id, contractInput({ executionApprovalRequired: true, sourceDocument }));
    assert.deepEqual(getGoalContract(db, run.id).route.sourceDocument, sourceDocument);
    amendGoalContract(db, root, run.id, { reason: "route 부분 변경", approvedByUser: true, route: { lifecycleProfile: "fast" } });
    assert.deepEqual(getGoalContract(db, run.id).route.sourceDocument, sourceDocument);
    assert.deepEqual(JSON.parse(latestArtifact(db, root, run.id, "goal-contract").content).route.sourceDocument, sourceDocument);
    for (const status of ["waived", "stale"]) {
      db.prepare("UPDATE artifacts SET status = ? WHERE id = ?").run(status, prd.id);
      assert.throws(() => amendGoalContract(db, root, run.id, { reason: "무효 원문", approvedByUser: true }));
    }
  } finally { db.close(); }
});
