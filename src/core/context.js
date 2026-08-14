import { readObject, storeObject } from "./objects.js";
import { gateReport, getRun } from "./state.js";
import { listDecisions, listFindings } from "./evidence.js";
import { listDocumentImpacts } from "./docs.js";
import { listChecks } from "./checks.js";
import { getRunnableTasks, listTasks } from "./tasks.js";
import { milestoneSummary } from "./milestones.js";
import { countTokens, effectiveContextBudget, estimateTokens } from "./tokens.js";
import { budgetStatus } from "./budget.js";
import { progressStatus } from "./progress.js";
import { traceabilityReport } from "./traceability.js";
import { governanceReport } from "./governance.js";
import { reviewReport } from "./reviews.js";
import { getGoalContract } from "./contracts.js";
import { makeId, parseJson, sha256, truncateMiddle } from "./util.js";

export { estimateTokens } from "./tokens.js";

const PHASE_ARTIFACT_DEPENDENCIES = Object.freeze({
  intake: [],
  discover: ["discovery"],
  research: ["discovery", "research"],
  design: ["design"],
  plan: ["plan-review"],
  execute: ["workspace-baseline"],
  review: [],
  verify: [],
  curate: [],
  complete: []
});

function lineList(items, empty = "- None") {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function parseArtifactContent(artifact) {
  if (!artifact?.content) return null;
  try { return JSON.parse(artifact.content); } catch { return { text: artifact.content }; }
}

function contextArtifact(db, projectRoot, runId, kind, options = {}) {
  const statuses = options.statuses ?? ["verified", "waived"];
  const placeholders = statuses.map(() => "?").join(",");
  const row = db.prepare(`
    SELECT * FROM artifacts
    WHERE run_id = ? AND kind = ? AND status IN (${placeholders})
    ORDER BY updated_at DESC LIMIT 1
  `).get(runId, kind, ...statuses);
  if (!row) return null;

  const artifact = {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
    content: null,
    loadInstructions: {
      artifact: `metis artifact get ${row.id}`,
      object: row.content_ref ? `metis object get ${row.content_ref}` : null
    }
  };
  if (options.materialize && row.content_ref) {
    const materializer = options.materializer ?? ((ref) => readObject(db, projectRoot, ref));
    artifact.content = materializer(row.content_ref, row);
  }
  return artifact;
}

function compactArtifact(artifact) {
  if (!artifact) return null;
  return {
    id: artifact.id,
    kind: artifact.kind,
    status: artifact.status,
    contentRef: artifact.content_ref,
    metadata: artifact.metadata,
    loadInstructions: artifact.loadInstructions
  };
}

function section(id, title, body, priority, mandatory = false) {
  return { id, title, body: String(body ?? "").trim() || "- None", priority, mandatory };
}

function renderSection(item, body = item.body) {
  return `## ${item.title}\n${body}\n\n`;
}

function taskSummary(tasks) {
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status}=${count}`).join(", ") || "none";
}

function fitSections(db, sections, budget, options) {
  const model = options.model ?? null;
  const config = options.config;
  const header = "METIS_MANAGED_V5\nExplicit opt-in: /goal $metis <objective>\nMain is an orchestrator only. Delegate repository inspection, external research, implementation, review, and verification through compiled task packets.\nThe runtime state is authoritative. Continue until COMPLETE or a declared user/authority blocker.\n\n";
  const mandatory = sections.filter((item) => item.mandatory).sort((a, b) => b.priority - a.priority);
  const optional = sections.filter((item) => !item.mandatory).sort((a, b) => b.priority - a.priority);
  const includedIds = [];
  let content = header;

  for (const item of mandatory) {
    content += renderSection(item);
    includedIds.push(item.id);
  }
  let measured = countTokens(db, content, { config, model });
  if (measured.tokens > budget) {
    const fixed = header;
    const allowance = Math.max(120, Math.floor((budget - countTokens(db, fixed, { config, model }).tokens) / Math.max(1, mandatory.length)));
    content = fixed;
    for (const item of mandatory) {
      content += renderSection(item, truncateMiddle(item.body, Math.max(160, allowance * 3)));
    }
  }

  for (const item of optional) {
    const candidate = `${content}${renderSection(item)}`;
    const candidateCount = countTokens(db, candidate, { config, model });
    if (candidateCount.tokens <= budget) {
      content = candidate;
      includedIds.push(item.id);
      continue;
    }
    const current = countTokens(db, content, { config, model }).tokens;
    const remaining = budget - current;
    if (remaining < 50) continue;
    const clipped = truncateMiddle(item.body, Math.max(160, remaining * 3));
    const clippedCandidate = `${content}${renderSection(item, clipped)}`;
    if (countTokens(db, clippedCandidate, { config, model }).tokens <= budget) {
      content = clippedCandidate;
      includedIds.push(item.id);
    }
  }

  let finalCount = countTokens(db, content, { config, model, observedTokens: options.observedTokens });
  if (finalCount.tokens > budget) {
    content = truncateMiddle(content, Math.max(900, Math.floor(content.length * budget / finalCount.tokens * 0.95)));
    finalCount = countTokens(db, content, { config, model, observedTokens: options.observedTokens });
  }
  return { content: content.trimEnd() + "\n", count: finalCount, includedIds };
}

function activeContract(db, runId) {
  try { return getGoalContract(db, runId); } catch { return null; }
}

function phaseSections(run, data) {
  const {
    contract, requirements, action, tasks, runnable, milestones, decisions, findings,
    staleFindings, checks, pendingDocs, discovery, research, design, planReview,
    workspaceBaseline, reviews, trace, governance, budget, progress, events, materializedKinds
  } = data;
  const activeMilestone = milestones.find((item) => item.id === run.current_milestone_id) ?? milestones.find((item) => !["completed", "waived"].includes(item.status));
  const progressState = progress ?? { stalled: false, stallCount: 0, lastProgressAt: null };
  const blockers = [
    ...tasks.filter((task) => ["blocked", "failed"].includes(task.status)).map((task) => `Task ${task.id}: ${task.status}`),
    ...reviews.blocking.map((item) => `Review ${item.id}: ${item.severity} — ${item.title}`),
    ...governance.blockers.assumptions.map((item) => `Assumption ${item.id}: ${item.statement}`),
    ...governance.blockers.violatedInvariants.map((item) => `Invariant ${item.id}: violated`),
    ...governance.blockers.risks.map((item) => `Risk ${item.id}: ${item.title}`)
  ];
  const mandatory = [
    section("goal", "Goal Contract", contract
      ? `- Version: ${contract.version}\n- Objective: ${contract.objective}\n- Complexity: ${contract.complexity}\n- Scope: ${contract.scope.join(", ") || "not yet bounded"}\n- Non-goals: ${contract.nonGoals.join(", ") || "none"}`
      : `- Objective: ${run.goal}\n- Contract: not frozen`, 100, true),
    section("requirements", "Requirements", lineList(requirements.map((item) => `${item.id} [${item.priority}/${item.status}]: ${item.title}`)), 100, true),
    section("phase", "Managed State", `- Run: ${run.id}\n- Phase: ${run.phase}\n- Status: ${run.status}\n- Revision: ${run.revision}\n- Current milestone: ${activeMilestone ? `${activeMilestone.id} — ${activeMilestone.title}` : "none"}`, 100, true),
    section("next", "Next Controller Action", `- Type: ${action.type}\n- Instruction: ${action.instruction ?? action.reason ?? action.command ?? "follow the structured action"}\n${action.command ? `- Command: ${action.command}` : ""}`, 100, true),
    section("blockers", "Blockers and Escalations", lineList(blockers), 100, true)
  ];
  const common = [
    section("budget", "Budget", `- Pass: ${budget.pass}\n- Input: ${budget.usage.inputTokens}/${budget.limits.inputTokens ?? "unbounded"}\n- Output: ${budget.usage.outputTokens}/${budget.limits.outputTokens ?? "unbounded"}\n- Tool calls: ${budget.usage.toolCalls}/${budget.limits.toolCalls ?? "unbounded"}\n- Agent spawns: ${budget.usage.agentSpawns}/${budget.limits.agentSpawns ?? "unbounded"}`, 92),
    section("progress", "Progress Watchdog", `- Stalled: ${progressState.stalled}\n- Stall count: ${progressState.stallCount}\n- Last progress: ${progressState.lastProgressAt ?? "none"}`, 94),
    section("trace", "Traceability", `- Pass: ${trace.pass}\n- Must requirements: ${trace.summary.must}\n- Planned: ${trace.summary.planned}\n- Implemented: ${trace.summary.implemented}\n- Verified: ${trace.summary.verified}\n- Gaps: ${JSON.stringify(trace.summary.uncoveredMust)}`, 96),
    section("tasks", "Subagent Task Graph", `- Counts: ${taskSummary(tasks)}\n- Active waves: ${[...new Set(tasks.filter((task) => !["completed", "waived"].includes(task.status)).map((task) => task.wave))].sort((a, b) => a - b).join(", ") || "none"}\n- Runnable: ${lineList(runnable.map((task) => `${task.id} [wave ${task.wave}/${task.taskKind}/${task.role}/${task.contractStatus}]: ${task.title}`))}`, 94),
    section("decisions", "Active Decisions", lineList(decisions.map((item) => `${item.id}: ${item.decision}`)), 86),
    section("risks", "Governance", `- Execution pass: ${governance.passForExecution}\n- Completion pass: ${governance.passForCompletion}\n- Open assumptions: ${governance.assumptions.filter((item) => item.status === "open").length}\n- Open risks: ${governance.risks.filter((item) => item.status === "open").length}\n- Violated invariants: ${governance.blockers.violatedInvariants.length}`, 90)
  ];
  const byPhase = {
    intake: [section("intake", "Intake Contract Work", "Freeze objective, scope, non-goals, constraints, measurable success criteria, route, and atomic requirements. Do not plan implementation yet.", 99)],
    discover: [section("knowledge", "Relevant Findings", lineList(findings.slice(0, 18).map((item) => `${item.id}: ${item.claim}`)), 88)],
    research: [section("unknowns", "Discovery Unknowns", lineList(discovery?.unknowns ?? []), 94)],
    design: [section("constraints", "Constraints and Invariants", lineList([...(contract?.constraints ?? []), ...governance.invariants.map((item) => `${item.id}: ${item.description}`)]), 96)],
    plan: [section("milestones", "Milestones", lineList(milestones.map((item) => `${item.id}: ${item.status} — ${item.title}; requirements=${item.requirementIds?.join(",") || "none"}`)), 98)],
    execute: [
      section("ownership", "Execution Ownership", lineList(tasks.filter((task) => task.phase === "execute" && !task.readOnly).map((task) => `${task.id}: ${task.targetPaths.join(", ")}`)), 98),
      section("preexisting", "Pre-existing Changes", lineList(workspaceBaseline?.preexistingChanges ?? []), 88)
    ],
    review: [section("review", "Review State", JSON.stringify({ tasks: reviews.tasks, blocking: reviews.blocking }, null, 2), 99)],
    verify: [
      section("checks", "Verification Checks", lineList(checks.map((check) => `${check.name}: ${check.status}${check.required ? " (required)" : ""}`)), 100),
      section("review-completion", "Completion Review", lineList(reviews.findings.filter((item) => item.review_kind === "completion").map((item) => `${item.id}: ${item.status}/${item.severity}`)), 96)
    ],
    curate: [
      section("docs", "Documentation Impact", lineList(pendingDocs.map((item) => `${item.path}: ${item.reason}`)), 100),
      section("stale", "Stale Knowledge", lineList(staleFindings.map((item) => item.id)), 98)
    ],
    complete: [section("completion", "Completion Evidence", `- Requirements verified: ${trace.summary.verified}/${trace.summary.total}\n- Required checks passed: ${checks.filter((item) => item.required && item.status === "passed").length}\n- Residual blocking reviews: ${reviews.blocking.length}`, 100)]
  };
  const artifactSections = [
    section("discovery", "Discovery", discovery ? JSON.stringify(discovery, null, 2) : "- No discovery artifact", 99),
    section("research", "External Research", research ? JSON.stringify(research, null, 2) : "- No research artifact", 99),
    section("design", "Design", design ? JSON.stringify(design, null, 2) : "- No design artifact", 99),
    section("plan-review", "Plan Review", planReview
      ? JSON.stringify(materializedKinds.has("plan-review") ? { verdict: planReview.verdict, findings: planReview.findings } : planReview, null, 2)
      : "- Not approved", 99)
  ];
  return [...mandatory, ...common, ...(byPhase[run.phase] ?? []), ...artifactSections, section("events", "Recent High-signal Events", lineList(events.map((event) => `${event.type}${event.count > 1 ? ` ×${event.count}` : ""}: ${JSON.stringify(parseJson(event.payload_json, {}))}`)), 45)];
}

export function buildMainContext(db, projectRoot, runId, config, requested = null) {
  const run = getRun(db, runId);
  const options = requested && typeof requested === "object" ? requested : { tokenBudget: requested };
  const envRemainingTokens = Number(process.env.METIS_REMAINING_TOKENS || 0);
  const remainingTokens = options.remainingTokens ?? (envRemainingTokens > 0 ? envRemainingTokens : null);
  const tokenBudget = effectiveContextBudget(config, options.tokenBudget, remainingTokens);
  const model = options.model ?? config.budgets.model ?? null;
  const tasks = listTasks(db, run.id);
  const runnable = getRunnableTasks(db, run.id, config.orchestration.maxConcurrent);
  const contract = activeContract(db, run.id);
  const requirements = db.prepare("SELECT * FROM requirements WHERE run_id = ? AND status <> 'superseded' ORDER BY priority, id").all(run.id);
  const decisions = listDecisions(db, run.id, "active");
  const allFindings = listFindings(db, run.id);
  const findings = allFindings.filter((item) => item.status === "valid");
  const staleFindings = allFindings.filter((item) => item.status === "stale");
  const checks = listChecks(db, run.id);
  const pendingDocs = listDocumentImpacts(db, run.id, "pending");
  const milestones = milestoneSummary(db, run.id);
  const materializedKinds = new Set(PHASE_ARTIFACT_DEPENDENCIES[run.phase] ?? []);
  const artifactOptions = (kind) => ({
    materialize: materializedKinds.has(kind),
    materializer: options.materializer
  });
  const discoveryArtifact = contextArtifact(db, projectRoot, run.id, "discovery", artifactOptions("discovery"));
  const researchArtifact = contextArtifact(db, projectRoot, run.id, "research", artifactOptions("research"));
  const designArtifact = contextArtifact(db, projectRoot, run.id, "design", artifactOptions("design"));
  const planReviewArtifact = contextArtifact(db, projectRoot, run.id, "plan-review", artifactOptions("plan-review"));
  const workspaceBaselineArtifact = contextArtifact(db, projectRoot, run.id, "workspace-baseline", artifactOptions("workspace-baseline"));
  const contextualContent = (kind, artifact) => materializedKinds.has(kind) ? parseArtifactContent(artifact) : compactArtifact(artifact);
  const discovery = contextualContent("discovery", discoveryArtifact);
  const research = contextualContent("research", researchArtifact);
  const design = contextualContent("design", designArtifact);
  const planReview = contextualContent("plan-review", planReviewArtifact);
  const workspaceBaseline = contextualContent("workspace-baseline", workspaceBaselineArtifact);
  const reviews = reviewReport(db, run.id);
  const trace = traceabilityReport(db, run.id, { refreshStatuses: false });
  const governance = governanceReport(db, run.id, config);
  const budget = budgetStatus(db, run.id);
  const progress = progressStatus(db, run.id, config);
  const gate = gateReport(db, projectRoot, run.id);
  const action = options.action ?? (run.phase === "complete" || run.status === "completed"
    ? { type: "COMPLETE" }
    : gate.pass
      ? { type: "ADVANCE_PHASE", command: `metis advance ${gate.to} --pretty`, targetPhase: gate.to }
      : runnable.length > 0
        ? { type: "SPAWN_BATCH", instruction: "Use metis schedule claim --pretty and dispatch the returned bounded contracts." }
        : { type: "FIX_GATE_FAILURES", instruction: gate.failures.join(" "), failures: gate.failures });
  const events = db.prepare(`
    SELECT type, severity, payload_json, count, updated_at FROM events
    WHERE run_id = ? AND type NOT LIKE 'performance.%'
    ORDER BY updated_at DESC LIMIT ?
  `).all(run.id, config.budgets.recentEvents);

  const sections = phaseSections(run, {
    db, projectRoot, contract, requirements, action, tasks, runnable, milestones, decisions,
    findings, staleFindings, checks, pendingDocs, discovery, research, design, planReview,
    workspaceBaseline, reviews, trace, governance, budget, progress, events, materializedKinds
  });
  const fitted = fitSections(db, sections, tokenBudget, { config, model, observedTokens: options.observedTokens });
  const essentialIds = ["goal", "requirements", "phase", "next", "blockers"];
  const included = new Set(fitted.includedIds);
  const quality = {
    essential: Object.fromEntries(essentialIds.map((id) => [id, included.has(id)])),
    coverage: essentialIds.filter((id) => included.has(id)).length / essentialIds.length,
    phase: run.phase,
    action: action.type,
    traceabilityPass: trace.pass,
    budgetPass: budget.pass,
    blockers: reviews.blocking.length + governance.blockers.assumptions.length + governance.blockers.violatedInvariants.length
  };
  const content = fitted.content;
  const ref = storeObject(db, projectRoot, "main-context", content, { redact: true });
  db.prepare(`
    INSERT INTO context_snapshots(
      id, run_id, role, model, token_budget, estimated_tokens, observed_tokens,
      remaining_tokens, token_method, content_hash, content_ref, quality_json, created_at
    ) VALUES(?, ?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    makeId("ctx"), run.id, model, tokenBudget, fitted.count.tokens, options.observedTokens ?? null,
    remainingTokens, fitted.count.method, sha256(content), ref, JSON.stringify(quality)
  );
  return {
    content,
    tokenBudget,
    estimatedTokens: fitted.count.tokens,
    tokenMethod: fitted.count.method,
    calibrationFactor: fitted.count.calibrationFactor,
    remainingTokens,
    contentRef: ref,
    quality,
    action
  };
}

