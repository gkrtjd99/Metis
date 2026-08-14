import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync
} from "node:fs";
import path from "node:path";
import { invariant } from "./errors.js";
import { transaction } from "./db.js";
import { hashFileContents } from "./hash.js";
import { runtimeArea } from "./paths.js";
import { listProjectFiles } from "./repository.js";
import { storeObject } from "./objects.js";
import {
  activateIntegrationJournal,
  removeIntegrationJournal,
  restoreIntegrationJournal
} from "./integration-journal.js";
import { isSafeRepoPath, json, normalizeRepoPath, now, pathsOverlap, stableStringify } from "./util.js";

function performanceEvent(db, runId, type, payload, severity = "info") {
  if (!runId) return;
  const timestamp = now();
  const body = { ...payload, operationId: payload.operationId ?? `op_${process.pid}_${Date.now()}_${randomBytes(5).toString("hex")}` };
  const fingerprint = createHash("sha256").update(stableStringify({ type, payload: body })).digest("hex");
  db.prepare(`INSERT INTO events(run_id, type, severity, payload_json, fingerprint, count, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(run_id, fingerprint) DO UPDATE SET count = events.count + 1, updated_at = excluded.updated_at`)
    .run(runId, type, severity, json(body), fingerprint, timestamp, timestamp);
}

function git(projectRoot, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeout ?? 120000,
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null
  };
}

function gitAvailable(projectRoot) {
  const result = git(projectRoot, ["rev-parse", "--verify", "HEAD"], { timeout: 5000 });
  return result.status === 0;
}

function physicalPath(value) {
  const absolute = path.resolve(value);
  try { return realpathSync.native(absolute); } catch {}
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  try { return path.join(realpathSync.native(parent), path.basename(absolute)); } catch { return absolute; }
}

function snapshotEntry(root, relative) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return null;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(absolute);
    return { type: "symlink", sha256: createHash("sha256").update(target).digest("hex"), target, mode: stat.mode & 0o777 };
  }
  if (!stat.isFile()) return null;
  return { type: "file", sha256: hashFileContents(absolute), size: stat.size, mode: stat.mode & 0o777 };
}

export function snapshotWorkspace(root, config) {
  const files = listProjectFiles(root, config);
  const snapshot = {};
  for (const relative of files) {
    const entry = snapshotEntry(root, relative);
    if (entry) snapshot[relative] = entry;
  }
  return snapshot;
}

export function changedSnapshotPaths(before = {}, after = {}) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((file) => stableStringify(before[file] ?? null) !== stableStringify(after[file] ?? null)).sort();
}

function copyEntry(sourceRoot, targetRoot, relative) {
  const source = path.join(sourceRoot, relative);
  const target = path.join(targetRoot, relative);
  const stat = lstatSync(source);
  mkdirSync(path.dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    return;
  }
  copyFileSync(source, target);
  chmodSync(target, stat.mode & 0o777);
}

function symlinkAncestor(root, relative) {
  let current = path.resolve(root);
  for (const part of normalizeRepoPath(relative).split("/").filter((item) => item && item !== ".")) {
    current = path.join(current, part);
    if (!existsSync(current)) return null;
    if (lstatSync(current).isSymbolicLink()) return current;
  }
  return null;
}

export function validateMutableOwnershipPaths(root, targetPaths) {
  for (const raw of targetPaths) {
    const relative = normalizeRepoPath(String(raw));
    invariant(isSafeRepoPath(relative), "TASK_PATH_INVALID", `Unsafe mutable target path: ${raw}.`);
    invariant(!/[\[*?{}\]]/u.test(relative), "TASK_PATH_GLOB", `Mutable target paths are path prefixes, not glob patterns: ${relative}.`);
    const symlink = symlinkAncestor(root, relative);
    if (symlink) {
      const symlinkPath = path.relative(root, symlink).replaceAll(path.sep, "/");
      invariant(
        false,
        "TASK_PATH_SYMLINK",
        `Mutable target path ${relative} crosses a symbolic link at ${symlinkPath}.`
      );
    }
  }
  return true;
}

