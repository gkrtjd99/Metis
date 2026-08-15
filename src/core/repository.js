import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { evidenceRefIsCurrent } from "./provenance.js";
import { hashFileContents } from "./hash.js";
import { runtimeArea } from "./paths.js";
import { makeId, now, normalizeRepoPath, parseJson, runCommand, stableStringify } from "./util.js";
import { recordEvent } from "./state.js";

const IMPORTANT_FILES = new Set([
  "AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md", "ARCHITECTURE.md",
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "build.gradle", "pom.xml"
]);

const SYMBOL_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".py", ".go", ".rs", ".java", ".kt", ".kts"
]);

const RESOLVABLE_EXTENSIONS = Object.freeze([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".json",
  ".py", ".go", ".rs", ".java", ".kt", ".kts"
]);

const REPOSITORY_SYNC_LEASE_MS = 5 * 60 * 1000;
const REPOSITORY_SYNC_BUSY_TIMEOUT_MS = 1000;
const REPOSITORY_SYNC_RETRY_MS = 50;

function waitForRepositorySyncRetry() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, REPOSITORY_SYNC_RETRY_MS);
}

function databaseBusy(error) {
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(String(error?.message ?? error));
}

function repositorySyncResource(projectRoot) {
  return `repository:${path.resolve(projectRoot)}`;
}

function acquireRepositorySyncLease(db, projectRoot) {
  const resource = repositorySyncResource(projectRoot);
  const ownerToken = makeId("repository-sync");

  for (;;) {
    db.exec("PRAGMA busy_timeout = " + REPOSITORY_SYNC_BUSY_TIMEOUT_MS);
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (!databaseBusy(error)) throw error;
      waitForRepositorySyncRetry();
      continue;
    }

    try {
      const existing = db.prepare("SELECT * FROM repository_sync_leases WHERE resource = ?").get(resource);
      if (existing && Date.parse(existing.expires_at) > Date.now()) {
        db.exec("ROLLBACK");
        waitForRepositorySyncRetry();
        continue;
      }

      const fencingToken = Number(existing?.fencing_token ?? 0) + 1;
      const timestamp = now();
      const expiresAt = new Date(Date.now() + REPOSITORY_SYNC_LEASE_MS).toISOString();
      if (existing) {
        db.prepare(`
          UPDATE repository_sync_leases
          SET owner_token = ?, fencing_token = ?, expires_at = ?, updated_at = ?
          WHERE resource = ? AND fencing_token = ?
        `).run(ownerToken, fencingToken, expiresAt, timestamp, resource, Number(existing.fencing_token));
      } else {
        db.prepare(`
          INSERT INTO repository_sync_leases(resource, owner_token, fencing_token, expires_at, updated_at)
          VALUES(?, ?, ?, ?, ?)
        `).run(resource, ownerToken, fencingToken, expiresAt, timestamp);
      }

      let closed = false;
      const assertOwned = () => {
        const row = db.prepare("SELECT owner_token, fencing_token FROM repository_sync_leases WHERE resource = ?").get(resource);
        if (!row || row.owner_token !== ownerToken || Number(row.fencing_token) !== fencingToken) {
          throw new Error(`Repository sync lease fenced for ${projectRoot}.`);
        }
      };
      const heartbeat = () => {
        assertOwned();
        const timestamp = now();
        const expiresAt = new Date(Date.now() + REPOSITORY_SYNC_LEASE_MS).toISOString();
        const result = db.prepare(`
          UPDATE repository_sync_leases
          SET expires_at = ?, updated_at = ?
          WHERE resource = ? AND owner_token = ? AND fencing_token = ?
        `).run(expiresAt, timestamp, resource, ownerToken, fencingToken);
        if (result.changes !== 1) throw new Error(`Repository sync lease fenced for ${projectRoot}.`);
      };
      const release = () => {
        if (closed) return;
        assertOwned();
        const timestamp = now();
        db.prepare(`
          UPDATE repository_sync_leases SET expires_at = ?, updated_at = ?
          WHERE resource = ? AND owner_token = ? AND fencing_token = ?
        `).run(timestamp, timestamp, resource, ownerToken, fencingToken);
        db.exec("COMMIT");
        db.exec("PRAGMA busy_timeout = 5000");
        closed = true;
      };
      const abort = () => {
        if (closed) return;
        try { db.exec("ROLLBACK"); } catch {}
        try { db.exec("PRAGMA busy_timeout = 5000"); } catch {}
        closed = true;
      };
      return { fencingToken, heartbeat, assertOwned, release, abort, get closed() { return closed; } };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
}

export function currentGitRef(projectRoot) {
  const result = runCommand("git", ["rev-parse", "HEAD"], { cwd: projectRoot, timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function currentGitChanges(projectRoot, config) {
  if (!existsSync(path.join(projectRoot, ".git"))) return { available: false, paths: [] };
  const commands = [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"]
  ];
  const paths = new Set();
  for (const args of commands) {
    const result = runCommand("git", args, { cwd: projectRoot, timeout: 5000 });
    if (result.status !== 0) continue;
    for (const item of result.stdout.split(/\r?\n/).filter(Boolean)) {
      const normalized = normalizeRepoPath(item);
      if (!ignored(normalized, config.index.ignore)) paths.add(normalized);
    }
  }
  return { available: true, paths: [...paths].sort() };
}

function ignored(relative, ignore) {
  const normalized = normalizeRepoPath(relative);
  const parts = normalized.split("/");
  return ignore.some((rule) => {
    const clean = normalizeRepoPath(rule).replace(/\/$/, "");
    return clean.includes("/")
      ? normalized === clean || normalized.startsWith(`${clean}/`)
      : parts.includes(clean);
  });
}

function walk(directory, root, ignore, output, state, maxFiles) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = normalizeRepoPath(path.relative(root, absolute));
    if (ignored(relative, ignore)) continue;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      walk(absolute, root, ignore, output, state, maxFiles);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      state.discovered += 1;
      if (output.length < maxFiles) output.push(relative);
    }
  }
}

export function scanProjectFiles(projectRoot, config) {
  const limit = Number(config.index.maxFiles);
  if (existsSync(path.join(projectRoot, ".git"))) {
    try {
      const data = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
        cwd: projectRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024
      });
      const all = [...new Set(data.split("\0").filter(Boolean).map(normalizeRepoPath))]
        .filter((file) => !ignored(file, config.index.ignore))
        .sort();
      return {
        files: all.slice(0, limit),
        discoveredFiles: all.length,
        indexedFiles: Math.min(all.length, limit),
        truncated: all.length > limit,
        limit,
        source: "git"
      };
    } catch {}
  }
  const files = [];
  const state = { discovered: 0 };
  walk(projectRoot, projectRoot, config.index.ignore, files, state, limit);
  files.sort();
  return {
    files, discoveredFiles: state.discovered, indexedFiles: files.length,
    truncated: state.discovered > limit, limit, source: "filesystem"
  };
}

