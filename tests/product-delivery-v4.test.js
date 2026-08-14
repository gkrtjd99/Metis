import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { registerBrowserScenario, runBrowserScenario } from "../src/core/browser.js";
import { resolveTaskCapabilities } from "../src/core/capabilities.js";
import { addCheckpoint, resolveCheckpoint } from "../src/core/checkpoints.js";
import { lintDesign } from "../src/core/design-review.js";
import { addMilestone } from "../src/core/milestones.js";
import { lintPlan } from "../src/core/plan-review.js";
import { syncRepository } from "../src/core/repository.js";
import { gateReport, putArtifact } from "../src/core/state.js";
import { addTask } from "../src/core/tasks.js";
import { bindCurrentPlanDraft, forcePhase, makeProject, nodeCommand, startTestRun } from "./helpers.js";

const uiRequirement = [{
  id: "REQ-UI",
  title: "Interactive login",
  description: "A user can sign in and see all interface states.",
  kind: "ui",
  priority: "must",
  acceptance: ["The browser flow passes."]
}];

test("capability routing uses requirement and path structure instead of task-title keywords", () => {
  const { root, config, db } = makeProject();
  const { run } = startTestRun(db, root, config, "Route capabilities", { contract: { requirements: uiRequirement } });
  const titleOnly = resolveTaskCapabilities(db, run.id, {
    title: "auth security database migration performance",
    targetPaths: ["src/plain.js"],
    requirementIds: ["REQ-UI"],
    verificationModes: ["test"]
  }).map((item) => item.name);
  assert.deepEqual(titleOnly, []);

  const routed = resolveTaskCapabilities(db, run.id, {
    targetPaths: ["src/components/Login.tsx"],
    requirementIds: ["REQ-UI"],
    verificationModes: ["browser"]
  }).map((item) => item.name);
  assert.deepEqual(routed, ["accessibility", "browser-testing", "frontend-ui", "visual-review"]);
});

test("UI design requires separate experience, visual, and browser acceptance contracts", () => {
  const { root, config, db } = makeProject();
  const { run } = startTestRun(db, root, config, "Design a login interface", {
    contract: { requirements: uiRequirement, designRequired: true }
  });
  forcePhase(db, root, config, run.id, "design");
  putArtifact(db, root, run.id, "design", {
    requirementIds: ["REQ-UI"],
    selectedApproach: "Use the existing form components.",
    interfaces: ["LoginForm"],
    errorHandling: ["Render validation errors inline."],
    testing: ["Run the browser acceptance scenario."]
  }, { status: "verified" });

  const before = lintDesign(db, root, run.id, config);
  assert.equal(before.pass, false);
  assert.ok(before.findings.some((item) => item.code === "EXPERIENCE_CONTRACT_MISSING"));
  assert.ok(before.findings.some((item) => item.code === "VISUAL_CONTRACT_MISSING"));
  assert.ok(before.findings.some((item) => item.code === "BROWSER_ACCEPTANCE_MISSING"));

  putArtifact(db, root, run.id, "experience-contract", {
    actors: ["signed-out user"], journeys: ["sign in"],
    states: ["loading", "empty", "error", "success"],
    interactionRules: ["Submit with keyboard or pointer."],
    informationArchitecture: ["Login page before dashboard."]
  }, { status: "verified" });
  putArtifact(db, root, run.id, "visual-contract", {
    existingDesignSystem: ["repository form components"],
    layoutRules: ["Use the existing form grid."],
    responsiveRules: ["Fit a 390 by 844 viewport."],
    tokens: [], componentReferences: [], visualReferences: []
  }, { status: "verified" });
  putArtifact(db, root, run.id, "browser-acceptance", {
    scenarios: [{ name: "login-happy-path", requirementIds: ["REQ-UI"] }]
  }, { status: "verified" });

  assert.equal(lintDesign(db, root, run.id, config).pass, true);
});

test("UI plans require browser verification and visual review capabilities", () => {
  const { root, config, db } = makeProject();
  const { run } = startTestRun(db, root, config, "Plan a login interface", { contract: { requirements: uiRequirement } });
  forcePhase(db, root, config, run.id, "plan");
  addMilestone(db, run.id, {
    id: "m-ui", title: "Login slice", objective: "Deliver an observable login flow",
    userVisibleOutcome: "A user can submit the login form and see success or error states.",
    exitCriteria: ["REQ-UI is browser verified"], requirementIds: ["REQ-UI"]
  });
  const worker = addTask(db, run.id, {
    id: "ui-worker", title: "Implement login slice", goal: "Implement the complete login interaction",
    role: "worker", runPhase: "execute", milestoneId: "m-ui", targetPaths: ["src/components/Login.tsx"],
    requirementIds: ["REQ-UI"], acceptanceCriteria: ["All states render"], requiredEvidence: ["Browser evidence"],
    verificationModes: ["browser"], effort: "small", sliceType: "vertical"
  }, config);
  addTask(db, run.id, {
    id: "ui-review", title: "Review integrated UI", goal: "Review visual and interaction quality",
    role: "reviewer", runPhase: "review", reviewKind: "integration", readOnly: true, milestoneId: "m-ui",
    requirementIds: ["REQ-UI"], acceptanceCriteria: ["Return an explicit verdict"], requiredEvidence: ["Current repository"],
    verificationModes: ["review"], capabilities: ["visual-review"], dependsOn: ["ui-worker"]
  }, config);
  addTask(db, run.id, {
    id: "ui-verifier", title: "Verify login in a browser", goal: "Run the browser acceptance flow",
    role: "verifier", runPhase: "verify", readOnly: true, milestoneId: "m-ui",
    requirementIds: ["REQ-UI"], acceptanceCriteria: ["The scenario passes"], requiredEvidence: ["Browser evidence"],
    verificationModes: ["browser"], capabilities: ["browser-testing"], dependsOn: ["ui-worker"]
  }, config);
  addTask(db, run.id, {
    id: "ui-adversarial", title: "Review login completion adversarially", goal: "Challenge the current verification candidate for hidden failures",
    role: "adversarial-reviewer", runPhase: "verify", reviewKind: "completion", readOnly: true, milestoneId: "m-ui",
    requirementIds: ["REQ-UI"], acceptanceCriteria: ["Return an explicit completion-review verdict with evidence-backed findings"],
    requiredEvidence: ["Current verification-candidate artifact"], dependsOn: ["ui-review", "ui-verifier"]
  }, config);

  assert.deepEqual(worker.capabilities.map((item) => item.name), ["accessibility", "browser-testing", "frontend-ui", "visual-review"]);
  bindCurrentPlanDraft(db, root, run.id, config);
  const lint = lintPlan(db, run.id, config, root);
  assert.equal(lint.verdict, "APPROVED", JSON.stringify(lint.findings));
});

