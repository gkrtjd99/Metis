import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureConfig } from "../src/core/config.js";
import { openDatabase } from "../src/core/db.js";
import { syncRepository } from "../src/core/repository.js";
import { latestArtifact, putArtifact, startRun } from "../src/core/state.js";
import { freezeGoalContract } from "../src/core/contracts.js";
import { addTask, claimTask, finishTask, sealPlan } from "../src/core/tasks.js";
import { recordPlanReview } from "../src/core/plan-review.js";
import { currentPlanDraftBinding, plannedGraphFingerprint } from "../src/core/plan-ingest.js";
import { now } from "../src/core/util.js";

export function makeProject(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-test-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fixture",
    type: "module",
    scripts: { test: "node --test" }
  }, null, 2));
  if (options.git !== false) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "package.json"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd: root });
  }
  const testDefaults = {
    orchestration: {
      requirePlanCritic: false,
      requireDesignCritic: false,
      specialistReviews: { enabled: false }
    }
  };
  const overrides = {
    ...testDefaults,
    ...(options.config ?? {}),
    orchestration: {
      ...testDefaults.orchestration,
      ...(options.config?.orchestration ?? {}),
      specialistReviews: {
        ...testDefaults.orchestration.specialistReviews,
        ...(options.config?.orchestration?.specialistReviews ?? {})
      }
    }
  };
  const config = ensureConfig(root, overrides);
  const db = openDatabase(root);
  syncRepository(db, root, config, null);
  return { root, config, db };
}


export function nodeCommand(args, options = {}) {
  return {
    command: process.execPath,
    args: [...args],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
  };
}

export function jsonIo() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; }
  };
}

export function spawnReceipts(batch, taskIds = null, prefix = "host") {
  const selected = new Set(taskIds ?? batch.map((item) => item.taskId));
  return Object.fromEntries(batch
    .filter((item) => selected.has(item.taskId))
    .map((item) => [item.taskId, {
      receipt: `${prefix}:${item.taskId}:${item.attemptFence}`,
      batchId: item.batchId,
      taskId: item.taskId,
      attemptFence: item.attemptFence
    }]));
}

export function freezeTestContract(db, root, runId, options = {}) {
  const run = db.prepare("SELECT goal FROM runs WHERE id = ?").get(runId);
  const requirements = options.requirements ?? [{
    id: "REQ-001",
    title: "Complete the requested change",
    description: "The requested repository change is implemented and verified.",
    kind: "functional",
    priority: "must",
    acceptance: ["The requested behavior exists.", "Verification evidence is current."]
  }];
  return freezeGoalContract(db, root, runId, {
    objective: options.objective ?? run.goal,
    scope: options.scope ?? ["repository"],
    nonGoals: options.nonGoals ?? ["Unrelated changes"],
    constraints: options.constraints ?? ["Preserve unrelated behavior"],
    successCriteria: options.successCriteria ?? ["The requested behavior is implemented and verified."],
    complexity: options.complexity ?? "standard",
    route: {
      ...(options.lifecycleProfile ? { lifecycleProfile: options.lifecycleProfile } : {}),
      ...(options.externalCurrentFact !== undefined ? { externalCurrentFact: options.externalCurrentFact } : {}),
      ...(options.sharedInterfaces ? { sharedInterfaces: options.sharedInterfaces } : {}),
      researchRequired: options.researchRequired ?? false,
      designRequired: options.designRequired ?? false,
      specialistReviewRequired: options.specialistReviewRequired ?? false,
      documentationRequired: options.documentationRequired ?? false
    },
    requirements
  });
}

export function startTestRun(db, root, config, goal, options = {}) {
  const result = startRun(db, root, config, goal, options);
  freezeTestContract(db, root, result.run.id, options.contract ?? {});
  return { ...result, run: { ...result.run, contract_version: 1 } };
}

/** Test-only phase positioning for low-level unit tests. */
export function forcePhase(db, root, config, runId, phase, options = {}) {
  const contract = db.prepare("SELECT id FROM goal_contracts WHERE run_id = ? AND status = 'active'").get(runId);
  if (!contract) freezeTestContract(db, root, runId, options.contract ?? {});
  db.prepare("UPDATE runs SET phase = ?, status = 'active', updated_at = ?, revision = revision + 1 WHERE id = ?")
    .run(phase, now(), runId);
  syncRepository(db, root, config, runId);
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
}

