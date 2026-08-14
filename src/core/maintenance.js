import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { invariant } from "./errors.js";
import { runtimeArea, runtimeDatabasePath, runtimeRoot, storageInventory } from "./paths.js";
import { cleanStaleWorktrees } from "./worktrees.js";
import { parseJson } from "./util.js";

const CLEAN_SCOPES = Object.freeze(new Set(["cache", "generated", "benchmarks", "worktrees", "all"]));

function hashFromRef(ref) {
  return typeof ref === "string" && ref.startsWith("obj_") ? ref.slice(4) : null;
}

function referencedObjectHashes(db, options = {}) {
  const excludedSnapshots = new Set(options.excludeContextSnapshotIds ?? []);
  const hashes = new Set();
  const add = (ref) => {
    const hash = hashFromRef(ref);
    if (hash) hashes.add(hash);
  };
  const addDeep = (value) => {
    if (typeof value === "string") return add(value);
    if (Array.isArray(value)) return value.forEach(addDeep);
    if (value && typeof value === "object") Object.values(value).forEach(addDeep);
  };
  const addJsonColumn = (query, column) => {
    for (const row of db.prepare(query).all()) addDeep(parseJson(row[column], {}));
  };

  for (const row of db.prepare("SELECT content_ref, metadata_json FROM artifacts WHERE content_ref IS NOT NULL OR metadata_json <> '{}'").all()) {
    add(row.content_ref);
    addDeep(parseJson(row.metadata_json, {}));
  }
  for (const row of db.prepare("SELECT output_ref FROM checks WHERE output_ref IS NOT NULL").all()) add(row.output_ref);
  for (const row of db.prepare("SELECT id, content_ref FROM context_snapshots WHERE content_ref IS NOT NULL").all()) {
    if (!excludedSnapshots.has(row.id)) add(row.content_ref);
  }
  addJsonColumn("SELECT result_json FROM tasks WHERE result_json IS NOT NULL", "result_json");
  addJsonColumn("SELECT sources_json FROM findings WHERE sources_json <> '[]'", "sources_json");
  addJsonColumn("SELECT evidence_refs_json FROM decisions WHERE evidence_refs_json <> '[]'", "evidence_refs_json");
  addJsonColumn("SELECT watch_refs_json FROM decisions WHERE watch_refs_json <> '[]'", "watch_refs_json");
  addJsonColumn("SELECT evidence_refs_json FROM document_impacts WHERE evidence_refs_json <> '[]'", "evidence_refs_json");
  addJsonColumn("SELECT evidence_refs_json FROM trace_links WHERE evidence_refs_json <> '[]'", "evidence_refs_json");
  addJsonColumn("SELECT evidence_refs_json FROM assumptions WHERE evidence_refs_json <> '[]'", "evidence_refs_json");
  addJsonColumn("SELECT evidence_refs_json FROM invariants WHERE evidence_refs_json <> '[]'", "evidence_refs_json");
  addJsonColumn("SELECT verification_refs_json FROM invariants WHERE verification_refs_json <> '[]'", "verification_refs_json");
  addJsonColumn("SELECT evidence_refs_json FROM risks WHERE evidence_refs_json <> '[]'", "evidence_refs_json");
  addJsonColumn("SELECT verification_refs_json FROM risks WHERE verification_refs_json <> '[]'", "verification_refs_json");
  addJsonColumn("SELECT evidence_refs_json FROM review_findings WHERE evidence_refs_json <> '[]'", "evidence_refs_json");
  addJsonColumn("SELECT payload_json FROM journal WHERE payload_json <> '{}'", "payload_json");
  for (const row of db.prepare("SELECT content_ref FROM self_evaluations WHERE content_ref IS NOT NULL").all()) add(row.content_ref);
  for (const row of db.prepare("SELECT patch_ref, baseline_ref FROM worktrees WHERE patch_ref IS NOT NULL OR baseline_ref IS NOT NULL").all()) {
    add(row.patch_ref);
    add(row.baseline_ref);
  }
  if (!options.excludeBenchmarkRuns) {
    for (const row of db.prepare("SELECT result_ref FROM benchmark_runs WHERE result_ref IS NOT NULL").all()) add(row.result_ref);
  }
  return hashes;
}

