import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import test from "node:test";
import { advancePhase, fastPathEligibility, isFastPathV2, materializeFastPathPrerequisites, materializeFastPathV2Approval, putArtifact, reopenPhase, startRun } from "../src/core/state.js";
import { freezeGoalContract } from "../src/core/contracts.js";
import { driveController } from "../src/core/controller.js";
import { addTask, claimTask, finishTask, retryTask, sealPlan } from "../src/core/tasks.js";
import { compileTaskPacket } from "../src/core/task-packets.js";
import { acknowledgeScheduleSpawn, claimSchedule } from "../src/core/scheduler.js";
import { lintPlan } from "../src/core/plan-review.js";
import { latestArtifact } from "../src/core/state.js";
import { makeProject, spawnReceipts } from "./helpers.js";
import { readObject, storeObject } from "../src/core/objects.js";
import { sha256, stableStringify } from "../src/core/util.js";

function fastContract(db, root, runId, route = {}) {
  return freezeGoalContract(db, root, runId, {
    objective: "Update the bounded parser",
    scope: ["src/parser.js"],
    nonGoals: ["Unrelated changes"],
    constraints: ["Preserve existing behavior"],
    successCriteria: ["The bounded parser accepts the local case."],
    complexity: "trivial",
    route: {
      lifecycleProfile: "fast",
      researchRequired: false,
      designRequired: false,
      specialistReviewRequired: false,
      documentationRequired: true,
      ...route
    },
    requirements: [{
      id: "REQ-001", title: "Accept the local parser case", description: "Accept the local parser case.",
      kind: "functional", priority: "must", acceptance: ["The local parser case is accepted."]
    }]
  });
}

function materializedFastProject(options = {}) {
  const { root, db, config } = makeProject({
    config: { orchestration: { requirePlanCritic: false }, ...(options.config ?? {}) }
  });
  const started = startRun(db, root, config, "Update the bounded parser", options.start ?? {});
  fastContract(db, root, started.run.id, options.route);
  db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
  const materialized = materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config, {
    ...(options.executionSettings === undefined ? {} : { executionSettings: options.executionSettings })
  });
  return { root, db, config, started, materialized };
}

function receipt(db, task, hostReceipt) {
  db.prepare(`INSERT INTO task_spawn_acks(task_id, attempt_fence, batch_id, owner, host_receipt, acknowledged_at)
    VALUES(?, ?, ?, ?, ?, datetime('now'))`).run(task.id, Number(task.attempt_fence), null, "unit-host", hostReceipt);
}