export function listProjectFiles(projectRoot, config) {
  return scanProjectFiles(projectRoot, config).files;
}

function classify(file) {
  const ext = path.extname(file).toLowerCase();
  if ([".test.js", ".test.ts", ".test.tsx", ".spec.js", ".spec.ts", ".spec.tsx"].some((suffix) => file.endsWith(suffix)) || /(^|\/)tests?(\/|$)/u.test(file)) return "test";
  if ([".md", ".mdx", ".rst", ".adoc"].includes(ext)) return "doc";
  if ([".json", ".yaml", ".yml", ".toml", ".ini", ".conf"].includes(ext)) return "config";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".pdf", ".zip"].includes(ext)) return "asset";
  return "source";
}

function extractHeadings(file, absolute) {
  if (!file.endsWith(".md") && !file.endsWith(".mdx")) return [];
  let text;
  try { text = readFileSync(absolute, "utf8"); } catch { return []; }
  return text.split(/\r?\n/)
    .filter((line) => /^#{1,3}\s+\S/u.test(line))
    .slice(0, 24)
    .map((line) => line.replace(/^#+\s+/u, "").trim());
}

function lineSymbols(file, text) {
  const ext = path.extname(file).toLowerCase();
  const symbols = [];
  const imports = [];
  const lines = text.split(/\r?\n/);
  const add = (kind, name, line, signature = null) => {
    if (!name || name.length > 200) return;
    symbols.push({ name, kind, line, signature: signature?.trim().slice(0, 300) ?? null });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;
    let match;
    if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].includes(ext)) {
      match = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u);
      if (match) add("function", match[1], lineNo, line);
      match = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/u);
      if (match) add("class", match[1], lineNo, line);
      match = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u);
      if (match) add("function", match[1], lineNo, line);
      match = line.match(/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/u);
      if (match) add("type", match[1], lineNo, line);
      match = line.match(/^\s*import\s+.*?\s+from\s+["']([^"']+)["']/u) ?? line.match(/^\s*(?:const|let|var)\s+.*?=\s*require\(["']([^"']+)["']\)/u);
      if (match) imports.push(match[1]);
    } else if (ext === ".py") {
      match = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/u);
      if (match) add("function", match[1], lineNo, line);
      match = line.match(/^\s*class\s+([A-Za-z_]\w*)/u);
      if (match) add("class", match[1], lineNo, line);
      match = line.match(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/u);
      if (match) imports.push(match[1] ?? match[2]);
    } else if (ext === ".go") {
      match = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/u);
      if (match) add("function", match[1], lineNo, line);
      match = line.match(/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/u);
      if (match) add("type", match[1], lineNo, line);
      match = line.match(/^\s*"([^"]+)"\s*$/u);
      if (match && index > 0 && /import\s*\(?\s*$/u.test(lines[index - 1])) imports.push(match[1]);
    } else if (ext === ".rs") {
      match = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/u);
      if (match) add("function", match[1], lineNo, line);
      match = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/u);
      if (match) add("type", match[1], lineNo, line);
      match = line.match(/^\s*use\s+([^;]+);/u);
      if (match) imports.push(match[1].trim());
    } else if ([".java", ".kt", ".kts"].includes(ext)) {
      match = line.match(/^\s*(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|static)\s+)*(?:class|interface|enum|object|record)\s+([A-Za-z_]\w*)/u);
      if (match) add("type", match[1], lineNo, line);
      match = line.match(/^\s*(?:(?:public|private|protected|internal|abstract|final|open|static|suspend|override)\s+)*(?:fun\s+)?(?:[\w<>?\[\],.]+\s+)?([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=|throws)/u);
      if (match && !["if", "for", "while", "switch", "catch"].includes(match[1])) add("function", match[1], lineNo, line);
      match = line.match(/^\s*import\s+([^;\s]+)/u);
      if (match) imports.push(match[1]);
    }
  }
  return { symbols, imports: [...new Set(imports)].slice(0, 200) };
}