function clipText(value, maxChars) {
  return typeof value === "string" ? truncateMiddle(value, maxChars) : value;
}

function clipList(values, maxItems, maxChars) {
  return (values ?? []).slice(0, maxItems).map((item) => clipText(item, maxChars));
}

function compactResultSchema(schema, hasSubjectArtifact) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const compact = { ...schema };
  // ResultGuidance is already present in the compiled packet prompt. Avoid
  // duplicating it in an over-budget transport envelope; the packet load
  // command remains available when the clipped contract is dispatched.
  delete compact.ResultGuidance;
  if (!hasSubjectArtifact) delete compact.SubjectEvidenceRequirement;
  return compact;
}

function compactCompiledPrompt(prompt) {
  return String(prompt ?? "").replace(
    /\n\s*"ResultGuidance":\s*\{[\s\S]*?\n\s*\},\n(?=\s*"SubjectEvidenceRequirement")/u,
    "\n"
  );
}

// A predecessor's full result is durable in the object store.  Keep only the
// typed handles needed to load it in a compact host envelope; copying result
// prose here both duplicates the compiled prompt and makes clipping lossy.
const COMPACT_ID_MAX = 128;
const COMPACT_TEXT_MAX = 240;
const MAX_UPSTREAM_EVIDENCE_REFS = 2;

