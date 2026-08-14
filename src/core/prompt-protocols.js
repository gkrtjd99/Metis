import { DEFAULT_TASK_KIND_BY_ROLE, TASK_KINDS, TASK_KINDS_BY_ROLE } from "./metadata.js";
import { PLAN_DRAFT_PROTOCOL } from "./plan-draft-schema.js";

export const PLAN_CRITIC_PROTOCOL = Object.freeze([
  "Inspect only the authenticated sealed PlanDraft and the supplied compiled task-packet/artifact handles; this task is strictly read-only.",
  "Load supplied artifacts and packet objects through their authenticated object-load commands only. Do not re-inspect the repository, run plan lint, or invoke any other repository/tool command.",
  "Never run Main/controller state-changing Metis commands, including plan review, plan ingest, plan seal, next, or drive.",
  "If a forbidden command is attempted or returns CONTROLLER_REQUIRED, stop immediately and return a bounded BLOCKED or FAILED structured result describing the command and evidence; do not retry or continue reasoning.",
  "After the bounded handle-only analysis, immediately write the structured result JSON to the exact descriptor terminal_handoff result_file and execute the fenced task finish command successfully.",
  "Do not return a prose-only review, invoke the controller, or wait for Main to record the review; the durable handoff is the only completion path."
]);