function completeTask(db, taskId, result) {
  db.prepare("UPDATE tasks SET status = 'completed', result_json = ?, owner = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(result), taskId);
}

test("sealed fast-v1 plans replay with their original five-role graph", () => {
  const fixture = materializedFastProject();
  try {
    const { db, root, config, started } = fixture;
    const prefix = `fast-path-${started.run.id}`;
    const taskSpecs = [
      ["implementation", "worker", "execute", false, []],
      ["integration-review", "reviewer", "review", true, [`${prefix}-implementation`]],
      ["verification", "verifier", "review", true, [`${prefix}-implementation`]],
      ["adversarial-review", "adversarial-reviewer", "verify", true, [`${prefix}-integration-review`, `${prefix}-verification`]],
      ["curation", "curator", "curate", true, [`${prefix}-adversarial-review`]]
    ];
    const taskIds = taskSpecs.map(([suffix]) => `${prefix}-${suffix}`);
    for (const [index, [suffix, role, runPhase, readOnly, dependsOn]] of taskSpecs.entries()) {
      addTask(db, started.run.id, {
        id: taskIds[index], title: `v1 ${role}`, goal: `Replay ${role}`,
        role, taskKind: role === "worker" ? "implementation" : "review", runPhase, wave: 1, readOnly,
        scope: ["src/parser.js"], targetPaths: readOnly ? [] : ["src/parser.js"], requirementIds: ["REQ-001"],
        acceptanceCriteria: ["The local parser case is accepted."], requiredEvidence: ["Current evidence"], dependsOn
      }, config);
      compileTaskPacket(db, root, taskIds[index], config);
    }
    const tasks = taskIds.map((id) => ({ id }));
    const planDraft = { version: 1, source: "bounded-fast-path", plannedTaskIds: taskIds };
    const planContent = { version: 1, source: "bounded-fast-path", planDraft, tasks };
    planContent.planHash = sha256(stableStringify(planContent));
    const planId = `${prefix}-plan`;
    const reviewId = `${prefix}-plan-review`;
    const plan = putArtifact(db, root, started.run.id, "plan", planContent, {
      id: planId, status: "verified", metadata: { source: "bounded-fast-path", immutable: true, planHash: planContent.planHash }
    });
    const packetBindings = taskIds.map((taskId) => {
      const packet = db.prepare("SELECT * FROM task_packets WHERE task_id = ? AND status = 'ready'").get(taskId);
      return { taskId, packetId: packet.id, packetHash: packet.packet_hash, packetBlueprintHash: packet.blueprint_hash,
        blueprintHash: packet.blueprint_hash, compiledBlueprintHash: packet.blueprint_hash, packetRef: packet.packet_ref, version: packet.version };
    });
    packetBindings.sort((left, right) => left.taskId.localeCompare(right.taskId));
    const packetSetHash = sha256(stableStringify(packetBindings));
    putArtifact(db, root, started.run.id, "plan-review", {
      version: 1, source: "bounded-fast-path", deterministic: true, verdict: "APPROVED",
      planArtifactId: plan.id, planContentRef: plan.content_ref, planHash: planContent.planHash,
      packetBindings, packetSetHash, reviewerTaskId: null
    }, { id: reviewId, status: "verified", metadata: { source: "bounded-fast-path", packetBindings, packetSetHash } });
    const replayed = materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config);
    assert.deepEqual(replayed.taskIds, taskIds);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND id LIKE 'fast-path-%' AND role IN ('reviewer','adversarial-reviewer','curator')").get(started.run.id).count, 3);
  } finally {
    fixture.db.close();
  }
});

test("fresh bounded fast materialization is authenticated fast-v2 with exactly worker and verifier tasks", () => {
  const fixture = materializedFastProject();
  try {
    const { db, root, started, materialized } = fixture;
    assert.equal(isFastPathV2(db, root, started.run.id), true);
    assert.equal(materialized.taskIds.length, 2);
    assert.deepEqual(db.prepare("SELECT role FROM tasks WHERE run_id = ? ORDER BY id").all(started.run.id).map((row) => row.role), ["worker", "verifier"]);
    const plan = db.prepare("SELECT metadata_json FROM artifacts WHERE id = ?").get(materialized.artifactIds[3]);
    assert.equal(JSON.parse(plan.metadata_json).fastPathProfileVersion, 2);
    const routing = db.prepare("SELECT requested_effort, effective_effort, effort_source, supported_efforts_json, capability_status FROM tasks WHERE run_id = ? AND id = ?").get(started.run.id, materialized.taskIds[0]);
    assert.ok(routing.requested_effort);
    assert.ok(routing.effective_effort);
    assert.ok(routing.effort_source);
    assert.ok(Array.isArray(JSON.parse(routing.supported_efforts_json)));
    assert.ok(routing.capability_status);
    assert.equal(lintPlan(db, started.run.id, fixture.config, root).verdict, "APPROVED");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND role IN ('reviewer','adversarial-reviewer','curator')").get(started.run.id).n, 0);
  } finally {
    fixture.db.close();
  }
});

test("fast-v2 materialization binds approved model and effort to the canonical two-task plan", () => {
  const fixture = materializedFastProject({
    config: { models: { capabilities: { codex: { models: { "host-confirmed-model": ["low", "medium", "high"] } } } } },
    executionSettings: {
      model: "host-confirmed-model",
      requestedEffort: "high",
      confirmed: true,
      evidence: "사용자가 worker와 verifier 실행 설정을 확인함"
    }
  });
  try {
    const { db, root, started, materialized } = fixture;
    assert.equal(isFastPathV2(db, root, started.run.id), true);
    const plan = JSON.parse(db.prepare("SELECT content_ref FROM artifacts WHERE id = ?").get(materialized.artifactIds[3]).content_ref
      ? readObject(db, root, db.prepare("SELECT content_ref FROM artifacts WHERE id = ?").get(materialized.artifactIds[3]).content_ref)
      : "{}");
    assert.equal(plan.tasks.length, 2);
    assert.equal(plan.executionSettings.mode, "exact");
    assert.equal(plan.executionSettings.entries.length, 2);
    assert.deepEqual(plan.executionSettings.entries.map((entry) => entry.model), ["host-confirmed-model", "host-confirmed-model"]);
    assert.ok(plan.executionSettings.entries.every((entry) => entry.userApproval?.status === "approved"));
    assert.ok(plan.tasks.every((task) => task.model === "host-confirmed-model" && task.requestedEffort === "high"));
    assert.equal(lintPlan(db, started.run.id, fixture.config, root).verdict, "APPROVED");
  } finally {
    fixture.db.close();
  }
});