function overlayCurrentWorkspace(projectRoot, worktreePath) {
  const diff = git(projectRoot, ["diff", "--binary", "HEAD", "--", "."]);
  if (diff.status !== 0) throw new Error(`Cannot snapshot current Git changes: ${diff.stderr || diff.error}`);
  if (diff.stdout) {
    const applied = git(worktreePath, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: diff.stdout });
    if (applied.status !== 0) throw new Error(`Cannot apply current Git changes to task worktree: ${applied.stderr || applied.error}`);
  }
  const untracked = git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.status !== 0) throw new Error(`Cannot list untracked files: ${untracked.stderr || untracked.error}`);
  for (const relative of untracked.stdout.split("\0").filter(Boolean).map(normalizeRepoPath)) {
    if (relative === ".metis" || relative.startsWith(".metis/")) continue;
    if (!existsSync(path.join(projectRoot, relative))) continue;
    copyEntry(projectRoot, worktreePath, relative);
  }
}

function removeGitWorktree(projectRoot, worktreePath, { ignoreMissing = false } = {}) {
  if (!existsSync(worktreePath) && ignoreMissing) return true;
  const result = git(projectRoot, ["worktree", "remove", "--force", worktreePath]);
  if (result.status !== 0) {
    const error = new Error(`Cannot remove Git worktree ${worktreePath}: ${result.stderr || result.error || "git worktree remove failed"}`);
    error.code = "WORKTREE_REMOVE_FAILED";
    throw error;
  }
  const pruned = git(projectRoot, ["worktree", "prune"]);
  if (pruned.status !== 0) {
    const error = new Error(`Cannot prune Git worktrees: ${pruned.stderr || pruned.error || "git worktree prune failed"}`);
    error.code = "WORKTREE_PRUNE_FAILED";
    throw error;
  }
  return true;
}

