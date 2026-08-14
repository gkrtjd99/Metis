import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { advancePhase, putArtifact, startRun } from "../src/core/state.js";
import { addTask, claimTask, finishTask, sealPlan } from "../src/core/tasks.js";
import { makeProject, startTestRun, forcePhase } from "./helpers.js";

test("mutable task completion must report every changed owned file", () => {
  const { root, config, db } = makeProject();
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/unchanged.js"), "export const unchanged = true;\n");

    const { run } = startTestRun(db, root, config, "Change two owned files");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["src"],
      constraints: [],
      nonGoals: [],
      successCriteria: ["Both changes are recorded"],
      designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "change_owned",
      title: "Change owned files",
      goal: "Create two files under src",
      role: "worker",
      readOnly: false,
      targetPaths: ["src"],
      acceptanceCriteria: ["Both files exist"],
      requiredEvidence: ["Changed file list"],
      dependsOn: []
    }, config);
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id).content);
    forcePhase(db, root, config, run.id, "execute");

    const claim = claimTask(db, run.id, "change_owned", "worker", config);
    writeFileSync(path.join(claim.workspacePath, "src/one.js"), "export const one = 1;\n");
    writeFileSync(path.join(claim.workspacePath, "src/two.js"), "export const two = 2;\n");

    assert.throws(
      () => finishTask(db, root, run.id, "change_owned", claim.leaseToken, {
        Status: "COMPLETED",
        Files: ["src/one.js"],
        Summary: "Created files.",
        EvidenceRefs: ["src/one.js:1"]
      }, config),
      /did not report every changed owned file/i
    );
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'change_owned'").get().status, "running");

    const finished = finishTask(db, root, run.id, "change_owned", claim.leaseToken, {
      Status: "COMPLETED",
      Files: ["src/one.js", "src/two.js"],
      Summary: "Created both files.",
      EvidenceRefs: ["src/one.js:1", "src/two.js:1"]
    }, config);
    assert.equal(finished.status, "completed");
    assert.deepEqual(finished.result.ActualChangedFiles, ["src/one.js", "src/two.js"]);
    assert.ok(!finished.result.ActualChangedFiles.includes("src/unchanged.js"));
  } finally {
    db.close();
  }
});

test("mutable task completion rejects hidden out-of-scope repository changes", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Change one owned file");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["src/owned.js"],
      constraints: [],
      nonGoals: [],
      successCriteria: ["Only the owned file changes"],
      designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, {
      id: "owned_only",
      title: "Change one file",
      goal: "Create src/owned.js",
      role: "worker",
      readOnly: false,
      targetPaths: ["src/owned.js"],
      acceptanceCriteria: ["Owned file exists"],
      requiredEvidence: ["Changed file list"],
      dependsOn: []
    }, config);
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id).content);
    forcePhase(db, root, config, run.id, "execute");

    const claim = claimTask(db, run.id, "owned_only", "worker", config);
    mkdirSync(path.join(claim.workspacePath, "src"), { recursive: true });
    mkdirSync(path.join(claim.workspacePath, "docs"), { recursive: true });
    writeFileSync(path.join(claim.workspacePath, "src/owned.js"), "export const owned = true;\n");
    writeFileSync(path.join(claim.workspacePath, "docs/hidden.md"), "# Hidden\n");

    assert.throws(
      () => finishTask(db, root, run.id, "owned_only", claim.leaseToken, {
        Status: "COMPLETED",
        Files: ["src/owned.js"],
        Summary: "Created owned file.",
        EvidenceRefs: ["src/owned.js:1"]
      }, config),
      /unowned repository changes/i
    );
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'owned_only'").get().status, "running");
  } finally {
    db.close();
  }
});

test("concurrent non-overlapping task changes are attributed without false conflicts", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Change independent files concurrently");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["src/a.js", "src/b.js"],
      constraints: [],
      nonGoals: [],
      successCriteria: ["Both files exist"],
      designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    for (const name of ["a", "b"]) {
      addTask(db, run.id, {
        id: `task_${name}`,
        title: `Create ${name}`,
        goal: `Create src/${name}.js`,
        role: "worker",
        readOnly: false,
        targetPaths: [`src/${name}.js`],
        acceptanceCriteria: [`src/${name}.js exists`],
        requiredEvidence: ["Changed file list"],
        dependsOn: []
      }, config);
    }
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id).content);
    forcePhase(db, root, config, run.id, "execute");

    const claimA = claimTask(db, run.id, "task_a", "worker-a", config);
    const claimB = claimTask(db, run.id, "task_b", "worker-b", config);
    mkdirSync(path.join(claimA.workspacePath, "src"), { recursive: true });
    mkdirSync(path.join(claimB.workspacePath, "src"), { recursive: true });
    writeFileSync(path.join(claimA.workspacePath, "src/a.js"), "export const a = 1;\n");
    writeFileSync(path.join(claimB.workspacePath, "src/b.js"), "export const b = 2;\n");

    const doneA = finishTask(db, root, run.id, "task_a", claimA.leaseToken, {
      Status: "COMPLETED",
      Files: ["src/a.js"],
      Summary: "Created A.",
      EvidenceRefs: ["src/a.js:1"]
    }, config);
    const doneB = finishTask(db, root, run.id, "task_b", claimB.leaseToken, {
      Status: "COMPLETED",
      Files: ["src/b.js"],
      Summary: "Created B.",
      EvidenceRefs: ["src/b.js:1"]
    }, config);

    assert.deepEqual(doneA.result.ActualChangedFiles, ["src/a.js"]);
    assert.deepEqual(doneB.result.ActualChangedFiles, ["src/b.js"]);
  } finally {
    db.close();
  }
});