function listObjectFiles(directory, relative = "") {
  if (!existsSync(directory)) return [];
  const output = [];
  for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...listObjectFiles(directory, child));
    else if (entry.isFile()) output.push(child.replaceAll(path.sep, "/"));
  }
  return output;
}

export function tokenMetrics(db, runId = null) {
  const where = runId ? "WHERE run_id = ?" : "";
  const params = runId ? [runId] : [];
  const snapshots = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(estimated_tokens), 0) AS total_tokens,
           COALESCE(AVG(estimated_tokens), 0) AS average_tokens,
           COALESCE(MAX(estimated_tokens), 0) AS max_tokens,
           COALESCE(SUM(observed_tokens), 0) AS observed_tokens
    FROM context_snapshots ${where}
  `).get(...params);
  const latest = db.prepare(`
    SELECT role, model, token_budget, estimated_tokens, observed_tokens,
           remaining_tokens, token_method, content_ref, created_at
    FROM context_snapshots ${where}
    ORDER BY created_at DESC LIMIT 1
  `).get(...params) ?? null;
  const usage = db.prepare(`
    SELECT COUNT(*) AS samples,
           COALESCE(SUM(observed_input_tokens), 0) AS input_tokens,
           COALESCE(SUM(observed_output_tokens), 0) AS output_tokens,
           COALESCE(SUM(estimated_tokens), 0) AS estimated_tokens
    FROM usage_samples ${where}
  `).get(...params);
  const objects = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(bytes), 0) AS bytes,
           COALESCE(SUM(compressed_bytes), 0) AS compressed_bytes
    FROM objects
  `).get();
  const externalized = db.prepare(`
    SELECT COALESCE(SUM(bytes), 0) AS bytes
    FROM objects
    WHERE kind LIKE 'task-result:%' OR kind LIKE 'task-structured-result:%'
       OR kind LIKE 'check:%' OR kind LIKE 'task-workspace-diff:%'
  `).get();
  const events = runId
    ? db.prepare("SELECT COUNT(*) AS unique_events, COALESCE(SUM(count), 0) AS total_events FROM events WHERE run_id = ?").get(runId)
    : db.prepare("SELECT COUNT(*) AS unique_events, COALESCE(SUM(count), 0) AS total_events FROM events").get();
  return {
    runId,
    mainContext: {
      snapshots: Number(snapshots.count),
      totalEstimatedTokens: Number(snapshots.total_tokens),
      totalObservedTokens: Number(snapshots.observed_tokens),
      averageEstimatedTokens: Math.round(Number(snapshots.average_tokens)),
      maxEstimatedTokens: Number(snapshots.max_tokens),
      latest
    },
    observedUsage: {
      samples: Number(usage.samples),
      inputTokens: Number(usage.input_tokens),
      outputTokens: Number(usage.output_tokens),
      estimatedTokens: Number(usage.estimated_tokens)
    },
    externalizedWorkingIo: {
      bytes: Number(externalized.bytes),
      approximateFourByteTokens: Math.ceil(Number(externalized.bytes) / 4)
    },
    objectStore: {
      objects: Number(objects.count),
      bytes: Number(objects.bytes),
      compressedBytes: Number(objects.compressed_bytes),
      compressionRatio: Number(objects.bytes) === 0 ? 1 : Number((Number(objects.compressed_bytes) / Number(objects.bytes)).toFixed(3))
    },
    events: {
      unique: Number(events.unique_events),
      totalOccurrences: Number(events.total_events),
      collapsedOccurrences: Number(events.total_events) - Number(events.unique_events)
    }
  };
}

