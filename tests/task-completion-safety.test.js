import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { addTask, claimTask, finishTask, getTask, prepareClaimedTask } from "../src/core/tasks.js";
import { forcePhase, makeProject, startTestRun } from "./helpers.js";
import { advancePhase, putArtifact } from "../src/core/state.js";
import { repositoryCodeFingerprint } from "../src/core/repository.js";
import { reconcileReview } from "../src/core/reviews.js";
import { countTokens } from "../src/core/tokens.js";
import { readObject } from "../src/core/objects.js";
import { codexSpawnDescriptor } from "../src/adapters/spawn-descriptors.js";

function executionTask(id, wave, options = {}) {
  return {
    id,
    title: options.title ?? id,
    goal: options.goal ?? `Complete ${id}`,
    role: options.role ?? "worker",
    taskKind: options.taskKind ?? "implementation",
    runPhase: options.runPhase ?? "execute",
    wave,
    readOnly: options.readOnly ?? false,
    targetPaths: options.targetPaths ?? [`${id}.txt`],
    requirementIds: options.requirementIds ?? ["REQ-001"],
    requiredEvidence: options.requiredEvidence ?? [],
    expectedOutputs: options.expectedOutputs ?? [],
    reviewKind: options.reviewKind,
    dependsOn: options.dependsOn ?? [],
    parentTaskId: options.parentTaskId ?? null
  };
}

function completedResult(extra = {}) {
  return {
    Status: "COMPLETED",
    Files: [],
    Summary: "The task completed with the declared result contract.",
    EvidenceRefs: [],
    Blockers: [],
    ...extra
  };
}

test("child terminal handoff persists exactly once and rejects the stale lease", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Persist a child terminal result");
    forcePhase(db, root, config, run.id, "execute");
    const task = addTask(db, run.id, executionTask("self-finish", 1, { readOnly: true, targetPaths: [] }), config);
    const claim = claimTask(db, run.id, task.id, "child-host", config);
    const descriptor = codexSpawnDescriptor({ ...getTask(db, task.id), role: "worker" }, { content: "bounded" }, {
      leaseToken: claim.leaseToken,
      parentRoot: root
    });
    assert.match(descriptor.message, new RegExp(`cd '${root.replaceAll("'", "'\\\"'\\\"'")}' && \\$METIS --root '${root.replaceAll("'", "'\\\"'\\\"'")}' task finish '${task.id}' --lease '${claim.leaseToken}' --file '.+\\.metis/task-results/terminal-[0-9a-f]{64}\\.json'`));
    assert.throws(() => finishTask(db, root, run.id, task.id, "lease_stale", completedResult(), config),
      (error) => error.code === "LEASE_INVALID");

    // Simulate the child executing the descriptor's durable command. Main does
    // not submit a second finish, so exactly one terminal transition exists.
    const finished = finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult(), config);
    assert.equal(finished.status, "completed");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND type = 'task.finished' AND json_extract(payload_json, '$.taskId') = ?").get(run.id, task.id).count, 1);
    assert.throws(() => finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult(), config),
      (error) => error.code === "TASK_NOT_RUNNING");
  } finally {
    db.close();
  }
});

function subjectReviewFixture(role = "reviewer", kind = "integration-candidate", options = {}) {
  const { root, config, db } = makeProject();
  const { run } = startTestRun(db, root, config, `Require exact ${kind} evidence.`, { contract: options.contract });
  forcePhase(db, root, config, run.id, "plan");
  const content = kind === "integration-candidate"
    ? { codeFingerprint: repositoryCodeFingerprint(db), candidate: true }
    : { candidate: true };
  const candidate = putArtifact(db, root, run.id, kind, content, { status: "verified" });
  const phase = kind === "verification-candidate" ? "verify" : "review";
  const task = addTask(db, run.id, executionTask(`subject-${role}-${kind}`, 1, {
    role,
    runPhase: phase,
    reviewKind: options.reviewKind,
    requirementIds: options.requirementIds,
    readOnly: true,
    targetPaths: [],
    requiredEvidence: [`Current ${kind} artifact`]
  }), config);
  forcePhase(db, root, config, run.id, phase);
  const claim = claimTask(db, run.id, task.id, `${role}-owner`, config);
  return { root, config, db, run, task, claim, candidate };
}