test("fast-v2 replay rejects a changed approved execution setting instead of ignoring it", () => {
  const fixture = materializedFastProject({
    config: { models: { capabilities: { codex: { models: { "host-confirmed-model": ["low", "medium", "high"] } } } } },
    executionSettings: { model: "host-confirmed-model", requestedEffort: "high", confirmed: true }
  });
  try {
    const { db, root, started, config } = fixture;
    assert.doesNotThrow(() => materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config, {
      executionSettings: { model: "host-confirmed-model", requestedEffort: "high", confirmed: true }
    }));
    assert.throws(() => materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config, {
      executionSettings: { model: "host-confirmed-model", requestedEffort: "medium", confirmed: true }
    }), /FAST_PATH_EXECUTION_SETTINGS_REAPPROVAL|실행 설정이 달라졌습니다/);
    reopenPhase(db, started.run.id, "discover", "사용자가 새 실행 설정을 선택함");
    assert.throws(() => materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config), /FAST_PATH_EXECUTION_SETTINGS_REAPPROVAL|이전 fast plan/);
    const rematerialized = materializeFastPathPrerequisites(db, root, started.run.id, started.controller, config, {
      executionSettings: { model: "host-confirmed-model", requestedEffort: "medium", confirmed: true }
    });
    assert.equal(rematerialized.taskIds.length, 2);
    assert.equal(db.prepare("SELECT requested_effort FROM tasks WHERE id = ?").get(rematerialized.taskIds[0]).requested_effort, "medium");
  } finally {
    fixture.db.close();
  }
});

test("approved fast-v2 settings block direct claim route drift before attempt creation", () => {
  const fixture = materializedFastProject({
    config: { models: { capabilities: { codex: { models: { "host-confirmed-model": ["low", "medium", "high"] } } } } },
    executionSettings: { model: "host-confirmed-model", requestedEffort: "high", confirmed: true }
  });
  try {
    const { db, root, started, materialized, config } = fixture;
    advancePhase(db, root, started.run.id, "execute");
    db.prepare("UPDATE tasks SET selected_model = 'drifted-model' WHERE id = ?").run(materialized.taskIds[0]);
    assert.throws(() => claimTask(db, started.run.id, materialized.taskIds[0], "direct-owner", config), /PLAN_EXECUTION_SETTINGS_DRIFT|approved execution setting/i);
    const task = db.prepare("SELECT status, attempts FROM tasks WHERE id = ?").get(materialized.taskIds[0]);
    assert.equal(task.status, "pending");
    assert.equal(task.attempts, 0);
  } finally {
    fixture.db.close();
  }
});

test("approved fast-v2 settings block retry escalation without changing the failed route", () => {
  const fixture = materializedFastProject({
    config: {
      delegation: { diagnoseBeforeRetry: false },
      models: { capabilities: { codex: { models: { "host-confirmed-model": ["low", "medium", "high", "xhigh"] } } } }
    },
    executionSettings: { model: "host-confirmed-model", requestedEffort: "high", confirmed: true }
  });
  try {
    const { db, root, started, materialized, config } = fixture;
    advancePhase(db, root, started.run.id, "execute");
    db.prepare("UPDATE tasks SET status = 'failed', failure_class = 'reasoning' WHERE id = ?").run(materialized.taskIds[0]);
    assert.throws(() => retryTask(db, started.run.id, materialized.taskIds[0], "Needs stronger reasoning", config, "reasoning"), /PLAN_EXECUTION_SETTINGS_RETRY_ESCALATION|retry escalation/i);
    const task = db.prepare("SELECT status, selected_model, requested_effort, effective_effort FROM tasks WHERE id = ?").get(materialized.taskIds[0]);
    assert.equal(task.status, "failed");
    assert.equal(task.selected_model, "host-confirmed-model");
    assert.equal(task.requested_effort, "high");
    assert.equal(task.effective_effort, "high");
  } finally {
    fixture.db.close();
  }
});