export const ROLE_PROTOCOLS = Object.freeze({
  scout: [
    "Inspect only the assigned repository questions and paths.",
    "Do not modify files.",
    "Connect every material claim to current source evidence.",
    "Return facts, unknowns, interfaces, risks, and relevant paths."
  ],
  researcher: [
    "Research only the assigned external questions.",
    "Prefer primary and current sources.",
    "Separate facts, inference, recommendation, and unresolved uncertainty.",
    "Do not inspect unrelated repository areas or implement code."
  ],
  synthesizer: [
    "Synthesize only the supplied child results and evidence.",
    "Do not perform new repository inspection or external research.",
    "Resolve contradictions explicitly. Do not hide uncertainty.",
    "Produce the requested artifact in the declared schema."
  ],
  designer: [
    "Use discovery and research evidence. Do not inspect the repository broadly.",
    "Choose the simplest complete design that meets the frozen requirements.",
    "Freeze shared interfaces before parallel implementation.",
    "Do not implement code or approve your own design."
  ],
  "design-critic": [
    "Attack the exact sealed design.",
    "Find unmet requirements, ambiguous interfaces, missing failure paths, and unnecessary complexity.",
    "Return an explicit verdict and severity-ranked findings.",
    "When SubjectArtifact is supplied, a COMPLETED result must include its exact typed EvidenceRef: {type:'artifact', id, contentRef}.",
    "Do not modify files or repair the design."
  ],
  planner: [
    "Convert the approved design into milestones, frozen interfaces, and a task DAG.",
    "Use one independently verifiable outcome per task.",
    "Separate mutable ownership and maximize safe parallel work.",
    "Always return PlanDraft.parallelism with eligible, independentSlices, desiredWidth, minimumSameWaveImplementationTasks, and an evidence-based rationale.",
    "Set desiredWidth to min(host capacity, safe independent slices, remaining spawn budget); explain any coupling that prevents use of safe capacity.",
    PLAN_DRAFT_PROTOCOL,
    "When the approved design exposes at least four independently verifiable, non-overlapping mutable slices, emit at least four mutually task- and milestone-dependency-independent worker or integrator execute tasks in the same earliest execution wave so they are actually concurrently runnable.",
    "Give same-wave implementation tasks non-empty canonical exclusive targetPaths and independent non-duplicated acceptance criteria.",
    "Set eligible false only for genuinely atomic or smaller-scope work: do not hide four independent non-overlapping mutable slices or bundle four or more canonical mutable target paths into one task; one to three intentionally coupled paths may remain atomic with a concrete rationale.",
    "Never use eligible false to override an explicit design or requirement for parallel fan-out.",
    "Do not implement code or write worker prompts."
  ],
  "plan-critic": [
    ...PLAN_CRITIC_PROTOCOL,
    "Attack the exact sealed plan and compiled task packets.",
    "Find missing requirements, invalid dependencies, overlapping ownership, weak boundaries, and missing verification.",
    "Check that every dispatched task is self-contained.",
    "When SubjectArtifact is supplied, a COMPLETED result must include its exact typed EvidenceRef: {type:'artifact', id, contentRef}.",
    "Do not implement or repair the plan."
  ],
  "task-compiler": [
    "Compile one task blueprint into a self-contained execution packet.",
    "Do not change scope, authority, dependencies, acceptance criteria, or frozen interfaces.",
    "Select and order only the context needed by the target task.",
    "Report ambiguity instead of inventing missing design decisions."
  ],
  worker: [
    "Execute only the compiled task packet.",
    "Modify only the owned paths.",
    "Use the frozen interfaces exactly.",
    "Run task-local verification and return structured evidence."
  ],
  coordinator: [
    "Coordinate only the declared child subtree.",
    "Keep child transcripts and raw output outside the parent context.",
    "Reconcile results in dependency order.",
    "Return compact steering, conflicts, and evidence references."
  ],
  integrator: [
    "Integrate only declared predecessor results.",
    "Preserve frozen interfaces unless the task explicitly owns a new version.",
    "Modify only the owned paths.",
    "Run integration checks and report conflicts."
  ],
  diagnostician: [
    "Diagnose the recorded failure without modifying files.",
    "Classify it as transient, reasoning, contract, dependency, integration, plan, or external.",
    "Identify the earliest invalid assumption or artifact.",
    "Recommend one next action with evidence."
  ],
  reviewer: [
    "Review the integrated code against the task contracts and frozen requirements.",
    "Do not trust worker summaries.",
    "Check correctness, architecture, error handling, tests, and unnecessary complexity.",
    "When SubjectArtifact is supplied, a COMPLETED result must include its exact typed EvidenceRef: {type:'artifact', id, contentRef}.",
    "Do not modify implementation files."
  ],
  "security-reviewer": [
    "Review authentication, authorization, secrets, injection, sessions, and trust boundaries.",
    "Use current source and command evidence.",
    "Return exact affected paths and requirements.",
    "When SubjectArtifact is supplied, a COMPLETED result must include its exact typed EvidenceRef: {type:'artifact', id, contentRef}.",
    "Do not modify implementation files."
  ],
  "database-reviewer": [
    "Review integrity, constraints, transactions, queries, migrations, and rollback behavior.",
    "Use current source and command evidence.",
    "Return exact affected paths and requirements.",
    "When SubjectArtifact is supplied, a COMPLETED result must include its exact typed EvidenceRef: {type:'artifact', id, contentRef}.",
    "Do not modify implementation files."
  ],
  "performance-reviewer": [
    "Review latency, throughput, allocation, I/O, cache, queue, and concurrency behavior.",
    "Reject unsupported performance claims.",
    "Return exact affected paths and requirements.",
    "When SubjectArtifact is supplied, a COMPLETED result must include its exact typed EvidenceRef: {type:'artifact', id, contentRef}.",
    "Do not modify implementation files."
  ],
  "accessibility-reviewer": [
    "Review keyboard access, semantics, focus, contrast, labels, and error communication.",
    "Use browser evidence for user-facing behavior.",
    "Return exact affected paths and requirements.",
    "When SubjectArtifact is supplied, a COMPLETED result must include its exact typed EvidenceRef: {type:'artifact', id, contentRef}.",
    "Do not modify implementation files."
  ],
  "migration-reviewer": [
    "Review source state, target state, rollout, retry, backfill, rollback, and mixed-version behavior.",
    "When SubjectArtifact is supplied, a COMPLETED result must include its exact typed EvidenceRef: {type:'artifact', id, contentRef}.",
    "Return exact affected paths and requirements.",
    "Do not modify implementation files."
  ],
  verifier: [
    "Verify acceptance criteria with current independent evidence.",
    "Do not modify implementation files.",
    "Do not treat a build or worker claim as behavioral proof.",
    "When SubjectArtifact is supplied, a COMPLETED result must include its exact typed EvidenceRef: {type:'artifact', id, contentRef}.",
    "Return the exact failed criterion when verification fails."
  ],
  "adversarial-reviewer": [
    "Assume the completion candidate is wrong.",
    "Find hidden failures, missing edge cases, weak tests, races, and delivery mismatches.",
    "When SubjectArtifact is supplied, a COMPLETED result must include its exact typed EvidenceRef: {type:'artifact', id, contentRef}.",
    "Return an explicit verdict and structured findings.",
    "Do not modify files."
  ],
  curator: [
    "Use only verified final behavior and active decisions.",
    "Modify only declared documentation paths.",
    "Do not infer design intent from code alone.",
    "Do not hand-edit generated indexes."
  ]
});

export function subjectEvidenceRequirement(subjectKind = "SubjectArtifact") {
  return `This task includes ${subjectKind}. A COMPLETED result MUST include one exact typed EvidenceRefs entry {type:'artifact', id:'<SubjectArtifact.id>', contentRef:'<SubjectArtifact.contentRef>'}; do not use a bare artifact id, a note, or a substituted contentRef.`;
}

export { DEFAULT_TASK_KIND_BY_ROLE, TASK_KINDS_BY_ROLE };

export function defaultTaskKind(role) {
  return DEFAULT_TASK_KIND_BY_ROLE[role] ?? "implementation";
}

export function validateTaskKind(kind) {
  return TASK_KINDS.includes(kind);
}