function boundedString(value, max = COMPACT_TEXT_MAX) {
  if (typeof value !== "string") return null;
  return value.length > max ? value.slice(0, max) : value;
}

function boundedIdentity(value) {
  const clipped = boundedString(value, COMPACT_ID_MAX);
  if (clipped === null) return null;
  const identity = clipped.trim();
  return identity || null;
}

function compactStructuredRef(value) {
  if (typeof value !== "string") return null;
  // Check the length before trimming so hostile 500k strings are rejected
  // without copying them into the compact envelope.
  if (value.length > 68) return null;
  const ref = value.trim();
  return /^obj_[0-9a-f]{64}$/iu.test(ref) ? ref : null;
}

function compactEvidenceRef(ref) {
  // Worker results carry normalized typed evidence objects. Untyped strings
  // are ambiguous (and can be hostilely large), so omit them from the compact
  // transport; the authenticated structured result remains available by ref.
  if (typeof ref === "string") return null;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const typeValue = ref.type ?? ref.Type;
  const type = typeof typeValue === "string" && typeValue.length <= 32 ? typeValue.toLowerCase() : "";
  const fieldsByType = {
    artifact: ["type", "id", "kind", "contentRef"],
    object: ["type", "ref"],
    source: ["type", "path", "startLine", "endLine", "fileSha256", "sliceSha256", "missing"],
    file: ["type", "path", "startLine", "endLine", "fileSha256", "sliceSha256", "missing"],
    finding: ["type", "id", "status"],
    decision: ["type", "id", "status"],
    command: ["type", "checkId", "name", "status", "commandHash", "outputRef", "exitCode", "codeFingerprint"],
    check: ["type", "checkId", "name", "status", "commandHash", "outputRef", "exitCode", "codeFingerprint"],
    note: ["type", "text", "verifiable"]
  };
  const fields = fieldsByType[type];
  if (!fields) return null;
  const compact = {};
  for (const key of fields) {
    if (ref[key] === undefined || ref[key] === null) continue;
    const value = ref[key];
    if (typeof value === "string") {
      if (["id", "checkId"].includes(key)) {
        const identity = boundedIdentity(value);
        if (identity) compact[key] = identity;
      } else if (["contentRef", "ref"].includes(key)) {
        const objectRef = compactStructuredRef(value);
        if (objectRef) compact[key] = objectRef;
      } else {
        compact[key] = boundedString(value);
      }
    } else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      compact[key] = value;
    }
  }
  return Object.keys(compact).length ? compact : null;
}

