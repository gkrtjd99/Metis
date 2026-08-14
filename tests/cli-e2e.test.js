import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { jsonIo, makeProject } from "./helpers.js";

let activeController = null;

function controllerFlags() {
  if (!activeController) return [];
  return [
    "--controller-session", activeController.sessionId,
    "--controller-owner", activeController.owner,
    "--controller-token", activeController.token,
    "--controller-fence", String(activeController.fencingToken)
  ];
}

async function runCli(root, args) {
  const io = jsonIo();
  const code = await main([...args, ...controllerFlags(), "--root", root, "--pretty"], io);
  const text = io.stdoutText.trim() || io.stderrText.trim();
  let value = null;
  if (text) value = JSON.parse(text);
  assert.equal(code, 0, JSON.stringify(value));
  return value;
}

function task(id, role, phase, extra = {}) {
  const taskKinds = {
    worker: "implementation",
    reviewer: "review",
    verifier: "verification",
    "adversarial-reviewer": "review",
    curator: "curation"
  };
  return {
    id,
    title: extra.title ?? id,
    goal: extra.goal ?? id,
    role,
    taskKind: extra.taskKind ?? taskKinds[role],
    runPhase: phase,
    wave: extra.wave ?? 1,
    readOnly: extra.readOnly ?? true,
    scope: extra.scope ?? ["src/value.js"],
    nonGoals: [],
    constraints: [],
    targetPaths: extra.targetPaths ?? [],
    interfaces: [],
    acceptanceCriteria: extra.acceptanceCriteria ?? ["Return a terminal result"],
    requiredEvidence: extra.requiredEvidence ?? ["Current repository evidence"],
    expectedOutputs: extra.expectedOutputs ?? [taskKinds[role]],
    requirementIds: ["REQ-VALUE"],
    dependsOn: extra.dependsOn ?? [],
    interfaceInputs: [],
    interfaceOutputs: [],
    verificationModes: extra.verificationModes ?? [],
    milestoneId: "M-VALUE",
    reviewKind: extra.reviewKind
  };
}