export function resultSchemaForRole(role) {
  const base = {
    Status: "COMPLETED | BLOCKED | FAILED | UNKNOWN",
    Summary: "",
    Files: [],
    AcceptanceResults: [{ Criterion: "", Status: "verified | failed | not-applicable", EvidenceRefs: [] }],
    InterfaceReport: {
      Consumed: [{ Id: "", Name: "", ContentHash: "" }],
      Produced: [{ Id: "", Name: "", ContentHash: "" }],
      Changed: [{ Id: "", Name: "", ProposedVersion: "", ContentHash: "" }]
    },
    Checks: [{ Name: "", Status: "passed | failed | skipped", EvidenceRefs: [] }],
    ProducedArtifacts: [{ Kind: "", Status: "verified | draft", Content: {}, Metadata: {} }],
    EvidenceRefs: [],
    ResultGuidance: {
      Files: "Changed paths only; read-only reviewer/verifier tasks MUST use Files: [].",
      EvidenceRefs: 'Use source "src/file.js:1" or {type:"source",path:"src/file.js",startLine:1,endLine:1}; never {type:"file",id:...}. '
    },
    SubjectEvidenceRequirement: subjectEvidenceRequirement(),
    Blockers: []
  };
  if (["design-critic", "plan-critic", "reviewer", "security-reviewer", "database-reviewer", "performance-reviewer", "accessibility-reviewer", "migration-reviewer", "adversarial-reviewer"].includes(role)) {
    return {
      ...base,
      Verdict: "APPROVED | REJECTED",
      Findings: [{ Title: "", Description: "", Severity: "info | warning | error | critical", TargetPaths: [], RequirementIds: [], SuggestedFix: "", EvidenceRefs: [] }]
    };
  }
  if (role === "scout") return { ...base, Facts: [], Unknowns: [], RelevantPaths: [], Interfaces: [], Risks: [] };
  if (role === "researcher") return { ...base, Questions: [], Sources: [], Findings: [], Constraints: [], Recommendations: [], Unknowns: [] };
  if (role === "synthesizer") return { ...base, ArtifactKind: "", ArtifactContent: {} };
  if (role === "planner") return {
    ...base,
    PlanDraft: {
      parallelism: {
        eligible: false,
        minimumSameWaveImplementationTasks: 4,
        independentSlices: 1,
        desiredWidth: 1,
        rationale: ""
      },
      milestones: [{ id: "", title: "", objective: "", userVisibleOutcome: "", exitCriteria: [], requirementIds: [], dependsOn: [] }],
      interfaces: [{ id: "", name: "", description: "", schema: {}, requirementIds: [] }],
      tasks: [{
        id: "", title: "", goal: "", role: "worker", taskKind: "implementation", runPhase: "execute",
        wave: 1, readOnly: false, targetPaths: [], scope: [], acceptanceCriteria: [], requiredEvidence: [],
        expectedOutputs: [], requirementIds: [], dependsOn: [], interfaceInputs: [], interfaceOutputs: []
      }]
    }
  };
  if (role === "task-compiler") {
    return {
      ...base,
      TargetTaskId: "",
      PacketOverlay: {
        ClarifiedObjective: "",
        ExecutionSteps: [],
        ContextPriorities: [],
        InterfaceNotes: [],
        VerificationPlan: [],
        AdditionalStopConditions: [],
        HandoffNotes: [],
        Ambiguities: []
      }
    };
  }
  if (role === "diagnostician") {
    return {
      ...base,
      Diagnosis: {
        FailureClass: "transient | reasoning | contract | dependency | integration | plan | external",
        EarliestInvalidState: "",
        Evidence: [],
        RecommendedAction: ""
      }
    };
  }
  return base;
}

function section(title, value) {
  const body = Array.isArray(value)
    ? value.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n") || "- None"
    : typeof value === "string"
      ? value || "None"
      : JSON.stringify(value ?? null, null, 2);
  return `# ${title}\n${body}`;
}

export function renderTaskPacketPrompt(packet) {
  return [
    section("ROLE", packet.Role),
    section("ROLE PROTOCOL", packet.RoleProtocol),
    section("OBJECTIVE", packet.Objective),
    section("REQUIREMENTS", packet.Requirements),
    section("WHY", packet.Rationale),
    section("OWNED SCOPE", packet.Scope),
    section("NON-GOALS", packet.NonGoals),
    section("CONSTRAINTS", packet.Constraints),
    section("FROZEN INTERFACES", packet.InterfaceContracts),
    section("UPSTREAM CONTRACTS", packet.UpstreamContracts),
    section("SELECTED CONTEXT", packet.Context),
    section("CAPABILITY PROCEDURES", packet.Capabilities),
    ...(packet.CompilerTarget ? [section("COMPILER TARGET BLUEPRINT", packet.CompilerTarget)] : []),
    section("EXECUTION STEPS", packet.ExecutionSteps),
    section("ACCEPTANCE CRITERIA", packet.AcceptanceCriteria),
    section("VERIFICATION PLAN", packet.VerificationPlan),
    section("REQUIRED OUTPUTS", packet.ExpectedOutputs),
    section("AUTHORITY", packet.Authority),
    section("STOP CONDITIONS", packet.StopConditions),
    section("RESULT SCHEMA", packet.ResultSchema)
  ].join("\n\n");
}
