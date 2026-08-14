import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { registerCheck, runChecks } from "../src/core/checks.js";
import { freezeGoalContract } from "../src/core/contracts.js";
import { lintDesign, recordDesignReview, sealDesign } from "../src/core/design-review.js";
import { evaluateRun } from "../src/core/evaluation.js";
import { synchronizeKnowledge } from "../src/core/knowledge.js";
import { addMilestone } from "../src/core/milestones.js";
import { recordPlanReview } from "../src/core/plan-review.js";
import { reconcileReview } from "../src/core/reviews.js";
import { buildReport } from "../src/core/report.js";
import { advancePhase, gateReport, latestArtifact, putArtifact, startRun } from "../src/core/state.js";
import { addTask, claimTask, finishTask, sealPlan } from "../src/core/tasks.js";
import { createVerificationCandidate } from "../src/core/verification.js";
import { bindCurrentPlanDraft, makeProject, nodeCommand } from "./helpers.js";

function readOnlyTask(id, title, role, runPhase, extra = {}) {
  return {
    id,
    title,
    goal: extra.goal ?? title,
    role,
    runPhase,
    readOnly: true,
    scope: extra.scope ?? ["repository"],
    nonGoals: [],
    constraints: extra.constraints ?? [],
    targetPaths: [],
    interfaces: [],
    acceptanceCriteria: extra.acceptanceCriteria ?? ["Return current evidence"],
    requiredEvidence: extra.requiredEvidence ?? ["Current evidence reference"],
    requirementIds: extra.requirementIds ?? [],
    dependsOn: extra.dependsOn ?? [],
    milestoneId: extra.milestoneId ?? null,
    reviewKind: extra.reviewKind
  };
}

function finishReadOnly(db, root, runId, taskId, owner, result, config) {
  const claim = claimTask(db, runId, taskId, owner, config);
  return finishTask(db, root, runId, taskId, claim.leaseToken, {
    Status: "COMPLETED",
    Files: [],
    Signatures: [],
    Breaking: [],
    Decisions: [],
    Findings: [],
    Blockers: [],
    ...result
  }, config);
}

