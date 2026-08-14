# Delegation and Scheduling

Main owns goal-level decisions and controller actions.
The runtime owns state, graph validation, Task Packet compilation, budgets, fencing, leases, and phase gates.
Subagents perform actual engineering work.

## Thin Main

Main must not perform broad repository inspection, external research, design authoring, planning, implementation, repair, review, browser operation, or curation.
It creates task specs requested by the controller and routes terminal results.

The Main transcript is never child context.

## Universal tasks

Use tasks for discovery, research, synthesis, design, planning, compilation, implementation, integration, diagnosis, repair, review, verification, and curation.

Each task defines:

- one testable outcome;
- role, kind, phase, and wave;
- dependencies and parent;
- scope and mutable paths;
- interface inputs and outputs;
- acceptance criteria and evidence;
- risk, effort, slice type, and verification modes;
- capabilities, authority, and stop conditions;
- structured result schema.

## Waves

A wave is the unit of parallel dispatch.
The scheduler selects only the earliest open wave in the current phase.
A later wave cannot start until every task in the earlier wave is terminal.

Use parallel fan-out for independent work such as:

- architecture, tests, and dependency scouts;
- official guidance and established-pattern research;
- non-overlapping implementation slices;
- independent review and verification dimensions.

Use a synthesis or integration wave after the fan-out when one canonical artifact is required.

## Task Packets

Do not send one-line child prompts.
The runtime compiles the task blueprint with:

- role protocol;
- frozen interfaces and their exact content hashes;
- upstream contracts;
- selected repository and artifact context;
- local capability procedures;
- verification and stop conditions;
- result schema.

Ordinary tasks use deterministic assembly.
Complex or high-risk tasks can use a task-compiler subagent.
The compiler cannot change protected contract fields.

## Roles and capabilities

Roles define responsibility and authority.
Capabilities define focused procedure.
Tools perform operations.

Use only canonical roles from `docs/REFERENCE.md`.
Do not add a fixed role for every framework or technology.

Capability selection uses requirement kinds, paths, file types, interfaces, risks, verification modes, and explicit plan selections.
Do not route from title keywords alone.
Do not search the web for a new skill during every task.

## Atomic batch claim

Use:

```sh
metis schedule claim --owner metis-main --pretty
```

The runtime claims the whole current-wave batch in one SQLite transaction.
It persists the batch before workspace preparation.
A preparation failure aborts the batch.
The `claimed` state means preparation is still in progress; do not spawn or
acknowledge a claimed batch. Only a `prepared` batch may be handed to the host.

Spawn only returned descriptors.
Use the exact task name, role, model, reasoning effort, workspace, lease, and compiled contract.
Use `fork_turns: "none"` for Codex children.

## Spawn acknowledgement

A task claim does not consume spawn budget.
Acknowledge only host spawns that returned a nonempty child/session/agent
receipt bound to each task and attempt:

```sh
metis schedule ack <batch-id> --tasks <id1,id2> --receipts '{"<id1>":{"receipt":"<host-receipt-1>","batchId":"<batch-id>","taskId":"<id1>","attemptFence":1},"<id2>":{"receipt":"<host-receipt-2>","batchId":"<batch-id>","taskId":"<id2>","attemptFence":1}}' --owner metis-main --pretty
```

Acknowledgement is idempotent only for the same receipt. It consumes spawn and
research budget once. A missing or conflicting receipt is rejected. Abort
rejected or unspawned batches explicitly.

## Context partition

A child receives one self-contained Task Packet.
It can contain selected source or artifact context and runtime references.
It must not receive full parent or sibling history.

Keep source bodies, patches, logs, screenshots, test streams, and transcripts outside Main.

## Worktree and fencing

Every mutable attempt uses a detached Git worktree.
There is no shared mutable fallback.
Each attempt has a fencing token and one lease token.

A stale worker cannot finish a newer attempt.
An expired worker changes to `blocked`.
Its ownership remains until explicit recovery.
Do not automatically dispatch a duplicate worker.

Renew active batch leases:

```sh
metis schedule heartbeat <batch-id> --pretty
```

Heartbeat only receipt-backed tasks. If a claimed or prepared batch still has
any task without a nonempty host receipt, the scheduler leaves its watchdog
timestamp unchanged and reports recovery required. After the controller's
stale observation, use its fenced abort command with the expected status,
timestamp, and controller fence; do not substitute an unfenced abort.

## Results and diagnosis

A child returns the packet result schema.
The runtime validates acceptance results, files, interfaces, checks, evidence, artifacts, and blockers.

A failed child goes to a diagnostician before retry when diagnosis-first policy is active.
The diagnostician returns the earliest invalid state and one recommended route.
Main selects the route but does not perform the repair.

## Model routing

Use lower-cost routes for bounded scouting and mechanical work.
Use stronger routes for synthesis, design, planning, critics, complex task compilation, integration, review, and verification.

Retry only transient failures on the same route.
Escalate reasoning failures.
Return contract and graph failures to task compilation, design, or planning.