test("fast-v2 combined approval requires distinct real host ACK receipts and rejects stale candidate", () => {
  const fixture = materializedFastProject();
  try {
    const { db, root, config, started, materialized } = fixture;
    const [workerId, verifierId] = materialized.taskIds;
    advancePhase(db, root, started.run.id, "execute");
    const worker = db.prepare("SELECT * FROM tasks WHERE id = ?").get(workerId);
    completeTask(db, workerId, {
      Status: "COMPLETED", Summary: "Worker completed the bounded change.",
      EvidenceRefs: [{ type: "artifact", id: "worker-test-evidence", contentRef: "obj_unit_worker" }],
      AcceptanceResults: [{ criterion: "The local parser case is accepted.", status: "passed" }], Blockers: []
    });
    receipt(db, worker, "host-worker-receipt");
    advancePhase(db, root, started.run.id, "review");
    const candidate = latestArtifact(db, root, started.run.id, "integration-candidate", ["verified"]);
    const verifier = db.prepare("SELECT * FROM tasks WHERE id = ?").get(verifierId);
    putArtifact(db, root, started.run.id, `task-baseline:${verifierId}`, {
      subject: { kind: "integration-candidate", artifactId: candidate.id, contentRef: candidate.content_ref, codeFingerprint: JSON.parse(candidate.content).codeFingerprint }
    }, { taskId: verifierId, status: "verified" });
    completeTask(db, verifierId, {
      Status: "COMPLETED", Summary: "Independent verifier completed the bounded test.",
      EvidenceRefs: [{ type: "artifact", id: candidate.id, contentRef: candidate.content_ref }],
      AcceptanceResults: [{
        criterion: "The local parser case is accepted.",
        status: "passed",
        EvidenceRefs: [{ type: "artifact", id: candidate.id, contentRef: candidate.content_ref }]
      }], Blockers: []
    });
    receipt(db, verifier, "host-worker-receipt");
    assert.throws(() => materializeFastPathV2Approval(db, root, started.run.id, "integration"), /independent verifier receipts|Fast-v2 requires/i);
    db.prepare("UPDATE task_spawn_acks SET host_receipt = ? WHERE task_id = ?").run("host-verifier-receipt", verifierId);
    const approval = materializeFastPathV2Approval(db, root, started.run.id, "integration");
    assert.equal(approval.data.source, "bounded-fast-path-v2");
    assert.equal(approval.data.separateReviewerPerformed, false);
    assert.equal(approval.data.verifierTaskId, verifierId);
    const verifierResult = JSON.parse(db.prepare("SELECT result_json FROM tasks WHERE id = ?").get(verifierId).result_json);
    const verificationCandidate = putArtifact(db, root, started.run.id, "verification-candidate", {
      version: 1,
      codeFingerprint: JSON.parse(candidate.content).codeFingerprint,
      integrationReview: { artifactId: candidate.id, contentRef: candidate.content_ref },
      verifierTasks: [{ id: verifierId, status: "completed", acceptanceResults: verifierResult.AcceptanceResults, evidenceRefs: verifierResult.EvidenceRefs }]
    }, { status: "verified" });
    const completion = materializeFastPathV2Approval(db, root, started.run.id, "completion");
    assert.equal(completion.data.fingerprint.artifactId, verificationCandidate.id);
    db.prepare("UPDATE artifacts SET status = 'stale' WHERE id = ?").run(candidate.id);
    assert.throws(() => materializeFastPathV2Approval(db, root, started.run.id, "integration"), /candidate|Fast-v2 requires|authenticated fast-v2/i);
  } finally {
    fixture.db.close();
  }
});

