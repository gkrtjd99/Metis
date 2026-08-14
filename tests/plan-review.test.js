import assert from "node:assert/strict";
import test from "node:test";
import { addTask, claimTask, finishTask, sealPlan } from "../src/core/tasks.js";
import { advancePhase, gateReport, latestArtifact, putArtifact, startRun } from "../src/core/state.js";
import { lintPlan, recordPlanReview } from "../src/core/plan-review.js";
import { resultSchemaForRole, ROLE_PROTOCOLS } from "../src/core/prompt-protocols.js";
import { currentPlanDraftBinding, plannedGraphFingerprint } from "../src/core/plan-ingest.js";
import { main } from "../src/cli.js";
import { jsonIo, makeProject, startTestRun, forcePhase } from "./helpers.js";
import { addMilestone } from "../src/core/milestones.js";

function enterPlan(db, root, config) {
  const { run } = startTestRun(db, root, config, "Implement a bounded feature");
  putArtifact(db, root, run.id, "discovery", {
    objective: "Implement a bounded feature",
    scope: ["src/feature.js"],
    nonGoals: [],
    constraints: [],
    successCriteria: ["The feature is tested"],
    knownFacts: [],
    unknowns: [],
    designRequired: false,
    userDecisionRequired: false
  });
  forcePhase(db, root, config, run.id, "plan");
  return run.id;
}

function addExecutionTask(db, runId, config, options = {}) {
  addMilestone(db, runId, {
    id: "m-feature",
    title: "Deliver feature",
    objective: "The bounded feature is implemented and verified.",
    userVisibleOutcome: "The requested feature works.",
    exitCriteria: ["REQ-001 is implemented and verified."],
    requirementIds: ["REQ-001"]
  });
  const worker = addTask(db, runId, {
    id: "worker-feature",
    title: "Implement feature",
    goal: "Implement the feature",
    role: "worker",
    runPhase: "execute",
    milestoneId: "m-feature",
    readOnly: false,
    targetPaths: options.targetPaths ?? ["src/feature.js"],
    scope: options.targetPaths ?? ["src/feature.js"],
    nonGoals: [],
    constraints: [],
    acceptanceCriteria: ["Feature behavior is implemented"],
    requiredEvidence: ["Final source and test output"]
  }, config);
  addTask(db, runId, {
    id: "verify-feature",
    title: "Verify feature",
    goal: "Verify the integrated feature",
    role: "verifier",
    runPhase: "verify",
    milestoneId: "m-feature",
    readOnly: true,
    scope: ["src/feature.js"],
    nonGoals: [],
    constraints: [],
    targetPaths: [],
    acceptanceCriteria: ["Return final-state verification evidence"],
    requiredEvidence: ["Current source or command evidence"],
    verificationModes: options.verificationModes,
    dependsOn: [worker.id]
  }, config);
  return worker;
}

function addCriticTask(db, runId, config) {
  return addTask(db, runId, {
    id: "critic-plan",
    title: "Critique sealed plan",
    goal: "Attack the sealed plan before execution",
    role: "plan-critic",
    runPhase: "plan",
    readOnly: true,
    scope: ["sealed plan"],
    nonGoals: ["Do not repair the plan"],
    constraints: ["Return a binary verdict"],
    acceptanceCriteria: ["Return APPROVED or REJECTED"],
    requiredEvidence: ["Current plan artifact"]
  }, config);
}

function addParallelWorkers(db, runId, config, options = {}) {
  addMilestone(db, runId, {
    id: options.milestoneId ?? "m-parallel",
    title: "Deliver parallel feature",
    objective: "Independent implementation slices are delivered.",
    userVisibleOutcome: "The requested feature works.",
    exitCriteria: ["REQ-001 is implemented and verified."],
    requirementIds: ["REQ-001"]
  });
  const count = options.count ?? 4;
  for (let index = 0; index < count; index += 1) {
    addTask(db, runId, {
      id: `parallel-${index + 1}`,
      title: `Implement slice ${index + 1}`,
      goal: `Implement independent slice ${index + 1}`,
      role: options.role ?? "worker",
      runPhase: "execute",
      wave: options.wave ?? 1,
      milestoneId: options.milestoneId ?? "m-parallel",
      readOnly: options.readOnly ?? false,
      targetPaths: options.targetPaths?.[index] ?? [`src/slice-${index + 1}.js`],
      scope: [`src/slice-${index + 1}.js`],
      acceptanceCriteria: options.acceptanceCriteria?.[index] ?? [`Slice ${index + 1} has independently verifiable behavior.`],
      requiredEvidence: ["Current test evidence"],
      dependsOn: options.dependsOn?.[index] ?? []
    }, config);
  }
}