function extractSymbolRecord(projectRoot, row) {
  if (!SYMBOL_EXTENSIONS.has(path.extname(row.path).toLowerCase()) || row.size > 2 * 1024 * 1024) return null;
  try {
    const text = readFileSync(path.join(projectRoot, row.path), "utf8");
    const parsed = lineSymbols(row.path, text);
    if (parsed.symbols.length === 0 && parsed.imports.length === 0) return null;
    return { path: row.path, sha256: row.sha256, ...parsed };
  } catch {
    return null;
  }
}

function tryCtagsSymbols(projectRoot, rows, config) {
  const provider = String(config.index.symbolProvider ?? "auto").toLowerCase();
  if (provider === "builtin" || !["auto", "ctags"].includes(provider)) return null;
  const candidates = rows
    .filter((row) => SYMBOL_EXTENSIONS.has(path.extname(row.path).toLowerCase()) && row.size <= 2 * 1024 * 1024)
    .map((row) => row.path)
    .filter((file) => !file.includes("\n") && !file.includes("\r"));
  if (candidates.length === 0) return null;
  try {
    const output = execFileSync(
      config.index.ctagsCommand ?? "ctags",
      ["--output-format=json", "--fields=+nK", "--extras=-F", "-f", "-", "-L", "-"],
      {
        cwd: projectRoot,
        input: `${candidates.join("\n")}\n`,
        encoding: "utf8",
        timeout: Number(config.index.ctagsTimeoutMs ?? 30000),
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["pipe", "pipe", "ignore"]
      }
    );
    const candidateSet = new Set(candidates);
    const records = new Map();
    let count = 0;
    for (const line of output.split(/\r?\n/u).filter(Boolean)) {
      if (count >= config.index.maxSymbols) break;
      let tag;
      try { tag = JSON.parse(line); } catch { continue; }
      if (tag._type && tag._type !== "tag") continue;
      const file = normalizeRepoPath(tag.path ?? tag.input ?? "");
      if (!candidateSet.has(file) || !tag.name) continue;
      const lineNumber = Number(tag.line ?? tag.lineNumber ?? 0);
      if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
      const symbols = records.get(file) ?? [];
      symbols.push({
        name: String(tag.name).slice(0, 200),
        kind: String(tag.kindName ?? tag.kind ?? "symbol").slice(0, 80),
        line: lineNumber,
        signature: tag.signature ? String(tag.signature).slice(0, 300) : null
      });
      records.set(file, symbols);
      count += 1;
    }
    return records.size > 0 ? records : null;
  } catch {
    if (provider === "ctags") throw new Error("Configured Universal Ctags symbol provider failed.");
    return null;
  }
}

function existingCandidate(fileSet, candidates) {
  return candidates.find((candidate) => fileSet.has(normalizeRepoPath(candidate))) ?? null;
}

function pathCandidates(base) {
  const normalized = normalizeRepoPath(base);
  const candidates = [normalized];
  if (!path.posix.extname(normalized)) {
    for (const extension of RESOLVABLE_EXTENSIONS) candidates.push(`${normalized}${extension}`);
    for (const extension of RESOLVABLE_EXTENSIONS) candidates.push(`${normalized}/index${extension}`);
    candidates.push(`${normalized}/__init__.py`, `${normalized}/mod.rs`);
  }
  return [...new Set(candidates)];
}

function resolvePythonRelative(from, specifier, fileSet) {
  const match = specifier.match(/^(\.+)(.*)$/u);
  if (!match) return null;
  let base = path.posix.dirname(from);
  for (let index = 1; index < match[1].length; index += 1) base = path.posix.dirname(base);
  const modulePath = match[2].replace(/^\./u, "").replaceAll(".", "/");
  const target = modulePath ? path.posix.join(base, modulePath) : base;
  return existingCandidate(fileSet, pathCandidates(target));
}