test("a managed goal completes the full reviewed lifecycle", () => {
  const { root, db, config } = makeProject({
    config: {
      orchestration: {
        requireDesignCritic: true,
        requirePlanCritic: true,
        specialistReviews: { enabled: false }
      }
    }
  });
  try {
    const { run } = startRun(db, root, config, "Add a greeting module and documentation");
    freezeGoalContract(db, root, run.id, {
      objective: "Add a greeting module and documentation",
      scope: ["src/greet.js", "docs/greet.md"],
      nonGoals: ["Do not change unrelated modules"],
      constraints: ["Keep the API deterministic"],
      successCriteria: ["greet(name) returns a stable greeting", "Current verification passes", "Documentation matches the final source"],
      complexity: "standard",
      route: {
        researchRequired: true,
        designRequired: true,
        specialistReviewRequired: false,
        documentationRequired: true
      },
      requirements: [{
        id: "REQ-GREET",
        title: "Provide a verified greeting API",
        description: "Export greet(name) and document its final behavior.",
        kind: "functional",
        priority: "must",
        acceptance: ["greet(name) returns Hello, name!", "Syntax verification passes", "docs/greet.md documents the API"]
      }]
    });
    advancePhase(db, root, run.id, "discover");

    addTask(db, run.id, readOnlyTask("discover-greet", "Inspect repository conventions", "scout", "discover", {
      scope: ["src", "docs"],
      requiredEvidence: ["Repository paths and source references"]
    }), config);
    finishReadOnly(db, root, run.id, "discover-greet", "scout", {
      Summary: "The repository has no greeting module and uses ES modules.",
      EvidenceRefs: ["package.json:1"]
    }, config);
    putArtifact(db, root, run.id, "discovery", {
      objective: "Add a greeting module and documentation",
      scope: ["src/greet.js", "docs/greet.md"],
      nonGoals: ["Unrelated modules"],
      constraints: ["Use ES modules"],
      knownFacts: ["package.json declares type=module"],
      unknowns: []
    });
    advancePhase(db, root, run.id, "research");

    addTask(db, run.id, readOnlyTask("research-greet", "Check applicable current platform constraints", "researcher", "research", {
      scope: ["Node.js module semantics"],
      requiredEvidence: ["Authoritative source identity and relevance"]
    }), config);
    finishReadOnly(db, root, run.id, "research-greet", "researcher", {
      Summary: "No external library or compatibility layer is required.",
      EvidenceRefs: [
        "package.json:1",
        { type: "note", text: "The implementation uses stable JavaScript module syntax only." }
      ]
    }, config);
    putArtifact(db, root, run.id, "research", {
      questions: ["Is an external dependency required?"],
      sources: [{ id: "node-runtime", authority: "runtime contract", date: "current" }],
      findings: ["No external dependency is required."],
      constraints: ["Use the repository's existing ES module mode."],
      recommendations: ["Implement one small module and one focused check."]
    });
    advancePhase(db, root, run.id, "design");

    addTask(db, run.id, readOnlyTask("design-greet", "Design the greeting module", "designer", "design", {
      scope: ["REQ-GREET", "src/greet.js", "docs/greet.md"]
    }), config);
    finishReadOnly(db, root, run.id, "design-greet", "designer", {
      Summary: "Use one pure function with no dependency and document its exact return format.",
      EvidenceRefs: ["package.json:1"]
    }, config);
    putArtifact(db, root, run.id, "design", {
      requirementIds: ["REQ-GREET"],
      selectedApproach: "One pure ES module function and one matching documentation page.",
      interfaces: ["greet(name: string): string"],
      errorHandling: "The function interpolates the supplied name without hidden I/O.",
      testing: ["Run node --check on src/greet.js", "Verify the exact exported behavior in task evidence"]
    });
    assert.equal(lintDesign(db, root, run.id, config).pass, true);
    const designSeal = sealDesign(db, root, run.id, config);
    addTask(db, run.id, readOnlyTask("critic-design", "Attack the sealed design", "design-critic", "design", {
      scope: ["Current sealed design"],
      acceptanceCriteria: ["Return APPROVED or REJECTED"],
      requiredEvidence: ["Current design-seal artifact"]
    }), config);
    finishReadOnly(db, root, run.id, "critic-design", "design-critic", {
      Verdict: "APPROVED",
      Summary: "The design covers the requirement with the smallest complete solution.",
      EvidenceRefs: [{ type: "artifact", id: designSeal.artifact.id, contentRef: designSeal.artifact.content_ref }]
    }, config);
    assert.equal(recordDesignReview(db, root, run.id, { reviewerTaskId: "critic-design" }, config).review.verdict, "APPROVED");
    advancePhase(db, root, run.id, "plan");

    addMilestone(db, run.id, {
      id: "M-GREET",
      title: "Greeting capability",
      objective: "Implement, review, verify, and document the greeting API.",
      sequence: 1,
      acceptanceCriteria: ["REQ-GREET is implemented and verified"],
      requirementIds: ["REQ-GREET"]
    });
    addTask(db, run.id, {
      id: "implement-greet",
      title: "Implement greeting module",
      goal: "Create src/greet.js",
      role: "worker",
      runPhase: "execute",
      readOnly: false,
      scope: ["src/greet.js"],
      nonGoals: [],
      constraints: ["Do not change unrelated files"],
      targetPaths: ["src/greet.js"],
      interfaces: ["greet(name): string"],
      acceptanceCriteria: ["The module exports greet(name)", "The return value is Hello, name!"],
      requiredEvidence: ["Final source reference", "Task-local syntax result"],
      requirementIds: ["REQ-GREET"],
      dependsOn: [],
      milestoneId: "M-GREET"
    }, config);
    addTask(db, run.id, readOnlyTask("review-greet", "Review integrated greeting code", "reviewer", "review", {
      scope: ["src/greet.js"],
      acceptanceCriteria: ["Review correctness, API shape, error handling, and tests"],
      requiredEvidence: ["Current integrated source"],
      requirementIds: ["REQ-GREET"],
      dependsOn: ["implement-greet"],
      milestoneId: "M-GREET",
      reviewKind: "integration"
    }), config);
    addTask(db, run.id, readOnlyTask("verify-greet", "Verify greeting behavior", "verifier", "review", {
      scope: ["src/greet.js"],
      requirementIds: ["REQ-GREET"],
      dependsOn: ["implement-greet"],
      milestoneId: "M-GREET"
    }), config);
    addTask(db, run.id, readOnlyTask("adversarial-greet", "Challenge the completion candidate", "adversarial-reviewer", "verify", {
      scope: ["Current verification candidate"],
      acceptanceCriteria: ["Identify any remaining credible failure or approve the candidate"],
      requiredEvidence: ["Current verification-candidate artifact"],
      requirementIds: ["REQ-GREET"],
      dependsOn: ["review-greet", "verify-greet"],
      milestoneId: "M-GREET",
      reviewKind: "completion"
    }), config);
    addTask(db, run.id, {
      id: "curate-greet",
      title: "Document greeting API",
      goal: "Create docs/greet.md from final verified behavior",
      role: "curator",
      runPhase: "curate",
      readOnly: false,
      scope: ["docs/greet.md"],
      nonGoals: [],
      constraints: ["Document only verified behavior"],
      targetPaths: ["docs/greet.md"],
      interfaces: [],
      acceptanceCriteria: ["Documentation matches greet(name)"],
      requiredEvidence: ["Final documentation reference"],
      requirementIds: ["REQ-GREET"],
      dependsOn: ["adversarial-greet"],
      milestoneId: "M-GREET"
    }, config);
    addTask(db, run.id, readOnlyTask("critic-plan", "Attack the sealed plan", "plan-critic", "plan", {
      scope: ["Current sealed plan"],
      acceptanceCriteria: ["Return APPROVED or REJECTED"],
      requiredEvidence: ["Current plan artifact"]
    }), config);

    const draft = bindCurrentPlanDraft(db, root, run.id, config);
    const sealedPlan = sealPlan(db, run.id, config);
    const planArtifact = putArtifact(db, root, run.id, "plan", sealedPlan.content, {
      status: "verified",
      metadata: {
        planHash: sealedPlan.planHash,
        version: sealedPlan.content.version,
        planDraftArtifactId: draft.binding.draftArtifactId,
        planDraftIngestedArtifactId: draft.binding.receiptArtifactId,
        planDraftContentRef: draft.binding.draftContentRef,
        plannedGraphFingerprint: draft.binding.plannedGraphFingerprint,
        plannerTaskId: draft.binding.plannerTaskId
      }
    });
    finishReadOnly(db, root, run.id, "critic-plan", "plan-critic", {
      Verdict: "APPROVED",
      Summary: "The DAG covers implementation, independent review, verification, adversarial review, and curation.",
      EvidenceRefs: [{ type: "artifact", id: planArtifact.id, contentRef: planArtifact.content_ref }]
    }, config);
    assert.equal(recordPlanReview(db, root, run.id, { reviewerTaskId: "critic-plan" }, config).verdict, "APPROVED");
    advancePhase(db, root, run.id, "execute");

    const worker = claimTask(db, run.id, "implement-greet", "worker", config);
    mkdirSync(path.join(worker.workspacePath, "src"), { recursive: true });
    writeFileSync(path.join(worker.workspacePath, "src/greet.js"), "export const greet = (name) => `Hello, ${name}!`;\n");
    finishTask(db, root, run.id, "implement-greet", worker.leaseToken, {
      Status: "COMPLETED",
      Files: ["src/greet.js"],
      Signatures: ["greet(name): string"],
      Breaking: [],
      Decisions: [],
      Summary: "Added the pure greeting function.",
      EvidenceRefs: ["src/greet.js:1"],
      Blockers: []
    }, config);
    advancePhase(db, root, run.id, "review");
    const integrationCandidate = latestArtifact(db, root, run.id, "integration-candidate", ["verified"]);

    finishReadOnly(db, root, run.id, "review-greet", "reviewer", {
      Verdict: "APPROVED",
      Summary: "The integrated source is minimal and correct.",
      EvidenceRefs: [
        "src/greet.js:1",
        { type: "artifact", id: integrationCandidate.id, contentRef: integrationCandidate.content_ref }
      ]
    }, config);
    finishReadOnly(db, root, run.id, "verify-greet", "verifier", {
      Summary: "The final module exists and exports greet.",
      EvidenceRefs: [
        "src/greet.js:1",
        { type: "artifact", id: integrationCandidate.id, contentRef: integrationCandidate.content_ref }
      ]
    }, config);
    assert.equal(reconcileReview(db, root, run.id, config, { reviewKind: "integration" }).status, "APPROVED");
    advancePhase(db, root, run.id, "verify");

    registerCheck(db, run.id, {
      name: "syntax",
      command: nodeCommand(["--check", "src/greet.js"]),
      required: true,
      requirementIds: ["REQ-GREET"]
    });
    assert.equal(runChecks(db, root, run.id, config)[0].status, "passed");
    const candidate = createVerificationCandidate(db, root, run.id, config);
    finishReadOnly(db, root, run.id, "adversarial-greet", "adversarial-reviewer", {
      Verdict: "APPROVED",
      Summary: "No uncovered requirement, stale check, or credible residual failure remains.",
      EvidenceRefs: [{ type: "artifact", id: candidate.artifact.id, contentRef: candidate.artifact.content_ref }]
    }, config);
    assert.equal(reconcileReview(db, root, run.id, config, { reviewKind: "completion" }).status, "APPROVED");
    advancePhase(db, root, run.id, "curate");

    const curator = claimTask(db, run.id, "curate-greet", "curator", config);
    mkdirSync(path.join(curator.workspacePath, "docs"), { recursive: true });
    writeFileSync(path.join(curator.workspacePath, "docs/greet.md"), "# Greeting API\n\n`greet(name)` returns `Hello, name!`.\n");
    finishTask(db, root, run.id, "curate-greet", curator.leaseToken, {
      Status: "COMPLETED",
      Files: ["docs/greet.md"],
      Signatures: [],
      Breaking: [],
      Decisions: [],
      Summary: "Documented the final verified API.",
      EvidenceRefs: ["docs/greet.md:1-3"],
      Blockers: []
    }, config);
    assert.equal(synchronizeKnowledge(db, root, run.id, config).clean, true);
    evaluateRun(db, root, run.id, config);

    const completion = gateReport(db, root, run.id, "complete");
    assert.equal(completion.pass, true, JSON.stringify(completion.failures));
    const completed = advancePhase(db, root, run.id, "complete").run;
    assert.equal(completed.status, "completed");
    const report = buildReport(db, run.id);
    assert.equal(report.tasks.completed, 11);
    assert.equal(report.traceability.pass, true);
    assert.equal(report.reviews.blocking.length, 0);
    assert.equal(report.checks[0].status, "passed");
  } finally {
    db.close();
  }
});