function addPlannerDraft(db, root, runId, config, content, suffix = "parallelism-test") {
  const planner = addTask(db, runId, {
    id: suffix,
    title: `Plan ${suffix}`,
    goal: "Return a bounded planner draft.",
    role: "planner",
    taskKind: "planning",
    runPhase: "plan",
    readOnly: true,
    scope: ["current approved design"],
    acceptanceCriteria: ["Return a valid PlanDraft."],
    requiredEvidence: [],
    expectedOutputs: ["plan-draft"]
  }, config);
  const claim = claimTask(db, runId, planner.id, planner.id, config);
  finishTask(db, root, runId, planner.id, claim.leaseToken, {
    Status: "COMPLETED",
    Files: [],
    Summary: "Created the current planner draft.",
    PlanDraft: content,
    EvidenceRefs: [],
    Blockers: []
  }, config);
  const completedPlanner = db.prepare("SELECT attempts, attempt_fence FROM tasks WHERE id = ?").get(planner.id);
  const draft = latestArtifact(db, root, runId, `plan-draft:${planner.id}`, ["verified"]);
  const graph = plannedGraphFingerprint(db, runId);
  const receipt = putArtifact(db, root, runId, `plan-draft-ingested:${planner.id}`, {
    version: 1,
    plannerTaskId: planner.id,
    plannerAttempt: Number(completedPlanner.attempts),
    plannerAttemptFence: Number(completedPlanner.attempt_fence),
    draftArtifactId: draft.id,
    draftContentRef: draft.content_ref,
    plannedGraphFingerprint: graph.hash,
    plannedMilestoneIds: graph.milestoneIds,
    plannedTaskIds: graph.taskIds,
    taskIds: graph.taskIds
  }, {
    taskId: planner.id,
    status: "verified",
    metadata: {
      plannerTaskId: planner.id,
      plannerAttempt: Number(completedPlanner.attempts),
      plannerAttemptFence: Number(completedPlanner.attempt_fence),
      draftArtifactId: draft.id,
      draftContentRef: draft.content_ref,
      plannedGraphFingerprint: graph.hash
    }
  });
  return { planner, draft, receipt };
}

function addPlannerDeclaration(db, root, runId, config, parallelism, verificationParallelism = null) {
  return addPlannerDraft(db, root, runId, config, {
    parallelism,
    ...(verificationParallelism ? { verificationParallelism } : {})
  });
}

function addForgedBinding(db, root, runId, plannerTaskId, options = {}) {
  const graph = plannedGraphFingerprint(db, runId);
  const draft = putArtifact(db, root, runId, `plan-draft:${plannerTaskId}`, {
    parallelism: { eligible: false, minimumSameWaveImplementationTasks: 4, rationale: "Forged atomic claim." }
  }, {
    taskId: plannerTaskId,
    status: "verified",
    metadata: { plannerTaskId }
  });
  const plannerAttempt = Number(options.plannerAttempt ?? 1);
  const plannerAttemptFence = Number(options.plannerAttemptFence ?? 1);
  const receipt = putArtifact(db, root, runId, `plan-draft-ingested:${plannerTaskId}`, {
    version: 1,
    plannerTaskId,
    plannerAttempt,
    plannerAttemptFence,
    draftArtifactId: draft.id,
    draftContentRef: draft.content_ref,
    plannedGraphFingerprint: graph.hash,
    plannedMilestoneIds: graph.milestoneIds,
    plannedTaskIds: graph.taskIds,
    taskIds: graph.taskIds
  }, {
    taskId: plannerTaskId,
    status: "verified",
    metadata: {
      plannerTaskId,
      plannerAttempt,
      plannerAttemptFence,
      draftArtifactId: draft.id,
      draftContentRef: draft.content_ref,
      plannedGraphFingerprint: graph.hash
    }
  });
  return { draft, receipt };
}

function seal(db, root, runId, config) {
  const sealed = sealPlan(db, runId, config);
  const binding = currentPlanDraftBinding(db, root, runId);
  return putArtifact(db, root, runId, "plan", sealed.content, {
    status: "verified",
    metadata: {
      planHash: sealed.planHash,
      ...(binding ? {
        planDraftArtifactId: binding.draftArtifactId,
        planDraftIngestedArtifactId: binding.receiptArtifactId,
        planDraftContentRef: binding.draftContentRef,
        plannedGraphFingerprint: binding.plannedGraphFingerprint
      } : {})
    }
  });
}

