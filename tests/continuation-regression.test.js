import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { bindContinuation, inspectContinuation } from "../src/core/continuation.js";
import { processHookEvent } from "../src/adapters/continuation-hook.js";
import { databasePath } from "../src/core/db.js";
import { recordEvent } from "../src/core/state.js";
import { makeProject, startTestRun } from "./helpers.js";

function boundRun(host = "claude") {
  const project = makeProject();
  // Keep non-WAL fixtures independent of SQLite sidecar lifecycle; the dedicated
  // closed-WAL case below opts into WAL explicitly.
  project.db.exec("PRAGMA journal_mode = DELETE");
  const started = startTestRun(project.db, project.root, project.config, "Continuation regression", {
    host,
    controllerSessionId: host + "-controller",
    controllerOwner: "metis-main"
  });
  bindContinuation(project.db, project.root, started.run.id, started.controller, {
    host,
    sessionId: "native-session",
    nativeGoalInactive: true,
    evidence: "native goal is explicitly inactive"
  });
  return { ...project, ...started };
}

function tree(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = lstatSync(file);
      entries.push([path.relative(root, file), stat.mode, stat.size, stat.mtimeMs]);
      if (stat.isDirectory()) visit(file);
    }
  };
  visit(root);
  return entries.sort();
}

test("durable completion is overridden by a blocker added after completion", () => {
  const { root, db, run } = boundRun();
  try {
    const timestamp = new Date().toISOString();
    db.prepare("UPDATE runs SET status = 'completed', phase = 'complete' WHERE id = ?").run(run.id);
    recordEvent(db, run.id, "run.completed", "info", { runId: run.id });
    db.prepare(`
      INSERT INTO findings(
        id, run_id, claim, kind, severity, status, sources_json,
        requirement_ids_json, target_paths_json, created_at, updated_at
      ) VALUES(?, ?, ?, 'blocker', 'critical', 'valid', '[]', '[]', '[]', ?, ?)
    `).run("late-blocker", run.id, "A blocker was added after completion.", timestamp, timestamp);

    const result = inspectContinuation(root, { host: "claude", sessionId: "native-session" });
    assert.equal(result.decision, "PAUSE");
    assert.equal(result.reasonCode, "BLOCKER_PRESENT");
  } finally {
    db.close();
  }
});

test("running tasks with multiple resource leases remain waitable", () => {
  const { root, db, run } = boundRun();
  try {
    const timestamp = new Date().toISOString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO tasks(
        id, run_id, title, goal, role, phase, status, target_paths_json,
        attempt_fence, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 'worker', 'execute', 'running', ?, 1, ?, ?)
    `).run("multi-resource-task", run.id, "Multiple resources", "Hold multiple resources", '["src/a.js","src/b.js"]', timestamp, timestamp);
    for (const resource of ["src/a.js", "src/b.js"]) {
      db.prepare(`
        INSERT INTO leases(resource, task_id, token, fencing_token, owner, expires_at, created_at)
        VALUES(?, ?, ?, 1, 'worker', ?, ?)
      `).run(resource, "multi-resource-task", "lease-" + resource, expiry, timestamp);
    }
    db.prepare(`
      INSERT INTO scheduler_batches(
        id, run_id, phase, status, batch_json, rationale_json,
        controller_fencing_token, claimed_task_ids_json, spawned_task_ids_json,
        created_at, updated_at
      ) VALUES(?, ?, 'execute', 'spawned', '[]', '[]', 1, ?, '[]', ?, ?)
    `).run("batch-multi-resource", run.id, '["multi-resource-task"]', timestamp, timestamp);
    db.prepare(`
      INSERT INTO task_spawn_acks(
        task_id, attempt_fence, batch_id, owner, host_receipt, acknowledged_at
      ) VALUES(?, 1, ?, 'worker', 'host-receipt', ?)
    `).run("multi-resource-task", "batch-multi-resource", timestamp);

    const result = inspectContinuation(root, { host: "claude", sessionId: "native-session" });
    assert.equal(result.decision, "WAIT");
    assert.equal(result.reasonCode, "ACTIVE_CHILD_RUNNING");
  } finally {
    db.close();
  }
});

test("same-turn hook delivery is not suppressed when the core state advances", async () => {
  const { root, db } = makeProject();
  try {
    const event = {
      hook_event_name: "Stop",
      session_id: "native-session",
      turn_id: "same-turn",
      cwd: root,
      stop_hook_active: false
    };
    let revision = 1;
    const inspect = () => ({
      protocol: "metis.continuation.v1",
      decision: "CONTINUE",
      reasonCode: "ACTION_REFRESH_REQUIRED",
      runId: "run-1",
      bindingId: "binding-1",
      revision,
      stateFingerprint: "state-" + revision
    });

    const first = await processHookEvent(event, { host: "claude", inspect });
    assert.equal(first.decision, "block");
    revision = 2;
    const second = await processHookEvent(event, { host: "claude", inspect });
    assert.equal(second.decision, "block");
  } finally {
    db.close();
  }
});

test("read-only inspection does not create WAL sidecars when both are absent", () => {
  const { root, db, run } = boundRun();
  const database = databasePath(root);
  const wal = database + "-wal";
  const shm = database + "-shm";
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.prepare("UPDATE runs SET updated_at = updated_at WHERE id = ?").run(run.id);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    rmSync(wal, { force: true });
    rmSync(shm, { force: true });
    assert.equal(existsSync(wal), false);
    assert.equal(existsSync(shm), false);

    const before = tree(root);
    const result = inspectContinuation(root, { host: "claude", sessionId: "native-session" });
    assert.equal(result.decision, "CONTINUE");
    assert.equal(result.reasonCode, "ACTION_REFRESH_REQUIRED");
    assert.deepEqual(tree(root), before);
  } finally {
    try { db.close(); } catch {}
  }
});

test("database sidecars fail closed without filesystem mutation", () => {
  for (const sidecars of [["wal"], ["shm"], ["wal", "shm"], ["journal"]]) {
    const { root, db, run } = boundRun();
    const database = databasePath(root);
    const wal = database + "-wal";
    const shm = database + "-shm";
    const journal = database + "-journal";
    const sidecarPath = { wal, shm, journal };
    try {
      db.close();
      for (const file of Object.values(sidecarPath)) rmSync(file, { force: true });
      for (const sidecar of sidecars) writeFileSync(sidecarPath[sidecar], "");
      const before = tree(root);
      const result = inspectContinuation(root, { host: "claude", sessionId: "native-session" });
      assert.equal(result.decision, "PAUSE");
      assert.equal(result.reasonCode, "STATE_BUSY");
      assert.deepEqual(tree(root), before);
      assert.equal(existsSync(wal), sidecars.includes("wal"));
      assert.equal(existsSync(shm), sidecars.includes("shm"));
      assert.equal(existsSync(journal), sidecars.includes("journal"));
    } finally {
      try { db.close(); } catch {}
    }
  }
});

