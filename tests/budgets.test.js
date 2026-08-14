import assert from "node:assert/strict";
import test from "node:test";
import { garbageCollect } from "../src/core/maintenance.js";
import { advancePhase, putArtifact, startRun } from "../src/core/state.js";
import { addTask, claimTask, finishTask, sealPlan } from "../src/core/tasks.js";
import { makeProject, startTestRun, forcePhase } from "./helpers.js";

const worker = (id) => ({
  id,
  title: id,
  goal: id,
  role: "worker",
  readOnly: false,
  targetPaths: [`src/${id}.js`],
  acceptanceCriteria: ["done"],
  requiredEvidence: ["diff"],
  dependsOn: []
});

test("run task count is bounded", () => {
  const { root, config, db } = makeProject({ config: { orchestration: { maxTasks: 1 } } });
  try {
    const { run } = startTestRun(db, root, config, "Bound task growth");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["src"], constraints: [], nonGoals: [], successCriteria: ["done"], designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, worker("one"), config);
    assert.throws(() => addTask(db, run.id, worker("two"), config), /task limit/i);
  } finally {
    db.close();
  }
});

test("large worker results move full structure outside active state", () => {
  const { root, config, db } = makeProject({ config: { budgets: { workerResultTokens: 200 } } });
  try {
    const { run } = startTestRun(db, root, config, "Compact worker results");
    putArtifact(db, root, run.id, "discovery", {
      scope: ["src"], constraints: [], nonGoals: [], successCriteria: ["done"], designRequired: false
    });
    forcePhase(db, root, config, run.id, "plan");
    addTask(db, run.id, worker("large"), config);
    putArtifact(db, root, run.id, "plan", sealPlan(db, run.id).content);
    forcePhase(db, root, config, run.id, "execute");
    const claim = claimTask(db, run.id, "large", "worker", config);
    const result = finishTask(db, root, run.id, "large", claim.leaseToken, {
      Status: "COMPLETED",
      Files: [],
      Breaking: ["BREAKING-MUST-SURVIVE"],
      Decisions: Array.from({ length: 80 }, (_, index) => `Decision ${index} ${"x".repeat(80)}`),
      Summary: "s".repeat(4000),
      EvidenceRefs: ["package.json:1", ...Array.from({ length: 199 }, (_, index) => `evidence-${index}`)],
      Blockers: []
    }, config);
    assert.equal(result.result.ResultCompacted, true);
    assert.ok(result.result.StructuredRef);
    assert.deepEqual(result.result.Breaking, ["BREAKING-MUST-SURVIVE"]);
    garbageCollect(db, root, { keepContexts: 1 });
    const structuredHash = result.result.StructuredRef.replace(/^obj_/, "");
    assert.ok(db.prepare("SELECT hash FROM objects WHERE hash = ?").get(structuredHash));
  } finally {
    db.close();
  }
});
