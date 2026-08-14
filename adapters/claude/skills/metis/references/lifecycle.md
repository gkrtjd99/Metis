# Managed Lifecycle

Metis runs only after an explicit `$metis` request.
The canonical state machine has ten phases.

```text
intake
  -> discover
  -> research
  -> design
  -> plan
  -> execute
  -> review
  -> verify
  -> curate
  -> complete
```

Optional work is waived inside this phase model.
Do not create a second phase list.
Each phase can contain multiple task waves.

Before materialization, resolve one deterministic lifecycle profile:
`fast` for explicitly low-risk local isolated work, `balanced` for ordinary
work, and `full` for high-risk, external, shared-interface, or review-critical
work. Reject unsafe fast requests; do not weaken gates implicitly. The bounded
`drive` controller command may advance persisted actions for automation, but it
uses the same ownership, task, budget, review, and integration fences as Main.

## Intake

Main freezes one Goal Contract.
Define scope, non-goals, constraints, success criteria, route, and atomic requirements.
A material amendment needs user approval.

## Discover

Main creates the requested scout task specs.
Scouts inspect architecture, tests, dependencies, conventions, and similar local code in parallel.
A synthesizer produces the canonical discovery artifact from completed scout evidence.
Main does not inspect or synthesize.

Record total and indexed file counts.
A truncated scan blocks progress by default.

The default route may place scouts and goal-contract-only researchers in one
read-only general atomic materialization wave. Stable task IDs and canonical
artifact identities make controller replay idempotent.

## Research

Main creates bounded researcher tasks only when current external evidence is required.
Use authoritative primary sources for technical facts.
Separate facts, inference, recommendation, and uncertainty.

A synthesizer produces the canonical research artifact.
Current task research does not install a new permanent capability.

## Design

A designer subagent maps every must requirement to the simplest complete design.
It defines shared interfaces, errors, tests, assumptions, invariants, risks, and operational impact.

UI work can also produce experience, visual, and browser acceptance contracts.
The visual contract must reference existing repository conventions.

Seal the design.
Run an independent design critic against the exact seal.

## Plan

A planner subagent returns a typed `PlanDraft`.
The runtime ingests interfaces, milestones, tasks, dependencies, waves, and capabilities.

Milestones need observable outcomes and exit criteria.
Tasks need bounded outcomes, ownership, interfaces, risk, effort, slice type, verification modes, authority, and expected outputs.

The runtime compiles Task Packets.
Complex or high-risk execution tasks can receive task-compiler tasks.
A packet ambiguity blocks dispatch.

Seal the plan only after required packets are ready.
Run an independent plan critic.

## Execute

Claim one atomic current-wave scheduler batch.
Spawn only returned descriptors.
Use detached worktrees for every mutable task.
Acknowledge accepted spawns.
Heartbeat the controller and active batch.

Effort is negotiated progressively (`low`, `medium`, `high`, `xhigh`, `max`)
against host/model capability evidence. Host adapters render provider flags at
spawn time; core contracts remain host-neutral. Each claim creates an
append-only attempt record containing requested/effective effort, evidence,
host/model/role, batch and lease fences, failure class, and token references.
Transient retries create a new attempt; contract, dependency, plan, and
external failures require diagnosis or an explicit route.

Workers use frozen interfaces and declared scope.
They return structured results.
They do not create undeclared work.

## Review

Review the integrated repository with fresh subagents.
Run general and selected specialist review.
Blocking findings become repair tasks.
Repeat review against the current code fingerprint.

## Verify

Run deterministic checks with structured commands.
Dispatch independent semantic and browser verifiers.
Resolve required checkpoints.
Create one immutable verification candidate.
Run adversarial completion review when required.

Main does not operate the browser or judge screenshots.

## Curate

Dispatch a curator for human documentation.
Regenerate indexes after current code is verified.
Synchronize project knowledge.
Run self-evaluation.

## Complete

Complete only when every deterministic gate passes.
A plan, child result, review, or test pass is not completion.