test("CLI completes an explicitly routed managed lifecycle and cleanup preview", async () => {
  const { root, db } = makeProject({
    config: {
      orchestration: {
        requireDesignCritic: false,
        requirePlanCritic: false,
        specialistReviews: { enabled: false }
      }
    }
  });
  db.close();

  await runCli(root, ["init", "--host", "codex"]);
  const started = await runCli(root, ["start", "Create a verified value module"]);
  activeController = started.controller;
  const runId = started.run.id;
  assert.match(started.context.content, /METIS_MANAGED_V5/);
  assert.match(started.context.content, /\/goal \$metis/);

  await runCli(root, [
    "contract", "freeze", "--data",
    JSON.stringify({
      objective: "Create a verified value module",
      scope: ["src/value.js", "docs/value.md"],
      nonGoals: ["Unrelated changes"],
      constraints: ["Use the existing ES module setup"],
      successCriteria: ["src/value.js exports value", "syntax check passes", "documentation is current"],
      complexity: "trivial",
      route: {
        lifecycleProfile: "fast",
        researchRequired: false,
        designRequired: false,
        specialistReviewRequired: false,
        documentationRequired: true
      },
      requirements: [{
        id: "REQ-VALUE",
        title: "Provide a verified value export",
        description: "Export value and document it.",
        kind: "functional",
        priority: "must",
        acceptance: ["src/value.js exports value", "syntax check passes", "docs/value.md is current"]
      }]
    })
  ]);
  await runCli(root, ["advance", "discover"]);
  await runCli(root, [
    "artifact", "put", "discovery", "--data",
    JSON.stringify({
      objective: "Create a verified value module",
      scope: ["src/value.js", "docs/value.md"],
      nonGoals: [],
      constraints: ["Use ES modules"],
      knownFacts: ["package.json declares type=module"],
      unknowns: []
    })
  ]);
  await runCli(root, ["advance", "research"]);
  await runCli(root, ["artifact", "waive", "research", "No current external dependency is involved."]);
  await runCli(root, ["advance", "design"]);
  await runCli(root, ["artifact", "waive", "design", "The Goal Contract defines a trivial one-file change."]);
  await runCli(root, ["advance", "plan"]);

  const plannedTasks = [
    task("T-VALUE", "worker", "execute", {
      readOnly: false,
      targetPaths: ["src/value.js"],
      acceptanceCriteria: ["src/value.js exports value"],
      requiredEvidence: ["Final source reference"],
      verificationModes: ["semantic"]
    }),
    task("T-REVIEW", "reviewer", "review", {
      dependsOn: ["T-VALUE"],
      reviewKind: "integration",
      acceptanceCriteria: ["Independently approve or reject the integration candidate"],
      requiredEvidence: ["Current integration-candidate artifact"]
    }),
    task("T-VERIFY", "verifier", "verify", {
      dependsOn: ["T-VALUE"],
      acceptanceCriteria: ["Verify the current export"],
      requiredEvidence: ["Current source and check evidence"],
      verificationModes: ["semantic"]
    }),
    task("T-ADVERSARIAL", "adversarial-reviewer", "verify", {
      dependsOn: ["T-REVIEW", "T-VERIFY"],
      reviewKind: "completion",
      acceptanceCriteria: ["Adversarially approve or reject the verification candidate"],
      requiredEvidence: ["Current verification-candidate artifact"]
    }),
    task("T-CURATE", "curator", "curate", {
      readOnly: false,
      targetPaths: ["docs/value.md"],
      dependsOn: ["T-ADVERSARIAL"],
      acceptanceCriteria: ["Documentation matches the final export"],
      requiredEvidence: ["Final documentation reference"]
    })
  ];
  await runCli(root, [
    "task", "add", "--data",
    JSON.stringify({
      id: "T-PLANNER",
      title: "Plan the value lifecycle",
      goal: "Return the complete bounded PlanDraft.",
      role: "planner",
      taskKind: "planning",
      runPhase: "plan",
      readOnly: true,
      scope: ["current Goal Contract"],
      acceptanceCriteria: ["Return a valid PlanDraft"],
      requiredEvidence: [],
      expectedOutputs: ["plan-draft"]
    })
  ]);
  const planner = await runCli(root, ["task", "claim", "T-PLANNER", "--owner", "planner"]);
  await runCli(root, [
    "task", "finish", "T-PLANNER", "--lease", planner.leaseToken, "--data",
    JSON.stringify({
      Status: "COMPLETED",
      Files: [],
      Summary: "Created the authenticated lifecycle plan.",
      PlanDraft: {
        parallelism: {
          eligible: false,
          minimumSameWaveImplementationTasks: 4,
          independentSlices: 1,
          desiredWidth: 1,
          rationale: "The implementation owns one atomic source path."
        },
        verificationParallelism: {
          eligible: false,
          rationale: "Verify the current export is the single semantic acceptance boundary."
        },
        interfaces: [],
        milestones: [{
          id: "M-VALUE",
          title: "Value module",
          objective: "Implement, verify, and document the value export.",
          userVisibleOutcome: "The value export is implemented, verified, and documented.",
          exitCriteria: ["REQ-VALUE is verified"],
          requirementIds: ["REQ-VALUE"],
          dependsOn: []
        }],
        tasks: plannedTasks
      },
      EvidenceRefs: [],
      Blockers: []
    })
  ]);
  await runCli(root, ["plan", "ingest", "T-PLANNER"]);

  const lint = await runCli(root, ["plan", "lint"]);
  assert.equal(lint.verdict, "APPROVED", JSON.stringify(lint.findings));
  await runCli(root, ["plan", "seal"]);
  await runCli(root, ["advance", "execute"]);

  const worker = await runCli(root, ["task", "claim", "T-VALUE", "--owner", "worker"]);
  assert.equal(worker.workspaceMode, "git-worktree");
  mkdirSync(path.join(worker.workspacePath, "src"), { recursive: true });
  writeFileSync(path.join(worker.workspacePath, "src/value.js"), "export const value = 1;\n");
  mkdirSync(path.dirname(worker.spawn.terminal_handoff.result_file), { recursive: true });
  writeFileSync(worker.spawn.terminal_handoff.result_file, JSON.stringify({
    Status: "COMPLETED",
    Files: ["src/value.js"],
    Signatures: ["value: number"],
    Breaking: [],
    Decisions: [],
    Summary: "Added the value export.",
    EvidenceRefs: ["src/value.js:1"],
    Blockers: []
  }));
  await runCli(root, [
    "task", "finish", "T-VALUE", "--lease", worker.leaseToken, "--file", worker.spawn.terminal_handoff.result_file
  ]);
  assert.equal(existsSync(worker.spawn.terminal_handoff.result_file), false);
  await runCli(root, ["advance", "review"]);

  const reviewer = await runCli(root, ["task", "claim", "T-REVIEW", "--owner", "reviewer"]);
  const reviewerContract = JSON.parse(reviewer.contract.content);
  await runCli(root, [
    "task", "finish", "T-REVIEW", "--lease", reviewer.leaseToken, "--data",
    JSON.stringify({
      Status: "COMPLETED",
      Files: [],
      Signatures: [],
      Breaking: [],
      Decisions: [],
      Verdict: "APPROVED",
      Findings: [],
      Summary: "The integration candidate is minimal and correct.",
      EvidenceRefs: [{
        type: "artifact",
        id: reviewerContract.SubjectArtifact.id,
        contentRef: reviewerContract.SubjectArtifact.contentRef
      }],
      Blockers: []
    })
  ]);
  assert.equal((await runCli(root, ["review", "reconcile", "--kind", "integration"])).status, "APPROVED");
  await runCli(root, ["advance", "verify"]);

  await runCli(root, [
    "check", "add", "--name", "syntax", "--command", process.execPath,
    "--args", JSON.stringify(["--check", "src/value.js"]), "--requirements", "REQ-VALUE"
  ]);
  const checks = await runCli(root, ["check", "run"]);
  assert.equal(checks[0].status, "passed");
  const verifier = await runCli(root, ["task", "claim", "T-VERIFY", "--owner", "verifier"]);
  await runCli(root, [
    "task", "finish", "T-VERIFY", "--lease", verifier.leaseToken, "--data",
    JSON.stringify({
      Status: "COMPLETED",
      Files: [],
      Signatures: [],
      Breaking: [],
      Decisions: [],
      Findings: [],
      Summary: "The current source exports value and passes syntax validation.",
      EvidenceRefs: [{
        type: "artifact",
        id: reviewerContract.SubjectArtifact.id,
        contentRef: reviewerContract.SubjectArtifact.contentRef
      }],
      Blockers: []
    })
  ]);
  const candidate = await runCli(root, ["verification", "candidate"]);
  assert.equal(candidate.candidate.requirements[0].verified, true);
  const adversarial = await runCli(root, ["task", "claim", "T-ADVERSARIAL", "--owner", "adversarial-reviewer"]);
  await runCli(root, [
    "task", "finish", "T-ADVERSARIAL", "--lease", adversarial.leaseToken, "--data",
    JSON.stringify({
      Status: "COMPLETED",
      Files: [],
      Signatures: [],
      Breaking: [],
      Decisions: [],
      Verdict: "APPROVED",
      Findings: [],
      Summary: "No credible residual failure remains.",
      EvidenceRefs: [{ type: "artifact", id: candidate.artifact.id, contentRef: candidate.artifact.content_ref }],
      Blockers: []
    })
  ]);
  assert.equal((await runCli(root, ["review", "reconcile", "--kind", "completion"])).status, "APPROVED");
  await runCli(root, ["advance", "curate"]);

  const curator = await runCli(root, ["task", "claim", "T-CURATE", "--owner", "curator"]);
  mkdirSync(path.join(curator.workspacePath, "docs"), { recursive: true });
  writeFileSync(path.join(curator.workspacePath, "docs/value.md"), "# Value\n\n`value` is exported as `1`.\n");
  await runCli(root, [
    "task", "finish", "T-CURATE", "--lease", curator.leaseToken, "--data",
    JSON.stringify({
      Status: "COMPLETED",
      Files: ["docs/value.md"],
      Signatures: [],
      Breaking: [],
      Decisions: [],
      Summary: "Documented the final export.",
      EvidenceRefs: ["docs/value.md:1-3"],
      Blockers: []
    })
  ]);
  assert.equal((await runCli(root, ["knowledge", "sync"])).clean, true);
  await runCli(root, ["evaluate"]);
  await runCli(root, ["advance", "complete"]);

  const status = await runCli(root, ["status"]);
  assert.equal(status.run.id, runId);
  assert.equal(status.run.phase, "complete");
  assert.equal(status.run.status, "completed");
  assert.equal((await runCli(root, ["trace", "report"])).pass, true);

  assert.equal((await runCli(root, ["clean", "--scope", "cache", "--dry-run"])).dryRun, true);
  assert.equal((await runCli(root, ["uninstall", "--host", "all", "--dry-run"])).dryRun, true);
  activeController = null;
});
