const TERMINAL_STATUSES = new Set(["completed", "waived"]);

function taskId(runId, lane) {
  return `predesign-${runId}-${lane}`;
}

function existingTask(tasks, spec) {
  return tasks.find((task) => task.id === spec.id);
}

function terminal(task) {
  return TERMINAL_STATUSES.has(task?.status);
}

function scoutSpecs(runId, requirementIds) {
  return [
    {
      id: taskId(runId, "scout-architecture"),
      title: "Map repository architecture and entry points",
      goal: "Identify the smallest relevant architecture, entry points, conventions, and shared interfaces for the goal.",
      role: "scout", taskKind: "discovery", runPhase: "discover", wave: 1, readOnly: true,
      scope: ["Architecture, entry points, and conventions relevant to the frozen goal."],
      nonGoals: ["Do not summarize the entire repository."],
      requirementIds,
      acceptanceCriteria: ["Relevant paths and interfaces are cited with current source evidence."],
      expectedOutputs: ["facts", "relevant-paths", "interfaces", "unknowns"]
    },
    {
      id: taskId(runId, "scout-tests"),
      title: "Map tests and verification surface",
      goal: "Locate existing tests, checks, fixtures, and behavioral verification paths for the goal.",
      role: "scout", taskKind: "discovery", runPhase: "discover", wave: 1, readOnly: true,
      scope: ["Tests, checks, fixtures, and current verification conventions."],
      requirementIds,
      acceptanceCriteria: ["Each proposed verification route names current evidence and gaps."],
      expectedOutputs: ["facts", "relevant-paths", "unknowns"]
    },
    {
      id: taskId(runId, "scout-boundaries"),
      title: "Map dependency and change boundaries",
      goal: "Identify dependency edges, ownership boundaries, likely parallel slices, and interface risks.",
      role: "scout", taskKind: "discovery", runPhase: "discover", wave: 1, readOnly: true,
      scope: ["Dependencies and change boundaries relevant to the goal."],
      requirementIds,
      acceptanceCriteria: ["Parallelizable and shared boundaries are explicit."],
      expectedOutputs: ["facts", "interfaces", "risks", "unknowns"]
    }
  ];
}

function researcherSpecs(runId, requirementIds) {
  const scope = ["Frozen goal contract, success criteria, constraints, and active requirements."];
  const contextRefs = ["artifact:goal-contract"];
  return [
    {
      id: taskId(runId, "research-official"),
      title: "Research official guidance from the frozen goal contract",
      goal: "Answer current technical questions that affect the goal using only the frozen goal contract and authoritative external sources.",
      role: "researcher", taskKind: "research", runPhase: "discover", wave: 1, readOnly: true,
      requirementIds, scope, contextRefs,
      acceptanceCriteria: ["Facts, inference, recommendations, and uncertainty are separated.", "Version applicability is explicit."],
      expectedOutputs: ["sources", "findings", "constraints", "recommendations", "unknowns"],
      authorityBoundary: "local-read"
    },
    {
      id: taskId(runId, "research-patterns"),
      title: "Research established patterns from the frozen goal contract",
      goal: "Find applicable implementation and workflow patterns using only the frozen goal contract and maintained primary sources.",
      role: "researcher", taskKind: "research", runPhase: "discover", wave: 1, readOnly: true,
      requirementIds, scope, contextRefs,
      acceptanceCriteria: ["Only applicable patterns and tradeoffs are returned.", "Uncertainty remains explicit."],
      expectedOutputs: ["sources", "findings", "recommendations", "unknowns"],
      authorityBoundary: "local-read"
    }
  ];
}

function findExisting(tasks, specs) {
  return specs.map((spec) => ({ spec, task: existingTask(tasks, spec) }));
}

export function predesignCanonicalLaneSpecs({ runId, requirementIds, discoveryCurrent }) {
  return [
    ...(discoveryCurrent ? [] : scoutSpecs(runId, requirementIds)),
    ...researcherSpecs(runId, requirementIds)
  ];
}

export function predesignLaneSpecs({ runId, requirementIds, tasks, discoveryCurrent }) {
  const desired = predesignCanonicalLaneSpecs({ runId, requirementIds, discoveryCurrent });
  return findExisting(tasks, desired).some(({ task }) => !task) ? desired : [];
}

export function predesignCanonicalSynthesisSpecs({ runId, requirementIds, discoveryCurrent, researchCurrent }) {
  if (researchCurrent) return [];
  const wave = 2;
  const specs = [];
  const scouts = scoutSpecs(runId, requirementIds);
  const researchers = researcherSpecs(runId, requirementIds);
  if (!discoveryCurrent) {
    specs.push({
      id: taskId(runId, "synthesis-discovery"),
      title: "Synthesize prefetched repository discovery",
      goal: "Merge completed scout evidence into the canonical discovery artifact without adding unsupported claims.",
      role: "synthesizer", taskKind: "synthesis", runPhase: "discover", wave, readOnly: true,
      dependsOn: scouts.map((task) => task.id),
      requirementIds,
      contextRefs: ["artifact:goal-contract", ...scouts.map((task) => `task-result:${task.id}`)],
      acceptanceCriteria: [
        "Contradictions and unknowns remain explicit.",
        "The artifact contains only evidence supplied by child tasks.",
        "ArtifactKind is discovery.",
        "ArtifactContent.scope is a non-empty string array.",
        "ArtifactContent.knownFacts is an array.",
        "ArtifactContent.unknowns is an array.",
        "ProducedArtifacts is empty; emit the canonical discovery only through ArtifactKind and ArtifactContent."
      ],
      constraints: [
        "ArtifactContent must use lowercase scope, knownFacts, and unknowns fields.",
        "Do not emit a duplicate discovery in ProducedArtifacts."
      ],
      expectedOutputs: ["artifact:discovery"],
      authorityBoundary: "local-read"
    });
  }
  specs.push({
    id: taskId(runId, "synthesis-research"),
    title: "Synthesize prefetched goal-contract research",
    goal: "Merge completed goal-contract-only research evidence into the canonical research artifact without consuming partial discovery.",
    role: "synthesizer", taskKind: "synthesis", runPhase: "discover", wave, readOnly: true,
    dependsOn: researchers.map((task) => task.id),
    requirementIds,
    contextRefs: ["artifact:goal-contract", ...researchers.map((task) => `task-result:${task.id}`)],
    acceptanceCriteria: ["Sources remain traceable.", "Contradictions and uncertainty remain explicit.", "No discovery result is consumed."],
    expectedOutputs: ["artifact:research"],
    authorityBoundary: "local-read"
  });
  return specs;
}

function synthesisSpecs({ runId, requirementIds, tasks, discoveryCurrent, researchCurrent }) {
  const scouts = scoutSpecs(runId, requirementIds).map((spec) => existingTask(tasks, spec)).filter(Boolean);
  const researchers = researcherSpecs(runId, requirementIds).map((spec) => existingTask(tasks, spec)).filter(Boolean);
  if (!researchCurrent && researchers.length === 0) return [];
  if (!discoveryCurrent && (scouts.length !== 3 || !scouts.every(terminal))) return [];
  const desired = predesignCanonicalSynthesisSpecs({ runId, requirementIds, discoveryCurrent, researchCurrent });
  return findExisting(tasks, desired).some(({ task }) => !task) ? desired : [];
}

export function predesignSynthesisSpecs({ runId, requirementIds, tasks, discoveryCurrent, researchCurrent }) {
  return synthesisSpecs({ runId, requirementIds, tasks, discoveryCurrent, researchCurrent });
}
