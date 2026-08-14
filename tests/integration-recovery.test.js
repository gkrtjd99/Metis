import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { activateIntegrationJournal, integrationJournalRoot, listIntegrationJournals } from "../src/core/integration-journal.js";
import { openDatabase } from "../src/core/db.js";
import { addTask, claimTask, sealPlan } from "../src/core/tasks.js";
import { putArtifact } from "../src/core/state.js";
import { forcePhase, makeProject, startTestRun } from "./helpers.js";

function runningRecoveryTask() {
  const { root, config, db } = makeProject();
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/keep.js"), "export const value = 'before';\n");
  symlinkSync("../package.json", path.join(root, "src/original-link.js"));
  const { run } = startTestRun(db, root, config, "Recover interrupted integration");
  forcePhase(db, root, config, run.id, "plan");
  addTask(db, run.id, {
    id: "recovery-task",
    title: "Recover a bounded integration",
    goal: "Exercise crash-safe filesystem integration recovery",
    role: "worker",
    runPhase: "execute",
    targetPaths: ["src"],
    acceptanceCriteria: ["The original filesystem state is recoverable"],
    requiredEvidence: ["The recovered source files"],
    dependsOn: []
  }, config);
  putArtifact(db, root, run.id, "plan", sealPlan(db, run.id, config).content);
  forcePhase(db, root, config, run.id, "execute");
  const claim = claimTask(db, run.id, "recovery-task", "recovery-worker", config);
  return { root, config, db, run, claim };
}

function activate(root, run, claim) {
  return activateIntegrationJournal(root, {
    runId: run.id,
    taskId: claim.task.id,
    attemptFence: claim.attemptFence,
    targetPaths: ["src"],
    paths: ["src/keep.js", "src/new.js", "src/original-link.js"]
  });
}

test("startup rolls back a partially mutated workspace and cleans pre-activation temp state", () => {
  const { root, db, run, claim } = runningRecoveryTask();
  try {
    const journal = activate(root, run, claim);
    assert.equal(listIntegrationJournals(root).length, 1);
    const temporary = path.join(integrationJournalRoot(root), ".tmp-preactivation");
    mkdirSync(temporary, { recursive: true });
    writeFileSync(path.join(temporary, "incomplete"), "discard me");
    writeFileSync(path.join(root, "src/keep.js"), "export const value = 'partial';\n");
    db.close();

    const recovered = openDatabase(root);
    try {
      assert.equal(readFileSync(path.join(root, "src/keep.js"), "utf8"), "export const value = 'before';\n");
      assert.equal(lstatSync(path.join(root, "src/original-link.js")).isSymbolicLink(), true);
      assert.equal(readlinkSync(path.join(root, "src/original-link.js")), "../package.json");
      assert.equal(lstatSync(path.join(root, "src/new.js"), { throwIfNoEntry: false }), undefined);
      assert.equal(listIntegrationJournals(root).length, 0);
      assert.equal(recovered.prepare("SELECT status, failure_class FROM tasks WHERE id = ?").get("recovery-task").status, "failed");
      assert.equal(recovered.prepare("SELECT failure_class FROM tasks WHERE id = ?").get("recovery-task").failure_class, "integration");
    } finally {
      recovered.close();
    }
    assert.ok(journal.manifest.originals.some((item) => item.state === "absent"));
  } finally {
    if (db.isOpen) db.close();
  }
});

test("startup rolls back a fully mutated workspace including symlink and absence originals", () => {
  const { root, db, run, claim } = runningRecoveryTask();
  try {
    activate(root, run, claim);
    writeFileSync(path.join(root, "src/keep.js"), "export const value = 'full';\n");
    writeFileSync(path.join(root, "src/new.js"), "export const created = true;\n");
    rmSync(path.join(root, "src/original-link.js"));
    writeFileSync(path.join(root, "src/original-link.js"), "not a link\n");
    db.close();

    const recovered = openDatabase(root);
    try {
      assert.equal(readFileSync(path.join(root, "src/keep.js"), "utf8"), "export const value = 'before';\n");
      assert.equal(lstatSync(path.join(root, "src/new.js"), { throwIfNoEntry: false }), undefined);
      assert.equal(lstatSync(path.join(root, "src/original-link.js")).isSymbolicLink(), true);
      assert.equal(readlinkSync(path.join(root, "src/original-link.js")), "../package.json");
      assert.equal(listIntegrationJournals(root).length, 0);
    } finally {
      recovered.close();
    }
  } finally {
    if (db.isOpen) db.close();
  }
});

test("startup keeps committed integration and removes its journal", () => {
  const { root, db, run, claim } = runningRecoveryTask();
  try {
    activate(root, run, claim);
    writeFileSync(path.join(root, "src/keep.js"), "export const value = 'committed';\n");
    db.prepare("UPDATE tasks SET status = 'completed', result_json = ?, owner = NULL WHERE id = ?")
      .run(JSON.stringify({ Status: "COMPLETED", Integrated: true }), claim.task.id);
    db.close();

    const recovered = openDatabase(root);
    try {
      assert.equal(readFileSync(path.join(root, "src/keep.js"), "utf8"), "export const value = 'committed';\n");
      assert.equal(recovered.prepare("SELECT status FROM tasks WHERE id = ?").get(claim.task.id).status, "completed");
      assert.equal(listIntegrationJournals(root).length, 0);
    } finally {
      recovered.close();
    }
  } finally {
    if (db.isOpen) db.close();
  }
});

test("startup quarantines a journal whose task attempt no longer matches", () => {
  const { root, db, run, claim } = runningRecoveryTask();
  try {
    activate(root, run, claim);
    db.prepare("UPDATE tasks SET attempt_fence = attempt_fence + 1 WHERE id = ?").run(claim.task.id);
    db.close();

    const recovered = openDatabase(root);
    try {
      assert.equal(listIntegrationJournals(root).length, 0);
      const entries = readdirSync(integrationJournalRoot(root));
      assert.ok(entries.some((entry) => entry.startsWith("quarantine-")));
      assert.equal(recovered.prepare("SELECT status FROM tasks WHERE id = ?").get(claim.task.id).status, "running");
    } finally {
      recovered.close();
    }
  } finally {
    if (db.isOpen) db.close();
  }
});

test("startup preserves the journal when restoration fails", () => {
  const { root, db, run, claim } = runningRecoveryTask();
  try {
    const journal = activate(root, run, claim);
    rmSync(path.join(journal.directory, "originals", "0.bak"));
    db.close();

    assert.throws(() => openDatabase(root), /Missing integration journal backup/u);
    assert.equal(existsSync(journal.directory), true);
    assert.equal(listIntegrationJournals(root).length, 1);
  } finally {
    if (db.isOpen) db.close();
  }
});