test("fast-v2 plan-only execution still requires the explicit planned-execution approval", () => {
  const fixture = materializedFastProject({
    start: { planOnly: true },
    route: { executionApprovalRequired: true },
    config: { models: { capabilities: { codex: { models: { "plan-only-model": ["low", "medium", "high"] } } } } },
    executionSettings: { model: "plan-only-model", requestedEffort: "high", confirmed: true }
  });
  try {
    assert.throws(() => advancePhase(fixture.db, fixture.root, fixture.started.run.id, "execute"), /Cannot enter execute|명시적인 run 승인이 필요|approval/i);
  } finally {
    fixture.db.close();
  }
});

test("official controller drive completes fast-v2 through worker and verifier only", () => {
  const fixture = materializedFastProject();
  try {
    const { db, root, config, started, materialized } = fixture;
    const workerId = materialized.taskIds[0];
    const verifierId = materialized.taskIds[1];
    const first = driveController(db, root, started.run.id, started.controller, config);
    assert.equal(first.type, "SPAWN_BATCH");
    assert.equal(db.prepare("SELECT phase FROM runs WHERE id = ?").get(started.run.id).phase, "execute");

    // 테스트용 host receipt이며 실제 native 실행 증거는 아니다.
    const workerSchedule = claimSchedule(db, root, started.run.id, config, {
      owner: "fixture-worker-host", limit: 1, controllerFencingToken: started.controller.fencingToken
    });
    const worker = workerSchedule.batch.find((item) => item.taskId === workerId);
    acknowledgeScheduleSpawn(db, started.run.id, workerSchedule.batchId, [workerId], "fixture-worker-host", config,
      spawnReceipts(workerSchedule.batch, [workerId], "fixture-worker-receipt"));
    mkdirSync(path.join(worker.workspacePath, "src"), { recursive: true });
    writeFileSync(path.join(worker.workspacePath, "src/parser.js"), "export const parser = 'official-fast-v2';\n");
    finishTask(db, root, started.run.id, workerId, worker.leaseToken, {
      Status: "COMPLETED",
      Files: ["src/parser.js"],
      Summary: "Official worker completed the bounded change.",
      EvidenceRefs: ["src/parser.js:1"],
      AcceptanceResults: [{ criterion: "The local parser case is accepted.", status: "passed" }],
      Blockers: []
    }, config);

    const review = driveController(db, root, started.run.id, started.controller, config);
    assert.equal(review.type, "SPAWN_BATCH");
    assert.equal(db.prepare("SELECT phase FROM runs WHERE id = ?").get(started.run.id).phase, "review");
    const verifierSchedule = claimSchedule(db, root, started.run.id, config, {
      owner: "fixture-verifier-host", limit: 1, controllerFencingToken: started.controller.fencingToken
    });
    const verifier = verifierSchedule.batch.find((item) => item.taskId === verifierId);
    acknowledgeScheduleSpawn(db, started.run.id, verifierSchedule.batchId, [verifierId], "fixture-verifier-host", config,
      spawnReceipts(verifierSchedule.batch, [verifierId], "fixture-verifier-receipt"));
    const candidate = latestArtifact(db, root, started.run.id, "integration-candidate", ["verified"]);
    finishTask(db, root, started.run.id, verifierId, verifier.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Official verifier independently verified the immutable candidate.",
      EvidenceRefs: [{ type: "artifact", id: candidate.id, contentRef: candidate.content_ref }],
      AcceptanceResults: [{
        criterion: "The local parser case is accepted.",
        status: "passed",
        EvidenceRefs: [{ type: "artifact", id: candidate.id, contentRef: candidate.content_ref }]
      }],
      Blockers: []
    }, config);

    const action = driveController(db, root, started.run.id, started.controller, config);
    assert.equal(action.type, "COMPLETE");
    assert.equal(db.prepare("SELECT status, phase FROM runs WHERE id = ?").get(started.run.id).status, "completed");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(started.run.id).count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_spawn_acks WHERE task_id = ? AND host_receipt LIKE ?").get(workerId, "fixture-worker-receipt:%").count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_spawn_acks WHERE task_id = ? AND host_receipt LIKE ?").get(verifierId, "fixture-verifier-receipt:%").count, 1);
  } finally {
    fixture.db.close();
  }
});