test("execution requires an independent review of the current sealed plan", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { requirePlanCritic: true } } });
  try {
    const runId = enterPlan(db, root, config);
    addExecutionTask(db, runId, config);
    addTask(db, runId, {
      id: "integration-review",
      title: "Review integration",
      goal: "Independently review the integrated feature",
      role: "reviewer",
      runPhase: "review",
      readOnly: true,
      milestoneId: "m-feature",
      reviewKind: "integration",
      acceptanceCriteria: ["Return an integration verdict"],
      requiredEvidence: ["Current integration evidence"],
      dependsOn: ["worker-feature"]
    }, config);
    addTask(db, runId, {
      id: "adversarial-review",
      title: "Review completion adversarially",
      goal: "Adversarially review the completed feature",
      role: "adversarial-reviewer",
      runPhase: "verify",
      readOnly: true,
      milestoneId: "m-feature",
      reviewKind: "completion",
      acceptanceCriteria: ["Return a completion verdict"],
      requiredEvidence: ["Current verification evidence"],
      dependsOn: ["integration-review", "verify-feature"]
    }, config);
    addCriticTask(db, runId, config);
    addPlannerDeclaration(db, root, runId, config, {
      eligible: false,
      minimumSameWaveImplementationTasks: 4,
      rationale: "The feature has one atomic mutable ownership boundary."
    }, {
      eligible: false,
      rationale: "Return final-state verification evidence is the single verification boundary."
    });
    const plan = seal(db, root, runId, config);

    const before = gateReport(db, root, runId, "execute");
    assert.equal(before.pass, false);
    assert.ok(before.failures.some((item) => /plan review/i.test(item)));

    const claim = claimTask(db, runId, "critic-plan", "critic", config);
    finishTask(db, root, runId, "critic-plan", claim.leaseToken, {
      Status: "COMPLETED",
      Verdict: "APPROVED",
      Findings: [],
      Files: [],
      Summary: "The plan has bounded ownership and final evidence.",
      EvidenceRefs: [{ type: "artifact", id: plan.id, contentRef: plan.content_ref }],
      Blockers: []
    }, config);
    const review = recordPlanReview(db, root, runId, {}, config);
    assert.equal(review.verdict, "APPROVED", JSON.stringify(review.findings));
    assert.equal(review.planArtifactId, plan.id);

    const after = gateReport(db, root, runId, "execute");
    assert.equal(after.pass, true, JSON.stringify(after.failures));
  } finally {
    db.close();
  }
});

test("a blocking critic finding rejects the plan", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { requirePlanCritic: true } } });
  try {
    const runId = enterPlan(db, root, config);
    addExecutionTask(db, runId, config);
    addCriticTask(db, runId, config);
    const plan = seal(db, root, runId, config);
    const claim = claimTask(db, runId, "critic-plan", "critic", config);
    finishTask(db, root, runId, "critic-plan", claim.leaseToken, {
      Status: "COMPLETED",
      Verdict: "REJECTED",
      Findings: [{ Severity: "critical", Claim: "The plan omits required integration verification.", EvidenceRefs: [{ type: "artifact", id: plan.id, contentRef: plan.content_ref }] }],
      Files: [],
      Summary: "The plan is incomplete.",
      EvidenceRefs: [{ type: "artifact", id: plan.id, contentRef: plan.content_ref }],
      Blockers: []
    }, config);
    const review = recordPlanReview(db, root, runId, {}, config);
    assert.equal(review.verdict, "REJECTED");
    const gate = gateReport(db, root, runId, "execute");
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.some((item) => /not approved/i.test(item)));
  } finally {
    db.close();
  }
});


test("a critic result for an older sealed plan cannot approve a replacement plan", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { requirePlanCritic: true } } });
  try {
    const runId = enterPlan(db, root, config);
    addExecutionTask(db, runId, config);
    addCriticTask(db, runId, config);
    const firstPlan = seal(db, root, runId, config);
    const claim = claimTask(db, runId, "critic-plan", "critic", config);
    finishTask(db, root, runId, "critic-plan", claim.leaseToken, {
      Status: "COMPLETED", Verdict: "APPROVED", Findings: [], Files: [],
      Summary: "Reviewed the first plan.", EvidenceRefs: [{ type: "artifact", id: firstPlan.id, contentRef: firstPlan.content_ref }], Blockers: []
    }, config);

    addTask(db, runId, {
      id: "worker-follow-up", title: "Implement follow-up", goal: "Implement follow-up",
      role: "worker", runPhase: "execute", readOnly: false, targetPaths: ["src/follow-up.js"],
      acceptanceCriteria: ["Follow-up exists"], requiredEvidence: ["Final source"]
    }, config);
    const secondPlan = seal(db, root, runId, config);
    assert.notEqual(secondPlan.id, firstPlan.id);
    assert.throws(() => recordPlanReview(db, root, runId, {}, config), /current sealed plan artifact/i);
  } finally {
    db.close();
  }
});

