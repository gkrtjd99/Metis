import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { registerCheck, runChecks } from "../src/core/checks.js";
import { addDecision, addFinding, getDecision, getFinding, setFindingStatus } from "../src/core/evidence.js";
import { syncRepository } from "../src/core/repository.js";
import { startRun } from "../src/core/state.js";
import { makeProject, nodeCommand } from "./helpers.js";

test("source changes invalidate findings, dependent decisions, and passed checks", () => {
  const { root, config, db } = makeProject();
  try {
    writeFileSync(path.join(root, "feature.js"), "export const value = 1;\n");
    syncRepository(db, root, config, null);
    const { run } = startRun(db, root, config, "Change the feature");
    const finding = addFinding(db, root, run.id, {
      claim: "Feature value is one.",
      kind: "fact",
      sources: [{ path: "feature.js", lineStart: 1, lineEnd: 1 }]
    });
    const decision = addDecision(db, run.id, {
      title: "Use current value",
      decision: "Keep value one.",
      rationale: "Current behavior requires it.",
      evidenceRefs: [finding.id]
    });
    registerCheck(db, run.id, { name: "syntax", command: nodeCommand(["--check", "feature.js"]), required: true });
    assert.equal(runChecks(db, root, run.id, config)[0].status, "passed");

    writeFileSync(path.join(root, "feature.js"), "export const value = 2;\n");
    const result = syncRepository(db, root, config, run.id);
    assert.deepEqual(result.staleFindings, [finding.id]);
    assert.equal(getFinding(db, finding.id).status, "stale");
    assert.equal(getDecision(db, decision.id).status, "needs-review");
    assert.equal(db.prepare("SELECT status FROM checks WHERE run_id = ? AND name = 'syntax'").get(run.id).status, "stale");

    const oldHash = finding.sources[0].fileSha256;
    const revalidated = setFindingStatus(db, root, run.id, finding.id, "valid", "Confirmed against current source");
    assert.notEqual(revalidated.sources[0].fileSha256, oldHash);
    assert.equal(syncRepository(db, root, config, run.id).staleFindings.length, 0);
  } finally {
    db.close();
  }
});