test("approved fast-v2 settings complete through worker and verifier only", () => {
  const fixture = materializedFastProject({
    config: { models: { capabilities: { codex: { models: { "host-confirmed-model": ["low", "medium", "high"] } } } } },
    executionSettings: {
      model: "host-confirmed-model",
      requestedEffort: "high",
      confirmed: true,
      evidence: "사용자가 worker와 verifier 실행 설정을 확인함"
    }
  });
  try {
    const { db, root, config, started, materialized } = fixture;
    const [workerId, verifierId] = materialized.taskIds;
    const first = driveController(db, root, started.run.id, started.controller, config);
    assert.equal(first.type, "SPAWN_BATCH");
    const workerSchedule = claimSchedule(db, root, started.run.id, config, {
      owner: "approved-worker-host", limit: 1, controllerFencingToken: started.controller.fencingToken
    });
    const worker = workerSchedule.batch.find((item) => item.taskId === workerId);
    acknowledgeScheduleSpawn(db, started.run.id, workerSchedule.batchId, [workerId], "approved-worker-host", config,
      spawnReceipts(workerSchedule.batch, [workerId], "approved-worker-receipt"));
    mkdirSync(path.join(worker.workspacePath, "src"), { recursive: true });
    writeFileSync(path.join(worker.workspacePath, "src/parser.js"), "export const parser = 'approved-fast-v2';\n");
    finishTask(db, root, started.run.id, workerId, worker.leaseToken, {
      Status: "COMPLETED", Files: ["src/parser.js"], Summary: "Approved worker completed the bounded change.",
      EvidenceRefs: ["src/parser.js:1"],
      AcceptanceResults: [{ criterion: "The local parser case is accepted.", status: "passed" }], Blockers: []
    }, config);
    const review = driveController(db, root, started.run.id, started.controller, config);
    assert.equal(review.type, "SPAWN_BATCH");
    const verifierSchedule = claimSchedule(db, root, started.run.id, config, {
      owner: "approved-verifier-host", limit: 1, controllerFencingToken: started.controller.fencingToken
    });
    const verifier = verifierSchedule.batch.find((item) => item.taskId === verifierId);
    acknowledgeScheduleSpawn(db, started.run.id, verifierSchedule.batchId, [verifierId], "approved-verifier-host", config,
      spawnReceipts(verifierSchedule.batch, [verifierId], "approved-verifier-receipt"));
    const candidate = latestArtifact(db, root, started.run.id, "integration-candidate", ["verified"]);
    const observation = spawnSync(process.execPath, ["--input-type=module", "-e",
      "import assert from 'node:assert/strict'; const { parser } = await import('./src/parser.js'); assert.equal(parser, 'approved-fast-v2');"
    ], { cwd: verifier.workspacePath, encoding: "utf8", timeout: 10000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|METIS_CONTROLLER/iu.test(key))) });
    assert.equal(observation.status, 0, "독립 verifier process가 실제 parser 모듈을 실행해야 합니다.");
    finishTask(db, root, started.run.id, verifierId, verifier.leaseToken, {
      Status: "COMPLETED", Files: [], Summary: "Approved verifier independently verified the candidate.",
      EvidenceRefs: [{ type: "artifact", id: candidate.id, contentRef: candidate.content_ref }],
      AcceptanceResults: [{
        criterion: "The local parser case is accepted.",
        status: "passed",
        EvidenceRefs: [{ type: "artifact", id: candidate.id, contentRef: candidate.content_ref }]
      }], Blockers: []
    }, config);
    const action = driveController(db, root, started.run.id, started.controller, config);
    assert.equal(action.type, "COMPLETE");
    assert.equal(db.prepare("SELECT status FROM runs WHERE id = ?").get(started.run.id).status, "completed");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(started.run.id).count, 2);
    assert.equal(db.prepare("SELECT selected_model, requested_effort, effective_effort FROM tasks WHERE run_id = ?").all(started.run.id)
      .every((task) => task.selected_model === "host-confirmed-model" && task.requested_effort === "high" && task.effective_effort === "high"), true);
  } finally {
    fixture.db.close();
  }
});