test("a plan critic from another run cannot approve the current run's plan", () => {
  const { root, db, config } = makeProject({ config: { orchestration: { requirePlanCritic: true } } });
  try {
    const runA = enterPlan(db, root, config);
    addExecutionTask(db, runA, config);
    const criticA = addCriticTask(db, runA, config);
    const planA = seal(db, root, runA, config);
    const claimA = claimTask(db, runA, criticA.id, "critic-a", config);

    db.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(runA);
    const runB = enterPlan(db, root, config);
    addMilestone(db, runB, {
      id: "m-feature-b", title: "Deliver feature B", objective: "Deliver feature B",
      userVisibleOutcome: "Feature B works.", exitCriteria: ["REQ-001 is implemented."], requirementIds: ["REQ-001"]
    });
    addTask(db, runB, {
      id: "worker-feature-b", title: "Implement feature B", goal: "Implement feature B", role: "worker",
      runPhase: "execute", milestoneId: "m-feature-b", readOnly: false, targetPaths: ["src/feature-b.js"],
      acceptanceCriteria: ["Feature B works."], requiredEvidence: ["Final source"]
    }, config);
    const planB = seal(db, root, runB, config);
    finishTask(db, root, runA, criticA.id, claimA.leaseToken, {
      Status: "COMPLETED", Verdict: "APPROVED", Findings: [], Files: [],
      Summary: "Reviewed run B's plan.", EvidenceRefs: [{ type: "artifact", id: planA.id, contentRef: planA.content_ref }], Blockers: []
    }, config);

    assert.throws(
      () => recordPlanReview(db, root, runB, { reviewerTaskId: criticA.id }, config),
      /another run/i
    );
  } finally {
    db.close();
  }
});

test("plan lint rejects parallel mutable tasks with overlapping ownership", async () => {
  const { root, db, config } = makeProject({ config: { orchestration: { requirePlanCritic: false } } });
  try {
    const runId = enterPlan(db, root, config);
    addTask(db, runId, {
      id: "overlap-a", title: "Change auth A", goal: "Change auth A", role: "worker",
      targetPaths: ["src/auth"], acceptanceCriteria: ["A done"], requiredEvidence: ["Source"]
    }, config);
    addTask(db, runId, {
      id: "overlap-b", title: "Change auth B", goal: "Change auth B", role: "worker",
      targetPaths: ["src/auth/login.js"], acceptanceCriteria: ["B done"], requiredEvidence: ["Source"]
    }, config);
    const { lintPlan } = await import("../src/core/plan-review.js");
    const result = lintPlan(db, runId);
    assert.equal(result.verdict, "REJECTED");
    assert.ok(result.findings.some((finding) => finding.code === "PARALLEL_OWNERSHIP_OVERLAP"));
  } finally {
    db.close();
  }
});

test("plan lint rejects persisted obsolete review projections", () => {
  const { root, db, config } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Review the full lifecycle", {
      contract: { lifecycleProfile: "full" }
    });
    forcePhase(db, root, config, run.id, "plan");
    addExecutionTask(db, run.id, config);
    const falseRoute = JSON.stringify({
      lifecycleProfile: "full",
      researchRequired: false,
      designRequired: false,
      independentReviewRequired: false,
      adversarialReviewRequired: false
    });
    db.prepare("UPDATE goal_contracts SET route_json = ? WHERE run_id = ? AND status = 'active'").run(falseRoute, run.id);
    db.prepare("UPDATE runs SET route_json = ?, revision = revision + 1 WHERE id = ?").run(falseRoute, run.id);

    assert.throws(
      () => lintPlan(db, run.id, config, root),
      (error) => error.code === "LIFECYCLE_ROUTE_OBSOLETE"
    );
  } finally {
    db.close();
  }
});

test("planner protocol requires conditional four-way same-wave fan-out", () => {
  const protocol = ROLE_PROTOCOLS.planner.join(" ");
  assert.match(protocol, /at least four/i);
  assert.match(protocol, /same earliest execution wave/i);
  assert.match(protocol, /task- and milestone-dependency-independent/i);
  assert.match(protocol, /canonical exclusive targetPaths/i);
  assert.match(protocol, /four or more canonical mutable target paths/i);
  assert.match(protocol, /canonical lower-camel-case interfaces, milestones, and tasks arrays/i);
  for (const field of [
    "interfaces", "milestones", "tasks", "parallelism", "userVisibleOutcome", "exitCriteria",
    "taskKind", "runPhase", "interfaceInputs", "interfaceOutputs", "dependsOn"
  ]) assert.match(protocol, new RegExp(`\\b${field}\\b`));
  assert.ok(protocol.length < 5000, `planner protocol unexpectedly large: ${protocol.length}`);
  assert.match(protocol, /milestone name, description, or wave/i);
  assert.match(protocol, /task kind, outcome, or consumesInterfaceIds/i);
  assert.match(protocol, /taskKind must be one of: discovery, research, synthesis, design, planning, compilation, implementation, integration, diagnosis, repair, review, verification, curation/i);
  assert.match(protocol, /runPhase must be one of: intake, discover, research, design, plan, execute, review, verify, curate, complete/i);
  assert.match(protocol, /reviewer=review/);
  assert.match(protocol, /adversarial-reviewer=review/);
  assert.match(protocol, /planned task phases are role-bound/i);
  assert.match(protocol, /review or verification role in execute/i);
  assert.match(protocol, /atomic or smaller-scope work/i);
  assert.match(protocol, /Always return PlanDraft\.parallelism/i);
  const schema = resultSchemaForRole("planner");
  assert.deepEqual(schema.PlanDraft.parallelism, {
    eligible: false,
    minimumSameWaveImplementationTasks: 4,
    independentSlices: 1,
    desiredWidth: 1,
    rationale: ""
  });
  assert.deepEqual(schema.PlanDraft.interfaces, [{ id: "", name: "", description: "", schema: {}, requirementIds: [] }]);
  assert.deepEqual(schema.PlanDraft.milestones, [{ id: "", title: "", objective: "", userVisibleOutcome: "", exitCriteria: [], requirementIds: [], dependsOn: [] }]);
  assert.deepEqual(schema.PlanDraft.tasks, [{
    id: "", title: "", goal: "", role: "worker", taskKind: "implementation", runPhase: "execute",
    wave: 1, readOnly: false, targetPaths: [], scope: [], acceptanceCriteria: [], requiredEvidence: [],
    expectedOutputs: [], requirementIds: [], dependsOn: [], interfaceInputs: [], interfaceOutputs: []
  }]);
});

