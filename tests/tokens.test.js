import assert from "node:assert/strict";
import test from "node:test";
import { countTokens, effectiveContextBudget, estimateTokens, recordUsageSample, usageCalibration } from "../src/core/tokens.js";
import { makeProject } from "./helpers.js";

test("fallback token counting is conservative for Korean and code", () => {
  assert.ok(estimateTokens("긴 컨텍스트에서 필요한 정보를 찾습니다.") >= 15);
  assert.ok(estimateTokens("const value = { nested: [1, 2, 3] };\n") >= 10);
});

test("host-observed samples calibrate later context estimates", () => {
  const { db, config } = makeProject();
  try {
    for (let index = 0; index < 3; index += 1) {
      recordUsageSample(db, null, {
        role: "main",
        model: "model-a",
        estimatedTokens: 100,
        observedInputTokens: 200,
        observedOutputTokens: 10
      });
    }
    assert.equal(usageCalibration(db, "model-a").factor, 2);
    const counted = countTokens(db, "a".repeat(370), { config, model: "model-a" });
    assert.equal(counted.method, "calibrated-estimate");
    assert.ok(counted.tokens >= 198 && counted.tokens <= 204);
  } finally {
    db.close();
  }
});

test("context budget reserves room for execution and compaction", () => {
  const { config, db } = makeProject();
  try {
    const budget = effectiveContextBudget(config, 3000, 10000);
    assert.equal(budget, 1800);
  } finally {
    db.close();
  }
});
