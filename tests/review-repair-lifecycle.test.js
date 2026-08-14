import assert from "node:assert/strict";
import test from "node:test";
import { addTask, claimTask, finishTask, getTask } from "../src/core/tasks.js";
import { latestArtifact, pauseRun, putArtifact } from "../src/core/state.js";
import { ingestReviewTask, reconcileReview } from "../src/core/reviews.js";
import { repositoryCodeFingerprint } from "../src/core/repository.js";
import { forcePhase, makeProject, startTestRun } from "./helpers.js";

function reviewTask(id, role, phase, kind) {
  return {
    id,
    title: id,
    goal: id,
    role,
    runPhase: phase,
    reviewKind: kind,
    readOnly: true,
    targetPaths: [],
    scope: ["package.json"],
    requirementIds: ["REQ-001"],
    acceptanceCriteria: ["Return a verdict with current evidence."],
    requiredEvidence: ["Current candidate artifact"],
    dependsOn: []
  };
}

function finishReview(db, root, runId, taskId, candidate, result, config) {
  const claim = claimTask(db, runId, taskId, "reviewer", config);
  return finishTask(db, root, runId, taskId, claim.leaseToken, {
    Status: "COMPLETED",
    Files: [],
    Summary: "Reviewed the current candidate.",
    Blockers: [],
    EvidenceRefs: [{ type: "artifact", id: candidate.id, contentRef: candidate.content_ref }],
    ...result
  }, config);
}

function candidate(db, root, runId, kind) {
  return putArtifact(db, root, runId, kind, {
    candidate: true,
    codeFingerprint: repositoryCodeFingerprint(db)
  }, { status: "verified" });
}

test("a repeated blocking finding after a completed repair gets a new bounded repair task", () => {
  const { root, config, db } = makeProject({
    config: { orchestration: { autoCreateRepairTasks: true } }
  });
  try {
    const { run } = startTestRun(db, root, config, "Repair a repeated review finding");
    forcePhase(db, root, config, run.id, "review");
    const firstCandidate = candidate(db, root, run.id, "integration-candidate");
    addTask(db, run.id, reviewTask("integration-review", "reviewer", "review", "integration"), config);
    finishReview(db, root, run.id, "integration-review", firstCandidate, {
      Verdict: "REJECTED",
      Findings: [{
        Id: "RF-REPEATED",
        Title: "Repeated defect",
        Description: "The same defect remains reproducible.",
        Severity: "error",
        TargetPaths: ["package.json"],
        RequirementIds: ["REQ-001"]
      }]
    }, config);
    const first = reconcileReview(db, root, run.id, config, { reviewKind: "integration" });
    assert.equal(first.status, "FIXES_SCHEDULED");
    assert.equal(first.repairTasks[0].id, "FIX-RF-REPEATED");

    const repairClaim = claimTask(db, run.id, first.repairTasks[0].id, "repairer", config);
    finishTask(db, root, run.id, repairClaim.task.id, repairClaim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Applied the bounded repair.",
      EvidenceRefs: ["package.json:1"],
      Blockers: []
    }, config);
    assert.equal(getTask(db, first.repairTasks[0].id).status, "completed");

    forcePhase(db, root, config, run.id, "review");
    const secondCandidate = candidate(db, root, run.id, "integration-candidate");
    finishReview(db, root, run.id, "integration-review", secondCandidate, {
      Verdict: "REJECTED",
      Findings: [{
        Id: "RF-REPEATED",
        Title: "Repeated defect",
        Description: "The same defect remains reproducible after the repair.",
        Severity: "error",
        TargetPaths: ["package.json"],
        RequirementIds: ["REQ-001"]
      }]
    }, config);
    const second = reconcileReview(db, root, run.id, config, { reviewKind: "integration" });
    assert.equal(second.status, "FIXES_SCHEDULED");
    assert.equal(second.repairTasks[0].id, "FIX-RF-REPEATED-2");
    assert.equal(getTask(db, second.repairTasks[0].id).status, "pending");
    assert.equal(db.prepare("SELECT repair_task_id FROM review_findings WHERE id = ?").get("RF-REPEATED").repair_task_id, "FIX-RF-REPEATED-2");
  } finally {
    db.close();
  }
});

