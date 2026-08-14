import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync
} from "node:fs";
import path from "node:path";
import { runtimeRoot } from "./paths.js";
import { isSafeRepoPath, makeId, normalizeRepoPath, now, stableStringify } from "./util.js";

const JOURNAL_VERSION = 1;
const JOURNAL_DIRECTORY = "integration-journal";

export function integrationJournalRoot(projectRoot) {
  return path.join(runtimeRoot(projectRoot), JOURNAL_DIRECTORY);
}

function durableWrite(file, contents, mode = 0o600) {
  const descriptor = openSync(file, "w", mode);
  try {
    writeSync(descriptor, contents, null, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(file, mode);
}

function durableCopy(source, target, mode) {
  copyFileSync(source, target);
  const descriptor = openSync(target, "r+");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  chmodSync(target, mode);
}

function syncDirectory(directory) {
  try {
    const descriptor = openSync(directory, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  } catch {}
}

function safeRelative(value, label) {
  const relative = normalizeRepoPath(String(value));
  if (!isSafeRepoPath(relative) || relative === ".") {
    throw new Error(`Invalid integration journal ${label}: ${value}.`);
  }
  return relative;
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertParentIsSafe(projectRoot, relative) {
  let current = path.resolve(projectRoot);
  const parts = path.dirname(relative).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Integration journal path crosses a symbolic link: ${relative}.`);
    }
  }
}

function currentOriginal(projectRoot, relative, backupDirectory, backupName) {
  assertParentIsSafe(projectRoot, relative);
  const target = path.join(projectRoot, relative);
  let stat;
  try { stat = lstatSync(target); } catch (error) {
    if (error.code === "ENOENT") return { path: relative, state: "absent" };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return {
      path: relative,
      state: "symlink",
      target: readlinkSync(target),
      mode: stat.mode & 0o777
    };
  }
  if (!stat.isFile()) throw new Error(`Integration journal cannot back up non-file path: ${relative}.`);
  const backup = path.join(backupDirectory, backupName);
  durableCopy(target, backup, stat.mode & 0o777);
  return { path: relative, state: "file", backup: path.join("originals", backupName), mode: stat.mode & 0o777 };
}

function validateManifest(manifest) {
  if (!manifest || manifest.version !== JOURNAL_VERSION || typeof manifest.id !== "string") {
    throw new Error("Invalid integration journal manifest.");
  }
  if (!Array.isArray(manifest.paths) || !Array.isArray(manifest.originals)) {
    throw new Error("Integration journal manifest paths are invalid.");
  }
  for (const relative of manifest.paths) safeRelative(relative, "path");
  for (const original of manifest.originals) {
    safeRelative(original?.path, "original path");
    if (!["absent", "file", "symlink"].includes(original?.state)) {
      throw new Error(`Invalid integration journal original state for ${original?.path}.`);
    }
    if (original.state === "file") {
      const backup = String(original.backup ?? "");
      if (!backup || path.isAbsolute(backup) || !isSafeRepoPath(backup) || backup === ".") {
        throw new Error(`Invalid integration journal backup for ${original.path}.`);
      }
    }
  }
  return manifest;
}

export function activateIntegrationJournal(projectRoot, details) {
  if (!details?.runId || !details?.taskId || !Number.isFinite(Number(details.attemptFence))) {
    throw new Error("Integration journal activation needs an explicit run, task, and attempt fence.");
  }
  const paths = [...new Set((details.paths ?? []).map((value) => safeRelative(value, "path")))].sort();
  const targetPaths = [...new Set((details.targetPaths ?? []).map((value) => {
    const relative = normalizeRepoPath(String(value));
    if (!isSafeRepoPath(relative)) throw new Error(`Invalid integration journal target path: ${value}.`);
    return relative;
  }))].sort();
  const root = integrationJournalRoot(projectRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = makeId("integration");
  const temporary = path.join(root, `.tmp-${id}`);
  const active = path.join(root, `journal-${id}`);
  const backupDirectory = path.join(temporary, "originals");
  try {
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const originals = paths.map((relative, index) => currentOriginal(projectRoot, relative, backupDirectory, `${index}.bak`));
    const manifest = validateManifest({
      version: JOURNAL_VERSION,
      id,
      runId: String(details.runId),
      taskId: String(details.taskId),
      attemptFence: Number(details.attemptFence),
      paths,
      targetPaths,
      originals,
      createdAt: now()
    });
    durableWrite(path.join(temporary, "journal.json"), `${stableStringify(manifest)}\n`);
    syncDirectory(backupDirectory);
    syncDirectory(temporary);
    renameSync(temporary, active);
    syncDirectory(root);
    return { projectRoot, directory: active, manifest };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function readJournal(projectRoot, directory) {
  const manifest = validateManifest(JSON.parse(readFileSync(path.join(directory, "journal.json"), "utf8")));
  return { projectRoot, directory, manifest };
}

export function cleanupIncompleteIntegrationJournals(projectRoot) {
  const root = integrationJournalRoot(projectRoot);
  if (!existsSync(root)) return [];
  const removed = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith(".tmp-")) continue;
    rmSync(path.join(root, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

export function listIntegrationJournals(projectRoot) {
  cleanupIncompleteIntegrationJournals(projectRoot);
  const root = integrationJournalRoot(projectRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("journal-"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => readJournal(projectRoot, path.join(root, entry.name)));
}

/**
 * Keep a journal that cannot be safely associated with the current task
 * attempt out of the recovery scan.  Quarantine is deliberately a rename,
 * not deletion: the journal remains available for forensic/manual recovery.
 */
export function quarantineIntegrationJournal(journal) {
  const root = integrationJournalRoot(journal.projectRoot);
  const suffix = journal.manifest?.id ?? path.basename(journal.directory).replace(/^journal-/u, "unknown");
  let target = path.join(root, `quarantine-${suffix}`);
  let counter = 0;
  while (existsSync(target)) {
    counter += 1;
    target = path.join(root, `quarantine-${suffix}-${counter}`);
  }
  renameSync(journal.directory, target);
  syncDirectory(root);
  return target;
}

export function restoreIntegrationJournal(journal) {
  const { projectRoot, directory, manifest } = journal;
  validateManifest(manifest);
  for (const original of manifest.originals) {
    assertParentIsSafe(projectRoot, original.path);
    const target = path.join(projectRoot, original.path);
    rmSync(target, { recursive: true, force: true });
    if (original.state === "absent") continue;
    mkdirSync(path.dirname(target), { recursive: true });
    if (original.state === "symlink") {
      symlinkSync(original.target, target);
      continue;
    }
    const backup = path.join(directory, original.backup);
    if (!inside(directory, backup) || !existsSync(backup)) throw new Error(`Missing integration journal backup for ${original.path}.`);
    durableCopy(backup, target, Number(original.mode) & 0o777);
  }
  syncDirectory(projectRoot);
}

export function removeIntegrationJournal(journal) {
  rmSync(journal.directory, { recursive: true, force: true });
  syncDirectory(integrationJournalRoot(journal.projectRoot));
}