test("subject review completion rejects missing and mismatched artifact evidence", () => {
  for (const evidence of [
    [],
    [{ type: "artifact", id: "wrong-artifact", contentRef: "obj_" + "0".repeat(64) }],
    [{ type: "artifact", id: "wrong-content-ref", contentRef: "obj_" + "1".repeat(64) }]
  ]) {
    const fixture = subjectReviewFixture();
    try {
      const refs = evidence.length === 1 && evidence[0].id === "wrong-content-ref"
        ? [{ type: "artifact", id: fixture.candidate.id, contentRef: evidence[0].contentRef }]
        : evidence;
      assert.throws(
        () => finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken, completedResult({ EvidenceRefs: refs }), fixture.config),
        (error) => error.code === (refs.length === 0 ? "TASK_SUBJECT_EVIDENCE_REQUIRED" : "TASK_SUBJECT_EVIDENCE_MISMATCH")
      );
      assert.equal(getTask(fixture.db, fixture.task.id).status, "running");
    } finally {
      fixture.db.close();
    }
  }
});

test("subject review completion accepts the exact typed artifact reference", () => {
  const fixture = subjectReviewFixture();
  try {
    const finished = finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken,
      completedResult({
        Verdict: "APPROVED",
        Findings: [],
        EvidenceRefs: [{ type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref }]
      }), fixture.config);
    assert.equal(finished.status, "completed");
    assert.deepEqual(finished.result.EvidenceRefs[0], {
      type: "artifact",
      kind: "integration-candidate",
      status: "verified",
      id: fixture.candidate.id,
      contentRef: fixture.candidate.content_ref
    });
    assert.equal(reconcileReview(fixture.db, fixture.root, fixture.run.id, fixture.config, { reviewKind: "integration" }).status, "APPROVED");
  } finally {
    fixture.db.close();
  }
});

test("subject review completion accepts an exact artifact reference after other artifact evidence", () => {
  const fixture = subjectReviewFixture();
  try {
    const unrelated = putArtifact(fixture.db, fixture.root, fixture.run.id, "unrelated-evidence", { note: true }, { status: "verified" });
    const finished = finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken,
      completedResult({
        Verdict: "APPROVED",
        Findings: [],
        EvidenceRefs: [
          { type: "artifact", id: unrelated.id, contentRef: unrelated.content_ref },
          { type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref }
        ]
      }), fixture.config);
    assert.equal(finished.status, "completed");
    assert.equal(finished.result.EvidenceRefs.at(-1).id, fixture.candidate.id);
  } finally {
    fixture.db.close();
  }
});

test("specialist review reconciles against the integration candidate and binds its full fingerprint", () => {
  const fixture = subjectReviewFixture("security-reviewer", "integration-candidate", { reviewKind: "security" });
  try {
    finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken,
      completedResult({
        Verdict: "APPROVED",
        Findings: [],
        EvidenceRefs: [{ type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref }]
      }), fixture.config);
    const result = reconcileReview(fixture.db, fixture.root, fixture.run.id, fixture.config, { reviewKind: "security" });
    assert.equal(result.status, "APPROVED");
    assert.deepEqual(JSON.parse(result.artifact.content).fingerprint, {
      artifactId: fixture.candidate.id,
      contentRef: fixture.candidate.content_ref,
      codeFingerprint: repositoryCodeFingerprint(fixture.db)
    });
  } finally {
    fixture.db.close();
  }
});

test("direct review reconciliation syncs source state and rejects a drifted integration candidate", () => {
  const fixture = subjectReviewFixture();
  try {
    finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken,
      completedResult({
        Verdict: "APPROVED",
        Findings: [],
        EvidenceRefs: [{ type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref }]
      }), fixture.config);
    writeFileSync(`${fixture.root}/source-drift.js`, "export const drifted = true;\n");
    assert.throws(
      () => reconcileReview(fixture.db, fixture.root, fixture.run.id, fixture.config, { reviewKind: "integration" }),
      (error) => error.code === "REVIEW_TASKS_STALE"
    );
    assert.equal(fixture.db.prepare("SELECT status FROM artifacts WHERE id = ?").get(fixture.candidate.id).status, "stale");
  } finally {
    fixture.db.close();
  }
});