test("plan lint rejects an eligible plan below its declared same-wave minimum", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config, { count: 3 });
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      independentSlices: 4,
      desiredWidth: 4,
      rationale: "The approved design exposes four independent slices."
    });
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_MINIMUM_NOT_MET"));
  } finally {
    db.close();
  }
});

test("plan lint accepts four eligible same-wave worker slices", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config, { count: 4 });
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      independentSlices: 4,
      desiredWidth: 4,
      rationale: "The approved design exposes four independent slices."
    });
    const result = lintPlan(db, runId, config, root);
    assert.equal(result.findings.some((finding) => finding.code.startsWith("PARALLELISM_")), false, JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("eligible fan-out rejects same-wave implementation tasks coupled by dependency reachability", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config, {
      dependsOn: [[], ["parallel-1"], ["parallel-2"], ["parallel-3"]]
    });
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      rationale: "Four paths exist, but the implementation order is coupled."
    });
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_DEPENDENCY_COUPLED"), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("eligible fan-out rejects tasks blocked by milestone dependency reachability", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    for (let index = 1; index <= 4; index += 1) {
      addMilestone(db, runId, {
        id: `m-${index}`,
        title: `Milestone ${index}`,
        objective: `Deliver milestone ${index}`,
        userVisibleOutcome: `Milestone ${index} is delivered.`,
        exitCriteria: [`Milestone ${index} is complete.`],
        requirementIds: ["REQ-001"],
        dependsOn: index > 1 ? [`m-${index - 1}`] : []
      });
      addTask(db, runId, {
        id: `milestone-worker-${index}`,
        title: `Implement milestone slice ${index}`,
        goal: `Implement milestone slice ${index}`,
        role: "worker",
        runPhase: "execute",
        wave: 1,
        milestoneId: `m-${index}`,
        readOnly: false,
        targetPaths: [`src/milestone-${index}.js`],
        scope: [`src/milestone-${index}.js`],
        acceptanceCriteria: [`Milestone slice ${index} works.`],
        requiredEvidence: ["Current test evidence"]
      }, config);
    }
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      rationale: "Four slices are placed in one wave but their milestones are sequential."
    });
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_DEPENDENCY_COUPLED"), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("eligible parallel plans require the implementation roles in the earliest wave", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config, { count: 3 });
    addTask(db, runId, {
      id: "parallel-late",
      title: "Implement late slice",
      goal: "Implement a late slice",
      role: "worker",
      runPhase: "execute",
      wave: 2,
      milestoneId: "m-parallel",
      readOnly: false,
      targetPaths: ["src/slice-late.js"],
      scope: ["src/slice-late.js"],
      acceptanceCriteria: ["The late slice is independently verifiable."],
      requiredEvidence: ["Current test evidence"]
    }, config);
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      rationale: "The approved design exposes four independent slices."
    });
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_MINIMUM_NOT_MET"));
  } finally {
    db.close();
  }
});

test("eligible parallel plans do not count non-implementation roles", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config, { count: 3 });
    addTask(db, runId, {
      id: "parallel-review",
      title: "Review the parallel slices",
      goal: "Review the parallel slices",
      role: "reviewer",
      runPhase: "review",
      wave: 1,
      milestoneId: "m-parallel",
      readOnly: true,
      targetPaths: [],
      scope: ["parallel slices"],
      acceptanceCriteria: ["The slices receive an independent review."],
      requiredEvidence: ["Current review evidence"]
    }, config);
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      rationale: "The approved design exposes four independent slices."
    });
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_MINIMUM_NOT_MET"));
  } finally {
    db.close();
  }
});

test("eligible false preserves atomic one-task plans", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addExecutionTask(db, runId, config);
    addPlannerDeclaration(db, root, runId, config, {
      eligible: false,
      minimumSameWaveImplementationTasks: 4,
      rationale: "The approved design is atomic and has one mutable ownership boundary."
    });
    const result = lintPlan(db, runId, config, root);
    assert.equal(result.findings.some((finding) => finding.code.startsWith("PARALLELISM_")), false);
  } finally {
    db.close();
  }
});