function compactUpstreamResultRefs(background) {
  if (!Array.isArray(background)) return [];
  return background.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const taskId = boundedIdentity(item.TaskId ?? item.taskId);
    const structuredRef = compactStructuredRef(item.StructuredRef ?? item.structuredRef);
    const rawEvidenceRefs = item.EvidenceRefs ?? item.evidenceRefs;
    const evidenceRefs = (Array.isArray(rawEvidenceRefs) ? rawEvidenceRefs : [])
      .slice(0, MAX_UPSTREAM_EVIDENCE_REFS)
      .map(compactEvidenceRef)
      .filter(Boolean);
    return {
      ...(taskId ? { TaskId: taskId } : {}),
      ...(structuredRef ? { StructuredRef: structuredRef } : {}),
      EvidenceRefs: evidenceRefs
    };
  }).filter((item) => item && (item.TaskId || item.StructuredRef || item.EvidenceRefs.length));
}

function compactBackground(background) {
  if (!Array.isArray(background)) return [];
  return background.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const taskId = boundedIdentity(item.TaskId ?? item.taskId);
    const summaryValue = item.Summary ?? item.summary;
    const summary = boundedString(summaryValue, COMPACT_TEXT_MAX);
    const breakingValue = item.Breaking ?? item.breaking;
    const breaking = Array.isArray(breakingValue)
      ? breakingValue.slice(0, 8).map((value) => boundedString(value, COMPACT_TEXT_MAX)).filter((value) => value !== null)
      : [];
    const compact = {
      ...(taskId ? { TaskId: taskId } : {}),
      Summary: summary || null,
      Breaking: breaking
    };
    return compact;
  }).filter(Boolean);
}