test("review reconciliation fails closed when source changes after its initial sync", () => {
  const fixture = subjectReviewFixture();
  try {
    finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken,
      completedResult({
        Verdict: "APPROVED",
        Findings: [],
        EvidenceRefs: [{ type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref }]
      }), fixture.config);
    assert.throws(
      () => reconcileReview(fixture.db, fixture.root, fixture.run.id, fixture.config, {
        reviewKind: "integration",
        beforeCurrentness() {
          writeFileSync(`${fixture.root}/source-mutated-after-sync.js`, "export const changed = true;\n");
        }
      }),
      (error) => error.code === "REVIEW_REPOSITORY_CHANGED"
    );
    assert.equal(fixture.db.prepare("SELECT status FROM artifacts WHERE id = ?").get(fixture.candidate.id).status, "stale");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind = 'integration-review' AND status = 'verified'").get(fixture.run.id).count, 0);
  } finally {
    fixture.db.close();
  }
});

test("invalid adversarial subject evidence cannot complete its wave", () => {
  const fixture = subjectReviewFixture("adversarial-reviewer", "verification-candidate");
  try {
    assert.throws(
      () => finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken, completedResult({
        Verdict: "APPROVED",
        EvidenceRefs: [{ type: "artifact", id: fixture.candidate.id, contentRef: "obj_" + "2".repeat(64) }]
      }), fixture.config),
      (error) => error.code === "TASK_SUBJECT_EVIDENCE_MISMATCH"
    );
    assert.equal(getTask(fixture.db, fixture.task.id).status, "running");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND status = 'completed'").get(fixture.run.id).count, 0);
  } finally {
    fixture.db.close();
  }
});

test("oversized adversarial results retain blocking finding schema at the 700-token budget", () => {
  const fixture = subjectReviewFixture("adversarial-reviewer", "verification-candidate");
  try {
    const subjectEvidence = { type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref };
    const unrelatedEvidence = Array.from({ length: 25 }, (_, index) => {
      const artifact = putArtifact(fixture.db, fixture.root, fixture.run.id, `unrelated-${index}`, { index }, { status: "verified" });
      return { type: "artifact", id: artifact.id, contentRef: artifact.content_ref };
    });
    const evidenceRefs = [...unrelatedEvidence, subjectEvidence, { type: "note", text: "n".repeat(50_000), nested: { note: "nested".repeat(10_000) } }];
    const finished = finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken, {
      Status: "COMPLETED",
      Verdict: "REJECTED",
      Files: [],
      Summary: "s".repeat(8000),
      Decisions: Array.from({ length: 100 }, (_, index) => `decision-${index}-${"x".repeat(200)}`),
      PacketOverlay: { huge: "p".repeat(50_000), nested: { huge: "q".repeat(50_000) } },
      Facts: Array.from({ length: 20 }, (_, index) => ({ id: index, value: "f".repeat(1200), nested: { value: "z".repeat(1200) } })),
      Risks: Array.from({ length: 20 }, (_, index) => ({ id: index, value: "r".repeat(1200) })),
      Sources: Array.from({ length: 20 }, (_, index) => ({ id: index, value: "source".repeat(1200) })),
      AcceptanceResults: ["REQ-001", "REQ-002", "REQ-003"].map((criterion, index) => ({
        Criterion: criterion,
        Status: index === 0 ? "failed" : "verified",
        EvidenceRefs: evidenceRefs,
        Explanation: "e".repeat(5000)
      })),
      Checks: [{ Name: "verification", Status: "failed", EvidenceRefs: evidenceRefs, Output: "o".repeat(5000) }],
      Findings: [{
        Id: "RF-VALUE-001",
        Title: "Value handling is unsafe",
        Description: "d".repeat(5000),
        Severity: "critical",
        RequirementIds: ["REQ-001"],
        TargetPaths: ["src/value.js"],
        EvidenceRefs: evidenceRefs,
        SuggestedFix: "Guard the value conversion."
      }],
      EvidenceRefs: evidenceRefs,
      Blockers: []
    }, fixture.config);

    assert.equal(finished.result.ResultCompacted, true);
    assert.ok(countTokens(fixture.db, JSON.stringify(finished.result), { config: fixture.config }).tokens <= 700);
    assert.equal(finished.result.ResultOverBudget, undefined);
    assert.ok(JSON.stringify(finished.result).length < 10_000);
    assert.deepEqual(finished.result.AcceptanceResults.map((item) => item.Criterion), ["REQ-001", "REQ-002", "REQ-003"]);
    assert.deepEqual(finished.result.AcceptanceResults.map((item) => item.Status), ["failed", "verified", "verified"]);
    for (const outcome of finished.result.AcceptanceResults) {
      assert.equal(outcome.EvidenceRefs[0].id, fixture.candidate.id);
      assert.deepEqual(Object.keys(outcome).sort(), ["Criterion", "EvidenceRefs", "Status"]);
    }
    assert.equal(finished.result.Findings[0].Id, "RF-VALUE-001");
    assert.equal(finished.result.Findings[0].Severity, "critical");
    assert.deepEqual(finished.result.Findings[0].RequirementIds, ["REQ-001"]);
    assert.deepEqual(finished.result.Findings[0].TargetPaths, ["src/value.js"]);
    assert.equal(finished.result.Findings[0].EvidenceRefs[0].id, fixture.candidate.id);
    const review = reconcileReview(fixture.db, fixture.root, fixture.run.id, fixture.config, { reviewKind: "completion" });
    assert.notEqual(review.status, "REPLAN_REQUIRED");
    assert.equal(review.blocking[0].id, "RF-VALUE-001");
    assert.equal(review.blocking[0].severity, "critical");
    assert.deepEqual(review.blocking[0].requirementIds, ["REQ-001"]);
    assert.deepEqual(review.blocking[0].targetPaths, ["src/value.js"]);
    assert.deepEqual(review.blocking[0].evidenceRefs[0], {
      ...subjectEvidence,
      kind: "verification-candidate",
      status: "verified"
    });
  } finally {
    fixture.db.close();
  }
});

