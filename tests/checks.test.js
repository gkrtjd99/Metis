import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { registerCheck, runChecks } from "../src/core/checks.js";
import { startRun } from "../src/core/state.js";
import { makeProject, nodeCommand } from "./helpers.js";

test("a verification command that mutates source-of-truth files does not pass", () => {
  const { root, config, db } = makeProject();
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    const { run } = startRun(db, root, config, "Detect mutating verification");
    registerCheck(db, run.id, {
      name: "mutating-check",
      command: nodeCommand(["-e", "require('fs').writeFileSync('src/generated.js','export const generated = true;\\n')"]),
      required: true
    });
    const result = runChecks(db, root, run.id, config)[0];
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, "failed");
    assert.deepEqual(result.mutatedPaths, ["src/generated.js"]);
    assert.match(result.preview, /changed source-of-truth files/i);
  } finally {
    db.close();
  }
});

test("a non-mutating successful verification command passes", () => {
  const { root, config, db } = makeProject();
  try {
    const { run } = startRun(db, root, config, "Run clean verification");
    registerCheck(db, run.id, {
      name: "clean-check",
      command: nodeCommand(["-e", "process.exit(0)"]),
      required: true
    });
    const result = runChecks(db, root, run.id, config)[0];
    assert.equal(result.status, "passed");
    assert.deepEqual(result.mutatedPaths, []);
  } finally {
    db.close();
  }
});