test("eligible false rejects four independent non-overlapping implementation slices", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config);
    addPlannerDeclaration(db, root, runId, config, {
      eligible: false,
      minimumSameWaveImplementationTasks: 4,
      rationale: "The planner claims the work is atomic."
    });
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_FALSE_DECOMPOSABLE"), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("eligible false rejects one task bundling four canonical mutable paths", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addExecutionTask(db, runId, config, {
      targetPaths: ["src/a.js", "src/b.js", "src/c.js", "src/d.js"]
    });
    addPlannerDeclaration(db, root, runId, config, {
      eligible: false,
      minimumSameWaveImplementationTasks: 4,
      rationale: "The planner bundles four files into one task."
    });
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_FALSE_BUNDLED_PATHS"), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("eligible false permits one intentionally coupled task with up to three canonical paths", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addExecutionTask(db, runId, config, {
      targetPaths: ["src/schema.js", "src/codec.js", "src/index.js"]
    });
    addPlannerDeclaration(db, root, runId, config, {
      eligible: false,
      minimumSameWaveImplementationTasks: 4,
      rationale: "The schema, codec, and export form one coupled compatibility boundary."
    });
    const result = lintPlan(db, runId, config, root);
    assert.equal(result.findings.some((finding) => finding.code.startsWith("PARALLELISM_FALSE_")), false, JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("a sealed plan without an authenticated planner draft fails closed", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addExecutionTask(db, runId, config);
    seal(db, root, runId, config);
    const result = lintPlan(db, runId, config, root);
    const finding = result.findings.find((item) => item.code === "PARALLELISM_DRAFT_UNBOUND");
    assert.equal(finding?.severity, "critical", JSON.stringify(result.findings));
    assert.match(finding?.claim ?? "", /current sealed plan is not bound to an authenticated ingested planner draft/i);
  } finally {
    db.close();
  }
});

test("a stale planner draft remains unbound", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addExecutionTask(db, runId, config);
    putArtifact(db, root, runId, "plan-draft:stale", { tasks: [] }, { status: "stale" });
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_DRAFT_UNBOUND"), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("current planner drafts fail closed without a declaration or rationale", () => {
  for (const parallelism of [undefined, { eligible: true, minimumSameWaveImplementationTasks: 4, rationale: "" }, { eligible: false, rationale: "   " }]) {
    const { root, db, config } = makeProject();
    try {
      const runId = enterPlan(db, root, config);
      addExecutionTask(db, runId, config);
      addPlannerDraft(db, root, runId, config, parallelism === undefined ? { tasks: [] } : { parallelism });
      const result = lintPlan(db, runId, config, root);
      const expected = parallelism === undefined ? "PARALLELISM_DECLARATION_MISSING" : "PARALLELISM_RATIONALE_MISSING";
      assert.ok(result.findings.some((finding) => finding.code === expected), JSON.stringify(result.findings));
    } finally {
      db.close();
    }
  }
});

test("planner declarations must be bound to the current sealed plan", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config);
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      independentSlices: 4,
      desiredWidth: 4,
      rationale: "Four independent mutable slices are available."
    });
    const sealed = sealPlan(db, runId, config);
    putArtifact(db, root, runId, "plan", sealed.content, {
      status: "verified",
      metadata: { planHash: sealed.planHash }
    });
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_DRAFT_UNBOUND"));
  } finally {
    db.close();
  }
});