test("deeply nested acceptance evidence is bounded before persistence while preserving the required criterion", () => {
  const fixture = subjectReviewFixture("adversarial-reviewer", "verification-candidate");
  try {
    const hostile = { type: "note", text: "n".repeat(100_000) };
    let nested = hostile;
    for (let index = 0; index < 20; index += 1) nested = { child: nested, payload: "p".repeat(20_000) };
    const finished = finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken,
      completedResult({
        Verdict: "APPROVED",
        Findings: [],
        AcceptanceResults: [{
          Criterion: "REQ-001",
          Status: "verified",
          EvidenceRefs: [
            { type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref },
            nested
          ],
          hostileExplanation: nested
        }],
        EvidenceRefs: [{ type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref }]
      }), fixture.config);

    assert.equal(finished.result.ResultOverBudget, undefined);
    assert.equal(finished.result.AcceptanceResults.length, 1);
    assert.deepEqual(finished.result.AcceptanceResults[0].Criterion, "REQ-001");
    assert.equal(finished.result.AcceptanceResults[0].Status, "verified");
    assert.deepEqual(Object.keys(finished.result.AcceptanceResults[0]).sort(), ["Criterion", "EvidenceRefs", "Status"]);
    assert.equal(finished.result.AcceptanceResults[0].EvidenceRefs[0].id, fixture.candidate.id);
    assert.ok(JSON.stringify(finished.result.AcceptanceResults).length < 2_000);
    if (finished.result.StructuredRef) {
      const persisted = readObject(fixture.db, fixture.root, finished.result.StructuredRef);
      assert.ok(persisted.length < 2_000, `bounded acceptance result persisted ${persisted.length} chars`);
    }
  } finally {
    fixture.db.close();
  }
});

test("repeated contract acceptance outcomes are deduplicated without losing the required criterion", () => {
  const fixture = subjectReviewFixture("adversarial-reviewer", "verification-candidate");
  try {
    const subjectRef = { type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref };
    const repeated = Array.from({ length: 100_000 }, (_, index) => ({
      Criterion: "REQ-001",
      Status: "verified",
      EvidenceRefs: index === 99_999 ? [subjectRef] : [{ type: "note", text: `duplicate-${index}` }]
    }));
    const finished = finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken,
      completedResult({
        Verdict: "APPROVED",
        Findings: [],
        AcceptanceResults: repeated,
        EvidenceRefs: [subjectRef]
      }), fixture.config);

    assert.equal(finished.result.ResultOverBudget, undefined);
    assert.equal(finished.result.AcceptanceResults.length, 1);
    assert.equal(finished.result.AcceptanceResults[0].Criterion, "REQ-001");
    assert.equal(finished.result.AcceptanceResults[0].EvidenceRefs[0].id, fixture.candidate.id);
    assert.ok(JSON.stringify(finished.result).length < 10_000);
    if (finished.result.StructuredRef) {
      const persisted = readObject(fixture.db, fixture.root, finished.result.StructuredRef);
      assert.ok(persisted.length < 10_000, `deduplicated acceptance result persisted ${persisted.length} chars`);
    }
  } finally {
    fixture.db.close();
  }
});

