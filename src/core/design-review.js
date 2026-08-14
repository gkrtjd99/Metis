import { MetisError, invariant } from "./errors.js";
import { evidenceRefIsCurrent } from "./provenance.js";
import { governanceReport } from "./governance.js";
import { getRun, latestArtifact, putArtifact, recordEvent } from "./state.js";
import { getTask } from "./tasks.js";
import { asArray, json, makeId, now, sha256, stableStringify } from "./util.js";

function parsed(artifact) {
  try { return artifact?.content ? JSON.parse(artifact.content) : null; } catch { return null; }
}

function designRequirementIds(data) {
  const direct = asArray(data.requirementIds);
  const coverage = data.requirementCoverage && typeof data.requirementCoverage === "object"
    ? Object.keys(data.requirementCoverage)
    : [];
  return [...new Set([...direct, ...coverage].map((item) => String(item).trim()).filter(Boolean))];
}

function activeRequirements(db, runId) {
  return db.prepare("SELECT id, priority FROM requirements WHERE run_id = ? AND status <> 'superseded' ORDER BY id").all(runId);
}

function uiRequirements(db, runId) {
  return db.prepare(`
    SELECT id, kind FROM requirements
    WHERE run_id = ? AND status <> 'superseded'
      AND lower(kind) IN ('ui','ux','frontend','user-facing','user-interface','user-experience','accessibility')
    ORDER BY id
  `).all(runId);
}

function lintUiContracts(db, projectRoot, runId, findings) {
  const ui = uiRequirements(db, runId);
  if (ui.length === 0) return { required: false, requirements: [] };
  const experience = latestArtifact(db, projectRoot, runId, "experience-contract", ["verified"]);
  const visual = latestArtifact(db, projectRoot, runId, "visual-contract", ["verified"]);
  const browser = latestArtifact(db, projectRoot, runId, "browser-acceptance", ["verified"]);
  if (!experience) findings.push({ severity: "critical", code: "EXPERIENCE_CONTRACT_MISSING", claim: "User-facing work needs a verified experience-contract artifact." });
  if (!visual) findings.push({ severity: "critical", code: "VISUAL_CONTRACT_MISSING", claim: "User-facing work needs a verified visual-contract artifact." });
  if (!browser) findings.push({ severity: "critical", code: "BROWSER_ACCEPTANCE_MISSING", claim: "User-facing work needs a verified browser-acceptance artifact." });
  const experienceData = parsed(experience) ?? {};
  const visualData = parsed(visual) ?? {};
  const browserData = parsed(browser) ?? {};
  for (const field of ["actors", "journeys", "states", "interactionRules", "informationArchitecture"]) {
    if (!Array.isArray(experienceData[field]) || experienceData[field].length === 0) {
      findings.push({ severity: "error", code: `EXPERIENCE_${field.toUpperCase()}_MISSING`, claim: `Experience contract must define ${field}.` });
    }
  }
  const states = new Set(asArray(experienceData.states).map((item) => typeof item === "string" ? item.toLowerCase() : String(item?.name ?? "").toLowerCase()));
  for (const state of ["loading", "empty", "error", "success"]) {
    if (!states.has(state)) findings.push({ severity: "error", code: "EXPERIENCE_STATE_GAP", claim: `Experience contract does not define the ${state} state.` });
  }
  for (const field of ["existingDesignSystem", "layoutRules", "responsiveRules"]) {
    if (!Array.isArray(visualData[field]) || visualData[field].length === 0) {
      findings.push({ severity: "error", code: `VISUAL_${field.toUpperCase()}_MISSING`, claim: `Visual contract must define ${field}.` });
    }
  }
  const scenarios = asArray(browserData.scenarios ?? browserData.browserScenarios);
  if (scenarios.length === 0) findings.push({ severity: "critical", code: "BROWSER_SCENARIOS_MISSING", claim: "Browser acceptance must define at least one user-flow scenario." });
  const covered = new Set(scenarios.flatMap((item) => asArray(item.requirementIds)).map(String));
  for (const requirement of ui.filter((item) => !covered.has(item.id))) {
    findings.push({ severity: "error", code: "BROWSER_REQUIREMENT_GAP", claim: `Browser acceptance does not cover UI requirement ${requirement.id}.` });
  }
  return {
    required: true,
    requirements: ui.map((item) => item.id),
    experienceArtifactId: experience?.id ?? null,
    visualArtifactId: visual?.id ?? null,
    browserAcceptanceArtifactId: browser?.id ?? null
  };
}

