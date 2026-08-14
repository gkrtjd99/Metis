import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stableStringify } from "./util.js";
import { RUNTIME_LAYOUT_VERSION } from "./metadata.js";

export { RUNTIME_LAYOUT_VERSION };

export const RUNTIME_AREAS = Object.freeze({
  state: { relative: "state", class: "persistent", description: "SQLite state and transaction files" },
  objects: { relative: "objects", class: "persistent", description: "Referenced content-addressed evidence" },
  generated: { relative: "generated", class: "regenerable", description: "Repository, document, symbol, and knowledge indexes" },
  cache: { relative: "cache", class: "cache", description: "Regenerable query and tokenizer caches" },
  logs: { relative: "logs", class: "cache", description: "Local execution logs" },
  tmp: { relative: "tmp", class: "ephemeral", description: "Atomic-write and integration staging files" },
  worktrees: { relative: "worktrees", class: "ephemeral", description: "Task-isolated Git worktrees" },
  benchmarks: { relative: "benchmarks", class: "user-output", description: "Benchmark specifications and run reports" },
  backups: { relative: "backups", class: "recovery", description: "Install-time backups for overwritten host files" }
});

export function runtimeRoot(projectRoot) {
  return path.join(projectRoot, ".metis");
}

export function runtimeArea(projectRoot, area) {
  const descriptor = RUNTIME_AREAS[area];
  if (!descriptor) throw new Error(`Unknown Metis runtime area: ${area}.`);
  return path.join(runtimeRoot(projectRoot), descriptor.relative);
}

export function runtimeLayoutPath(projectRoot) {
  return path.join(runtimeRoot(projectRoot), "layout.json");
}

export function runtimeConfigPath(projectRoot) {
  return path.join(runtimeRoot(projectRoot), "config.json");
}

export function runtimeDatabasePath(projectRoot) {
  return path.join(runtimeArea(projectRoot, "state"), "state.db");
}

export function ensureRuntimeLayout(projectRoot) {
  const root = runtimeRoot(projectRoot);
  const oldDatabase = path.join(root, "state.db");
  if (existsSync(oldDatabase)) {
    throw new Error(
      "Unsupported legacy Metis runtime layout. " +
      "Remove `.metis/` and initialize a new managed project."
    );
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const area of Object.keys(RUNTIME_AREAS)) mkdirSync(runtimeArea(projectRoot, area), { recursive: true, mode: 0o700 });
  const file = runtimeLayoutPath(projectRoot);
  if (existsSync(file)) {
    const current = JSON.parse(readFileSync(file, "utf8"));
    if (current.version !== RUNTIME_LAYOUT_VERSION) {
      throw new Error(
        `Unsupported Metis runtime layout ${current.version}. ` +
        "Remove `.metis/` and start a new goal."
      );
    }
    chmodSync(root, 0o700);
    chmodSync(file, 0o600);
    return current;
  }
  const layout = {
    version: RUNTIME_LAYOUT_VERSION,
    areas: Object.fromEntries(Object.entries(RUNTIME_AREAS).map(([name, value]) => [name, value.relative]))
  };
  writeFileSync(file, `${stableStringify(layout)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(root, 0o700);
  chmodSync(file, 0o600);
  return layout;
}

export function runtimeInventory(projectRoot) {
  return Object.fromEntries(
    Object.entries(RUNTIME_AREAS).map(([name, descriptor]) => [name, {
      ...descriptor,
      path: runtimeArea(projectRoot, name),
      relativePath: `.metis/${descriptor.relative}/`
    }])
  );
}


function measurePath(target) {
  if (!existsSync(target)) return { bytes: 0, files: 0, directories: 0 };
  const stat = lstatSync(target);
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1, directories: 0 };
  let bytes = 0;
  let files = 0;
  let directories = 0;
  const visit = (directory) => {
    directories += 1;
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute);
      else {
        files += 1;
        try { bytes += lstatSync(absolute).size; } catch {}
      }
    }
  };
  visit(target);
  return { bytes, files, directories };
}

export function storageInventory(projectRoot) {
  const root = runtimeRoot(projectRoot);
  const areas = Object.entries(RUNTIME_AREAS).map(([name, descriptor]) => {
    const target = runtimeArea(projectRoot, name);
    return {
      name,
      class: descriptor.class,
      description: descriptor.description,
      path: `.metis/${descriptor.relative}/`,
      exists: existsSync(target),
      ...measurePath(target)
    };
  });
  const fixed = [
    { name: "layout", class: "persistent", description: "Runtime layout version", path: ".metis/layout.json", target: runtimeLayoutPath(projectRoot) },
    { name: "config", class: "persistent", description: "Project-local Metis configuration", path: ".metis/config.json", target: runtimeConfigPath(projectRoot) }
  ].map((item) => ({ ...item, exists: existsSync(item.target), ...measurePath(item.target), target: undefined }));
  const all = [...fixed, ...areas];
  return {
    root: ".metis/",
    exists: existsSync(root),
    totalBytes: all.reduce((sum, item) => sum + item.bytes, 0),
    areas: all
  };
}
