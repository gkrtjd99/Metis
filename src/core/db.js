import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema.js";
import { ensureRuntimeLayout, runtimeDatabasePath, runtimeRoot } from "./paths.js";
import { SCHEMA_VERSION } from "./metadata.js";
import { syncCapabilityRegistry } from "./capabilities.js";
import {
  cleanupIncompleteIntegrationJournals,
  listIntegrationJournals,
  removeIntegrationJournal,
  quarantineIntegrationJournal,
  restoreIntegrationJournal
} from "./integration-journal.js";
import { json, now, sha256, stableStringify } from "./util.js";

export function stateDirectory(projectRoot) {
  return runtimeRoot(projectRoot);
}

export function databasePath(projectRoot) {
  return runtimeDatabasePath(projectRoot);
}

export function openDatabase(projectRoot) {
  ensureRuntimeLayout(projectRoot);
  mkdirSync(path.dirname(databasePath(projectRoot)), { recursive: true });
  const db = new DatabaseSync(databasePath(projectRoot));
  try { chmodSync(databasePath(projectRoot), 0o600); } catch {}
  // Integration recovery must wait for an in-flight terminal commit.  The
  // normal short timeout is restored before returning the opened connection.
  db.exec("PRAGMA busy_timeout = 120000");
  db.exec(SCHEMA_SQL);
  const schemaVersion = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
  if (schemaVersion && schemaVersion !== String(SCHEMA_VERSION)) {
    db.close();
    throw new Error(
      `Metis state schema ${schemaVersion} is not compatible with schema ${SCHEMA_VERSION}. ` +
      "Remove `.metis/` and start a new goal."
    );
  }
  db.prepare(`
    INSERT INTO meta(key, value) VALUES('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(SCHEMA_VERSION));
  syncCapabilityRegistry(db);
  try {
    recoverIntegrationJournals(projectRoot, db);
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
  return db;
}

const TERMINAL_TASK_STATUSES = new Set(["completed", "waived", "failed", "blocked"]);

function taskResult(row) {
  try { return row?.result_json ? JSON.parse(row.result_json) : {}; } catch { return {}; }
}

function reconcileInterruptedIntegration(db, journal) {
  const manifest = journal.manifest;
  transaction(db, () => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(manifest.taskId);
    if (!task) return;
    const timestamp = now();
    const payload = {
      taskId: manifest.taskId,
      attemptFence: manifest.attemptFence,
      paths: manifest.paths,
      reason: "Interrupted filesystem integration was rolled back during database recovery."
    };
    const result = {
      Status: "FAILED",
      Summary: payload.reason,
      FailureClass: "integration",
      Integrated: false,
      Files: manifest.paths,
      ActualChangedFiles: manifest.paths,
      EvidenceRefs: [],
      Blockers: [payload.reason]
    };
    db.prepare(`
      UPDATE tasks SET status = 'failed', result_json = ?, owner = NULL,
        failure_class = 'integration', updated_at = ?
      WHERE id = ? AND run_id = ?
    `).run(json(result), timestamp, manifest.taskId, manifest.runId);
    db.prepare("DELETE FROM leases WHERE task_id = ? AND fencing_token = ?")
      .run(manifest.taskId, Number(manifest.attemptFence));
    db.prepare("UPDATE worktrees SET status = 'failed', updated_at = ? WHERE task_id = ? AND attempt_fence = ?")
      .run(timestamp, manifest.taskId, Number(manifest.attemptFence));
    const fingerprint = sha256(stableStringify({ type: "task.integration-recovered", payload }));
    db.prepare(`
      INSERT INTO events(run_id, type, severity, payload_json, fingerprint, count, created_at, updated_at)
      VALUES(?, 'task.integration-recovered', 'error', ?, ?, 1, ?, ?)
      ON CONFLICT(run_id, fingerprint) DO UPDATE SET count = events.count + 1, updated_at = excluded.updated_at
    `).run(task.run_id, json(payload), fingerprint, timestamp, timestamp);
    db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(timestamp, task.run_id);
  });
}

function recoverIntegrationJournals(projectRoot, db) {
  // Hold the SQLite write lock for the whole decision/restore operation. A
  // second opener must observe the terminal DB commit before it can decide
  // whether to keep or roll back the journal.
  const journalsToRemove = [];
  transaction(db, () => {
    cleanupIncompleteIntegrationJournals(projectRoot);
    for (const journal of listIntegrationJournals(projectRoot)) {
      const manifest = journal.manifest;
      const task = db.prepare("SELECT status, run_id, attempt_fence, result_json FROM tasks WHERE id = ?").get(manifest.taskId);
      if (!task
          || task.run_id !== manifest.runId
          || Number(task.attempt_fence) !== Number(manifest.attemptFence)) {
        quarantineIntegrationJournal(journal);
        continue;
      }
      const result = taskResult(task);
      const committed = Boolean(
        TERMINAL_TASK_STATUSES.has(task.status)
        && result.Integrated === true
      );
      if (committed) {
        journalsToRemove.push(journal);
        continue;
      }
      restoreIntegrationJournal(journal);
      reconcileInterruptedIntegration(db, journal);
      journalsToRemove.push(journal);
    }
  });
  // Removal after COMMIT preserves the journal if the DB transaction itself
  // fails. A subsequent startup can safely repeat the idempotent decision.
  for (const journal of journalsToRemove) removeIntegrationJournal(journal);
}

let savepointSequence = 0;

export function transaction(db, fn) {
  if (db.isTransaction) {
    savepointSequence += 1;
    const savepoint = "metis_sp_" + savepointSequence;
    db.exec("SAVEPOINT " + savepoint);
    try {
      const result = fn();
      db.exec("RELEASE SAVEPOINT " + savepoint);
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK TO SAVEPOINT " + savepoint); } catch {}
      try { db.exec("RELEASE SAVEPOINT " + savepoint); } catch {}
      throw error;
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}
