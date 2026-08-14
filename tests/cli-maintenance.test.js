import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installAdapters } from "../src/adapters/install.js";
import { main } from "../src/cli.js";
import { freezeGoalContract } from "../src/core/contracts.js";
import { startRun } from "../src/core/state.js";
import { jsonIo, makeProject } from "./helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("install status reports managed file integrity", async () => {
  const { root, db } = makeProject();
  db.close();
  installAdapters(root, ["codex"], false);
  const io = jsonIo();
  const code = await main(["install", "status", "--root", root, "--pretty"], io);
  assert.equal(code, 0);
  const result = JSON.parse(io.stdoutText);
  assert.equal(result.installed, true);
  assert.deepEqual(result.hosts, ["codex"]);
  assert.ok(result.files.every((file) => file.state === "current"));
});

test("state purge refuses to erase the only backup of a modified managed file", async () => {
  const { root, db } = makeProject();
  db.close();
  installAdapters(root, ["codex"], false);
  const managed = path.join(root, ".agents", "skills", "metis", "SKILL.md");
  writeFileSync(managed, "locally modified\n");

  const blockedIo = jsonIo();
  const blocked = await main([
    "uninstall", "--root", root, "--force-modified", "--purge-state", "--yes", "--pretty"
  ], blockedIo);
  assert.equal(blocked, 1);
  const payload = JSON.parse(blockedIo.stdoutText);
  assert.equal(payload.error.code, "MODIFIED_BACKUP_WOULD_BE_PURGED");
  assert.equal(readFileSync(managed, "utf8"), "locally modified\n");
  assert.equal(existsSync(path.join(root, ".metis")), true);

  const discardIo = jsonIo();
  const discarded = await main([
    "uninstall", "--root", root, "--force-modified", "--discard-modified",
    "--purge-state", "--yes", "--pretty"
  ], discardIo);
  assert.equal(discarded, 0);
  assert.equal(existsSync(managed), false);
  assert.equal(existsSync(path.join(root, ".metis")), false);
});

test("the installed metis symlink executes the CLI entry point", () => {
  const { root, db } = makeProject();
  db.close();
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const link = path.join(binDir, "metis");
  symlinkSync(CLI, link);
  const result = spawnSync(link, ["--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Metis CLI/u);
  assert.match(result.stdout, /metis drive/u);
  assert.match(result.stdout, /metis clean/u);
});

test("CLI main normalizes config setup failures into its error payload", async () => {
  const { root, db } = makeProject();
  db.close();
  writeFileSync(path.join(root, ".metis", "config.json"), JSON.stringify({ version: 4 }));

  const io = jsonIo();
  const code = await main(["status", "--root", root], io);

  assert.equal(code, 2);
  assert.equal(io.stdoutText, "");
  const payload = JSON.parse(io.stderrText);
  assert.equal(payload.error.code, "INTERNAL_ERROR");
  assert.match(payload.error.message, /config version 6/u);
});

test("drive is the only public command that materializes fast-profile prerequisites", async () => {
  const { root, db, config } = makeProject();
  const started = startRun(db, root, config, "Update the local parser");
  freezeGoalContract(db, root, started.run.id, {
    objective: "Update the local parser",
    scope: ["src/parser.js", "tests/parser.test.js"],
    nonGoals: ["Unrelated changes"],
    constraints: ["Preserve existing behavior"],
    successCriteria: ["The parser accepts the new local case."],
    complexity: "trivial",
    route: {
      lifecycleProfile: "fast",
      researchRequired: false,
      designRequired: false,
      specialistReviewRequired: false,
      documentationRequired: true
    },
    requirements: [{
      id: "REQ-001",
      title: "Accept the local parser case",
      description: "Accept the local parser case.",
      kind: "functional",
      priority: "must",
      acceptance: ["The local parser case is accepted."]
    }]
  });
  db.prepare("UPDATE runs SET phase = 'discover', revision = revision + 1 WHERE id = ?").run(started.run.id);
  db.close();

  const controllerFlags = [
    "--controller-session", started.controller.sessionId,
    "--controller-owner", started.controller.owner,
    "--controller-token", started.controller.token,
    "--controller-fence", String(started.controller.fencingToken)
  ];
  const materializeIo = jsonIo();
  const materializeCode = await main(["drive", "--root", root, ...controllerFlags], materializeIo);
  assert.equal(materializeCode, 0, materializeIo.stderrText);
  assert.equal(materializeIo.stderrText, "");
  const result = JSON.parse(materializeIo.stdoutText);
  assert.equal(result.type, "SPAWN_BATCH");
  assert.deepEqual(result.applied.map((item) => item.type), ["MATERIALIZE_FAST_PATH_PREREQUISITES", "ADVANCE_PHASE"]);
});