export function bindCurrentPlanDraft(db, root, runId, config, options = {}) {
  const plannerId = options.plannerId ?? `planner_${runId.slice(-8)}`;
  addTask(db, runId, {
    id: plannerId,
    title: "Create the authenticated plan draft",
    goal: "Attest the current materialized plan graph and its parallelism decisions",
    role: "planner",
    taskKind: "planning",
    runPhase: "plan",
    readOnly: true,
    scope: ["current approved design"],
    acceptanceCriteria: ["Return the authenticated PlanDraft"],
    requiredEvidence: [],
    expectedOutputs: ["plan-draft"]
  }, config);
  const claim = claimTask(db, runId, plannerId, plannerId, config);
  finishTask(db, root, runId, plannerId, claim.leaseToken, {
    Status: "COMPLETED",
    Files: [],
    Summary: "Attested the current bounded plan graph.",
    PlanDraft: {
      parallelism: options.parallelism ?? {
        eligible: false,
        minimumSameWaveImplementationTasks: 4,
        independentSlices: 1,
        desiredWidth: 1,
        rationale: "The current test plan has one intentionally coupled implementation boundary."
      },
      verificationParallelism: options.verificationParallelism ?? {
        eligible: false,
        rationale: "The current verifier covers one explicit acceptance boundary.",
        evidenceRefs: ["current test plan graph"]
      }
    },
    EvidenceRefs: [],
    Blockers: []
  }, config);
  const completed = db.prepare("SELECT attempts, attempt_fence FROM tasks WHERE id = ?").get(plannerId);
  const draft = latestArtifact(db, root, runId, `plan-draft:${plannerId}`, ["verified"]);
  const graph = plannedGraphFingerprint(db, runId);
  const receipt = putArtifact(db, root, runId, `plan-draft-ingested:${plannerId}`, {
    version: 1,
    plannerTaskId: plannerId,
    plannerAttempt: Number(completed.attempts),
    plannerAttemptFence: Number(completed.attempt_fence),
    draftArtifactId: draft.id,
    draftContentRef: draft.content_ref,
    plannedGraphFingerprint: graph.hash,
    plannedMilestoneIds: graph.milestoneIds,
    plannedTaskIds: graph.taskIds,
    taskIds: graph.taskIds
  }, {
    taskId: plannerId,
    status: "verified",
    metadata: {
      plannerTaskId: plannerId,
      plannerAttempt: Number(completed.attempts),
      plannerAttemptFence: Number(completed.attempt_fence),
      draftArtifactId: draft.id,
      draftContentRef: draft.content_ref,
      plannedGraphFingerprint: graph.hash
    }
  });
  return { plannerId, draft, receipt, graph, binding: currentPlanDraftBinding(db, root, runId) };
}

export function sealAndApprovePlan(db, root, runId, config, options = {}) {
  const criticId = options.criticId ?? `plan_critic_${runId.slice(-8)}`;
  const existing = db.prepare("SELECT id FROM tasks WHERE id = ?").get(criticId);
  if (!existing) {
    addTask(db, runId, {
      id: criticId,
      title: "Review sealed plan",
      goal: "Independently review the current sealed execution plan",
      role: "plan-critic",
      runPhase: "plan",
      readOnly: true,
      scope: ["current plan artifact"],
      nonGoals: ["Do not implement or edit the plan"],
      constraints: ["Reject missing dependencies, ownership conflicts, or weak verification"],
      targetPaths: [],
      acceptanceCriteria: ["Return an explicit APPROVED or REJECTED verdict"],
      requiredEvidence: ["Current plan artifact reference"],
      dependsOn: []
    }, config);
  }
  // Sealing first assigns any required default milestone. Bind the planner
  // receipt only after that deterministic graph normalization is complete.
  sealPlan(db, runId, config);
  const draft = bindCurrentPlanDraft(db, root, runId, config, options);
  const sealed = sealPlan(db, runId, config);
  const plan = putArtifact(db, root, runId, "plan", sealed.content, {
    status: "verified",
    metadata: {
      planHash: sealed.planHash,
      version: sealed.content.version,
      planDraftArtifactId: draft.binding.draftArtifactId,
      planDraftIngestedArtifactId: draft.binding.receiptArtifactId,
      planDraftContentRef: draft.binding.draftContentRef,
      plannedGraphFingerprint: draft.binding.plannedGraphFingerprint,
      plannerTaskId: draft.binding.plannerTaskId
    }
  });
  const claim = claimTask(db, runId, criticId, "plan-critic", config);
  finishTask(db, root, runId, criticId, claim.leaseToken, {
    Status: "COMPLETED",
    Verdict: "APPROVED",
    Findings: [],
    Files: [],
    Summary: "The plan is bounded, dependency-valid, and verifiable.",
    EvidenceRefs: [{ type: "artifact", id: plan.id, contentRef: plan.content_ref }],
    Blockers: []
  }, config);
  const review = recordPlanReview(db, root, runId, {
    reviewerTaskId: criticId,
    verdict: "APPROVED",
    findings: []
  }, { ...config, orchestration: { ...config.orchestration, requirePlanCritic: true } });
  return { sealed, plan, review, criticId, draft };
}
