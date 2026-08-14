import assert from "node:assert/strict";
import test from "node:test";
import { assertBudgetAvailable, budgetStatus } from "../src/core/budget.js";
import { recordUsageSample } from "../src/core/tokens.js";
import { makeProject, startTestRun } from "./helpers.js";

test("host-observed token usage updates the enforced run budget", () => {
  const { root, config, db } = makeProject({
    config: { budgets: { run: { inputTokens: 10, outputTokens: 5 } } }
  });
  const { run } = startTestRun(db, root, config, "Enforce observed tokens");
  recordUsageSample(db, run.id, {
    role: "worker", model: "fixture", observedInputTokens: 8, observedOutputTokens: 4, source: "host"
  });
  const status = budgetStatus(db, run.id);
  assert.equal(status.usage.inputTokens, 8);
  assert.equal(status.usage.outputTokens, 4);
  assert.equal(status.remaining.inputTokens, 2);
  assert.equal(status.remaining.outputTokens, 1);
  assert.throws(() => assertBudgetAvailable(db, run.id, { inputTokens: 3 }), (error) => error.code === "BUDGET_EXCEEDED");
  assert.throws(() => assertBudgetAvailable(db, run.id, { outputTokens: 2 }), (error) => error.code === "BUDGET_EXCEEDED");
});

test("usage beyond a hard limit is recorded and blocks all later consumption", () => {
  const { root, config, db } = makeProject({
    config: { budgets: { run: { inputTokens: 5, outputTokens: 5 } } }
  });
  const { run } = startTestRun(db, root, config, "Stop after actual usage exceeds the limit");
  recordUsageSample(db, run.id, {
    role: "main", observedInputTokens: 6, observedOutputTokens: 0, source: "host"
  });
  const status = budgetStatus(db, run.id);
  assert.equal(status.pass, false);
  assert.deepEqual(status.exceeded, ["inputTokens"]);
  assert.throws(() => assertBudgetAvailable(db, run.id, { toolCalls: 1 }), (error) => error.code === "BUDGET_EXCEEDED");
});