test("a detached or newer planner draft cannot override the sealed plan binding", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config);
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      independentSlices: 4,
      desiredWidth: 4,
      rationale: "Four independent mutable slices are available."
    });
    const sealedPlan = seal(db, root, runId, config);
    addPlannerDraft(db, root, runId, config, {
      parallelism: { eligible: false, rationale: "This detached replacement claims atomic work." }
    }, "detached-newer");
    db.prepare("UPDATE artifacts SET status = 'verified' WHERE id = ?").run(sealedPlan.id);
    const result = lintPlan(db, runId, config, root);
    assert.equal(result.findings.some((finding) => finding.code.startsWith("PARALLELISM_")), false, JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("planned graph fingerprint rejects task additions after draft ingestion", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config);
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      rationale: "Four independent mutable slices are available."
    });
    addTask(db, runId, {
      id: "post-ingest-mutation",
      title: "Add detached work",
      goal: "Mutate the planned graph after receipt creation",
      role: "worker",
      runPhase: "execute",
      wave: 2,
      milestoneId: "m-parallel",
      readOnly: false,
      targetPaths: ["src/detached.js"],
      scope: ["src/detached.js"],
      acceptanceCriteria: ["Detached work is complete."],
      requiredEvidence: ["Current evidence"]
    }, config);
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_DRAFT_UNBOUND"
      && /planned graph changed/i.test(finding.claim)), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("sealed plan binding rejects fan-out field mutations in the current graph", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config);
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      rationale: "Four independent mutable slices are available."
    });
    seal(db, root, runId, config);
    db.prepare("UPDATE tasks SET wave = 2 WHERE id = 'parallel-4'").run();
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_DRAFT_UNBOUND"
      && /planned graph changed/i.test(finding.claim)), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("planner binding rejects a ghost planner task", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config);
    addForgedBinding(db, root, runId, "ghost-planner");
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_DRAFT_UNBOUND"
      && /missing or wrong-run/i.test(finding.claim)), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("planner binding rejects a planner task from another run", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config);
    db.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(runId);
    const wrongRunId = enterPlan(db, root, config);
    const { planner } = addPlannerDraft(db, root, wrongRunId, config, {
      parallelism: { eligible: false, minimumSameWaveImplementationTasks: 4, rationale: "Another run's planner draft." }
    }, "wrong-run-planner");
    const attempt = db.prepare("SELECT attempts, attempt_fence FROM tasks WHERE id = ?").get(planner.id);
    addForgedBinding(db, root, runId, planner.id, {
      plannerAttempt: attempt.attempts,
      plannerAttemptFence: attempt.attempt_fence
    });
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_DRAFT_UNBOUND"
      && /missing or wrong-run/i.test(finding.claim)), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("planner binding rejects a completed task with the wrong role", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config);
    const { planner } = addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      rationale: "Four independent mutable slices are available."
    });
    db.prepare("UPDATE tasks SET role = 'researcher' WHERE id = ?").run(planner.id);
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_DRAFT_UNBOUND"
      && /not a planner/i.test(finding.claim)), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("planner binding rejects an incomplete planner task", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config);
    const planner = addTask(db, runId, {
      id: "incomplete-planner",
      title: "Incomplete planner",
      goal: "Return a bounded planner draft.",
      role: "planner",
      taskKind: "planning",
      runPhase: "plan",
      readOnly: true,
      scope: ["current approved design"],
      acceptanceCriteria: ["Return a valid PlanDraft."],
      requiredEvidence: [],
      expectedOutputs: ["plan-draft"]
    }, config);
    addForgedBinding(db, root, runId, planner.id);
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_DRAFT_UNBOUND"
      && /not completed/i.test(finding.claim)), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("planner binding rejects stale attempts and non-current results", () => {
  for (const tamper of ["attempt", "result"]) {
    const { root, db, config } = makeProject();
    try {
      const runId = enterPlan(db, root, config);
      addParallelWorkers(db, runId, config);
      const { planner } = addPlannerDeclaration(db, root, runId, config, {
        eligible: true,
        minimumSameWaveImplementationTasks: 4,
        rationale: "Four independent mutable slices are available."
      });
      if (tamper === "attempt") {
        db.prepare("UPDATE tasks SET attempts = attempts + 1, attempt_fence = attempt_fence + 1 WHERE id = ?").run(planner.id);
      } else {
        db.prepare("UPDATE tasks SET result_json = ? WHERE id = ?")
          .run(JSON.stringify({ Status: "BLOCKED", ProducedArtifactRefs: [] }), planner.id);
      }
      const result = lintPlan(db, runId, config, root);
      const expected = tamper === "attempt" ? /stale planner attempt/i : /current result is not completed/i;
      assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_DRAFT_UNBOUND"
        && expected.test(finding.claim)), JSON.stringify(result.findings));
    } finally {
      db.close();
    }
  }
});

test("eligible plans count only mutable implementation tasks in the overall earliest execute wave", () => {
  for (const earlierCoordinator of [false, true]) {
    const { root, db, config } = makeProject();
    try {
      const runId = enterPlan(db, root, config);
      addParallelWorkers(db, runId, config, { readOnly: !earlierCoordinator, wave: earlierCoordinator ? 2 : 1 });
      if (earlierCoordinator) {
        addTask(db, runId, {
          id: "earliest-coordinator",
          title: "Prepare integration",
          goal: "Prepare integration before workers",
          role: "coordinator",
          runPhase: "execute",
          wave: 1,
          milestoneId: "m-parallel",
          readOnly: true,
          scope: ["integration"],
          acceptanceCriteria: ["Integration preparation is complete."],
          requiredEvidence: ["Current preparation evidence"],
          verificationModes: ["semantic"]
        }, config);
      }
      addPlannerDeclaration(db, root, runId, config, {
        eligible: true,
        minimumSameWaveImplementationTasks: 4,
        rationale: "Four mutable slices are claimed."
      });
      const result = lintPlan(db, runId, config, root);
      assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_IMPLEMENTATION_TASKS_MISSING"), JSON.stringify(result.findings));
    } finally {
      db.close();
    }
  }
});

