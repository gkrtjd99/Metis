import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { json, now, parseJson } from "./util.js";

export const UI_REQUIREMENT_KINDS = Object.freeze([
  "ui",
  "ux",
  "frontend",
  "user-facing",
  "user-interface",
  "user-experience",
  "accessibility"
]);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const BUILT_INS = Object.freeze([
  {
    name: "frontend-ui",
    description: "Design and implement user-facing web interfaces against an explicit experience and visual contract.",
    reviewRole: null,
    skillPath: "capabilities/frontend-ui/CAPABILITY.md"
  },
  {
    name: "browser-testing",
    description: "Verify browser user flows, viewports, console output, network failures, assertions, and screenshots.",
    reviewRole: null,
    skillPath: "capabilities/browser-testing/CAPABILITY.md"
  },
  {
    name: "visual-review",
    description: "Review visual hierarchy, design-system adherence, responsive behavior, and interaction states.",
    reviewRole: null,
    skillPath: "capabilities/visual-review/CAPABILITY.md"
  },
  {
    name: "security",
    description: "Review authentication, authorization, secrets, cryptography, sessions, and trust boundaries.",
    reviewRole: "security-reviewer",
    skillPath: "capabilities/security/CAPABILITY.md"
  },
  {
    name: "database",
    description: "Review schemas, queries, transactions, persistence behavior, and data integrity.",
    reviewRole: "database-reviewer",
    skillPath: "capabilities/database/CAPABILITY.md"
  },
  {
    name: "migration",
    description: "Review data or configuration migration, rollout, backfill, and rollback behavior.",
    reviewRole: "migration-reviewer",
    skillPath: "capabilities/migration/CAPABILITY.md"
  },
  {
    name: "performance",
    description: "Review latency, throughput, memory, caching, queues, and concurrency limits.",
    reviewRole: "performance-reviewer",
    skillPath: "capabilities/performance/CAPABILITY.md"
  },
  {
    name: "accessibility",
    description: "Review keyboard, focus, semantic, contrast, and assistive-technology behavior.",
    reviewRole: "accessibility-reviewer",
    skillPath: "capabilities/accessibility/CAPABILITY.md"
  }
]);

const BY_NAME = new Map(BUILT_INS.map((item) => [item.name, item]));

function strings(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : [];
}

function normalizedPaths(input) {
  const values = input.targetPaths ?? input.TargetPaths ?? [];
  return strings(values).map((value) => value.replaceAll("\\", "/"));
}

function pathSegments(paths) {
  return new Set(paths.flatMap((value) => value.split("/").filter(Boolean)));
}

function extensions(paths) {
  return new Set(paths.map((value) => path.extname(value).toLowerCase()).filter(Boolean));
}

function requirementSignals(db, runId, ids) {
  if (!db || !runId || ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`SELECT id, kind, title, description FROM requirements WHERE run_id = ? AND id IN (${placeholders})`).all(runId, ...ids);
}

function explicitCapabilities(input) {
  return strings(input.capabilities ?? input.Capabilities ?? []);
}