test("a completion repair invalidates the old candidate and requires a fresh adversarial subject", () => {
  const { root, config, db } = makeProject({
    config: { orchestration: { autoCreateRepairTasks: true } }
  });
  try {
    const { run } = startTestRun(db, root, config, "Repair a completion finding");
    forcePhase(db, root, config, run.id, "verify");
    const firstCandidate = candidate(db, root, run.id, "verification-candidate");
    addTask(db, run.id, reviewTask("completion-review", "adversarial-reviewer", "verify", "completion"), config);
    finishReview(db, root, run.id, "completion-review", firstCandidate, {
      Verdict: "REJECTED",
      Findings: [{
        Id: "RF-COMPLETION",
        Title: "Completion defect",
        Description: "The completion candidate still has a blocking defect.",
        Severity: "error",
        TargetPaths: ["package.json"],
        RequirementIds: ["REQ-001"]
      }]
    }, config);
    const first = reconcileReview(db, root, run.id, config, { reviewKind: "completion" });
    assert.equal(first.status, "FIXES_SCHEDULED");
    assert.equal(latestArtifact(db, root, run.id, "verification-candidate"), null);

    const repairClaim = claimTask(db, run.id, first.repairTasks[0].id, "repairer", config);
    finishTask(db, root, run.id, repairClaim.task.id, repairClaim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Summary: "Applied the bounded completion repair.",
      EvidenceRefs: ["package.json:1"],
      Blockers: []
    }, config);
    assert.throws(
      () => reconcileReview(db, root, run.id, config, { reviewKind: "completion" }),
      (error) => error.code === "REVIEW_CANDIDATE_REQUIRED"
    );

    forcePhase(db, root, config, run.id, "verify");
    const secondCandidate = candidate(db, root, run.id, "verification-candidate");
    finishReview(db, root, run.id, "completion-review", secondCandidate, {
      Verdict: "APPROVED",
      Findings: []
    }, config);
    const second = reconcileReview(db, root, run.id, config, { reviewKind: "completion" });
    assert.equal(second.status, "APPROVED");
    assert.equal(JSON.parse(second.artifact.content).fingerprint.artifactId, secondCandidate.id);
    assert.equal(db.prepare("SELECT status FROM review_findings WHERE id = ?").get("RF-COMPLETION").status, "resolved");
  } finally {
    db.close();
  }
});

test("review finding IDs cannot cross run boundaries, while same-run replay remains idempotent", () => {
  const { root, config, db } = makeProject({
    config: { orchestration: { autoCreateRepairTasks: true } }
  });
  try {
    const firstRun = startTestRun(db, root, config, "First run owns the finding").run;
    forcePhase(db, root, config, firstRun.id, "review");
    const firstCandidate = candidate(db, root, firstRun.id, "integration-candidate");
    addTask(db, firstRun.id, reviewTask("integration-review-first", "reviewer", "review", "integration"), config);
    finishReview(db, root, firstRun.id, "integration-review-first", firstCandidate, {
      Verdict: "REJECTED",
      Findings: [{
        Id: "RF-CROSS-RUN",
        Title: "Owned finding",
        Description: "The first run owns this finding identity.",
        Severity: "error",
        TargetPaths: ["package.json"],
        RequirementIds: ["REQ-001"]
      }]
    }, config);
    assert.doesNotThrow(() => ingestReviewTask(db, root, firstRun.id, "integration-review-first"));
    const first = db.prepare("SELECT run_id, title FROM review_findings WHERE id = ?").get("RF-CROSS-RUN");
    pauseRun(db, firstRun.id, "Pause before testing cross-run finding identity isolation.");

    const secondRun = startTestRun(db, root, config, "Second run cannot claim the finding").run;
    forcePhase(db, root, config, secondRun.id, "review");
    const secondCandidate = candidate(db, root, secondRun.id, "integration-candidate");
    addTask(db, secondRun.id, reviewTask("integration-review-second", "reviewer", "review", "integration"), config);
    finishReview(db, root, secondRun.id, "integration-review-second", secondCandidate, {
      Verdict: "REJECTED",
      Findings: [{
        Id: "RF-CROSS-RUN",
        Title: "Foreign overwrite",
        Description: "This must not overwrite the first run.",
        Severity: "critical",
        TargetPaths: ["package.json"],
        RequirementIds: ["REQ-001"]
      }]
    }, config);
    assert.throws(
      () => reconcileReview(db, root, secondRun.id, config, { reviewKind: "integration" }),
      (error) => error.code === "REVIEW_FINDING_ID_COLLISION"
    );
    assert.deepEqual(db.prepare("SELECT run_id, title FROM review_findings WHERE id = ?").get("RF-CROSS-RUN"), first);
  } finally {
    db.close();
  }
});

