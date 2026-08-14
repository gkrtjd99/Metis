import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { installAdapters } from "../adapters/install.js";
import { ensureConfig, loadConfig } from "./config.js";
import { invariant } from "./errors.js";
import { databasePath } from "./db.js";
import { parseJson } from "./util.js";

const SUPPORTED_HOSTS = new Set(["codex", "claude", "opencode", "all"]);

export const LIFECYCLE_ROUTES = Object.freeze({
  NO_RUN: "no-run",
  PAUSED: "paused",
  COMPLETED: "completed",
  ACTIVE_LIVE_CONTROLLER: "active-live-controller",
  ACTIVE_EXPIRED_CONTROLLER: "active-expired-controller"
});

function existingDirectory(value, code, message) {
  invariant(typeof value === "string" && value.trim(), code, message);
  const resolved = path.resolve(value);
  invariant(existsSync(resolved), "ROOT_NOT_FOUND", `Project root does not exist: ${resolved}`);
  invariant(lstatSync(resolved).isDirectory(), "ROOT_NOT_DIRECTORY", `Project root is not a directory: ${resolved}`);
  return resolved;
}

function gitTopLevel(cwd) {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output ? path.resolve(output) : null;
  } catch {
    return null;
  }
}

/** Resolve only an explicit root or the Git top-level enclosing cwd. */
export function resolveProjectRoot({ root, cwd = process.cwd() } = {}) {
  const base = existingDirectory(cwd, "CWD_INVALID", "The current working directory must be an existing directory.");
  const explicit = root !== undefined && root !== null;
  const projectRoot = explicit
    ? existingDirectory(root, "ROOT_REQUIRED", "An explicit project root is required.")
    : gitTopLevel(base);
  invariant(projectRoot, "GIT_REQUIRED", "A Git project root is required for mutable Metis attachment.");
  const gitRoot = gitTopLevel(projectRoot);
  invariant(gitRoot, "GIT_REQUIRED", `The project root is not inside a Git worktree: ${projectRoot}`);
  return {
    projectRoot,
    source: explicit ? "explicit" : "git-top-level",
    gitRoot
  };
}

function selectedHosts(host) {
  const values = Array.isArray(host) ? host : String(host ?? "codex").split(",");
  const selected = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
  invariant(selected.length > 0, "HOST_REQUIRED", "Select at least one host.");
  for (const item of selected) invariant(SUPPORTED_HOSTS.has(item), "HOST_INVALID", `Unsupported host: ${item}.`);
  return selected;
}

/** Attach host integrations without taking over a run. */
export function attachProject({ root, cwd = process.cwd(), host = "codex", force = false } = {}) {
  const resolved = resolveProjectRoot({ root, cwd });
  const hosts = selectedHosts(host);
  // Both reads must complete before the installer creates runtime directories
  // or changes any host files. In particular, do not let a bad config or
  // lifecycle database leave behind a partial attachment.
  loadConfig(resolved.projectRoot);
  const lifecycle = routeLifecycle({ projectRoot: resolved.projectRoot });
  const installed = installAdapters(resolved.projectRoot, hosts, Boolean(force));
  const config = ensureConfig(resolved.projectRoot, { host: hosts[0] === "all" ? "codex" : hosts[0] });
  return {
    projectRoot: resolved.projectRoot,
    rootSource: resolved.source,
    gitRoot: resolved.gitRoot,
    installed,
    config,
    lifecycle
  };
}

function routeForRun(row) {
  const expiresAt = row.controller_expires_at ? Date.parse(row.controller_expires_at) : NaN;
  const controllerLive = Number.isFinite(expiresAt) && expiresAt > Date.now();
  const route = row.status === "completed"
    ? LIFECYCLE_ROUTES.COMPLETED
    : row.status === "paused"
      ? LIFECYCLE_ROUTES.PAUSED
      : controllerLive
        ? LIFECYCLE_ROUTES.ACTIVE_LIVE_CONTROLLER
        : LIFECYCLE_ROUTES.ACTIVE_EXPIRED_CONTROLLER;
  return {
    route,
    run: {
      id: row.id,
      status: row.status,
      phase: row.phase,
      goal: row.goal,
      controllerOwner: row.controller_owner,
      controllerSessionId: row.controller_session_id,
      controllerExpiresAt: row.controller_expires_at
    },
    automaticTakeover: false,
    takeoverRequired: route === LIFECYCLE_ROUTES.ACTIVE_EXPIRED_CONTROLLER
  };
}

/**
 * Read lifecycle state without creating a runtime database or mutating controller ownership.
 * A caller may provide an already-open database; otherwise an existing database is opened
 * read-only for the duration of this read. The read-only path intentionally skips runtime
 * schema setup and integration recovery.
 */
export function routeLifecycle({ projectRoot, db = null } = {}) {
  const root = existingDirectory(projectRoot, "ROOT_REQUIRED", "A project root is required.");
  if (!db && !existsSync(databasePath(root))) {
    return { projectRoot: root, route: LIFECYCLE_ROUTES.NO_RUN, run: null, automaticTakeover: false, takeoverRequired: false };
  }
  const ownedDb = db ?? new DatabaseSync(databasePath(root), { readOnly: true });
  try {
    const row = ownedDb.prepare("SELECT * FROM runs ORDER BY updated_at DESC LIMIT 1").get();
    if (!row) return { projectRoot: root, route: LIFECYCLE_ROUTES.NO_RUN, run: null, automaticTakeover: false, takeoverRequired: false };
    return { projectRoot: root, ...routeForRun(row), ...(row.route_json ? { lifecycle: parseJson(row.route_json, {}) } : {}) };
  } finally {
    if (!db) ownedDb.close();
  }
}
