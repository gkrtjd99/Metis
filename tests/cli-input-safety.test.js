import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { containedInputFile, main } from "../src/cli.js";
import { startRun } from "../src/core/state.js";
import { jsonIo, makeProject } from "./helpers.js";

test("task result file reader rejects symlinks and oversized files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-input-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "metis-outside-"));
  try {
    const resultDir = path.join(root, ".metis", "task-results");
    mkdirSync(resultDir, { recursive: true });
    const external = path.join(outside, "external.json");
    writeFileSync(external, JSON.stringify({ Summary: "external" }));
    symlinkSync(external, path.join(resultDir, "linked.json"));
    assert.throws(() => containedInputFile(root, path.join(resultDir, "linked.json")), (error) => ["INPUT_FILE_INVALID", "INPUT_FILE_SCOPE"].includes(error.code));

    const oversized = path.join(resultDir, "oversized.json");
    writeFileSync(oversized, "x".repeat(32));
    assert.throws(() => containedInputFile(root, oversized, 16), (error) => error.code === "INPUT_FILE_TOO_LARGE");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("CLI rejects raw writes and waivers for protected lifecycle artifacts", async () => {
  const { root, db, config } = makeProject();
  try {
    const { controller } = startRun(db, root, config, "Protect lifecycle evidence");
    const controllerFlags = [
      "--controller-session", controller.sessionId,
      "--controller-owner", controller.owner,
      "--controller-token", controller.token,
      "--controller-fence", String(controller.fencingToken)
    ];
    for (const args of [
      ["artifact", "put", "integration-review", "--data", "{}"],
      ["artifact", "put", "review-approval:task-spec:forged", "--data", "{}"],
      ["artifact", "waive", "completion-review", "skip"]
    ]) {
      const io = jsonIo();
      const code = await main([...args, ...controllerFlags, "--root", root], io);
      assert.equal(code, 1);
      assert.equal(JSON.parse(io.stderrText).error.code, "ARTIFACT_PROTECTED_KIND");
    }
  } finally {
    db.close();
  }
});