function fitClippedExecution(execution, packetLoadInstruction, tokenBudget, options) {
  const prompt = String(execution.CompiledPrompt ?? "");
  const config = options.config;
  const model = options.model ?? null;
  const render = (length) => JSON.stringify({
    ...execution,
    CompiledPrompt: length > 0 ? truncateMiddle(prompt, length) : "",
    PacketLoadInstruction: packetLoadInstruction
  }, null, 2);
  const measure = (length) => countTokens(options.db ?? null, render(length), { config, model }).tokens;
  const baseTokens = measure(0);
  if (baseTokens > tokenBudget) return render(0);

  // Reserve space for the packet loader and typed upstream handles, then make
  // a conservative interpolation from one full-prompt measurement. A few
  // bounded corrections account for tokenization discontinuities without
  // turning every dispatch into a long binary-search loop.
  const fullTokens = measure(prompt.length);
  const availableTokens = tokenBudget - baseTokens;
  const promptTokens = Math.max(1, fullTokens - baseTokens);
  let length = Math.min(prompt.length, Math.max(0, Math.floor(prompt.length * availableTokens / promptTokens * 0.94)));
  let best = render(0);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = render(length);
    if (countTokens(options.db ?? null, candidate, { config, model }).tokens <= tokenBudget) {
      best = candidate;
      break;
    }
    length = Math.floor(length * 0.88);
  }
  return best;
}