test("plan sealing rolls back approved route changes when graph validation fails", () => {
  const fixture = materializedFastProject({
    config: { models: { capabilities: { codex: { models: { "host-confirmed-model": ["low", "medium", "high"] } } } } },
    executionSettings: { model: "host-confirmed-model", requestedEffort: "high", confirmed: true }
  });
  try {
    const { db, started, config } = fixture;
    const [workerId, verifierId] = fixture.materialized.taskIds;
    db.prepare("INSERT OR IGNORE INTO task_dependencies(task_id, depends_on) VALUES(?, ?)").run(workerId, verifierId);
    const before = db.prepare(`SELECT id, model_tier, selected_model, model_source, requested_effort,
      effective_effort, effort_source, supported_efforts_json, capability_status, reasoning_effort
      FROM tasks WHERE run_id = ? ORDER BY id`).all(started.run.id);
    assert.throws(() => sealPlan(db, started.run.id, config, {
      executionSettings: { model: "host-confirmed-model", requestedEffort: "high", confirmed: true }
    }), /cycle/i);
    const after = db.prepare(`SELECT id, model_tier, selected_model, model_source, requested_effort,
      effective_effort, effort_source, supported_efforts_json, capability_status, reasoning_effort
      FROM tasks WHERE run_id = ? ORDER BY id`).all(started.run.id);
    assert.deepEqual(after, before);
  } finally {
    fixture.db.close();
  }
});

test("fast-v2 failed verifier blocks controller completion", () => {
  const fixture = materializedFastProject();
  try {
    const { db, root, config, started, materialized } = fixture;
    const [workerId, verifierId] = materialized.taskIds;
    driveController(db, root, started.run.id, started.controller, config);
    const workerSchedule = claimSchedule(db, root, started.run.id, config, {
      owner: "fixture-failed-worker", limit: 1, controllerFencingToken: started.controller.fencingToken
    });
    const worker = workerSchedule.batch.find((item) => item.taskId === workerId);
    acknowledgeScheduleSpawn(db, started.run.id, workerSchedule.batchId, [workerId], "fixture-failed-worker", config,
      spawnReceipts(workerSchedule.batch, [workerId], "fixture-failed-worker-receipt"));
    mkdirSync(path.join(worker.workspacePath, "src"), { recursive: true });
    writeFileSync(path.join(worker.workspacePath, "src/parser.js"), "export const parser = 'failed-verifier';\n");
    finishTask(db, root, started.run.id, workerId, worker.leaseToken, {
      Status: "COMPLETED", Files: ["src/parser.js"], Summary: "Fixture worker completed.", EvidenceRefs: ["src/parser.js:1"],
      AcceptanceResults: [{ criterion: "The local parser case is accepted.", status: "passed" }], Blockers: []
    }, config);
    driveController(db, root, started.run.id, started.controller, config);
    const verifierSchedule = claimSchedule(db, root, started.run.id, config, {
      owner: "fixture-failed-verifier", limit: 1, controllerFencingToken: started.controller.fencingToken
    });
    const verifier = verifierSchedule.batch.find((item) => item.taskId === verifierId);
    acknowledgeScheduleSpawn(db, started.run.id, verifierSchedule.batchId, [verifierId], "fixture-failed-verifier", config,
      spawnReceipts(verifierSchedule.batch, [verifierId], "fixture-failed-verifier-receipt"));
    finishTask(db, root, started.run.id, verifierId, verifier.leaseToken, {
      Status: "FAILED", Files: [], Summary: "Fixture verifier found a failing acceptance case.",
      EvidenceRefs: [], AcceptanceResults: [{ criterion: "The local parser case is accepted.", status: "failed" }],
      Blockers: ["Verifier acceptance failed."], FailureClass: "verification"
    }, config);
    const blocked = driveController(db, root, started.run.id, started.controller, config);
    assert.notEqual(blocked.type, "COMPLETE");
    assert.notEqual(db.prepare("SELECT status FROM runs WHERE id = ?").get(started.run.id).status, "completed");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind = 'completion-review' AND status = 'verified'").get(started.run.id).count, 0);
  } finally {
    fixture.db.close();
  }
});

