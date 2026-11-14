import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { listChecks, registerCheck } from "../src/core/checks.js";
import { startRun } from "../src/core/state.js";
import { jsonIo, makeProject, nodeCommand } from "./helpers.js";

test("CLI check detect wires both name flag forms and retains default full detection", async () => {
  const { root, db, config } = makeProject();
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "node --test", build: "tsc" } }));
    const { run, controller } = startRun(db, root, config, "Select detected checks via CLI");
    const flags = [
      "--root", root,
      "--controller-session", controller.sessionId,
      "--controller-owner", controller.owner,
      "--controller-token", controller.token,
      "--controller-fence", String(controller.fencingToken)
    ];
    const required = registerCheck(db, run.id, { name: "custom-required", command: nodeCommand(["-e", "process.exit(0)"]) });
    for (const [nameFlags, expectedName] of [[["--name", "test"], "test"], [["--name=build"], "build"]]) {
      const io = jsonIo();
      assert.equal(await main(["check", "detect", ...nameFlags, ...flags], io), 0, io.stderrText);
      assert.deepEqual(JSON.parse(io.stdoutText).map((check) => check.name), [expectedName]);
    }
    assert.deepEqual(listChecks(db, run.id).map((check) => check.name), ["build", "custom-required", "test"]);
    assert.deepEqual(listChecks(db, run.id).find((check) => check.name === required.name), required);
    const io = jsonIo();
    assert.equal(await main(["check", "detect", ...flags], io), 0, io.stderrText);
    assert.deepEqual(JSON.parse(io.stdoutText).map((check) => check.name), ["lint", "test", "build"]);
  } finally {
    db.close();
  }
});

test("CLI check detect rejects unknown, empty, and missing name values without changing checks", async () => {
  const { root, db, config } = makeProject();
  try {
    const { run, controller } = startRun(db, root, config, "Reject invalid CLI check selection");
    const flags = [
      "--root", root,
      "--controller-session", controller.sessionId,
      "--controller-owner", controller.owner,
      "--controller-token", controller.token,
      "--controller-fence", String(controller.fencingToken)
    ];
    registerCheck(db, run.id, { name: "custom-required", command: nodeCommand(["-e", "process.exit(0)"]) });
    const before = listChecks(db, run.id);
    for (const [nameFlags, expectedCode] of [
      [["--name", "unknown"], "CHECK_NOT_FOUND"],
      [["--name", " test "], "CHECK_NOT_FOUND"],
      [["--name="], "CHECK_NAME"],
      [["--name", " "], "CHECK_NAME"],
      [["--name"], "CHECK_NAME"]
    ]) {
      const io = jsonIo();
      assert.equal(await main(["check", "detect", ...nameFlags, ...flags], io), 1);
      const error = JSON.parse(io.stderrText).error;
      assert.equal(error.code, expectedCode);
      assert.match(error.message, /detected check/i);
      assert.deepEqual(listChecks(db, run.id), before);
    }
  } finally {
    db.close();
  }
});