export function compactTaskContract(contract, tokenBudget, options = {}) {
  const config = options.config ?? { budgets: { tokenizer: { mode: "estimate" } } };
  const isPlanCritic = contract.AgentType === "metis-plan-critic" || contract.Role === "plan-critic";
  const packetLoadInstruction = contract.TaskPacket?.LoadCommand
    ? `Run ${[contract.TaskPacket.LoadCommand.command, ...(contract.TaskPacket.LoadCommand.args ?? [])].join(" ")} before execution because the compiled prompt was clipped.`
    : contract.TaskPacket?.ContentRef
      ? `Load packet object ${contract.TaskPacket.ContentRef} before execution because the compiled prompt was clipped.`
      : null;
  const original = JSON.stringify(contract, null, 2);
  const originalCount = countTokens(options.db ?? null, original, { config, model: options.model ?? contract.Model });
  if (originalCount.tokens <= tokenBudget) {
    return { content: original, estimatedTokens: originalCount.tokens, tokenMethod: originalCount.method, truncated: false, overBudget: false };
  }
  const execution = {
    ContractVersion: contract.ContractVersion,
    RunId: contract.RunId,
    TaskId: contract.TaskId,
    TaskKind: contract.TaskKind,
    Wave: contract.Wave,
    RunPhase: contract.RunPhase,
    RepositoryRoot: contract.RepositoryRoot,
    IntegrationRoot: contract.IntegrationRoot,
    WorkspaceMode: contract.WorkspaceMode,
    AgentType: contract.AgentType,
    Model: contract.Model,
    ReasoningEffort: contract.ReasoningEffort,
    LeasePolicy: contract.LeasePolicy,
    SubjectArtifact: contract.SubjectArtifact ? {
      ...contract.SubjectArtifact,
      loadCommand: contract.EvidenceAccess?.artifact
        ? [contract.EvidenceAccess.artifact.command, ...(contract.EvidenceAccess.artifact.args ?? [])].join(" ")
        : null
    } : null,
    EvidenceAccess: contract.EvidenceAccess ?? null,
    Packet: contract.TaskPacket ? {
      Id: contract.TaskPacket.Id,
      Version: contract.TaskPacket.Version,
      Policy: contract.TaskPacket.Policy,
      BlueprintHash: contract.TaskPacket.BlueprintHash,
      PacketHash: contract.TaskPacket.PacketHash,
      ContentRef: contract.TaskPacket.ContentRef,
      LoadCommand: contract.TaskPacket.LoadCommand ?? null,
      FallbackLoadCommand: contract.TaskPacket.FallbackLoadCommand ?? null
    } : null,
    // Critic packets already carry the complete sealed-plan/task-packet
    // evidence behind an authenticated load handle. Do not duplicate that
    // prose in the host envelope; preserve the typed handles and loader.
    Background: isPlanCritic ? [] : compactBackground(Array.isArray(contract.Background) ? contract.Background.slice(0, 8) : []),
    // Keep this transport separate from duplicated predecessor prose.  It is
    // intentionally deterministic and carries every predecessor handle even
    // when the human-readable Background is bounded to the first eight items.
    UpstreamResultRefs: compactUpstreamResultRefs(contract.Background),
    RoleInstructions: isPlanCritic ? [] : contract.RoleInstructions ?? [],
    OrchestrationBoundary: contract.OrchestrationBoundary ?? null,
    CompiledPrompt: isPlanCritic
      ? "# PLAN CRITIC\nLoad only the authenticated sealed PlanDraft and supplied task-packet/artifact objects before inspection. Perform handle-only read-only analysis; return the declared structured result and complete the fenced terminal handoff immediately."
      : compactCompiledPrompt(contract.CompiledPrompt ?? [
      "# ROLE",
      contract.AgentType ?? "subagent",
      "# OBJECTIVE",
      contract.Objective ?? contract.Title ?? "Complete the bounded task contract.",
      "# OWNED SCOPE",
      JSON.stringify(contract.TargetPaths ?? contract.Scope ?? [], null, 2),
      "# ACCEPTANCE CRITERIA",
      JSON.stringify(contract.AcceptanceCriteria ?? [], null, 2)
    ].join("\n")),
    ...(isPlanCritic && packetLoadInstruction ? { PacketLoadInstruction: packetLoadInstruction } : {}),
    ResultTokenBudget: contract.ResultTokenBudget,
    ResultSchema: compactResultSchema(contract.ResultSchema, Boolean(contract.SubjectArtifact))
  };
  let content = JSON.stringify(execution, null, 2);
  let measured = countTokens(options.db ?? null, content, { config, model: options.model ?? contract.Model });
  if (measured.tokens > tokenBudget) {
    const clippedPacketLoadInstruction = packetLoadInstruction;
    const fallbackExecution = {
      ...execution,
      Background: execution.Background.map((item) => ({
        ...item,
        Summary: truncateMiddle(String(item.Summary ?? ""), 80) || null
      }))
    };
    content = fitClippedExecution(fallbackExecution, clippedPacketLoadInstruction, tokenBudget, {
      ...options,
      config,
      model: options.model ?? contract.Model
    });
    measured = countTokens(options.db ?? null, content, { config, model: options.model ?? contract.Model });
    if (measured.tokens > tokenBudget && fallbackExecution.Background.length) {
      const minimalExecution = {
        ...fallbackExecution,
        // UpstreamResultRefs is the lossless typed transport. Drop duplicated
        // predecessor labels from prose before sacrificing any structured ref.
        Background: []
      };
      content = fitClippedExecution(minimalExecution, clippedPacketLoadInstruction, tokenBudget, {
        ...options,
        config,
        model: options.model ?? contract.Model
      });
      measured = countTokens(options.db ?? null, content, { config, model: options.model ?? contract.Model });
    }
  }
  return {
    content,
    estimatedTokens: measured.tokens,
    tokenMethod: measured.method,
    truncated: true,
    overBudget: measured.tokens > tokenBudget
  };
}