test("browser evidence is current, encrypted, mutation-sensitive, and usable by checkpoints", () => {
  const { root, config, db } = makeProject();
  const { run } = startTestRun(db, root, config, "Verify the login flow", { contract: { requirements: uiRequirement } });
  const screenshot = ".metis/tmp/login.png";
  registerBrowserScenario(db, run.id, {
    name: "login-happy-path", url: "http://127.0.0.1:3000/login",
    viewport: { width: 390, height: 844 }, requirementIds: ["REQ-UI"],
    command: nodeCommand(["--input-type=module", "-e", `
      import { mkdirSync, writeFileSync } from "node:fs";
      mkdirSync(".metis/tmp", { recursive: true });
      writeFileSync(${JSON.stringify(screenshot)}, Buffer.from([1,2,3,4]));
      console.log(JSON.stringify({ status: "passed", actions: ["submit"], assertions: [{ name: "dashboard-visible", pass: true }], screenshots: [${JSON.stringify(screenshot)}], consoleErrors: [], networkFailures: [] }));
    `])
  });
  const passed = runBrowserScenario(db, root, run.id, "login-happy-path", config);
  assert.equal(passed.evidence.status, "passed");
  assert.equal(passed.mutatedPaths.length, 0);
  const screenshotRef = passed.evidence.screenshotRefs[0];
  const objectRow = db.prepare("SELECT * FROM objects WHERE hash = ?").get(screenshotRef.replace(/^obj_/, ""));
  assert.equal(objectRow.encrypted, 1);

  addCheckpoint(db, run.id, {
    id: "uat-current", kind: "human-verify", reason: "Confirm the subjective interaction quality.",
    requiredEvidence: ["browser-scenario:login-happy-path"]
  });
  assert.equal(resolveCheckpoint(db, run.id, "uat-current", { resolution: "Accepted after review" }).status, "resolved");

  const pkgFile = path.join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  pkg.description = "fingerprint change";
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  syncRepository(db, root, config, run.id);
  addCheckpoint(db, run.id, {
    id: "uat-stale", kind: "human-verify", reason: "Reject stale evidence.",
    requiredEvidence: ["browser-scenario:login-happy-path"]
  });
  assert.throws(() => resolveCheckpoint(db, run.id, "uat-stale", { resolution: "Should not resolve" }), (error) => error.code === "CHECKPOINT_EVIDENCE_MISSING");

  registerBrowserScenario(db, run.id, {
    name: "mutating-browser", url: "http://127.0.0.1:3000/login", requirementIds: ["REQ-UI"],
    command: nodeCommand(["--input-type=module", "-e", `
      import { mkdirSync, writeFileSync } from "node:fs";
      mkdirSync("src", { recursive: true });
      writeFileSync("src/browser-mutated.js", "export const changed = true;\\n");
      console.log(JSON.stringify({ status: "passed", assertions: [{ name: "visible", pass: true }] }));
    `])
  });
  const failed = runBrowserScenario(db, root, run.id, "mutating-browser", config);
  assert.equal(failed.evidence.status, "failed");
  assert.ok(failed.mutatedPaths.includes("src/browser-mutated.js"));
});

test("bounded repository discovery reports truncation and blocks later gates", () => {
  const { root, config, db } = makeProject({ config: { index: { maxFiles: 2, allowTruncated: false } } });
  mkdirSync(path.join(root, "src"), { recursive: true });
  for (let index = 0; index < 6; index += 1) writeFileSync(path.join(root, "src", `file-${index}.js`), `export const v${index} = ${index};\n`);
  const { run } = startTestRun(db, root, config, "Index the complete repository");
  const scan = syncRepository(db, root, config, run.id).scan;
  assert.equal(scan.truncated, true);
  assert.equal(scan.indexedFiles, 2);
  assert.ok(scan.discoveredFiles >= 7);
  const gate = gateReport(db, root, run.id, "plan");
  assert.equal(gate.pass, false);
  assert.ok(gate.failures.some((item) => item.includes("Repository discovery was truncated")));
});
