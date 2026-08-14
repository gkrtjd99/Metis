import { PHASES, ROLES, TASK_KINDS, TASK_KINDS_BY_ROLE } from "./metadata.js";

export const PLAN_DRAFT_SCHEMA = Object.freeze({
  topLevel: Object.freeze({
    requiredArrays: Object.freeze(["interfaces", "milestones", "tasks"]),
    requiredObjects: Object.freeze(["parallelism"])
  }),
  interface: Object.freeze({
    required: Object.freeze(["id", "name", "description", "schema", "requirementIds"]),
    forbiddenAliases: Object.freeze({})
  }),
  milestone: Object.freeze({
    required: Object.freeze(["id", "title", "objective", "userVisibleOutcome", "exitCriteria", "requirementIds", "dependsOn"]),
    forbiddenAliases: Object.freeze({ name: "title", description: "objective", wave: "sequence" })
  }),
  task: Object.freeze({
    required: Object.freeze([
      "id", "title", "goal", "role", "taskKind", "runPhase", "wave", "readOnly",
      "targetPaths", "scope", "acceptanceCriteria", "requiredEvidence", "expectedOutputs",
      "requirementIds", "dependsOn", "interfaceInputs", "interfaceOutputs"
    ]),
    forbiddenAliases: Object.freeze({ kind: "taskKind", outcome: "goal", consumesInterfaceIds: "interfaceInputs/interfaceOutputs" }),
    roles: ROLES,
    runPhases: PHASES,
    taskKinds: TASK_KINDS,
    taskKindsByRole: TASK_KINDS_BY_ROLE
  })
});

export const PLAN_DRAFT_PROTOCOL = Object.freeze([
  "PlanDraft is one object with canonical lower-camel-case interfaces, milestones, and tasks arrays; tasks must be non-empty.",
  "Each interface is {id, name, description, schema, requirementIds}; id/name/description are non-empty strings, schema is a plain object, and requirementIds is a string array.",
  "Each milestone is {id, title, objective, userVisibleOutcome, exitCriteria, requirementIds, dependsOn}; title/objective/outcome are non-empty strings and the three arrays are explicit.",
  "Each task is {id, title, goal, role, taskKind, runPhase, wave, readOnly, targetPaths, scope, acceptanceCriteria, requiredEvidence, expectedOutputs, requirementIds, dependsOn, interfaceInputs, interfaceOutputs}; use the exact field names and array types.",
  `Task role must be one of: ${ROLES.join(", ")}; runPhase must be one of: ${PHASES.join(", ")}; taskKind must be one of: ${TASK_KINDS.join(", ")}. Canonical role kinds are: ${Object.entries(TASK_KINDS_BY_ROLE).map(([role, kinds]) => `${role}=${kinds.join("|")}`).join("; ")}.`,
  "Planned task phases are role-bound: worker/coordinator/integrator use runPhase execute; reviewer and specialist reviewers use review; verifier and adversarial-reviewer use verify; curator uses curate. Do not put a review or verification role in execute.",
  "Do not use milestone name, description, or wave; use title, objective, and sequence only when a sequence is needed. Do not use task kind, outcome, or consumesInterfaceIds; use taskKind, goal, interfaceInputs, and interfaceOutputs.",
  "Dependencies are milestone.dependsOn and task.dependsOn arrays of existing ids; wave is a positive integer on tasks and same-wave implementation tasks must have no dependency path between them."
  ]).join(" ");