test("eligible plans reject non-canonical alias paths and duplicated acceptance", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config, {
      targetPaths: [["src/a"], ["src/./a/x"], ["src/b"], ["src/c"]],
      acceptanceCriteria: [["Shared generic result."], [" shared   generic result. "], ["Slice C works."], ["Slice D works."]]
    });
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      rationale: "Four independent mutable slices are claimed."
    });
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "TASK_PATH_NONCANONICAL"), JSON.stringify(result.findings));
    assert.ok(result.findings.some((finding) => finding.code === "PARALLELISM_ACCEPTANCE_DUPLICATED"), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("CLI plan lint loads the bound planner draft through projectRoot", async () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    addParallelWorkers(db, runId, config);
    addPlannerDeclaration(db, root, runId, config, {
      eligible: true,
      minimumSameWaveImplementationTasks: 4,
      independentSlices: 4,
      desiredWidth: 4,
      rationale: "Four independent mutable slices are available."
    });
    const io = jsonIo();
    const code = await main(["plan", "lint", "--root", root, "--run", runId], io);
    assert.equal(code, 0, io.stderrText);
    const result = JSON.parse(io.stdoutText);
    assert.equal(result.findings.some((finding) => finding.code === "PARALLELISM_DRAFT_UNBOUND"), false, JSON.stringify(result.findings));
    assert.equal(result.findings.some((finding) => finding.code.startsWith("PARALLELISM_")), false, JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("verification parallelism requires two independent earliest-wave dimensions", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    const worker = addExecutionTask(db, runId, config, { verificationModes: ["test"] });
    addTask(db, runId, {
      id: "verify-feature-semantic",
      title: "Verify feature semantics",
      goal: "Verify the feature's semantic contract",
      role: "verifier",
      runPhase: "verify",
      wave: 1,
      milestoneId: "m-feature",
      readOnly: true,
      scope: ["semantic feature behavior"],
      acceptanceCriteria: ["The feature preserves its semantic contract."],
      requiredEvidence: ["Current semantic evidence"],
      verificationModes: ["semantic"],
      requirementIds: ["REQ-001"],
      dependsOn: [worker.id]
    }, config);
    addPlannerDraft(db, root, runId, config, {
      parallelism: {
        eligible: false,
        minimumSameWaveImplementationTasks: 4,
        rationale: "One implementation boundary is intentionally coupled."
      },
      verificationParallelism: {
        eligible: true,
        minimumSameWaveVerifierTasks: 2,
        independentSlices: 2,
        desiredWidth: 2,
        rationale: "The approved requirement has separate test and semantic acceptance dimensions."
      }
    }, "verification-parallel");
    const result = lintPlan(db, runId, config, root);
    assert.equal(result.findings.some((finding) => finding.code.startsWith("VERIFICATION_")), false, JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("verification parallelism rejects overlapping modes and dependent dimensions", () => {
  const { root, db, config } = makeProject();
  try {
    const runId = enterPlan(db, root, config);
    const worker = addExecutionTask(db, runId, config, { verificationModes: ["semantic"] });
    addTask(db, runId, {
      id: "verify-feature-overlap",
      title: "Verify feature edge cases",
      goal: "Verify the feature edge cases",
      role: "verifier",
      runPhase: "verify",
      wave: 1,
      milestoneId: "m-feature",
      readOnly: true,
      scope: ["feature edge cases"],
      acceptanceCriteria: ["The feature handles edge cases."],
      requiredEvidence: ["Current semantic evidence"],
      verificationModes: ["semantic"],
      requirementIds: ["REQ-001"],
      dependsOn: ["verify-feature"]
    }, config);
    addPlannerDraft(db, root, runId, config, {
      parallelism: {
        eligible: false,
        minimumSameWaveImplementationTasks: 4,
        rationale: "One implementation boundary is intentionally coupled."
      },
      verificationParallelism: {
        eligible: true,
        minimumSameWaveVerifierTasks: 2,
        rationale: "The design claims independent verification dimensions."
      }
    }, "verification-overlap");
    const result = lintPlan(db, runId, config, root);
    assert.ok(result.findings.some((finding) => finding.code === "VERIFICATION_PARALLELISM_DIMENSIONS_NOT_INDEPENDENT"), JSON.stringify(result.findings));
  } finally {
    db.close();
  }
});

test("a single atomic verifier needs a concrete evidence-based rationale", () => {
  for (const [rationale, shouldReject] of [
    ["The work is atomic and one verifier is enough.", true],
    ["REQ-001 has one semantic acceptance boundary, so the current semantic verifier is the complete evidence source.", false]
  ]) {
    const { root, db, config } = makeProject();
    try {
      const runId = enterPlan(db, root, config);
      addExecutionTask(db, runId, config, { verificationModes: ["semantic"] });
      addPlannerDraft(db, root, runId, config, {
        parallelism: {
          eligible: false,
          minimumSameWaveImplementationTasks: 4,
          rationale: "One implementation boundary is intentionally coupled."
        },
        verificationParallelism: {
          eligible: false,
          rationale
        }
      }, `verification-atomic-${shouldReject}`);
      const result = lintPlan(db, runId, config, root);
      assert.equal(result.findings.some((finding) => finding.code === "VERIFICATION_PARALLELISM_ATOMIC_EVIDENCE_MISSING"), shouldReject, JSON.stringify(result.findings));
    } finally {
      db.close();
    }
  }
});
