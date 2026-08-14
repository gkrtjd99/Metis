export const SCHEMA_VERSION = 11;
export const CONFIG_VERSION = 6;
export const RUNTIME_LAYOUT_VERSION = 4;

export const PHASES = Object.freeze([
  "intake",
  "discover",
  "research",
  "design",
  "plan",
  "execute",
  "review",
  "verify",
  "curate",
  "complete"
]);

export const ROLES = Object.freeze([
  "scout",
  "researcher",
  "synthesizer",
  "designer",
  "design-critic",
  "planner",
  "plan-critic",
  "task-compiler",
  "worker",
  "coordinator",
  "integrator",
  "diagnostician",
  "reviewer",
  "security-reviewer",
  "database-reviewer",
  "performance-reviewer",
  "accessibility-reviewer",
  "migration-reviewer",
  "verifier",
  "adversarial-reviewer",
  "curator"
]);

export const MODEL_ROUTE_GROUPS = Object.freeze({
  ordinary: Object.freeze(["scout", "researcher", "worker", "coordinator", "curator"]),
  strong: Object.freeze(ROLES.filter((role) => !["scout", "researcher", "worker", "coordinator", "curator"].includes(role)))
});

export const TASK_KINDS = Object.freeze([
  "discovery",
  "research",
  "synthesis",
  "design",
  "planning",
  "compilation",
  "implementation",
  "integration",
  "diagnosis",
  "repair",
  "review",
  "verification",
  "curation"
]);

// A task kind is a lifecycle contract, not free-form planner prose. Keep the
// role defaults and explicitly supported alternate kind together with the
// canonical enum so PlanDraft prompts and ingestion cannot drift from addTask.
export const TASK_KINDS_BY_ROLE = Object.freeze({
  scout: Object.freeze(["discovery"]),
  researcher: Object.freeze(["research"]),
  synthesizer: Object.freeze(["synthesis"]),
  designer: Object.freeze(["design"]),
  "design-critic": Object.freeze(["review"]),
  planner: Object.freeze(["planning"]),
  "plan-critic": Object.freeze(["review"]),
  "task-compiler": Object.freeze(["compilation"]),
  worker: Object.freeze(["implementation", "repair"]),
  coordinator: Object.freeze(["integration"]),
  integrator: Object.freeze(["integration"]),
  diagnostician: Object.freeze(["diagnosis"]),
  reviewer: Object.freeze(["review"]),
  "security-reviewer": Object.freeze(["review"]),
  "database-reviewer": Object.freeze(["review"]),
  "performance-reviewer": Object.freeze(["review"]),
  "accessibility-reviewer": Object.freeze(["review"]),
  "migration-reviewer": Object.freeze(["review"]),
  verifier: Object.freeze(["verification"]),
  "adversarial-reviewer": Object.freeze(["review"]),
  curator: Object.freeze(["curation"])
});

export const DEFAULT_TASK_KIND_BY_ROLE = Object.freeze(
  Object.fromEntries(Object.entries(TASK_KINDS_BY_ROLE).map(([role, kinds]) => [role, kinds[0]]))
);

export const REVIEW_ROLES = Object.freeze([
  "reviewer",
  "security-reviewer",
  "database-reviewer",
  "performance-reviewer",
  "accessibility-reviewer",
  "migration-reviewer",
  "adversarial-reviewer"
]);

export const SPECIALIST_CAPABILITIES = Object.freeze([
  "security",
  "database",
  "performance",
  "accessibility",
  "migration"
]);

export const CLEANUP_SCOPES = Object.freeze([
  "cache",
  "worktrees",
  "generated",
  "benchmarks",
  "all"
]);

export const REQUIREMENT_KINDS = Object.freeze([
  "functional",
  "quality",
  "operational",
  "security",
  "documentation",
  "ui",
  "ux",
  "frontend",
  "user-facing",
  "user-interface",
  "user-experience",
  "accessibility",
  "database",
  "migration",
  "performance"
]);

export const CHECKPOINT_KINDS = Object.freeze([
  "decision",
  "human-verify",
  "authority",
  "external",
  "release"
]);
