import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { syncRepository } from "../src/core/repository.js";
import { now } from "../src/core/util.js";
import { makeProject } from "./helpers.js";

function scanCount(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM repository_scans").get().count;
}

function indexPath(root, name = "repository-index.json") {
  return path.join(root, ".metis", "generated", name);
}

test("repository sync cache hits without changing scan or generated-index timestamps", () => {
  const { root, config, db } = makeProject();
  try {
    const beforeScan = scanCount(db);
    const beforeIndex = statSync(indexPath(root)).mtimeMs;
    const result = syncRepository(db, root, config, null);
    assert.equal(result.cached, true);
    assert.equal(scanCount(db), beforeScan);
    assert.equal(statSync(indexPath(root)).mtimeMs, beforeIndex);
  } finally {
    db.close();
  }
});

test("force bypasses repository sync cache", () => {
  const { root, config, db } = makeProject();
  try {
    const before = scanCount(db);
    const result = syncRepository(db, root, config, null, { force: true });
    assert.equal(result.cached, undefined);
    assert.equal(scanCount(db), before + 1);
  } finally {
    db.close();
  }
});

test("assume-unchanged tracked files cannot hide source mutations from the cache", () => {
  const { root, config, db } = makeProject();
  try {
    execFileSync("git", ["update-index", "--assume-unchanged", "package.json"], { cwd: root });
    writeFileSync(path.join(root, "package.json"), `${readFileSync(path.join(root, "package.json"), "utf8")}\n`);
    const result = syncRepository(db, root, config);
    assert.notEqual(result.cached, true);
    assert.deepEqual(result.modified, ["package.json"]);
  } finally {
    db.close();
  }
});

test("content, HEAD, untracked, config, and generated-output changes miss the cache", () => {
  const { root, config, db } = makeProject();
  try {
    const contentPath = path.join(root, "same-size.js");
    writeFileSync(contentPath, "export const value = 1;\n");
    syncRepository(db, root, config, null, { force: true });

    writeFileSync(contentPath, "export const value = 2;\n");
    assert.notEqual(syncRepository(db, root, config).cached, true);
    syncRepository(db, root, config);

    execFileSync("git", ["add", "same-size.js"] , { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "content"], { cwd: root });
    assert.notEqual(syncRepository(db, root, config).cached, true);
    syncRepository(db, root, config);

    writeFileSync(path.join(root, "untracked.js"), "export const untracked = true;\n");
    assert.notEqual(syncRepository(db, root, config).cached, true);
    syncRepository(db, root, config);

    config.index.maxFiles += 1;
    assert.notEqual(syncRepository(db, root, config).cached, true);
    syncRepository(db, root, config);

    unlinkSync(indexPath(root));
    assert.notEqual(syncRepository(db, root, config).cached, true);
  } finally {
    db.close();
  }
});

test("generated index content tampering misses the cache and regenerates output", () => {
  const { root, config, db } = makeProject();
  try {
    const generated = indexPath(root);
    const original = readFileSync(generated, "utf8");
    writeFileSync(generated, `${"x".repeat(original.length - 1)}\n`);
    const before = scanCount(db);

    const result = syncRepository(db, root, config);

    assert.notEqual(result.cached, true);
    assert.equal(scanCount(db), before + 1);
    assert.equal(JSON.parse(readFileSync(generated, "utf8")).version, 2);
  } finally {
    db.close();
  }
});

test("malformed and invalid repository scan metadata are cache misses", () => {
  const { root, config, db } = makeProject();
  try {
    const latestId = () => db.prepare("SELECT id FROM repository_scans ORDER BY created_at DESC LIMIT 1").get().id;
    db.prepare("UPDATE repository_scans SET metadata_json = ? WHERE id = ?").run("{", latestId());
    const malformed = syncRepository(db, root, config);
    assert.notEqual(malformed.cached, true);

    db.prepare("UPDATE repository_scans SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({ syncCache: { version: 1, fingerprint: "invalid", generated: {} } }), latestId());
    const invalid = syncRepository(db, root, config);
    assert.notEqual(invalid.cached, true);
  } finally {
    db.close();
  }
});

test("a source mutation during cache lookup cannot produce a false hit", () => {
  const { root, config, db } = makeProject();
  try {
    const source = path.join(root, "race.js");
    writeFileSync(source, "export const value = 1;\n");
    syncRepository(db, root, config, null, { force: true });
    assert.equal(syncRepository(db, root, config).cached, true);

    let mutated = false;
    const racingDb = {
      exec(...args) {
        return db.exec(...args);
      },
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.includes("SELECT * FROM repository_scans")) return statement;
        return {
          get(...args) {
            const row = statement.get(...args);
            if (!mutated) {
              mutated = true;
              writeFileSync(source, "export const value = 2;\n");
            }
            return row;
          }
        };
      }
    };

    const result = syncRepository(racingDb, root, config);
    assert.equal(mutated, true);
    assert.notEqual(result.cached, true);
    assert.deepEqual(result.modified, ["race.js"]);
  } finally {
    db.close();
  }
});

test("a later process waits for and recovers an expired repository lease", async () => {
  const { root, config, db } = makeProject();
  try {
    const resource = `repository:${path.resolve(root)}`;
    const timestamp = now();
    db.prepare(`
      UPDATE repository_sync_leases
      SET owner_token = ?, fencing_token = fencing_token + 1,
        expires_at = ?, updated_at = ?
      WHERE resource = ?
    `).run("test-owner", new Date(Date.now() + 60_000).toISOString(), timestamp, resource);

    const childCode = `
      import { openDatabase } from ${JSON.stringify(path.resolve("src/core/db.js"))};
      import { ensureConfig } from ${JSON.stringify(path.resolve("src/core/config.js"))};
      import { syncRepository } from ${JSON.stringify(path.resolve("src/core/repository.js"))};
      const root = process.argv[1];
      const db = openDatabase(root);
      try {
        const result = syncRepository(db, root, ensureConfig(root), null, { force: true });
        process.stdout.write(JSON.stringify({ cached: result.cached, scanId: result.scan.id }));
      } finally {
        db.close();
      }
    `;
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", childCode, root], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(child.exitCode, null);
    db.prepare(`
      UPDATE repository_sync_leases SET expires_at = ?, updated_at = ? WHERE resource = ?
    `).run(new Date(Date.now() - 1).toISOString(), now(), resource);
    const status = await new Promise((resolve) => child.once("close", (code) => resolve(code)));
    assert.equal(status, 0, stderr);
    assert.equal(JSON.parse(stdout).cached, undefined);
    assert.equal(JSON.parse(readFileSync(indexPath(root), "utf8")).version, 2);
    const lease = db.prepare("SELECT fencing_token, owner_token FROM repository_sync_leases WHERE resource = ?").get(resource);
    assert.equal(lease.owner_token.startsWith("repository-sync_"), true);
    assert.ok(Number(lease.fencing_token) >= 3);
  } finally {
    db.close();
  }
});