export function prepareTaskWorkspace(db, run, task, config) {
  const started = performance.now();
  const operationId = `wt_${task.id}_${task.attempt_fence}_${Date.now()}`;
  performanceEvent(db, run.id, "performance.worktree-queue", { operationId, taskId: task.id, attemptFence: Number(task.attempt_fence), phase: "start" });
  if (task.readOnly) {
    db.prepare("UPDATE tasks SET workspace_mode = 'shared' WHERE id = ?").run(task.id);
    performanceEvent(db, run.id, "performance.worktree-queue", { operationId, taskId: task.id, durationMs: performance.now() - started, phase: "shared" });
    return { mode: "shared", path: run.project_root, baseRef: run.baseline_ref };
  }
  validateMutableOwnershipPaths(run.project_root, task.targetPaths);
  invariant(String(config.worktrees?.mode ?? "required") === "required", "WORKTREE_MODE_REQUIRED", "Mutable tasks require Git worktree isolation.");
  invariant(gitAvailable(run.project_root), "WORKTREE_GIT_REQUIRED", "Mutable tasks require a Git repository with a valid HEAD.");
  const directory = path.join(runtimeArea(run.project_root, "worktrees"), run.id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fence = Number(task.attempt_fence);
  const worktreePath = path.join(directory, `${task.id}-f${fence}`);
  removeGitWorktree(run.project_root, worktreePath, { ignoreMissing: true });
  const createStarted = performance.now();
  const added = git(run.project_root, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
  invariant(added.status === 0, "WORKTREE_CREATE_FAILED", `Cannot create task worktree: ${added.stderr || added.error}`);
  performanceEvent(db, run.id, "performance.worktree-create", { operationId, taskId: task.id, durationMs: performance.now() - createStarted });
  try {
    const overlayStarted = performance.now();
    overlayCurrentWorkspace(run.project_root, worktreePath);
    performanceEvent(db, run.id, "performance.worktree-overlay", { operationId, taskId: task.id, durationMs: performance.now() - overlayStarted });
  } catch (error) {
    removeGitWorktree(run.project_root, worktreePath);
    throw error;
  }
  const baseRef = git(worktreePath, ["rev-parse", "HEAD"], { timeout: 5000 }).stdout.trim();
  const timestamp = now();
  db.prepare(`
    INSERT INTO worktrees(id, task_id, run_id, attempt_fence, path, mode, status, base_ref, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, 'git-worktree', 'active', ?, ?, ?)
  `).run(`wt_${task.id}_${fence}`, task.id, run.id, fence, worktreePath, baseRef || null, timestamp, timestamp);
  db.prepare("UPDATE tasks SET workspace_mode = 'git-worktree' WHERE id = ? AND attempt_fence = ?").run(task.id, fence);
  return { mode: "git-worktree", path: worktreePath, baseRef, attemptFence: fence };
}

export function getTaskWorkspace(db, task, projectRoot) {
  if (task.readOnly) return { mode: "shared", path: projectRoot };
  const row = db.prepare("SELECT * FROM worktrees WHERE task_id = ? AND attempt_fence = ? ORDER BY created_at DESC LIMIT 1")
    .get(task.id, Number(task.attempt_fence));
  invariant(row && row.status === "active", "WORKTREE_NOT_ACTIVE", `Task ${task.id} has no active workspace for attempt ${task.attempt_fence}.`);
  return { mode: row.mode, path: row.path, record: row };
}

function integrationOwnerToken() {
  return randomBytes(24).toString("hex");
}

export function acquireIntegrationLock(db, runId, seconds) {
  const started = performance.now();
  const name = "main-workspace";
  const ownerToken = integrationOwnerToken();
  const timeoutMs = Math.max(1000, Number(seconds) * 1000);
  db.exec(`PRAGMA busy_timeout = ${Math.floor(timeoutMs)}`);
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db.exec("PRAGMA busy_timeout = 5000");
    throw error;
  }
  let closed = false;
  try {
    const existing = db.prepare("SELECT * FROM integration_locks WHERE name = ?").get(name);
    invariant(!existing, "INTEGRATION_LOCK_ORPHANED", "An orphaned integration lock exists. Reset the run state before continuing.");
    db.prepare(`
      INSERT INTO integration_locks(name, run_id, owner_token, fencing_token, expires_at, updated_at)
      VALUES(?, ?, ?, 1, '9999-12-31T23:59:59.999Z', ?)
    `).run(name, runId, ownerToken, now());
    performanceEvent(db, runId, "performance.integration-lock", { operationId: `lock_${process.pid}_${Date.now()}`, durationMs: performance.now() - started, phase: "acquired" });
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    db.exec("PRAGMA busy_timeout = 5000");
    throw error;
  }
  const assertOwned = () => {
    const row = db.prepare("SELECT * FROM integration_locks WHERE name = ?").get(name);
    invariant(row && row.owner_token === ownerToken && row.run_id === runId, "INTEGRATION_LOCK_FENCED", "The integration lock changed during integration.");
    return row;
  };
  const heartbeat = () => {
    assertOwned();
    db.prepare("UPDATE integration_locks SET updated_at = ? WHERE name = ? AND owner_token = ?")
      .run(now(), name, ownerToken);
  };
  const release = () => {
    if (closed) return;
    assertOwned();
    db.prepare("DELETE FROM integration_locks WHERE name = ? AND owner_token = ?").run(name, ownerToken);
    db.exec("COMMIT");
    db.exec("PRAGMA busy_timeout = 5000");
    closed = true;
  };
  const abort = () => {
    if (closed) return;
    try { db.exec("ROLLBACK"); } catch {}
    db.exec("PRAGMA busy_timeout = 5000");
    closed = true;
  };
  return { ownerToken, fencingToken: 1, assertOwned, heartbeat, release, abort };
}


function recordedTaskChangesSince(db, run, taskId, capturedAt) {
  const paths = new Set();
  const rows = db.prepare(`
    SELECT id FROM artifacts
    WHERE run_id = ? AND task_id <> ? AND kind LIKE 'task-changes:%'
      AND status = 'verified' AND updated_at >= ?
    ORDER BY updated_at
  `).all(run.id, taskId, capturedAt);
  for (const row of rows) {
    const artifact = db.prepare("SELECT content_ref FROM artifacts WHERE id = ?").get(row.id);
    if (!artifact?.content_ref) continue;
    // The caller stores task change paths in the result and active leases cover in-flight work.
    const taskRow = db.prepare("SELECT result_json FROM tasks WHERE id = (SELECT task_id FROM artifacts WHERE id = ?)").get(row.id);
    try {
      const result = JSON.parse(taskRow?.result_json ?? "{}");
      for (const file of result.ActualChangedFiles ?? []) paths.add(normalizeRepoPath(String(file)));
    } catch {}
  }
  return paths;
}

function recoveryPatch(workspacePath, changedPaths) {
  if (changedPaths.length === 0 || !gitAvailable(workspacePath)) return "";
  const pathspec = ["--", ...changedPaths];
  git(workspacePath, ["add", "-N", ...pathspec]);
  const diff = git(workspacePath, ["diff", "--binary", "--no-ext-diff", ...pathspec], { maxBuffer: 256 * 1024 * 1024 });
  git(workspacePath, ["reset", "--quiet", ...pathspec]);
  return diff.status === 0 ? diff.stdout : "";
}

function integrateChanges(db, run, task, workspacePath, baseline, finalSnapshot, changedPaths, config) {
  const integrationStarted = performance.now();
  const lock = acquireIntegrationLock(db, run.id, Number(config.worktrees?.integrationLockSeconds ?? 120));
  let integrationJournal = null;
  let handedOff = false;
  try {
    lock.heartbeat();
    validateMutableOwnershipPaths(run.project_root, changedPaths);
    for (const relative of changedPaths) {
      lock.heartbeat();
      const current = snapshotEntry(run.project_root, relative);
      const expected = baseline[relative] ?? null;
      invariant(stableStringify(current) === stableStringify(expected), "WORKTREE_INTEGRATION_CONFLICT",
        `The main workspace changed after task claim: ${relative}.`, { path: relative, expected, current });
    }
    integrationJournal = activateIntegrationJournal(run.project_root, {
      runId: run.id,
      taskId: task.id,
      attemptFence: task.attempt_fence,
      targetPaths: task.targetPaths,
      paths: changedPaths
    });
    try {
      for (const relative of changedPaths) {
        lock.heartbeat();
        const finalEntry = finalSnapshot[relative] ?? null;
        const target = path.join(run.project_root, relative);
        if (!finalEntry) rmSync(target, { recursive: true, force: true });
        else copyEntry(workspacePath, run.project_root, relative);
      }
      performanceEvent(db, run.id, "performance.integration-copy", {
        operationId: `copy_${task.id}_${task.attempt_fence}_${Date.now()}`, taskId: task.id,
        files: changedPaths.length, durationMs: performance.now() - integrationStarted
      });
      lock.assertOwned();
      const currentTask = db.prepare("SELECT attempt_fence, status FROM tasks WHERE id = ?").get(task.id);
      invariant(currentTask?.status === "running" && Number(currentTask.attempt_fence) === Number(task.attempt_fence),
        "TASK_FENCED", `Task ${task.id} attempt changed during integration.`);
      handedOff = true;
    } catch (error) {
      restoreIntegrationJournal(integrationJournal);
      removeIntegrationJournal(integrationJournal);
      integrationJournal = null;
      throw error;
    }
  } finally {
    if (!handedOff) lock.abort();
  }
  return { journal: integrationJournal, lock };
}


export function finalizeTaskWorkspace(db, run, task, resultStatus, reportedFiles, baseline, config) {
  const workspace = getTaskWorkspace(db, task, run.project_root);
  const finalSnapshot = snapshotWorkspace(workspace.path, config);
  const allChangedPaths = changedSnapshotPaths(baseline.repositoryFiles ?? {}, finalSnapshot);
  const recordedOtherChanges = workspace.mode === "shared"
    ? recordedTaskChangesSince(db, run, task.id, baseline.capturedAt ?? now())
    : new Set();
  const otherLeases = workspace.mode === "shared"
    ? db.prepare("SELECT resource FROM leases WHERE task_id <> ? AND resource NOT LIKE '@task:%'").all(task.id)
    : [];
  const outOfScope = allChangedPaths.filter((file) => {
    if (!task.readOnly && task.targetPaths.some((target) => pathsOverlap(file, target))) return false;
    if (workspace.mode === "shared" && recordedOtherChanges.has(file)) return false;
    if (workspace.mode === "shared" && otherLeases.some((lease) => pathsOverlap(file, lease.resource))) return false;
    return true;
  });
  invariant(
    outOfScope.length === 0,
    task.readOnly ? "READ_ONLY_TASK_MUTATION" : "TASK_OUT_OF_SCOPE_MUTATION",
    task.readOnly
      ? `Read-only task ${task.id} modified files: ${outOfScope.join(", ")}.`
      : `Task ${task.id} produced unowned repository changes outside TargetPaths: ${outOfScope.join(", ")}.`,
    { changedPaths: allChangedPaths, targetPaths: task.targetPaths }
  );
  const changedPaths = task.readOnly
    ? []
    : allChangedPaths.filter((file) => task.targetPaths.some((target) => pathsOverlap(file, target)));
  const symlinkChanges = changedPaths.filter((file) => finalSnapshot[file]?.type === "symlink");
  invariant(
    symlinkChanges.length === 0,
    "TASK_SYMLINK_MUTATION",
    `Task ${task.id} created or changed symbolic links: ${symlinkChanges.join(", ")}.`,
    { symlinkChanges }
  );
  const reported = new Set(reportedFiles.map(normalizeRepoPath));
  const unreported = changedPaths.filter((file) => !reported.has(file));
  const overreported = [...reported].filter((file) => !changedPaths.includes(file));
  invariant(unreported.length === 0, "TASK_FILES_UNREPORTED", `Task ${task.id} did not report every changed owned file. Missing: ${unreported.join(", ")}.`, { changedPaths, unreported });
  invariant(overreported.length === 0, "TASK_FILES_OVERREPORTED", `Task ${task.id} reported unchanged files: ${overreported.join(", ")}.`, { changedPaths, overreported });

  let integrated = false;
  let integrationJournal = null;
  let integrationLock = null;
  // Generate and persist the diagnostic patch before taking the serialized
  // main-workspace lock. This is read-only work against the task worktree and
  // should not extend the mutable integration critical section.
  const patch = recoveryPatch(workspace.path, changedPaths);
  const patchRef = storeObject(db, run.project_root, `task-workspace-patch:${task.id}`, json({
    version: 2,
    taskId: task.id,
    workspaceMode: workspace.mode,
    resultStatus,
    changedPaths,
    patchFormat: "git-binary-diff",
    patch,
    before: Object.fromEntries(changedPaths.map((file) => [file, baseline.repositoryFiles?.[file] ?? null])),
    after: Object.fromEntries(changedPaths.map((file) => [file, finalSnapshot[file] ?? null]))
  }));
  try {
    if (workspace.mode === "git-worktree" && resultStatus === "COMPLETED") {
      const integration = integrateChanges(db, run, task, workspace.path, baseline.repositoryFiles ?? {}, finalSnapshot, changedPaths, config);
      integrationJournal = integration.journal;
      integrationLock = integration.lock;
      integrated = true;
    }
    if (workspace.mode === "git-worktree") {
      const keep = resultStatus === "COMPLETED" ? config.worktrees?.keepCompleted : config.worktrees?.keepFailed;
      // Removing a detached worktree does not participate in main-workspace
      // integration. Defer that cleanup until the caller releases the DB
      // integration transaction when a completed task was integrated.
      const deferCleanup = Boolean(integrated && !keep);
      if (!keep && !deferCleanup) removeGitWorktree(run.project_root, workspace.path);
      db.prepare("UPDATE worktrees SET status = ?, patch_ref = ?, updated_at = ? WHERE task_id = ? AND attempt_fence = ?")
        .run(integrated ? "integrated" : resultStatus.toLowerCase(), patchRef, now(), task.id, Number(task.attempt_fence));
      return {
        actualChangedFiles: changedPaths,
        workspaceMode: workspace.mode,
        workspacePath: workspace.path,
        integrated,
        patchRef,
        integrationJournal,
        integrationLock,
        deferredWorktreeCleanup: deferCleanup
      };
    }
    return {
      actualChangedFiles: changedPaths,
      workspaceMode: workspace.mode,
      workspacePath: workspace.path,
      integrated,
      patchRef,
      integrationJournal,
      integrationLock,
      deferredWorktreeCleanup: false
    };
  } catch (error) {
    if (integrationLock) {
      try { integrationLock.abort(); } catch {}
    }
    if (integrationJournal) {
      let restored = false;
      try {
        restoreIntegrationJournal(integrationJournal);
        restored = true;
      } finally {
        // A failed restore is precisely when the journal is needed most.
        if (restored) removeIntegrationJournal(integrationJournal);
      }
    }
    throw error;
  }
}

export function cleanupTaskWorkspace(db, projectRoot, taskId, status = "abandoned", attemptFence = null) {
  const started = performance.now();
  const row = attemptFence === null
    ? db.prepare("SELECT * FROM worktrees WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId)
    : db.prepare("SELECT * FROM worktrees WHERE task_id = ? AND attempt_fence = ?").get(taskId, Number(attemptFence));
  if (!row) return false;
  removeGitWorktree(projectRoot, row.path);
  db.prepare("UPDATE worktrees SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), row.id);
  performanceEvent(db, row.run_id, "performance.worktree-cleanup", { operationId: `cleanup_${row.id}_${Date.now()}`, taskId, durationMs: performance.now() - started, status });
  return true;
}

export function cleanStaleWorktrees(db, projectRoot, options = {}) {
  const maxAgeMs = Math.max(0, Number(options.maxAgeMinutes ?? 120)) * 60_000;
  const dryRun = Boolean(options.dryRun);
  const activeTasks = new Set(db.prepare("SELECT id FROM tasks WHERE status = 'running'").all().map((row) => row.id));
  const rows = db.prepare("SELECT * FROM worktrees").all();
  const registered = new Set(rows.map((row) => physicalPath(row.path)));
  const removed = [];

  for (const row of rows) {
    const age = Date.now() - Date.parse(row.updated_at);
    if (activeTasks.has(row.task_id) || age < maxAgeMs) continue;
    const absolute = path.resolve(row.path);
    if (!dryRun) {
      removeGitWorktree(projectRoot, row.path);
      db.prepare("UPDATE worktrees SET status = 'cleaned', updated_at = ? WHERE id = ?").run(now(), row.id);
    }
    removed.push(absolute);
  }

  const root = path.resolve(runtimeArea(projectRoot, "worktrees"));
  const gitWorktrees = new Set(
    git(projectRoot, ["worktree", "list", "--porcelain"]).stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.resolve(line.slice("worktree ".length)))
      .filter((candidate) => candidate.startsWith(`${root}${path.sep}`))
  );

  const hasRegisteredDescendant = (candidate) =>
    [...registered].some((known) => known.startsWith(`${physicalPath(candidate)}${path.sep}`));

  const collectOrphans = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      const canonical = physicalPath(absolute);
      if (registered.has(canonical)) continue;
      if (hasRegisteredDescendant(absolute)) {
        try {
          if (lstatSync(absolute).isDirectory()) collectOrphans(absolute);
        } catch {}
        continue;
      }
      let stat;
      try { stat = lstatSync(absolute); } catch { continue; }
      const age = Date.now() - stat.mtimeMs;
      if (age < maxAgeMs) continue;
      removed.push(absolute);
      if (dryRun) continue;
      if (gitWorktrees.has(canonical)) removeGitWorktree(projectRoot, absolute);
      else rmSync(absolute, { recursive: true, force: true });
    }
  };
  collectOrphans(root);

  if (!dryRun && existsSync(root)) {
    const removeEmptyDirectories = (directory) => {
      for (const entry of readdirSync(directory)) {
        const absolute = path.join(directory, entry);
        try {
          if (lstatSync(absolute).isDirectory()) removeEmptyDirectories(absolute);
        } catch {}
      }
      if (directory !== root) {
        try { if (readdirSync(directory).length === 0) rmSync(directory, { recursive: true, force: true }); } catch {}
      }
    };
    removeEmptyDirectories(root);
    const pruned = git(projectRoot, ["worktree", "prune"]);
    if (pruned.status !== 0) throw new Error(`Cannot prune Git worktrees: ${pruned.stderr || pruned.error || "git worktree prune failed"}`);
  }
  return [...new Set(removed)].sort();
}
