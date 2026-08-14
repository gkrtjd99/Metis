import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function now() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)])
    );
  }
  return value;
}

export function parseJson(text, fallback = undefined) {
  if (text === null || text === undefined || text === "") return fallback;
  return JSON.parse(text);
}

export function json(value) {
  return stableStringify(value ?? null);
}

export function readJsonFile(file, fallback = undefined) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function findProjectRoot(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeout,
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : null
  };
}

export function commandExists(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  return runCommand(probe, [command], { timeout: 5000 }).status === 0;
}

export async function readStdin() {
  if (process.stdin.isTTY) return "";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export function relativePath(root, file) {
  const rel = path.relative(root, path.resolve(root, file));
  return rel === "" ? "." : rel.replaceAll(path.sep, "/");
}

export function normalizeRepoPath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === "" ? "." : normalized;
}

export function isSafeRepoPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (path.isAbsolute(value)) return false;
  const normalized = normalizeRepoPath(value);
  return !normalized.split("/").includes("..");
}

export function pathsOverlap(a, b) {
  const left = normalizeRepoPath(a).replace(/\/$/, "");
  const right = normalizeRepoPath(b).replace(/\/$/, "");
  if (left === "." || right === ".") return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function truncateMiddle(text, maxChars) {
  if (text.length <= maxChars) return text;
  if (maxChars < 80) return text.slice(0, maxChars);
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head - 26;
  return `${text.slice(0, head)}\n…[content omitted]…\n${text.slice(-tail)}`;
}

export function redactSecrets(text) {
  let value = String(text ?? "");
  const patterns = [
    [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_OPENAI_KEY]"],
    [/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
    [/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_KEY]"],
    [/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]"],
    [/(api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*["']?[^\s"']+/gi, "$1=[REDACTED]"]
  ];
  for (const [pattern, replacement] of patterns) value = value.replace(pattern, replacement);
  return value;
}

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function redactValue(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}