test("oversized optional acceptance outcomes are dropped before a completed result can exceed budget", () => {
  const fixture = subjectReviewFixture("adversarial-reviewer", "verification-candidate");
  try {
    const subjectRef = { type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref };
    const optional = Array.from({ length: 100_000 }, (_, index) => ({
      Criterion: `OPTIONAL-${index}`,
      Status: "verified",
      EvidenceRefs: [{ type: "note", text: "x".repeat(1_000) }]
    }));
    const finished = finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken,
      completedResult({
        Verdict: "APPROVED",
        Findings: [],
        AcceptanceResults: optional,
        EvidenceRefs: [subjectRef]
      }), fixture.config);

    assert.equal(finished.result.ResultOverBudget, undefined);
    assert.ok(countTokens(fixture.db, JSON.stringify(finished.result), { config: fixture.config }).tokens <= fixture.config.budgets.workerResultTokens);
    assert.ok(JSON.stringify(finished.result).length < 10_000);
    assert.ok(finished.result.AcceptanceResults.length < 16);
  } finally {
    fixture.db.close();
  }
});

test("long contract criterion identities remain required after bounded display compaction", () => {
  const criterion = `REQ-${"x".repeat(300)}`;
  const fixture = subjectReviewFixture("adversarial-reviewer", "verification-candidate", {
    requirementIds: [criterion],
    contract: {
      requirements: [{
        id: criterion,
        title: "Long criterion",
        description: "A valid long-lived contract criterion.",
        acceptance: ["The required evidence remains present."]
      }]
    }
  });
  try {
    const subjectRef = { type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref };
    const optional = Array.from({ length: 100 }, (_, index) => ({
      Criterion: `OPTIONAL-${index}`,
      Status: "verified",
      EvidenceRefs: [{ type: "note", text: "x".repeat(1_000) }]
    }));
    optional.push({ Criterion: criterion, Status: "verified", EvidenceRefs: [subjectRef] });
    const finished = finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken,
      completedResult({
        Verdict: "APPROVED",
        Findings: [],
        AcceptanceResults: optional,
        EvidenceRefs: [subjectRef]
      }), fixture.config);

    const boundedCriterion = `${criterion.slice(0, 64)}…${criterion.slice(-63)}`;
    assert.equal(finished.result.ResultOverBudget, undefined);
    assert.ok(finished.result.AcceptanceResults.some((item) => item.Criterion === boundedCriterion), JSON.stringify(finished.result.AcceptanceResults));
  } finally {
    fixture.db.close();
  }
});

test("hostile finding identities and nested artifact refs are bounded without corrupting the subject ref", () => {
  const fixture = subjectReviewFixture("adversarial-reviewer", "verification-candidate");
  try {
    const subjectEvidence = { type: "artifact", id: fixture.candidate.id, contentRef: fixture.candidate.content_ref };
    const hostileId = `RF-HOSTILE-${"x".repeat(50_000)}`;
    const hostileEvidence = {
      type: "artifact",
      id: `art-${"y".repeat(50_000)}`,
      contentRef: `obj_${"z".repeat(50_000)}`
    };
    const finished = finishTask(fixture.db, fixture.root, fixture.run.id, fixture.task.id, fixture.claim.leaseToken, {
      Status: "COMPLETED",
      Verdict: "REJECTED",
      Files: [],
      Summary: "Hostile identity bounds.",
      Findings: [{
        Id: hostileId,
        Title: "Ordinary finding title",
        Description: "A bounded finding.",
        Severity: "critical",
        RequirementIds: ["REQ-001"],
        TargetPaths: ["src/value.js"],
        EvidenceRefs: [hostileEvidence]
      }],
      EvidenceRefs: [subjectEvidence],
      Blockers: []
    }, fixture.config);

    const finding = finished.result.Findings[0];
    assert.ok(finding.Id.length <= 128);
    assert.equal(finding.Title, "Ordinary finding title");
    assert.ok(finding.EvidenceRefs[0].id.length <= 128);
    assert.ok(finding.EvidenceRefs[0].contentRef.length <= 128);
    assert.ok(countTokens(fixture.db, JSON.stringify(finished.result), { config: fixture.config }).tokens <= 700);
    assert.equal(finished.result.EvidenceRefs[0].id, fixture.candidate.id);
    assert.equal(finished.result.EvidenceRefs[0].contentRef, fixture.candidate.content_ref);
  } finally {
    fixture.db.close();
  }
});