export function lintDesign(db, projectRoot, runId, config) {
  const run = getRun(db, runId);
  const design = latestArtifact(db, projectRoot, run.id, "design", ["verified"]);
  const contract = latestArtifact(db, projectRoot, run.id, "goal-contract", ["verified"]);
  const findings = [];
  if (!design) findings.push({ severity: "critical", code: "DESIGN_MISSING", claim: "No verified design artifact exists." });
  if (!contract) findings.push({ severity: "critical", code: "CONTRACT_MISSING", claim: "No verified goal contract exists." });
  const data = parsed(design) ?? {};
  const requiredFields = ["selectedApproach", "interfaces", "errorHandling", "testing"];
  for (const field of requiredFields) {
    const value = data[field];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      findings.push({ severity: "error", code: `DESIGN_${field.toUpperCase()}_MISSING`, claim: `Design must define ${field}.` });
    }
  }
  const requirements = activeRequirements(db, run.id);
  const referenced = new Set(designRequirementIds(data));
  for (const id of referenced) {
    if (!requirements.some((item) => item.id === id)) {
      findings.push({ severity: "error", code: "DESIGN_UNKNOWN_REQUIREMENT", claim: `Design references unknown requirement ${id}.` });
    }
  }
  for (const requirement of requirements.filter((item) => item.priority === "must")) {
    if (!referenced.has(requirement.id)) {
      findings.push({ severity: "critical", code: "DESIGN_REQUIREMENT_GAP", claim: `Design does not cover must requirement ${requirement.id}.` });
    }
  }
  const uiContracts = lintUiContracts(db, projectRoot, run.id, findings);
  const governance = governanceReport(db, run.id, config);
  for (const assumption of governance.blockers.assumptions) {
    findings.push({ severity: "error", code: "ASSUMPTION_UNRESOLVED", claim: `High-impact assumption ${assumption.id} remains open.` });
  }
  for (const invariantItem of governance.blockers.violatedInvariants) {
    findings.push({ severity: "critical", code: "INVARIANT_VIOLATED", claim: `Invariant ${invariantItem.id} is violated.` });
  }
  const blocking = findings.filter((item) => ["error", "critical"].includes(item.severity));
  return { runId: run.id, pass: blocking.length === 0, findings, designArtifactId: design?.id ?? null, uiContracts };
}

export function sealDesign(db, projectRoot, runId, config) {
  const run = getRun(db, runId);
  invariant(run.phase === "design", "DESIGN_SEAL_PHASE", "Seal the design during the design phase.");
  const lint = lintDesign(db, projectRoot, run.id, config);
  if (!lint.pass) throw new MetisError("DESIGN_LINT_FAILED", "Design lint failed.", lint);
  const design = latestArtifact(db, projectRoot, run.id, "design", ["verified"]);
  const content = parsed(design);
  const seal = {
    version: 1,
    designArtifactId: design.id,
    designContentRef: design.content_ref,
    designHash: sha256(stableStringify(content)),
    contractVersion: run.contract_version,
    runRevision: run.revision
  };
  const artifact = putArtifact(db, projectRoot, run.id, "design-seal", seal, {
    status: "verified",
    metadata: { designHash: seal.designHash, designArtifactId: design.id }
  });
  const evidenceRefs = [{
    type: "artifact",
    id: artifact.id,
    kind: artifact.kind,
    status: artifact.status,
    contentRef: artifact.content_ref
  }];
  const timestamp = now();
  for (const requirementId of designRequirementIds(content)) {
    db.prepare(`
      INSERT INTO trace_links(
        id, run_id, requirement_id, target_type, target_id, relation,
        status, evidence_refs_json, created_at, updated_at
      ) VALUES(?, ?, ?, 'design', ?, 'designed-by', 'current', ?, ?, ?)
      ON CONFLICT(run_id, requirement_id, target_type, target_id, relation) DO UPDATE SET
        status = 'current', evidence_refs_json = excluded.evidence_refs_json, updated_at = excluded.updated_at
    `).run(makeId("trace"), run.id, requirementId, artifact.id, json(evidenceRefs), timestamp, timestamp);
  }
  recordEvent(db, run.id, "design.sealed", "info", { artifactId: artifact.id, designHash: seal.designHash });
  return { lint, seal, artifact };
}