export function garbageCollect(db, projectRoot, options = {}) {
  const keepContexts = Math.max(1, Number(options.keepContexts ?? 20));
  const dryRun = options.dryRun === true;
  const runs = db.prepare("SELECT id FROM runs").all();
  const snapshotIds = [];
  for (const run of runs) {
    snapshotIds.push(...db.prepare(`
      SELECT id FROM context_snapshots
      WHERE run_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?
    `).all(run.id, keepContexts).map((row) => row.id));
  }

  const referenced = referencedObjectHashes(db, {
    excludeContextSnapshotIds: snapshotIds,
    excludeBenchmarkRuns: options.excludeBenchmarkRuns === true
  });
  const rows = db.prepare("SELECT hash, path, compressed_bytes FROM objects").all();
  const unreferenced = rows.filter((row) => !referenced.has(row.hash));
  const registeredPaths = new Set(rows.map((row) => row.path.replace(/^objects\//u, "")));
  const objectDirectory = runtimeArea(projectRoot, "objects");
  const orphanFiles = listObjectFiles(objectDirectory).filter((relative) => !registeredPaths.has(relative));

  if (!dryRun) {
    const removeSnapshot = db.prepare("DELETE FROM context_snapshots WHERE id = ?");
    for (const id of snapshotIds) removeSnapshot.run(id);
    for (const row of unreferenced) {
      const file = path.join(runtimeRoot(projectRoot), row.path);
      if (existsSync(file)) rmSync(file, { force: true });
      db.prepare("DELETE FROM objects WHERE hash = ?").run(row.hash);
    }
    for (const relative of orphanFiles) rmSync(path.join(objectDirectory, relative), { force: true });
  }
  const candidateCompressedBytes = unreferenced.reduce((sum, row) => sum + Number(row.compressed_bytes), 0);
  return {
    dryRun,
    keepContexts,
    candidateSnapshots: snapshotIds.length,
    removedSnapshots: dryRun ? 0 : snapshotIds.length,
    candidateObjects: unreferenced.length,
    removedObjects: dryRun ? 0 : unreferenced.length,
    candidateOrphanFiles: orphanFiles.length,
    removedOrphanFiles: dryRun ? 0 : orphanFiles.length,
    candidateCompressedBytes,
    removedCompressedBytes: dryRun ? 0 : candidateCompressedBytes
  };
}

function clearArea(projectRoot, area, dryRun) {
  const directory = runtimeArea(projectRoot, area);
  const existed = existsSync(directory);
  const before = storageInventory(projectRoot).areas.find((item) => item.name === area) ?? { bytes: 0, files: 0, directories: 0 };
  if (existed && !dryRun) rmSync(directory, { recursive: true, force: true });
  if (!dryRun) mkdirSync(directory, { recursive: true });
  return {
    area,
    path: `.metis/${area}/`,
    existed,
    candidateBytes: before.bytes,
    candidateFiles: before.files,
    removed: existed && !dryRun
  };
}

function normalizeScopes(input) {
  const raw = input ?? ["cache"];
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const scopes = [...new Set(values.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  invariant(scopes.length > 0, "CLEAN_SCOPE", "Select at least one cleanup scope.");
  for (const scope of scopes) invariant(CLEAN_SCOPES.has(scope), "CLEAN_SCOPE", `Unsupported cleanup scope: ${scope}.`);
  return scopes.includes("all") ? ["all"] : scopes;
}

export function cleanRuntime(db, projectRoot, options = {}) {
  const keepContexts = Math.max(1, Number(options.keepContexts ?? 5));
  const dryRun = options.dryRun === true;
  const scopes = normalizeScopes(options.scopes);
  const all = scopes.includes("all");
  const cleanBenchmarks = all || scopes.includes("benchmarks");
  const activeTasks = Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'").get().count);
  const benchmarkRuns = cleanBenchmarks
    ? Number(db.prepare("SELECT COUNT(*) AS count FROM benchmark_runs").get().count)
    : 0;
  if (cleanBenchmarks && !dryRun) db.prepare("DELETE FROM benchmark_runs").run();
  const gc = (all || scopes.includes("cache") || cleanBenchmarks)
    ? garbageCollect(db, projectRoot, {
      keepContexts,
      dryRun,
      excludeBenchmarkRuns: cleanBenchmarks
    })
    : null;
  const selectedAreas = new Set();
  if (all || scopes.includes("cache")) {
    selectedAreas.add("cache");
    selectedAreas.add("logs");
    if (activeTasks === 0 || options.forceEphemeral === true) selectedAreas.add("tmp");
  }
  if (all || scopes.includes("generated")) selectedAreas.add("generated");
  if (all || scopes.includes("benchmarks")) selectedAreas.add("benchmarks");

  const areas = [...selectedAreas].map((area) => clearArea(projectRoot, area, dryRun));
  const cleanWorktrees = all || scopes.includes("worktrees") || scopes.includes("cache");
  const explicitWorktrees = all || scopes.includes("worktrees");
  const worktreeMaxAgeMinutes = explicitWorktrees
    ? 0
    : Math.max(0, Number(options.worktreeMaxAgeMinutes ?? 24 * 60));
  const worktreeCandidates = cleanWorktrees
    ? cleanStaleWorktrees(db, projectRoot, { maxAgeMinutes: worktreeMaxAgeMinutes, dryRun })
    : [];
  if (cleanWorktrees) {
    const worktreeRoot = runtimeArea(projectRoot, "worktrees");
    const orphanEntries = existsSync(worktreeRoot) ? readdirSync(worktreeRoot).length : 0;
    const clearAllWorktreeFiles = activeTasks === 0 && worktreeMaxAgeMinutes === 0;
    if (clearAllWorktreeFiles && !dryRun) {
      rmSync(worktreeRoot, { recursive: true, force: true });
      mkdirSync(worktreeRoot, { recursive: true });
    }
    areas.push({
      area: "worktrees",
      path: ".metis/worktrees/",
      candidateEntries: Math.max(worktreeCandidates.length, orphanEntries),
      removedEntries: dryRun ? 0 : clearAllWorktreeFiles ? orphanEntries : worktreeCandidates.length,
      removed: false,
      cleared: clearAllWorktreeFiles && !dryRun,
      preservedForActiveTasks: activeTasks > 0,
      maxAgeMinutes: worktreeMaxAgeMinutes
    });
  }

  return {
    mode: "clean",
    scopes,
    dryRun,
    activeTasks,
    database: runtimeDatabasePath(projectRoot),
    benchmarkRuns: {
      candidates: benchmarkRuns,
      removed: dryRun ? 0 : benchmarkRuns
    },
    gc,
    areas,
    removedDirectories: areas.filter((item) => item.removed).map((item) => item.area),
    removedWorktrees: dryRun ? [] : worktreeCandidates,
    preserved: [
      ".metis/state/",
      ".metis/objects/ (referenced objects)",
      ".metis/config.json",
      ".metis/layout.json",
      ".metis/backups/",
      ...((all || scopes.includes("benchmarks")) ? [] : [".metis/benchmarks/"]),
      ...((all || scopes.includes("generated")) ? [] : [".metis/generated/"]),
      ...(activeTasks > 0 ? ["active task worktrees and task staging files"] : [])
    ]
  };
}

function runtimeGitWorktrees(projectRoot) {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return [];
  const physicalPath = (value) => {
    const absolute = path.resolve(value);
    try { return realpathSync.native(absolute); } catch {}
    const parent = path.dirname(absolute);
    try { return path.join(realpathSync.native(parent), path.basename(absolute)); } catch { return absolute; }
  };
  const root = physicalPath(runtimeArea(projectRoot, "worktrees"));
  const projectPhysical = physicalPath(projectRoot);
  return String(result.stdout ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => {
      const candidate = path.resolve(line.slice("worktree ".length));
      const canonical = physicalPath(candidate);
      const relative = path.relative(projectPhysical, canonical);
      return relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        ? path.join(projectRoot, relative)
        : candidate;
    })
    .filter((candidate) => {
      const canonical = physicalPath(candidate);
      return canonical === root || canonical.startsWith(`${root}${path.sep}`);
    });
}

export function resetRuntime(projectRoot, options = {}) {
  const directory = runtimeRoot(projectRoot);
  const existed = existsSync(directory);
  const dryRun = options.dryRun === true;
  const worktrees = runtimeGitWorktrees(projectRoot);
  if (!dryRun) {
    for (const worktree of worktrees) {
      const removed = spawnSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "ignore", "ignore"]
      });
      if (removed.status !== 0) {
        const error = new Error(`Cannot remove Git worktree ${worktree}.`);
        error.code = "WORKTREE_REMOVE_FAILED";
        throw error;
      }
    }
    if (worktrees.length > 0) {
      const pruned = spawnSync("git", ["worktree", "prune"], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "ignore", "ignore"]
      });
      if (pruned.status !== 0) {
        const error = new Error("Cannot prune Git worktrees.");
        error.code = "WORKTREE_PRUNE_FAILED";
        throw error;
      }
    }
    if (existed) rmSync(directory, { recursive: true, force: true });
  }
  return {
    mode: "state",
    dryRun,
    removed: existed && !dryRun ? [".metis/"] : [],
    candidates: existed ? [".metis/"] : [],
    worktreeCandidates: worktrees,
    removedWorktrees: dryRun ? [] : worktrees,
    installationPreserved: true
  };
}