test("researcher can run in discover only as the fused read-only lane", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Discover the repository safely.");
    forcePhase(db, root, config, run.id, "discover");
    const task = addTask(db, run.id, {
      id: "discover-researcher",
      title: "Research repository context",
      goal: "Read repository context for the fused discover lane.",
      role: "researcher",
      taskKind: "research",
      runPhase: "discover",
      readOnly: true,
      authorityBoundary: "local-read",
      targetPaths: [],
      requirementIds: []
    }, config);

    const claim = claimTask(db, run.id, task.id, "researcher", config);
    assert.equal(claim.task.role, "researcher");
    assert.equal(claim.task.phase, "discover");
    assert.equal(claim.task.readOnly, true);
    assert.equal(claim.task.authority, "local-read");

    assert.throws(() => addTask(db, run.id, {
      id: "discover-researcher-write",
      title: "Write during discover",
      goal: "This must not be admitted to the fused lane.",
      role: "researcher",
      taskKind: "research",
      runPhase: "discover",
      readOnly: false,
      authorityBoundary: "local-write-assigned-paths",
      targetPaths: ["unsafe.txt"]
    }, config), (error) => error.code === "TASK_RESEARCHER_DISCOVER_READ_ONLY");
    assert.throws(() => addTask(db, run.id, {
      id: "discover-researcher-authority",
      title: "Use the wrong read authority",
      goal: "This must remain outside the fused lane contract.",
      role: "researcher",
      taskKind: "research",
      runPhase: "discover",
      readOnly: true,
      authorityBoundary: "local-command",
      targetPaths: []
    }, config), (error) => error.code === "TASK_RESEARCHER_DISCOVER_AUTHORITY");
  } finally {
    db.close();
  }
});

test("direct claims cannot bypass the phase-global earliest open wave", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Execute work in wave order.");
    forcePhase(db, root, config, run.id, "plan");
    const first = addTask(db, run.id, executionTask("wave-one", 1), config);
    const second = addTask(db, run.id, executionTask("wave-two", 2), config);
    forcePhase(db, root, config, run.id, "execute");

    assert.throws(() => prepareClaimedTask(db, run.id, second.id, "wave-two-owner", config),
      (error) => error.code === "TASK_WAVE_NOT_EARLIEST");
    assert.throws(() => claimTask(db, run.id, second.id, "wave-two-owner", config),
      (error) => error.code === "TASK_WAVE_NOT_EARLIEST");
    assert.equal(getTask(db, first.id).status, "pending");
    assert.equal(getTask(db, second.id).status, "pending");

    const firstClaim = claimTask(db, run.id, first.id, "wave-one-owner", config);
    finishTask(db, root, run.id, first.id, firstClaim.leaseToken, completedResult(), config);
    const secondClaim = claimTask(db, run.id, second.id, "wave-two-owner", config);
    assert.equal(secondClaim.task.status, "running");
  } finally {
    db.close();
  }
});

test("a running coordinator does not hold a later wave as a work barrier", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Run delegated work.");
    forcePhase(db, root, config, run.id, "plan");
    const coordinator = addTask(db, run.id, executionTask("running-coordinator", 1, {
      role: "coordinator",
      readOnly: true,
      targetPaths: []
    }), config);
    const child = addTask(db, run.id, executionTask("coordinator-child", 2, {
      parentTaskId: coordinator.id
    }), config);
    forcePhase(db, root, config, run.id, "execute");

    claimTask(db, run.id, coordinator.id, "coordinator-owner", config);
    const childClaim = claimTask(db, run.id, child.id, "child-owner", config);
    assert.equal(childClaim.task.status, "running");
  } finally {
    db.close();
  }
});

test("completed results reject stale normalized evidence", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject stale evidence.");
    forcePhase(db, root, config, run.id, "plan");
    const task = addTask(db, run.id, executionTask("stale-evidence", 1, {
      requiredEvidence: ["an artifact reference"]
    }), config);
    const evidence = putArtifact(db, root, run.id, "stale-evidence-source", { value: "old" }, { status: "stale" });
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, task.id, "stale-owner", config);

    assert.throws(() => finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult({
      EvidenceRefs: [{ type: "artifact", id: evidence.id }]
    }), config), (error) => error.code === "TASK_RESULT_EVIDENCE_STALE");
    assert.equal(getTask(db, task.id).status, "running");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leases WHERE task_id = ?").get(task.id).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind = ?").get(run.id, `task-changes:${task.id}`).count, 0);
  } finally {
    db.close();
  }
});