export function recordDesignReview(db, projectRoot, runId, input, config) {
  const run = getRun(db, runId);
  invariant(run.phase === "design", "DESIGN_REVIEW_PHASE", "Record design review during the design phase.");
  const reviewerTaskId = String(input.reviewerTaskId ?? "").trim();
  invariant(reviewerTaskId, "DESIGN_REVIEW_TASK", "Design review needs reviewerTaskId.");
  const task = getTask(db, reviewerTaskId);
  invariant(task.run_id === run.id, "DESIGN_REVIEW_RUN", "Design critic task belongs to another run.");
  invariant(task.role === "design-critic", "DESIGN_REVIEW_ROLE", "Design review must come from a design-critic task.");
  invariant(task.status === "completed", "DESIGN_REVIEW_TASK_STATUS", "Design critic task must be completed.");
  const sealArtifact = latestArtifact(db, projectRoot, run.id, "design-seal", ["verified"]);
  invariant(sealArtifact, "DESIGN_SEAL_REQUIRED", "Seal the current design before recording its review.");
  const seal = parsed(sealArtifact);
  const result = task.result ?? {};
  const sealEvidence = asArray(result.EvidenceRefs).some((ref) => (
    ref?.type === "artifact"
    && ref.id === sealArtifact.id
    && ref.contentRef === sealArtifact.content_ref
    && evidenceRefIsCurrent(db, projectRoot, ref)
  ));
  invariant(sealEvidence, "DESIGN_CRITIC_EVIDENCE", "The design critic must cite the current sealed design artifact.");
  const verdict = String(result.Verdict ?? "REJECTED").toUpperCase();
  invariant(["APPROVED", "REJECTED"].includes(verdict), "DESIGN_REVIEW_VERDICT", "Design critic verdict must be APPROVED or REJECTED.");
  const findings = Array.isArray(result.Findings) ? result.Findings : [];
  const blocking = findings.filter((item) => ["error", "critical"].includes(String(item.Severity ?? item.severity ?? "").toLowerCase()));
  if (blocking.length > Number(config.orchestration.maxDesignCriticalFindings ?? 0)) {
    invariant(verdict === "REJECTED", "DESIGN_REVIEW_BLOCKING", "A design review with blocking findings cannot approve the design.");
  }
  const review = {
    version: 1,
    reviewerTaskId,
    designSealArtifactId: sealArtifact.id,
    designArtifactId: seal.designArtifactId,
    designContentRef: seal.designContentRef,
    designHash: seal.designHash,
    verdict,
    findings,
    evidenceRefs: result.EvidenceRefs ?? [],
    summary: result.Summary ?? ""
  };
  const artifact = putArtifact(db, projectRoot, run.id, "design-review", review, {
    taskId: reviewerTaskId,
    status: "verified",
    metadata: { verdict, designHash: seal.designHash }
  });
  recordEvent(db, run.id, "design.reviewed", verdict === "APPROVED" ? "info" : "warning", { reviewerTaskId, verdict, findings: findings.length });
  return { review, artifact };
}