test("fast-v2 authentication is read-only for task and packet state", () => {
  const fixture = materializedFastProject();
  try {
    const beforeTasks = fixture.db.prepare("SELECT id, status, contract_status, compiled_packet_id, updated_at FROM tasks WHERE run_id = ? ORDER BY id").all(fixture.started.run.id);
    const beforePackets = fixture.db.prepare("SELECT id, task_id, status, version, updated_at FROM task_packets WHERE task_id IN (?, ?) ORDER BY id")
      .all(...fixture.materialized.taskIds);
    assert.equal(isFastPathV2(fixture.db, fixture.root, fixture.started.run.id), true);
    assert.deepEqual(fixture.db.prepare("SELECT id, status, contract_status, compiled_packet_id, updated_at FROM tasks WHERE run_id = ? ORDER BY id").all(fixture.started.run.id), beforeTasks);
    assert.deepEqual(fixture.db.prepare("SELECT id, task_id, status, version, updated_at FROM task_packets WHERE task_id IN (?, ?) ORDER BY id")
      .all(...fixture.materialized.taskIds), beforePackets);
  } finally {
    fixture.db.close();
  }
});

test("fast-v2 authentication rejects incomplete or duplicate packet bindings", () => {
  const fixture = materializedFastProject();
  try {
    const reviewId = fixture.materialized.artifactIds[4];
    const review = fixture.db.prepare("SELECT content_ref, metadata_json FROM artifacts WHERE id = ?").get(reviewId);
    const content = JSON.parse(readObject(fixture.db, fixture.root, review.content_ref));
    const metadata = JSON.parse(review.metadata_json);
    const verifierBinding = content.packetBindings.find((binding) => binding.taskId.endsWith("-verification"));
    const incomplete = [verifierBinding];
    const packetSetHash = sha256(stableStringify(incomplete));
    content.packetBindings = incomplete;
    content.packetSetHash = packetSetHash;
    metadata.packetBindings = incomplete;
    metadata.packetSetHash = packetSetHash;
    const contentRef = storeObject(fixture.db, fixture.root, "artifact:plan-review", JSON.stringify(content));
    fixture.db.prepare("UPDATE artifacts SET content_ref = ?, metadata_json = ? WHERE id = ?")
      .run(contentRef, JSON.stringify(metadata), reviewId);
    assert.equal(isFastPathV2(fixture.db, fixture.root, fixture.started.run.id), false);
    const duplicate = [verifierBinding, verifierBinding];
    const duplicateHash = sha256(stableStringify(duplicate));
    content.packetBindings = duplicate;
    content.packetSetHash = duplicateHash;
    metadata.packetBindings = duplicate;
    metadata.packetSetHash = duplicateHash;
    const duplicateRef = storeObject(fixture.db, fixture.root, "artifact:plan-review", JSON.stringify(content));
    fixture.db.prepare("UPDATE artifacts SET content_ref = ?, metadata_json = ? WHERE id = ?")
      .run(duplicateRef, JSON.stringify(metadata), reviewId);
    assert.equal(isFastPathV2(fixture.db, fixture.root, fixture.started.run.id), false);
  } finally {
    fixture.db.close();
  }
});

test("fast-v2 authentication rejects forged source markers", () => {
  const fixture = materializedFastProject();
  try {
    const planId = fixture.materialized.artifactIds[3];
    const artifact = fixture.db.prepare("SELECT metadata_json FROM artifacts WHERE id = ?").get(planId);
    const metadata = JSON.parse(artifact.metadata_json);
    metadata.source = "bounded-fast-path";
    fixture.db.prepare("UPDATE artifacts SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), planId);
    assert.equal(isFastPathV2(fixture.db, fixture.root, fixture.started.run.id), false);
  } finally {
    fixture.db.close();
  }
});

test("fast-v2 authentication rejects sealed plan content drift", () => {
  const fixture = materializedFastProject();
  try {
    const planId = fixture.materialized.artifactIds[3];
    const plan = fixture.db.prepare("SELECT content_ref FROM artifacts WHERE id = ?").get(planId);
    const content = JSON.parse(readObject(fixture.db, fixture.root, plan.content_ref));
    content.tasks[0].title = "Drifted bounded task";
    const driftedRef = storeObject(fixture.db, fixture.root, "artifact:plan", JSON.stringify(content));
    fixture.db.prepare("UPDATE artifacts SET content_ref = ? WHERE id = ?").run(driftedRef, planId);
    assert.equal(isFastPathV2(fixture.db, fixture.root, fixture.started.run.id), false);
  } finally {
    fixture.db.close();
  }
});
