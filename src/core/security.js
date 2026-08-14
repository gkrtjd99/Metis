import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { invariant } from "./errors.js";
import { normalizeRepoPath } from "./util.js";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveInside(root, relativePath, options = {}) {
  invariant(typeof relativePath === "string" && relativePath.trim(), options.code ?? "PATH_REQUIRED", "A relative path is required.");
  invariant(!path.isAbsolute(relativePath), options.code ?? "PATH_OUTSIDE_ROOT", `Absolute paths are not allowed: ${relativePath}`);
  const normalized = normalizeRepoPath(relativePath);
  invariant(normalized && normalized !== "." && !normalized.startsWith("../") && normalized !== "..", options.code ?? "PATH_OUTSIDE_ROOT", `Path escapes its root: ${relativePath}`);
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, normalized);
  invariant(inside(absoluteRoot, candidate), options.code ?? "PATH_OUTSIDE_ROOT", `Path escapes its root: ${relativePath}`);
  return { absolute: candidate, relative: normalized };
}

export function assertNoSymlinkTraversal(root, relativePath, options = {}) {
  const resolved = resolveInside(root, relativePath, options);
  const segments = resolved.relative.split("/").filter(Boolean);
  let cursor = path.resolve(root);
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (!existsSync(cursor)) continue;
    const stat = lstatSync(cursor);
    invariant(!stat.isSymbolicLink(), options.code ?? "PATH_SYMLINK", `Managed path crosses a symbolic link: ${relativePath}`);
  }
  if (existsSync(resolved.absolute)) {
    const realRoot = realpathSync(path.resolve(root));
    const realTarget = realpathSync(resolved.absolute);
    invariant(inside(realRoot, realTarget), options.code ?? "PATH_OUTSIDE_ROOT", `Resolved path escapes its root: ${relativePath}`);
  }
  return resolved;
}

export function safeManifestPath(root, recordPath, options = {}) {
  return assertNoSymlinkTraversal(root, recordPath, {
    code: options.code ?? "MANIFEST_PATH_INVALID"
  });
}

export function normalizeCommandSpec(value, options = {}) {
  invariant(value && typeof value === "object" && !Array.isArray(value), options.code ?? "COMMAND_SPEC", "A command must be a structured object.");
  const command = String(value.command ?? "").trim();
  invariant(command, options.code ?? "COMMAND_SPEC", "A command executable is required.");
  invariant(!/[\r\n\0]/u.test(command), options.code ?? "COMMAND_SPEC", "The executable contains invalid characters.");
  const args = value.args ?? [];
  invariant(Array.isArray(args) && args.every((item) => typeof item === "string" && !item.includes("\0")), options.code ?? "COMMAND_SPEC", "Command arguments must be strings.");
  const env = value.env ?? {};
  invariant(env && typeof env === "object" && !Array.isArray(env), options.code ?? "COMMAND_SPEC", "Command environment must be an object.");
  for (const [key, item] of Object.entries(env)) {
    invariant(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key), options.code ?? "COMMAND_SPEC", `Invalid environment variable name: ${key}`);
    invariant(typeof item === "string" && !item.includes("\0"), options.code ?? "COMMAND_SPEC", `Invalid environment value for ${key}.`);
  }
  return {
    command,
    args: [...args],
    env: { ...env },
    cwd: value.cwd === undefined || value.cwd === null ? null : String(value.cwd),
    timeoutMs: value.timeoutMs === undefined || value.timeoutMs === null ? null : Number(value.timeoutMs)
  };
}

export function substituteCommandSpec(spec, variables = {}, options = {}) {
  const normalized = normalizeCommandSpec(spec, options);
  const replace = (value) => String(value).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (match, key) => {
    invariant(Object.hasOwn(variables, key), options.code ?? "COMMAND_TEMPLATE", `Unknown command template variable: ${key}`);
    return String(variables[key]);
  });
  return {
    ...normalized,
    command: replace(normalized.command),
    args: normalized.args.map(replace),
    env: Object.fromEntries(Object.entries(normalized.env).map(([key, value]) => [key, replace(value)])),
    cwd: normalized.cwd ? replace(normalized.cwd) : null
  };
}