test("duplicate finding IDs in one result fail closed before a critical tail can be erased", () => {
  const { root, config, db } = makeProject({
    config: { orchestration: { autoCreateRepairTasks: true } }
  });
  try {
    const { run } = startTestRun(db, root, config, "Reject duplicate finding identities");
    forcePhase(db, root, config, run.id, "review");
    const integrationCandidate = candidate(db, root, run.id, "integration-candidate");
    addTask(db, run.id, reviewTask("integration-review-duplicate", "reviewer", "review", "integration"), config);
    finishReview(db, root, run.id, "integration-review-duplicate", integrationCandidate, {
      Verdict: "REJECTED",
      Findings: [
        {
          Id: "RF-DUPLICATE",
          Title: "Benign duplicate",
          Description: "A warning appears first.",
          Severity: "warning",
          TargetPaths: ["package.json"],
          RequirementIds: ["REQ-001"]
        },
        {
          Id: "RF-DUPLICATE",
          Title: "Critical duplicate",
          Description: "A critical duplicate must not be lost.",
          Severity: "critical",
          TargetPaths: ["package.json"],
          RequirementIds: ["REQ-001"]
        }
      ]
    }, config);
    assert.throws(
      () => reconcileReview(db, root, run.id, config, { reviewKind: "integration" }),
      (error) => error.code === "REVIEW_FINDING_DUPLICATE_ID"
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM review_findings WHERE run_id = ?").get(run.id).count, 0);
  } finally {
    db.close();
  }
});

test("path-like finding IDs fail before a repair task or external worktree path can be created", () => {
  const { root, config, db } = makeProject({
    config: { orchestration: { autoCreateRepairTasks: true } }
  });
  try {
    const { run } = startTestRun(db, root, config, "Reject path-like finding identities");
    forcePhase(db, root, config, run.id, "review");
    const integrationCandidate = candidate(db, root, run.id, "integration-candidate");
    addTask(db, run.id, reviewTask("integration-review-path-id", "reviewer", "review", "integration"), config);
    finishReview(db, root, run.id, "integration-review-path-id", integrationCandidate, {
      Verdict: "REJECTED",
      Findings: [{
        Id: "../../../../../../tmp/pwn",
        Title: "Path-like identity",
        Description: "This identity must never become part of a task or worktree path.",
        Severity: "critical",
        TargetPaths: ["package.json"],
        RequirementIds: ["REQ-001"]
      }]
    }, config);
    const taskCount = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id).count;
    assert.throws(
      () => reconcileReview(db, root, run.id, config, { reviewKind: "integration" }),
      (error) => error.code === "REVIEW_FINDING_ID_INVALID"
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?").get(run.id).count, taskCount);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM review_findings WHERE run_id = ?").get(run.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id LIKE '%tmp%' OR id LIKE '%pwn%'").get().count, 0);
  } finally {
    db.close();
  }
});