test("completed results authenticate artifact evidence from the integration root", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Accept current artifact evidence safely.");
    forcePhase(db, root, config, run.id, "plan");
    const task = addTask(db, run.id, executionTask("artifact-evidence", 1, {
      requiredEvidence: ["A current artifact reference"]
    }), config);
    const evidence = putArtifact(db, root, run.id, "artifact-evidence-source", { value: "current" }, { status: "verified" });
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, task.id, "artifact-owner", config);

    const finished = finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult({
      EvidenceRefs: [
        { type: "note", text: "The artifact contains the current result." },
        { type: "artifact", id: evidence.id }
      ]
    }), config);
    assert.equal(finished.status, "completed");
    assert.equal(finished.result.EvidenceRefs[1].id, evidence.id);
  } finally {
    db.close();
  }
});

test("mutable tasks cannot complete with note-only evidence", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject unverifiable completion notes.");
    forcePhase(db, root, config, run.id, "plan");
    const task = addTask(db, run.id, executionTask("note-only-evidence", 1, {
      requiredEvidence: ["A current implementation reference"]
    }), config);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, task.id, "note-only-owner", config);

    assert.throws(() => finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult({
      EvidenceRefs: [{ type: "note", text: "The implementation is complete.", verifiable: false }]
    }), config), (error) => error.code === "RESULT_EVIDENCE_REQUIRED");
    assert.equal(getTask(db, task.id).status, "running");
  } finally {
    db.close();
  }
});

test("completed results reject missing source evidence", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject missing source evidence.");
    forcePhase(db, root, config, run.id, "plan");
    const task = addTask(db, run.id, executionTask("missing-source-evidence", 1, {
      requiredEvidence: ["A current source reference"]
    }), config);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, task.id, "missing-source-owner", config);

    assert.throws(() => finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult({
      EvidenceRefs: [{ type: "source", path: "does-not-exist.js", startLine: 1, endLine: 1 }]
    }), config), (error) => error.code === "TASK_RESULT_EVIDENCE_SOURCE_MISSING");
    assert.equal(getTask(db, task.id).status, "running");
  } finally {
    db.close();
  }
});

test("completed results reject a packet hash changed after claim", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject a changed packet basis.");
    forcePhase(db, root, config, run.id, "plan");
    const task = addTask(db, run.id, executionTask("packet-hash-fence", 1), config);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, task.id, "packet-hash-owner", config);
    db.prepare("UPDATE task_packets SET packet_hash = ? WHERE task_id = ? AND status = 'ready'").run("changed-after-claim", task.id);

    assert.throws(() => finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult(), config),
      (error) => error.code === "TASK_PACKET_BASIS_STALE");
    assert.equal(getTask(db, task.id).status, "running");
    assert.equal(db.prepare("SELECT owner FROM tasks WHERE id = ?").get(task.id).owner, "packet-hash-owner");
  } finally {
    db.close();
  }
});

test("a failed finalization releases the bounded completion reservation", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Release a failed completion reservation.");
    forcePhase(db, root, config, run.id, "plan");
    const task = addTask(db, run.id, executionTask("reservation-release", 1), config);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, task.id, "reservation-owner", config);
    const originalExpiry = db.prepare("SELECT expires_at FROM leases WHERE task_id = ?").get(task.id).expires_at;

    assert.throws(() => finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult({
      Files: ["reservation-release.txt"]
    }), config), (error) => error.code === "TASK_FILES_OVERREPORTED");
    const current = getTask(db, task.id);
    const lease = db.prepare("SELECT owner, expires_at FROM leases WHERE task_id = ?").get(task.id);
    assert.equal(current.status, "running");
    assert.equal(current.owner, "reservation-owner");
    assert.equal(lease.owner, "reservation-owner");
    assert.equal(lease.expires_at, originalExpiry);
  } finally {
    db.close();
  }
});

test("undeclared produced artifacts fail before workspace finalization or DB persistence", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject undeclared outputs atomically.");
    forcePhase(db, root, config, run.id, "plan");
    const task = addTask(db, run.id, executionTask("undeclared-output", 1, {
      expectedOutputs: ["artifact:declared-output"]
    }), config);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, task.id, "output-owner", config);

    assert.throws(() => finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult({
      ProducedArtifacts: [{ Kind: "undeclared-output", Content: { value: "must not persist" } }]
    }), config), (error) => error.code === "TASK_ARTIFACT_UNDECLARED");
    assert.equal(getTask(db, task.id).status, "running");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leases WHERE task_id = ?").get(task.id).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind = ?").get(run.id, "undeclared-output").count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind = ?").get(run.id, `task-changes:${task.id}`).count, 0);
  } finally {
    db.close();
  }
});

