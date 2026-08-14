import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectLifecycleProfile } from "../src/core/contracts.js";
import { ensureConfig } from "../src/core/config.js";
import { lifecycleReviewRequired } from "../src/core/state.js";

const requirement = {
  id: "REQ-001",
  title: "Make the local change",
  description: "Make the local change.",
  kind: "functional",
  priority: "must",
  acceptance: ["The local behavior is verified."]
};

function contractInput(overrides = {}) {
  return {
    objective: "Make the local change",
    scope: ["src/parser.js", "tests/parser.test.js"],
    nonGoals: ["Unrelated changes"],
    constraints: ["Preserve existing behavior"],
    successCriteria: ["The local behavior is verified."],
    complexity: "trivial",
    requirements: [requirement],
    ...overrides
  };
}

test("auto selection chooses fast only for the exact bounded local shape", () => {
  const selected = selectLifecycleProfile(contractInput(), "trivial", [requirement], contractInput().scope);
  assert.equal(selected.lifecycleProfile, "fast");
  assert.deepEqual(selected.lifecycleProfileReasons, ["auto: exact bounded local change"]);
});

test("balanced waives research and design only when their triggering evidence is absent", () => {
  const selected = selectLifecycleProfile(contractInput({ route: { lifecycleProfile: "balanced" } }), "trivial", [requirement], contractInput().scope);
  assert.equal(selected.lifecycleProfile, "balanced");
  assert.match(selected.lifecycleProfileReasons.join("; "), /external research is waived/);
  assert.match(selected.lifecycleProfileReasons.join("; "), /separate design is skipped/);

  const research = selectLifecycleProfile(contractInput({ externalCurrentFacts: ["Current API behavior"] }), "trivial", [requirement], contractInput().scope);
  assert.equal(research.lifecycleProfile, "balanced");
  assert.match(research.lifecycleProfileReasons.join("; "), /requires research/);

  const design = selectLifecycleProfile(contractInput({ sharedInterfaces: ["ParserResult"] }), "trivial", [requirement], contractInput().scope);
  assert.equal(design.lifecycleProfile, "balanced");
  assert.match(design.lifecycleProfileReasons.join("; "), /requires separate design/);
});

test("full is selected for high-risk surfaces and explicit full is always allowed", () => {
  const highRisk = selectLifecycleProfile(contractInput({ scope: ["src/auth/handler.js"] }), "trivial", [requirement], ["src/auth/handler.js"]);
  assert.equal(highRisk.lifecycleProfile, "full");
  assert.match(highRisk.lifecycleProfileReasons.join("; "), /high-risk surface: auth/);

  const explicit = selectLifecycleProfile(contractInput({ route: { lifecycleProfile: "full" } }), "trivial", [requirement], contractInput().scope);
  assert.equal(explicit.lifecycleProfile, "full");
  assert.deepEqual(explicit.lifecycleProfileReasons, ["explicit user full override"]);
});

test("obsolete false route fields are rejected for explicit balanced and full profiles", () => {
  for (const lifecycleProfile of ["balanced", "full"]) {
    assert.throws(
      () => selectLifecycleProfile(contractInput({ route: {
        lifecycleProfile,
        independentReviewRequired: false,
        adversarialReviewRequired: false
      } }), "trivial", [requirement], contractInput().scope),
      /CONTRACT_OBSOLETE_ROUTE_FIELD|obsolete.*lifecycleProfile controls mandatory review gates/i
    );
  }
});

test("explicit fast rejects an unsafe downgrade and selection has no obsolete fastPath field", () => {
  assert.throws(
    () => selectLifecycleProfile(contractInput({ route: { lifecycleProfile: "fast" }, externalCurrentFacts: ["Current API behavior"] }), "trivial", [requirement], contractInput().scope),
    /Fast lifecycle profile is unsafe.*external-current fact/
  );
  const selected = selectLifecycleProfile(contractInput(), "trivial", [requirement], contractInput().scope);
  assert.equal(selected.lifecycleProfile, "fast");
  assert.equal(Object.hasOwn(selected, "fastPath"), false);
});

test("fast and auto-balanced profiles preserve all review gates when obsolete config flags are false", () => {
  const falseConfig = { orchestration: {
    requireIndependentReview: false,
    requireAdversarialCompletionReview: false
  } };
  assert.equal(lifecycleReviewRequired({ lifecycleProfile: "fast" }, falseConfig, "integration"), true);
  assert.equal(lifecycleReviewRequired({ lifecycleProfile: "fast" }, falseConfig, "completion"), true);
  const selected = selectLifecycleProfile(contractInput({ scope: ["src/parser.js", "tests/parser.test.js", "src/other.js"] }), "standard", [requirement], ["src/parser.js", "tests/parser.test.js", "src/other.js"]);
  assert.equal(selected.lifecycleProfile, "balanced");
  assert.equal(lifecycleReviewRequired(selected, falseConfig, "integration"), true);
  assert.equal(lifecycleReviewRequired(selected, falseConfig, "completion"), true);
});

test("obsolete orchestration review flags are rejected by config validation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "metis-config-test-"));
  assert.throws(
    () => ensureConfig(root, { orchestration: { requireIndependentReview: false } }),
    /Obsolete configuration field orchestration\.requireIndependentReview/
  );
  assert.throws(
    () => ensureConfig(root, { orchestration: { requireAdversarialCompletionReview: false } }),
    /Obsolete configuration field orchestration\.requireAdversarialCompletionReview/
  );
});
