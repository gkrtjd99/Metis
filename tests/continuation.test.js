import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindContinuation, detachContinuation, inspectContinuation } from "../src/core/continuation.js";
import { makeProject, startTestRun } from "./helpers.js";

function tree(root) {
  const result = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file);
      const stat = statSync(file);
      result.push([relative, stat.mode, stat.size, stat.mtimeMs]);
      if (stat.isDirectory()) visit(file);
    }
  };
  visit(root);
  return result.sort();
}

function dbSnapshot(db, runId) {
  const tables = ["events", "journal", "progress_samples", "context_snapshots", "usage_samples"];
  return [
    ["runs", db.prepare("SELECT * FROM runs WHERE id = ?").all(runId)],
    ...tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} WHERE run_id IS ? ORDER BY 1`).all(runId)])
  ];
}

function sessionFile(root, host, sessionId) {
  const digest = createHash("sha256").update(`${host}:${sessionId}`).digest("hex");
  return path.join(root, ".metis", "continuation", `${digest}.json`);
}

test("unbound inspection is detached and does not create runtime files", () => {
  const root = fsTemp();
  const before = tree(root);
  const result = inspectContinuation(root, { host: "codex", sessionId: "main-unbound" });
  assert.deepEqual(result, {
    protocol: "metis.continuation.v1",
    decision: "DETACHED",
    reasonCode: "NO_BINDING",
    runId: null,
    bindingId: null,
    revision: null
  });
  assert.deepEqual(tree(root), before);
  assert.equal(existsSync(path.join(root, ".metis")), false);
});

test("binding requires supported host, inactive native goal, and evidence", () => {
  const { root, db, config, controller, run } = makeBoundRun("codex");
  assert.throws(() => bindContinuation(db, root, run.id, controller, {
    host: "opencode", sessionId: controller.sessionId, nativeGoalInactive: true, evidence: "test"
  }), /CONTINUATION_HOST_UNSUPPORTED/);
  assert.throws(() => bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: controller.sessionId, nativeGoalInactive: false, evidence: "test"
  }), /CONTINUATION_NATIVE_GOAL_ACTIVE/);
  assert.throws(() => bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: controller.sessionId, nativeGoalInactive: true, evidence: ""
  }), /CONTINUATION_EVIDENCE_REQUIRED/);
  void config;
});

test("inspect projects the current run without writing DB or filesystem state", () => {
  const { root, db, controller, run } = makeBoundRun("codex");
  const binding = bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: "host-session", nativeGoalInactive: true, evidence: "native goal is inactive"
  });
  const beforeDb = dbSnapshot(db, run.id);
  const beforeTree = tree(root);
  const first = inspectContinuation(root, { host: "codex", sessionId: "host-session" });
  const second = inspectContinuation(root, { host: "codex", sessionId: "host-session" });
  assert.equal(binding.runId, run.id);
  assert.equal(first.decision, "CONTINUE");
  assert.equal(first.reasonCode, "ACTION_REFRESH_REQUIRED");
  assert.deepEqual(second, first);
  assert.deepEqual(dbSnapshot(db, run.id), beforeDb);
  assert.deepEqual(tree(root), beforeTree);
  assert.ok(!JSON.stringify(first).includes(controller.token));
});

test("task completion is not runtime completion", () => {
  const { root, db, controller, run } = makeBoundRun("codex");
  bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: "host-session", nativeGoalInactive: true, evidence: "native goal is inactive"
  });
  db.prepare("INSERT INTO tasks(id, run_id, title, goal, role, phase, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("done-task", run.id, "Done", "Done", "worker", "execute", "completed", new Date().toISOString(), new Date().toISOString());
  const result = inspectContinuation(root, { host: "codex", sessionId: "host-session" });
  assert.notEqual(result.decision, "COMPLETE");
});

test("running task without a current lease pauses fail closed", () => {
  const { root, db, controller, run } = makeBoundRun("codex");
  bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: "host-session", nativeGoalInactive: true, evidence: "goal disabled"
  });
  db.prepare("INSERT INTO tasks(id, run_id, title, goal, role, phase, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("lease-missing-task", run.id, "Running", "Running", "worker", "execute", "running", new Date().toISOString(), new Date().toISOString());
  const result = inspectContinuation(root, { host: "codex", sessionId: "host-session" });
  assert.equal(result.decision, "PAUSE");
  assert.equal(result.reasonCode, "TASK_LEASE_INVALID");
});

test("durable completion survives controller expiry but late blockers pause", () => {
  const { root, db, controller, run } = makeBoundRun("codex");
  bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: "host-session", nativeGoalInactive: true, evidence: "goal disabled"
  });
  const completedAt = new Date().toISOString();
  db.prepare("UPDATE runs SET status = 'completed', phase = 'complete', controller_expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 60_000).toISOString(), run.id);
  db.prepare("INSERT INTO events(run_id, type, severity, payload_json, fingerprint, count, created_at, updated_at) VALUES(?, 'run.completed', 'info', '{}', ?, 1, ?, ?)")
    .run(run.id, `completion-${run.id}`, completedAt, completedAt);
  assert.equal(inspectContinuation(root, { host: "codex", sessionId: "host-session" }).decision, "COMPLETE");
  db.prepare("INSERT INTO findings(id, run_id, claim, kind, confidence, severity, status, sources_json, requirement_ids_json, target_paths_json, created_at, updated_at) VALUES(?, ?, 'late blocker', 'blocker', 1, 'error', 'valid', '[]', '[]', '[]', ?, ?)")
    .run(`finding-${run.id}`, run.id, completedAt, completedAt);
  assert.equal(inspectContinuation(root, { host: "codex", sessionId: "host-session" }).reasonCode, "BLOCKER_PRESENT");
});

test("budget exhaustion and native blocker pause continuation", () => {
  const { root, db, controller, run } = makeBoundRun("claude");
  bindContinuation(db, root, run.id, controller, {
    host: "claude", sessionId: "host-session", nativeGoalInactive: true, evidence: "goal disabled"
  });
  db.prepare("UPDATE budget_state SET input_tokens = input_token_limit + 1 WHERE run_id = ?").run(run.id);
  assert.equal(inspectContinuation(root, { host: "claude", sessionId: "host-session" }).reasonCode, "BUDGET_EXCEEDED");
});

test("malformed budget state fails closed", () => {
  const { root, db, controller, run } = makeBoundRun("codex");
  bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: "host-session", nativeGoalInactive: true, evidence: "goal disabled"
  });
  db.prepare("UPDATE budget_state SET input_token_limit = ? WHERE run_id = ?").run("not-a-number", run.id);
  const result = inspectContinuation(root, { host: "codex", sessionId: "host-session" });
  assert.equal(result.decision, "PAUSE");
  assert.equal(result.reasonCode, "STATE_UNREADABLE");
});

test("unsupported inspection host fails closed", () => {
  const root = fsTemp();
  const result = inspectContinuation(root, { host: "opencode", sessionId: "host-session" });
  assert.equal(result.decision, "PAUSE");
  assert.equal(result.reasonCode, "HOST_UNSUPPORTED");
});

test("foreign host and fence cannot inspect or detach a binding", () => {
  const { root, db, controller, run } = makeBoundRun("codex");
  bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: "host-session", nativeGoalInactive: true, evidence: "goal disabled"
  });
  assert.equal(inspectContinuation(root, { host: "claude", sessionId: "host-session" }).reasonCode, "NO_BINDING");
  assert.throws(() => detachContinuation(db, root, run.id, controller, { host: "claude", sessionId: "host-session" }), /CONTINUATION_FOREIGN_BINDING/);
  db.prepare("UPDATE runs SET controller_fencing_token = controller_fencing_token + 1 WHERE id = ?").run(run.id);
  assert.equal(inspectContinuation(root, { host: "codex", sessionId: "host-session" }).reasonCode, "CONTROLLER_FENCE_MISMATCH");
});

test("malformed or symlinked binding fails closed and secrets are not returned", () => {
  const { root, db, controller, run } = makeBoundRun("codex");
  bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: "host-session", nativeGoalInactive: true, evidence: "goal disabled"
  });
  const file = sessionFile(root, "codex", "host-session");
  writeFileSync(file, JSON.stringify({ protocol: "metis.continuation.v1", token: controller.token }));
  const result = inspectContinuation(root, { host: "codex", sessionId: "host-session" });
  assert.equal(result.decision, "PAUSE");
  assert.equal(result.reasonCode, "BINDING_INVALID");
  assert.ok(!JSON.stringify(result).includes(controller.token));
});

test("explicit rebind rotates the binding identity", () => {
  const { root, db, controller, run } = makeBoundRun("codex");
  const first = bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: "host-session", nativeGoalInactive: true, evidence: "goal disabled"
  });
  const second = bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: "host-session", nativeGoalInactive: true, evidence: "goal disabled", rebind: true
  });
  assert.notEqual(second.bindingId, first.bindingId);
  assert.equal(inspectContinuation(root, { host: "codex", sessionId: "host-session" }).bindingId, second.bindingId);
});

test("detach removes only the authenticated binding", () => {
  const { root, db, controller, run } = makeBoundRun("codex");
  const binding = bindContinuation(db, root, run.id, controller, {
    host: "codex", sessionId: "host-session", nativeGoalInactive: true, evidence: "goal disabled"
  });
  const result = detachContinuation(db, root, run.id, controller, { host: "codex", sessionId: "host-session" });
  assert.equal(result.detached, true);
  assert.equal(result.bindingId, binding.bindingId);
  assert.equal(inspectContinuation(root, { host: "codex", sessionId: "host-session" }).decision, "DETACHED");
});

function fsTemp() {
  const root = os.tmpdir() + `/metis-continuation-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(root, { recursive: true });
  return root;
}

function makeBoundRun(host) {
  const value = makeProject();
  const started = startTestRun(value.db, value.root, value.config, "Continuation test", {
    host, controllerSessionId: `${host}-controller`, controllerOwner: "metis-main"
  });
  value.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
  return { ...value, ...started, controller: started.controller };
}