export function resolveTaskCapabilities(db, runId, input = {}) {
  const paths = normalizedPaths(input);
  const segments = pathSegments(paths);
  const exts = extensions(paths);
  const modes = strings(input.verificationModes ?? input.VerificationModes ?? []);
  const requirementIds = strings(input.requirementIds ?? input.RequirementIds ?? []);
  const requirements = requirementSignals(db, runId, requirementIds);
  const kinds = new Set(requirements.map((item) => String(item.kind).toLowerCase()));
  const requested = explicitCapabilities(input);
  const selected = new Map();
  const add = (name, reason) => {
    const capability = BY_NAME.get(name);
    if (capability && !selected.has(name)) selected.set(name, { ...capability, reason });
  };

  for (const name of requested) add(name, "explicit task capability");

  const frontendExtension = [...exts].some((ext) => [".tsx", ".jsx", ".vue", ".svelte", ".html", ".css", ".scss"].includes(ext));
  const frontendPath = ["components", "views", "screens", "pages", "app", "frontend", "ui"].some((segment) => segments.has(segment));
  const userFacingRequirement = [...kinds].some((kind) => UI_REQUIREMENT_KINDS.includes(kind));
  if (frontendExtension && (frontendPath || userFacingRequirement || modes.includes("browser"))) {
    add("frontend-ui", "user-facing frontend path and file type");
  }

  const securityPath = ["auth", "authentication", "authorization", "security", "session", "sessions", "oauth", "crypto", "permissions"].some((segment) => segments.has(segment));
  if (securityPath || kinds.has("security")) add("security", "security-sensitive path or requirement kind");

  const databasePath = ["db", "database", "schema", "schemas", "sql", "queries", "models"].some((segment) => segments.has(segment))
    || [...exts].some((ext) => [".sql", ".prisma"].includes(ext));
  if (databasePath || kinds.has("database")) add("database", "database path, file type, or requirement kind");

  const migrationPath = ["migration", "migrations", "backfill", "rollout"].some((segment) => segments.has(segment));
  if (migrationPath || kinds.has("migration")) add("migration", "migration path or requirement kind");

  const performancePath = ["performance", "perf", "cache", "caches", "queue", "queues", "stream", "streams", "worker", "workers"].some((segment) => segments.has(segment));
  if (performancePath || kinds.has("performance")) add("performance", "performance-sensitive path or requirement kind");

  if (selected.has("frontend-ui")) {
    add("visual-review", "frontend UI work requires visual review");
    add("accessibility", "frontend UI work requires accessibility review");
  }
  if (modes.includes("browser")) add("browser-testing", "task verification mode includes browser");

  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function syncCapabilityRegistry(db) {
  const timestamp = now();
  const insert = db.prepare(`
    INSERT INTO capabilities(name, description, review_role, skill_path, metadata_json, updated_at)
    VALUES(?, ?, ?, ?, '{}', ?)
    ON CONFLICT(name) DO UPDATE SET description = excluded.description,
      review_role = excluded.review_role, skill_path = excluded.skill_path, updated_at = excluded.updated_at
  `);
  for (const item of BUILT_INS) insert.run(item.name, item.description, item.reviewRole, item.skillPath, timestamp);
}

export function listCapabilities(db) {
  return db.prepare("SELECT * FROM capabilities ORDER BY name").all().map((row) => ({
    name: row.name,
    description: row.description,
    reviewRole: row.review_role,
    skillPath: row.skill_path,
    metadata: parseJson(row.metadata_json, {})
  }));
}

export function bindTaskCapabilities(db, taskId, capabilities) {
  db.prepare("DELETE FROM task_capabilities WHERE task_id = ?").run(taskId);
  const insert = db.prepare("INSERT INTO task_capabilities(task_id, capability_name, reason) VALUES(?, ?, ?)");
  for (const item of capabilities) insert.run(taskId, item.name, item.reason);
}

export function taskCapabilities(db, taskId) {
  return db.prepare(`
    SELECT c.name, c.description, c.review_role, c.skill_path, tc.reason
    FROM task_capabilities tc JOIN capabilities c ON c.name = tc.capability_name
    WHERE tc.task_id = ? ORDER BY c.name
  `).all(taskId).map((row) => ({
    name: row.name,
    description: row.description,
    reviewRole: row.review_role,
    skillPath: row.skill_path,
    reason: row.reason
  }));
}

export function capabilityNamesFromTask(task) {
  if (Array.isArray(task.capabilities)) return task.capabilities.map((item) => typeof item === "string" ? item : item.name);
  return parseJson(task.capabilities_json, []);
}

export function specialistRolesForCapabilities(capabilities) {
  const names = capabilities.map((item) => typeof item === "string" ? item : item.name);
  return [...new Set(names.map((name) => BY_NAME.get(name)?.reviewRole).filter(Boolean))].sort();
}

export function capabilityExplanation(db, taskId) {
  return {
    taskId,
    capabilities: taskCapabilities(db, taskId)
  };
}

export function capabilityRegistryManifest() {
  return BUILT_INS.map((item) => ({ ...item }));
}


export function capabilityProcedure(name) {
  const item = BY_NAME.get(name);
  if (!item?.skillPath) return [];
  const file = path.join(packageRoot, "skills", "metis", item.skillPath);
  const content = readFileSync(file, "utf8");
  const body = content.replace(/^---[\s\S]*?---\s*/u, "").trim();
  return body.split(/\r?\n/u).map((line) => line.trim()).filter((line) => /^\d+\.|^- /u.test(line));
}
