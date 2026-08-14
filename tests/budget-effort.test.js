import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBudgetAvailable,
  budgetStatus,
  estimateEffortTokens,
  estimateEffortUsage
} from "../src/core/budget.js";
import { estimateAttemptTokens, recordUsageSample } from "../src/core/tokens.js";
import { makeProject, startTestRun } from "./helpers.js";

test("budget status exposes conservative projections for every reasoning effort", () => {
  const { root, config, db } = makeProject({
    config: { budgets: { run: { inputTokens: 1_000, outputTokens: 2_000 } } }
  });
  try {
    const { run } = startTestRun(db, root, config, "Effort budget projections");
    recordUsageSample(db, run.id, {
      role: "worker", model: "fixture", observedInputTokens: 100, observedOutputTokens: 100, source: "host"
    });
    const status = budgetStatus(db, run.id);
    assert.deepEqual(Object.keys(status.effortAware.projections), ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(status.effortAware.projections.high.outputTokens, 135);
    assert.equal(status.effortAware.projections.max.outputTokens, 225);
    assert.equal(status.effortAware.projections.max.fitsHardBudget, true);
  } finally {
    db.close();
  }
});

test("max effort is rejected and journaled before an attempt that cannot fit the hard budget", () => {
  const { root, config, db } = makeProject({
    config: { budgets: { run: { inputTokens: 1_000, outputTokens: 200 } } }
  });
  try {
    const { run } = startTestRun(db, root, config, "Reject unaffordable max effort");
    recordUsageSample(db, run.id, {
      role: "worker", model: "fixture", observedInputTokens: 100, observedOutputTokens: 100, source: "host"
    });
    assert.throws(
      () => assertBudgetAvailable(db, run.id, {}, {
        effort: "max", estimatedInputTokens: 100, estimatedOutputTokens: 100
      }),
      (error) => error.code === "BUDGET_EXCEEDED"
        && error.details.effortEstimate.outputTokens === 225
        && error.details.unavailable.some((item) => item.key === "outputTokens")
    );
    const warning = db.prepare("SELECT event_type, payload_json FROM journal WHERE run_id = ? AND event_type = 'budget.effort-warning'").get(run.id);
    assert.ok(warning);
    assert.match(warning.payload_json, /max-attempt-would-exceed-hard-budget/);
  } finally {
    db.close();
  }
});

test("attempt estimates scale only the reasoning/output envelope", () => {
  assert.equal(estimateEffortTokens(101, "max"), 228);
  assert.deepEqual(estimateEffortUsage(100, 100, "xhigh"), {
    effort: "xhigh", multiplier: 1.75, inputTokens: 100, outputTokens: 175, totalTokens: 275
  });
  const estimate = estimateAttemptTokens(null, "const value = 1;", { effort: "high", outputTokens: 20 });
  assert.equal(estimate.inputTokens, estimate.estimatedInputTokens);
  assert.equal(estimate.outputTokens, 27);
  assert.equal(estimate.effortMultiplier, 1.35);
});