function resolveRustPath(from, specifier, fileSet) {
  const root = specifier.match(/^(crate|self|super)::(.+)$/u);
  if (!root) return null;
  let base;
  if (root[1] === "crate") base = "src";
  else if (root[1] === "self") base = path.posix.dirname(from);
  else base = path.posix.dirname(path.posix.dirname(from));
  const clean = root[2]
    .replace(/\{.*$/u, "")
    .replace(/::\*$/u, "")
    .replaceAll("::", "/");
  return existingCandidate(fileSet, pathCandidates(path.posix.join(base, clean)));
}

function resolveImport(from, specifier, fileSet) {
  const clean = String(specifier).trim().replace(/[?#].*$/u, "");
  if (!clean) return { kind: "unknown", to: null, resolved: false };
  if (clean.startsWith(".")) {
    const extension = path.posix.extname(from).toLowerCase();
    const pythonTarget = extension === ".py" ? resolvePythonRelative(from, clean, fileSet) : null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
    const target = pythonTarget ?? existingCandidate(fileSet, pathCandidates(base));
    return { kind: target ? "internal" : "internal-unresolved", to: target, resolved: Boolean(target) };
  }
  if (clean.startsWith("/")) {
    const target = existingCandidate(fileSet, pathCandidates(clean.replace(/^\/+/, "")));
    return { kind: target ? "internal" : "internal-unresolved", to: target, resolved: Boolean(target) };
  }
  const rustTarget = resolveRustPath(from, clean, fileSet);
  if (rustTarget) return { kind: "internal", to: rustTarget, resolved: true };
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u.test(clean)) {
    const dotted = clean.replaceAll(".", "/");
    const target = existingCandidate(fileSet, pathCandidates(dotted));
    if (target) return { kind: "internal", to: target, resolved: true };
  }
  return { kind: "external", to: null, resolved: false };
}

function buildDependencyIndex(symbolFiles, rows, config) {
  const fileSet = new Set(rows.map((row) => row.path));
  const maxEdges = Math.max(1, Number(config.index.maxDependencyEdges ?? 100000));
  const edges = [];
  const seen = new Set();
  for (const file of symbolFiles) {
    for (const specifier of file.imports ?? []) {
      if (edges.length >= maxEdges) break;
      const resolution = resolveImport(file.path, specifier, fileSet);
      const key = `${file.path}\0${specifier}\0${resolution.to ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: file.path,
        specifier,
        to: resolution.to,
        kind: resolution.kind,
        resolved: resolution.resolved
      });
    }
    if (edges.length >= maxEdges) break;
  }
  const consumers = new Map();
  for (const edge of edges) {
    if (!edge.to) continue;
    const current = consumers.get(edge.to) ?? [];
    current.push(edge.from);
    consumers.set(edge.to, current);
  }
  return {
    version: 1,
    generatedAt: now(),
    truncated: edges.length >= maxEdges,
    counts: {
      edges: edges.length,
      internal: edges.filter((edge) => edge.kind === "internal").length,
      unresolvedInternal: edges.filter((edge) => edge.kind === "internal-unresolved").length,
      external: edges.filter((edge) => edge.kind === "external").length
    },
    edges,
    consumers: Object.fromEntries(
      [...consumers.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([target, sources]) => [target, [...new Set(sources)].sort()])
    )
  };
}

function invalidateFindings(db, projectRoot, changedPaths) {
  if (changedPaths.size === 0) return [];
  const stale = [];
  const rows = db.prepare("SELECT id, sources_json FROM findings WHERE status = 'valid'").all();
  const update = db.prepare("UPDATE findings SET status = 'stale', updated_at = ? WHERE id = ?");
  for (const row of rows) {
    const sources = parseJson(row.sources_json, []);
    const invalid = sources.some((source) => {
      if (!source || typeof source !== "object" || source.type === "note") return false;
      if (source.type === "source" && changedPaths.has(normalizeRepoPath(source.path))) return true;
      return !evidenceRefIsCurrent(db, projectRoot, source);
    });
    if (invalid) {
      update.run(now(), row.id);
      db.prepare("UPDATE trace_links SET status = 'stale', updated_at = ? WHERE target_type = 'finding' AND target_id = ?")
        .run(now(), row.id);
      stale.push(row.id);
    }
  }
  return stale;
}

function addDocumentImpacts(db, runId, projectRoot, changed, allFiles) {
  if (!runId || changed.length === 0) return [];
  const docs = allFiles.filter((file) => classify(file) === "doc");
  const documentBodies = new Map();
  for (const doc of docs) {
    try { documentBodies.set(doc, readFileSync(path.join(projectRoot, doc), "utf8")); } catch {}
  }
  const insert = db.prepare(`
    INSERT INTO document_impacts(id, run_id, path, reason, status, evidence_refs_json, created_at, updated_at)
    VALUES(?, ?, ?, ?, 'pending', '[]', ?, ?)
    ON CONFLICT(run_id, path, reason) DO UPDATE SET
      status = 'pending', disposition = NULL, updated_at = excluded.updated_at
  `);
  const impacts = [];
  for (const source of changed.filter((item) => item.kind !== "doc")) {
    const base = path.basename(source.path);
    for (const [doc, content] of documentBodies) {
      if (content.includes(source.path) || content.includes(base)) {
        const reason = `References changed file ${source.path}`;
        const id = `doc_${createHash("sha256").update(`${runId}:${doc}:${reason}`).digest("hex").slice(0, 16)}`;
        insert.run(id, runId, doc, reason, now(), now());
        impacts.push({ path: doc, reason });
      }
    }
    if (/api|schema|config|cli|public|route|endpoint/i.test(source.path)) {
      const reason = `Public or operational surface changed: ${source.path}`;
      const doc = "<documentation-review>";
      const id = `doc_${createHash("sha256").update(`${runId}:${doc}:${reason}`).digest("hex").slice(0, 16)}`;
      insert.run(id, runId, doc, reason, now(), now());
      impacts.push({ path: doc, reason });
    }
  }
  return impacts;
}

export function repositoryCodeFingerprint(db) {
  const rows = db.prepare(`
    SELECT path, sha256 FROM files
    WHERE kind IN ('source', 'test', 'config')
    ORDER BY path
  `).all();
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${row.path}\0${row.sha256}\0`);
  return hash.digest("hex");
}

function generatedIndexNames(config) {
  return [
    "repository-index.json",
    "docs-index.json",
    ...(config.index.symbols ? ["symbol-index.json"] : []),
    ...(config.index.dependencies ? ["dependency-index.json"] : []),
    "PROJECT_INDEX.md"
  ];
}

function gitChangedPaths(projectRoot, config) {
  const result = runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: projectRoot,
    timeout: 5000
  });
  if (result.status !== 0) return null;
  const paths = [];
  const tokens = result.stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const first = normalizeRepoPath(entry.slice(3));
    if (first && !ignored(first, config.index.ignore)) paths.push({ path: first, status });
    if (status[0] === "R" || status[0] === "C") {
      const second = normalizeRepoPath(tokens[++index] ?? "");
      if (second && !ignored(second, config.index.ignore)) paths.push({ path: second, status });
    }
  }
  const tracked = paths.filter((item) => item.status[0] !== "?" && item.status[1] !== "?");
  const indexResult = tracked.length === 0 ? { status: 0, stdout: "" } : runCommand(
    "git",
    ["ls-files", "--stage", "-z", "--", ...tracked.map((item) => item.path)],
    { cwd: projectRoot, timeout: 5000 }
  );
  const indexIdentities = new Map();
  if (indexResult.status === 0) {
    for (const entry of indexResult.stdout.split("\0").filter(Boolean)) {
      const separator = entry.indexOf("\t");
      if (separator < 0) continue;
      // `git ls-files --stage` emits: <mode> <object-id> <stage>\t<path>.
      const fields = entry.slice(0, separator).match(/^(\d+) ([0-9a-f]+) ([0-3])$/u);
      if (!fields) continue;
      const [, mode, object, stage] = fields;
      indexIdentities.set(normalizeRepoPath(entry.slice(separator + 1)), { mode, object, stage });
    }
  }
  return paths
    .map((item) => ({ ...item, index: indexIdentities.get(item.path) ?? null }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function gitStatusHiddenPaths(projectRoot, config) {
  const result = runCommand("git", ["ls-files", "-v", "-z"], {
    cwd: projectRoot,
    timeout: 5000
  });
  if (result.status !== 0) return null;
  return result.stdout.split("\0").filter(Boolean).flatMap((entry) => {
    const marker = entry[0];
    const relative = normalizeRepoPath(entry.slice(2));
    // Ordinary tracked files are tagged H. Lowercase tags are assume-unchanged;
    // S denotes skip-worktree. Both can hide working-tree mutations from status.
    if (!relative || marker === "H" || ignored(relative, config.index.ignore)) return [];
    return [{ marker, ...pathIdentity(projectRoot, relative) }];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function pathIdentity(projectRoot, relative) {
  const absolute = path.join(projectRoot, relative);
  let stat;
  try { stat = lstatSync(absolute); } catch { return { path: relative, exists: false }; }
  const identity = {
    path: relative,
    exists: true,
    mode: stat.mode & 0o7777,
    type: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other"
  };
  if (stat.isSymbolicLink()) {
    try { identity.target = readlinkSync(absolute); } catch { identity.target = null; }
  } else if (stat.isFile()) {
    try { identity.content = createHash("sha256").update(readFileSync(absolute)).digest("hex"); } catch { identity.content = null; }
  }
  return identity;
}

function repositoryPreflight(projectRoot, config) {
  const rootResult = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot, timeout: 5000 });
  if (rootResult.status !== 0) return null;
  const changed = gitChangedPaths(projectRoot, config);
  const statusHidden = gitStatusHiddenPaths(projectRoot, config);
  if (!changed || !statusHidden) return null;
  const generatedRoot = runtimeArea(projectRoot, "generated");
  const generated = generatedIndexNames(config).map((name) => pathIdentity(generatedRoot, name));
  const sourcePayload = {
    version: 1,
    head: currentGitRef(projectRoot),
    indexConfig: config.index,
    changed: changed.map((item) => ({ ...item, identity: pathIdentity(projectRoot, item.path) })),
    statusHidden
  };
  const sourceFingerprint = createHash("sha256").update(stableStringify(sourcePayload)).digest("hex");
  return {
    fingerprint: createHash("sha256").update(stableStringify({ sourceFingerprint, generated })).digest("hex"),
    sourceFingerprint,
    generated: generated.filter((item) => item.exists).map((item) => item.path)
  };
}

function validSyncCacheMetadata(text, config) {
  let metadata;
  try { metadata = parseJson(text, null); } catch { return null; }
  const cache = metadata?.syncCache;
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) return null;
  if (cache.version !== 1 || !/^[0-9a-f]{64}$/u.test(cache.fingerprint)) return null;
  if (!Array.isArray(cache.generated) || cache.generated.some((item) => typeof item !== "string")) return null;
  const expected = generatedIndexNames(config);
  if (cache.generated.length !== expected.length || cache.generated.some((item, index) => item !== expected[index])) return null;
  return cache;
}

function cachedSyncResult(db, row, metadata) {
  const files = Number(db.prepare("SELECT COUNT(*) AS count FROM files").get().count);
  return {
    files,
    scan: {
      id: row.id,
      limit: row.file_limit,
      discoveredFiles: row.discovered_files,
      indexedFiles: row.indexed_files,
      truncated: Boolean(row.truncated),
      source: row.source
    },
    created: [],
    modified: [],
    deleted: [],
    staleFindings: [],
    decisionsNeedingReview: [],
    governanceInvalidated: { assumptions: [], invariants: [], risks: [] },
    checksInvalidated: false,
    documentImpacts: [],
    generated: metadata.generated ?? [],
    cached: true,
    syncReason: "cache-hit"
  };
}

function syncRepositoryLocked(db, projectRoot, config, runId, options, retryCount = 0, lease = null) {
  lease?.heartbeat();
  let preflight = repositoryPreflight(projectRoot, config);
  if (preflight && options.force !== true) {
    lease?.heartbeat();
    const latest = db.prepare("SELECT * FROM repository_scans ORDER BY created_at DESC LIMIT 1").get();
    const cache = validSyncCacheMetadata(latest?.metadata_json, config);
    if (latest && cache?.fingerprint === preflight.fingerprint) {
      const candidate = cachedSyncResult(db, latest, cache);
      const confirmed = repositoryPreflight(projectRoot, config);
      if (confirmed?.fingerprint === preflight.fingerprint) return candidate;
      preflight = confirmed;
    }
  }
  lease?.heartbeat();
  const scan = scanProjectFiles(projectRoot, config);
  const files = scan.files;
  const previous = new Map(db.prepare("SELECT * FROM files").all().map((row) => [row.path, row]));
  const next = new Map();
  const changed = [];
  const upsert = db.prepare(`
    INSERT INTO files(path, sha256, size, mtime_ms, ctime_ms, kind, indexed_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      sha256 = excluded.sha256, size = excluded.size, mtime_ms = excluded.mtime_ms,
      ctime_ms = excluded.ctime_ms, kind = excluded.kind, indexed_at = excluded.indexed_at
  `);
  for (const file of files) {
    const absolute = path.join(projectRoot, file);
    let stat;
    try { stat = lstatSync(absolute); } catch { continue; }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    const targetStat = stat.isSymbolicLink() ? stat : statSync(absolute);
    const old = previous.get(file);
    const unchangedMetadata = old
      && Number(old.size) === Number(targetStat.size)
      && Number(old.mtime_ms) === Number(targetStat.mtimeMs)
      && Number(old.ctime_ms) === Number(targetStat.ctimeMs);
    const digest = unchangedMetadata
      ? old.sha256
      : stat.isSymbolicLink()
        ? createHash("sha256").update(`symlink:${readlinkSync(absolute)}`).digest("hex")
        : hashFileContents(absolute);
    const row = {
      path: file,
      sha256: digest,
      size: targetStat.size,
      mtime_ms: targetStat.mtimeMs,
      ctime_ms: targetStat.ctimeMs,
      kind: classify(file)
    };
    next.set(file, row);
    if (!old || old.sha256 !== digest) changed.push({ ...row, change: old ? "modified" : "created" });
    upsert.run(file, digest, row.size, row.mtime_ms, row.ctime_ms, row.kind, now());
  }
  const deleted = [];
  const remove = db.prepare("DELETE FROM files WHERE path = ?");
  for (const [file, row] of previous) {
    if (!next.has(file)) {
      deleted.push({ path: file, kind: row.kind, change: "deleted" });
      remove.run(file);
    }
  }
  const changedPaths = new Set([...changed, ...deleted].map((item) => item.path));
  const staleFindings = invalidateFindings(db, projectRoot, changedPaths);
  const decisionsNeedingReview = [];
  const decisions = db.prepare("SELECT id, evidence_refs_json, watch_refs_json, review_after FROM decisions WHERE status = 'active'").all();
  for (const decision of decisions) {
    const refs = [...parseJson(decision.evidence_refs_json, []), ...parseJson(decision.watch_refs_json, [])];
    const expired = decision.review_after && new Date(decision.review_after).getTime() <= Date.now();
    if (expired || refs.some((ref) => ref?.type !== "note" && !evidenceRefIsCurrent(db, projectRoot, ref))) {
      db.prepare("UPDATE decisions SET status = 'needs-review', updated_at = ? WHERE id = ?").run(now(), decision.id);
      db.prepare("UPDATE trace_links SET status = 'stale', updated_at = ? WHERE target_type = 'decision' AND target_id = ?").run(now(), decision.id);
      decisionsNeedingReview.push(decision.id);
    }
  }

  const governanceInvalidated = { assumptions: [], invariants: [], risks: [] };
  for (const item of db.prepare("SELECT id, status, evidence_refs_json FROM assumptions WHERE status = 'validated'").all()) {
    const refs = parseJson(item.evidence_refs_json, []);
    if (refs.some((ref) => !evidenceRefIsCurrent(db, projectRoot, ref))) {
      db.prepare("UPDATE assumptions SET status = 'open', disposition = 'Evidence changed; revalidation required.', updated_at = ? WHERE id = ?").run(now(), item.id);
      governanceInvalidated.assumptions.push(item.id);
    }
  }
  for (const item of db.prepare("SELECT id, status, verification_refs_json FROM invariants WHERE status = 'verified'").all()) {
    const refs = parseJson(item.verification_refs_json, []);
    if (refs.some((ref) => !evidenceRefIsCurrent(db, projectRoot, ref))) {
      db.prepare("UPDATE invariants SET status = 'active', updated_at = ? WHERE id = ?").run(now(), item.id);
      db.prepare("UPDATE trace_links SET status = 'stale', updated_at = ? WHERE target_type = 'invariant' AND target_id = ? AND relation = 'verified-by'").run(now(), item.id);
      governanceInvalidated.invariants.push(item.id);
    }
  }
  for (const item of db.prepare("SELECT id, status, verification_refs_json FROM risks WHERE status IN ('mitigated','resolved')").all()) {
    const refs = parseJson(item.verification_refs_json, []);
    if (refs.some((ref) => !evidenceRefIsCurrent(db, projectRoot, ref))) {
      db.prepare("UPDATE risks SET status = 'open', disposition = 'Mitigation evidence changed; review required.', updated_at = ? WHERE id = ?").run(now(), item.id);
      governanceInvalidated.risks.push(item.id);
    }
  }
  const traceRows = db.prepare("SELECT id, evidence_refs_json FROM trace_links WHERE status = 'current'").all();
  for (const trace of traceRows) {
    const refs = parseJson(trace.evidence_refs_json, []);
    if (refs.some((ref) => !evidenceRefIsCurrent(db, projectRoot, ref))) {
      db.prepare("UPDATE trace_links SET status = 'stale', updated_at = ? WHERE id = ?").run(now(), trace.id);
    }
  }
  const changedCode = [...changed, ...deleted].some((item) => ["source", "test", "config"].includes(item.kind));
  if (runId && changedPaths.size > 0) {
    db.prepare("UPDATE artifacts SET status = 'stale', updated_at = ? WHERE run_id = ? AND kind = 'knowledge-sync' AND status = 'verified'")
      .run(now(), runId);
  }
  if (runId && changedCode) {
    db.prepare("UPDATE checks SET status = 'stale', updated_at = ? WHERE run_id = ? AND status = 'passed'").run(now(), runId);
    db.prepare(`
      UPDATE artifacts SET status = 'stale', updated_at = ?
      WHERE run_id = ? AND kind IN ('integration-candidate','integration-review','verification','verification-candidate','completion-review','self-evaluation') AND status = 'verified'
    `).run(now(), runId);
    db.prepare("UPDATE requirements SET status = CASE WHEN status = 'verified' THEN 'implemented' ELSE status END, updated_at = ? WHERE run_id = ?")
      .run(now(), runId);
  }
  const documentImpacts = addDocumentImpacts(db, runId, projectRoot, [...changed, ...deleted], files);
  lease?.heartbeat();
  const scanId = makeId("scan");
  const metadata = preflight ? { syncCache: { version: 1, fingerprint: preflight.fingerprint, generated: [] } } : {};
  db.prepare(`
    INSERT INTO repository_scans(id, run_id, file_limit, discovered_files, indexed_files, truncated, source, metadata_json, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(scanId, runId, scan.limit, scan.discoveredFiles, scan.indexedFiles, scan.truncated ? 1 : 0, scan.source, stableStringify(metadata), now());
  const generated = generateIndexes(projectRoot, [...next.values()], config, scan, lease);
  lease?.heartbeat();
  if (preflight) {
    const postflight = repositoryPreflight(projectRoot, config);
    if (!postflight || postflight.sourceFingerprint !== preflight.sourceFingerprint) {
      db.prepare("UPDATE repository_scans SET metadata_json = '{}' WHERE id = ?").run(scanId);
      if (retryCount < 1) return syncRepositoryLocked(db, projectRoot, config, runId, { ...options, force: true }, retryCount + 1, lease);
    } else {
      db.prepare("UPDATE repository_scans SET metadata_json = ? WHERE id = ?")
        .run(stableStringify({ syncCache: { version: 1, fingerprint: postflight.fingerprint, generated } }), scanId);
    }
  }
  return {
    files: next.size,
    scan: { ...scan, id: scanId },
    created: changed.filter((item) => item.change === "created").map((item) => item.path),
    modified: changed.filter((item) => item.change === "modified").map((item) => item.path),
    deleted: deleted.map((item) => item.path),
    staleFindings,
    decisionsNeedingReview,
    governanceInvalidated,
    checksInvalidated: Boolean(runId && changedCode),
    documentImpacts,
    generated,
    syncReason: options.force === true ? "forced" : "cache-miss"
  };
}

export function syncRepository(db, projectRoot, config, runId = null, options = {}) {
  const started = performance.now();
  const lease = acquireRepositorySyncLease(db, projectRoot);
  try {
    const result = syncRepositoryLocked(db, projectRoot, config, runId, options, 0, lease);
    if (runId) {
      let symbols = 0;
      let dependencyEdges = 0;
      try {
        const generatedRoot = runtimeArea(projectRoot, "generated");
        if (result.generated?.includes("symbol-index.json")) symbols = Number(parseJson(readFileSync(path.join(generatedRoot, "symbol-index.json"), "{}").toString(), {})?.symbolCount ?? 0);
        if (result.generated?.includes("dependency-index.json")) dependencyEdges = Number(parseJson(readFileSync(path.join(generatedRoot, "dependency-index.json"), "{}").toString(), {})?.counts?.edges ?? 0);
      } catch {}
      recordEvent(db, runId, "performance.repository-sync", "info", {
        operationId: makeId("sync"), durationMs: Math.round((performance.now() - started) * 100) / 100,
        cached: Boolean(result.cached), reason: result.syncReason ?? (result.cached ? "cache-hit" : "cache-miss"),
        discoveredFiles: Number(result.scan?.discoveredFiles ?? 0), indexedFiles: Number(result.scan?.indexedFiles ?? result.files ?? 0),
        created: result.created?.length ?? 0, modified: result.modified?.length ?? 0, deleted: result.deleted?.length ?? 0,
        symbols, dependencyEdges
      });
    }
    return result;
  } catch (error) {
    if (runId) recordEvent(db, runId, "performance.repository-sync", "error", {
      operationId: makeId("sync"), durationMs: Math.round((performance.now() - started) * 100) / 100,
      cached: false, reason: "error", errorClass: error?.code ?? error?.name ?? "error"
    });
    lease.abort();
    throw error;
  } finally {
    if (!lease.closed) {
      try { lease.release(); } catch (error) {
        lease.abort();
        throw error;
      }
    }
  }
}

function writeGeneratedFile(directory, name, contents) {
  const target = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${process.pid}.${makeId("tmp")}.tmp`);
  try {
    writeFileSync(temporary, contents, "utf8");
    renameSync(temporary, target);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

function generateIndexes(projectRoot, rows, config, scan = null, lease = null) {
  const directoryMap = new Map();
  const docs = [];
  const important = [];
  const symbolFiles = [];
  let symbolCount = 0;
  const ctagsSymbols = config.index.symbols ? tryCtagsSymbols(projectRoot, rows, config) : null;
  for (const row of rows) {
    if (symbolCount % 64 === 0) lease?.heartbeat();
    const parts = row.path.split("/");
    const max = Math.min(parts.length - 1, config.index.maxDepth);
    for (let depth = 0; depth <= max; depth += 1) {
      const directory = depth === 0 ? "." : parts.slice(0, depth).join("/");
      const current = directoryMap.get(directory) ?? { files: 0, source: 0, test: 0, doc: 0, config: 0, asset: 0 };
      current.files += 1;
      current[row.kind] = (current[row.kind] ?? 0) + 1;
      directoryMap.set(directory, current);
    }
    if (row.kind === "doc") docs.push({ path: row.path, headings: extractHeadings(row.path, path.join(projectRoot, row.path)) });
    if (IMPORTANT_FILES.has(path.basename(row.path))) important.push(row.path);
    if (config.index.symbols && symbolCount < config.index.maxSymbols) {
      let record = extractSymbolRecord(projectRoot, row);
      if (ctagsSymbols?.has(row.path)) {
        record ??= { path: row.path, sha256: row.sha256, symbols: [], imports: [] };
        record.symbols = ctagsSymbols.get(row.path);
      }
      if (record) {
        const available = Math.max(0, config.index.maxSymbols - symbolCount);
        record.symbols = record.symbols.slice(0, available);
        symbolCount += record.symbols.length;
        symbolFiles.push(record);
      }
    }
  }
  const indexDir = runtimeArea(projectRoot, "generated");
  mkdirSync(indexDir, { recursive: true });
  const repositoryIndex = {
    version: 2,
    generatedAt: now(),
    fileCount: rows.length,
    discovery: scan ? {
      source: scan.source,
      limit: scan.limit,
      discoveredFiles: scan.discoveredFiles,
      indexedFiles: scan.indexedFiles,
      truncated: scan.truncated
    } : null,
    directories: Object.fromEntries([...directoryMap.entries()].sort(([a], [b]) => a.localeCompare(b))),
    importantFiles: important.sort()
  };
  const docsIndex = { version: 2, generatedAt: now(), documents: docs.sort((a, b) => a.path.localeCompare(b.path)) };
  const sortedSymbolFiles = symbolFiles.sort((a, b) => a.path.localeCompare(b.path));
  const symbolIndex = {
    version: 2,
    generatedAt: now(),
    provider: ctagsSymbols ? "universal-ctags" : "builtin",
    symbolCount,
    symbols: sortedSymbolFiles.flatMap((file) => file.symbols.map((symbol) => ({ path: file.path, ...symbol }))),
    files: sortedSymbolFiles
  };
  lease?.heartbeat();
  writeGeneratedFile(indexDir, "repository-index.json", `${stableStringify(repositoryIndex)}\n`);
  writeGeneratedFile(indexDir, "docs-index.json", `${stableStringify(docsIndex)}\n`);
  const generated = ["repository-index.json", "docs-index.json"];
  if (config.index.symbols) {
    writeGeneratedFile(indexDir, "symbol-index.json", `${stableStringify(symbolIndex)}\n`);
    generated.push("symbol-index.json");
  }
  let dependencyIndex = null;
  if (config.index.dependencies) {
    dependencyIndex = buildDependencyIndex(sortedSymbolFiles, rows, config);
    writeGeneratedFile(indexDir, "dependency-index.json", `${stableStringify(dependencyIndex)}\n`);
    generated.push("dependency-index.json");
  }
  const top = [...directoryMap.entries()]
    .filter(([name]) => name === "." || !name.includes("/"))
    .sort(([a], [b]) => a.localeCompare(b));
  const markdown = [
    "# Generated Project Index",
    "",
    `Files indexed: ${rows.length}`,
    ...(scan ? [`Files discovered: ${scan.discoveredFiles}`, `Truncated: ${scan.truncated}`] : []),
    `Symbols: ${symbolCount}`,
    `Dependency edges: ${dependencyIndex?.counts.edges ?? 0}`,
    "",
    "## Top-level areas",
    "",
    ...top.map(([name, counts]) => `- \`${name}\`: ${counts.files} files; ${counts.source} source; ${counts.test} test; ${counts.doc} docs`),
    "",
    "## Important files",
    "",
    ...important.sort().map((file) => `- \`${file}\``),
    ""
  ].join("\n");
  writeGeneratedFile(indexDir, "PROJECT_INDEX.md", markdown);
  generated.push("PROJECT_INDEX.md");
  return generated;
}
