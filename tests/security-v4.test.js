import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installAdapters, uninstallAdapters } from "../src/adapters/install.js";
import { stripInstalledMetis } from "../src/core/benchmark.js";
import { registerCheck, runChecks } from "../src/core/checks.js";
import { objectKeyPath, objectSecurityStatus, readObject, storeObject } from "../src/core/objects.js";
import { forcePhase, startTestRun, makeProject, nodeCommand } from "./helpers.js";
import { doctor } from "../src/core/doctor.js";
import { addTask } from "../src/core/tasks.js";
import { prepareTaskWorkspace } from "../src/core/worktrees.js";

test("benchmark manifest traversal is rejected before removing outside files", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "metis-benchmark-traversal-"));
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  mkdirSync(path.join(source, ".agents", "metis"), { recursive: true });
  mkdirSync(target, { recursive: true });
  const outside = path.join(base, "outside.txt");
  writeFileSync(outside, "preserve", "utf8");
  writeFileSync(path.join(source, ".agents", "metis", "install-manifest.json"), JSON.stringify({
    files: [{ path: "../outside.txt" }]
  }), "utf8");

  assert.throws(() => stripInstalledMetis(source, target), (error) => error.code === "BENCHMARK_MANIFEST_PATH");
  assert.equal(readFileSync(outside, "utf8"), "preserve");
});

test("uninstall rejects a tampered managed-file path", () => {
  const { root } = makeProject();
  installAdapters(root, ["codex"], false);
  const manifestFile = path.join(root, ".agents", "metis", "install-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.files[0].path = "../outside.txt";
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
  const outside = path.join(path.dirname(root), "outside.txt");
  writeFileSync(outside, "preserve", "utf8");

  assert.throws(() => uninstallAdapters(root, ["all"]), (error) => ["MANIFEST_PATH_INVALID", "INSTALL_MANIFEST_PATH_INVALID", "PATH_OUTSIDE_ROOT"].includes(error.code));
  assert.equal(readFileSync(outside, "utf8"), "preserve");
});

test("task creation rejects IDs that are not single portable path components", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startTestRun(db, root, config, "Reject unsafe task IDs");
    forcePhase(db, root, config, run.id, "discover");
    assert.throws(
      () => addTask(db, run.id, { id: "../../outside", title: "Unsafe task", goal: "Must not persist" }, config),
      (error) => error.code === "TASK_ID_INVALID"
    );
    assert.equal(db.prepare("SELECT 1 FROM tasks WHERE id = ?").get("../../outside"), undefined);
  } finally {
    db.close();
  }
});

test("worktree preparation rejects a tampered task ID before filesystem mutation", () => {
  const { root, config, db } = makeProject();
  const escaped = path.join(root, ".metis", "outside-f1");
  try {
    const { run } = startTestRun(db, root, config, "Reject tampered task paths");
    assert.throws(
      () => prepareTaskWorkspace(db, run, {
        id: "../../outside",
        attempt_fence: 1,
        readOnly: false,
        targetPaths: ["src"]
      }, config),
      (error) => error.code === "WORKTREE_PATH_INVALID"
    );
    assert.equal(existsSync(escaped), false);
  } finally {
    db.close();
  }
});

test("structured verification arguments do not invoke a shell", () => {
  const { root, config, db } = makeProject();
  const { run } = startTestRun(db, root, config, "Verify structured command execution");
  const injected = path.join(root, "injected.txt");
  const payload = `; touch ${injected}`;
  registerCheck(db, run.id, {
    name: "literal-argument",
    command: nodeCommand([
      "-e",
      "if (process.argv[1] !== process.env.EXPECTED) process.exit(9)",
      payload
    ], { env: { EXPECTED: payload } }),
    required: true,
    requirementIds: ["REQ-001"]
  });

  const [result] = runChecks(db, root, run.id, config);
  assert.equal(result.status, "passed");
  assert.equal(existsSync(injected), false);
});

test("Metis reports an orchestration boundary without claiming host permission enforcement", () => {
  const { root, config, db } = makeProject();
  const { run } = startTestRun(db, root, config, "Run a structured local check");
  registerCheck(db, run.id, {
    name: "noop",
    command: nodeCommand(["-e", "process.exit(0)"]),
    requirementIds: ["REQ-001"]
  });
  assert.equal(runChecks(db, root, run.id, config)[0].status, "passed");
  const report = doctor(root, config);
  assert.equal(report.boundary.orchestrationBoundary, true);
  assert.equal(report.boundary.runtimeEnforcesHostToolPermissions, false);
});

test("object-store payloads are encrypted and the key remains outside the repository", () => {
  const { root, db } = makeProject();
  const payloadText = ["fixture", "payload", "42"].join("-");
  const ref = storeObject(db, root, "security-test", payloadText);
  const row = db.prepare("SELECT * FROM objects WHERE hash = ?").get(ref.replace(/^obj_/, ""));
  const file = path.join(root, ".metis", row.path);
  const payload = readFileSync(file);
  const status = objectSecurityStatus(root);

  assert.equal(payload.includes(Buffer.from(payloadText)), false);
  assert.equal(readObject(db, root, ref), payloadText);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(status.encrypted, true);
  assert.equal(status.keyOutsideRepository, true);
  if (process.env.METIS_OBJECT_KEY) {
    assert.equal(status.keySource, "environment");
    assert.equal(status.keyPath, null);
  } else {
    assert.equal(status.keySource, "external-file");
    assert.equal(status.keyPath, objectKeyPath(root));
    assert.equal(path.resolve(status.keyPath).startsWith(`${path.resolve(root)}${path.sep}`), false);
  }
});

test("object-store keys use one identity for a physical root and its symlink", () => {
  const { root, db } = makeProject();
  const alias = `${root}-alias`;
  symlinkSync(root, alias, "dir");

  assert.equal(objectKeyPath(root), objectKeyPath(alias));
  const ref = storeObject(db, alias, "symlink-security-test", "alias-safe-secret");
  assert.equal(readObject(db, root, ref), "alias-safe-secret");
  const status = objectSecurityStatus(alias);
  assert.equal(status.keyPath, process.env.METIS_OBJECT_KEY ? null : objectKeyPath(root));
});