test("synthesizer duplicate canonical artifacts fail closed before persistence and phase advance", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject duplicate canonical discovery output.");
    forcePhase(db, root, config, run.id, "discover");
    const task = addTask(db, run.id, executionTask("duplicate-discovery", 1, {
      role: "synthesizer",
      taskKind: "synthesis",
      runPhase: "discover",
      readOnly: true,
      targetPaths: [],
      expectedOutputs: ["artifact:discovery"]
    }), config);
    const claim = claimTask(db, run.id, task.id, "discovery-synthesizer", config);
    const duplicate = completedResult({
      ArtifactKind: "discovery",
      ArtifactContent: { scope: ["src"], knownFacts: ["bounded"], unknowns: [] },
      ProducedArtifacts: [{ Kind: "discovery", Content: { scope: ["src"], knownFacts: ["duplicate"], unknowns: [] } }]
    });
    assert.throws(
      () => finishTask(db, root, run.id, task.id, claim.leaseToken, duplicate, config),
      (error) => error.code === "TASK_ARTIFACT_DUPLICATE"
    );
    assert.equal(getTask(db, task.id).status, "running");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind = 'discovery'").get(run.id).count, 0);
    assert.throws(
      () => advancePhase(db, root, run.id, "research"),
      (error) => error.code === "PHASE_GATE_FAILED"
    );

    finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult({
      ArtifactKind: "discovery",
      ArtifactContent: { scope: ["src"], knownFacts: ["bounded"], unknowns: [] },
      ProducedArtifacts: []
    }), config);
    const advanced = advancePhase(db, root, run.id, "research");
    assert.equal(advanced.run.phase, "research");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind = 'discovery'").get(run.id).count, 1);
  } finally {
    db.close();
  }
});

test("synthesizers may emit distinct declared artifact kinds alongside their canonical artifact", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Allow distinct synthesis outputs.");
    forcePhase(db, root, config, run.id, "discover");
    const task = addTask(db, run.id, executionTask("distinct-synthesis", 1, {
      role: "synthesizer",
      taskKind: "synthesis",
      runPhase: "discover",
      readOnly: true,
      targetPaths: [],
      expectedOutputs: ["artifact:discovery", "artifact:research"]
    }), config);
    const claim = claimTask(db, run.id, task.id, "distinct-synthesizer", config);
    const finished = finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult({
      ArtifactKind: "discovery",
      ArtifactContent: { scope: ["src"], knownFacts: ["bounded"], unknowns: [] },
      ProducedArtifacts: [{ Kind: "research", Content: { sources: ["goal contract"], unknowns: [] } }]
    }), config);
    assert.equal(finished.status, "completed");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ? AND kind IN ('discovery', 'research')").get(run.id).count, 2);
  } finally {
    db.close();
  }
});

test("produced artifacts do not satisfy required evidence unless artifact outputs are declared", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Require declared artifact evidence.");
    forcePhase(db, root, config, run.id, "plan");
    const task = addTask(db, run.id, executionTask("artifact-evidence-contract", 1, {
      requiredEvidence: ["A current artifact reference"]
    }), config);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, task.id, "artifact-contract-owner", config);

    assert.throws(() => finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult({
      ProducedArtifacts: [{ Kind: "not-declared", Content: { value: "must not count" } }]
    }), config), (error) => error.code === "RESULT_EVIDENCE_REQUIRED");
    assert.equal(getTask(db, task.id).status, "running");
  } finally {
    db.close();
  }
});

test("completed results require a current compiled task packet basis", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject stale task packets.");
    forcePhase(db, root, config, run.id, "plan");
    const task = addTask(db, run.id, executionTask("stale-packet", 1), config);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, task.id, "packet-owner", config);
    db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("Changed after dispatch", task.id);

    assert.throws(() => finishTask(db, root, run.id, task.id, claim.leaseToken, completedResult(), config),
      (error) => error.code === "TASK_PACKET_BASIS_STALE");
    assert.equal(getTask(db, task.id).status, "running");
  } finally {
    db.close();
  }
});
