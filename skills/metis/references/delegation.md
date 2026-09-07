# Delegation and Scheduling

Main owns goal-level decisions and controller actions.
The runtime owns state, graph validation, Task Packet compilation, budgets, fencing, leases, and phase gates.
Subagents perform actual engineering work.

## Thin Main

Main coordinates only the goal, canonical documents, and task-owner handoffs. It
must not perform broad repository inspection, external research, design
authoring, planning, implementation, repair, review, browser operation, or
curation. It creates only task specs requested by the controller and routes
compact terminal results. Follow the runtime-returned profile and action; do
not invent a route or force an unnecessary critic.

The Main transcript is never child context.

## Task owners

An existing `coordinator` role is the task owner for one bounded subtree. Main
and the planner approve its direct-child subtree in the sealed plan. Dynamic
child-task creation changes that plan and must be requested from Main for
approval and re-sealing. The owner keeps that subtree's lifecycle alive through
normal completion, manages low-cost execution agents and an independent
verifier, and reports local progress and normal completion to Main. The owner
does not implement or self-verify. Escalate only contract, scope, interface,
authority, or budget changes, or an unresolved blocker. Child tasks execute
only their packet outcome and hand terminal results to the parent owner; they
must not repeat the full goal lifecycle. Only the root owner uses Main's
`next`/action boundary.

Owner lifecycle actions are `metis owner next|claim|ack|heartbeat|abort|child-failure|status <owner-task-id> --lease <owner-lease>`; `ack`, `abort`, `status`, and `child-failure` also carry `--batch <id>` and existing receipts/data flags. Global `maxConcurrent` and per-owner `maxConcurrentChildren` jointly apply; the per-owner default is 4, it may be configured to any positive integer, and the global cap still applies.

The verifier must use a distinct host receipt/agent from the worker. Owner
execution requires `config delegation.ownerExecution.hosts.<host>` to explicitly
set `childSpawning: true` and verified `evidence`; unknown/false defaults block
it. Use `mode: "host-relay"` as the common path when native nested agents are
not available. In host-relay mode the owner prepares a batch but does not spawn
children: it relays only the batch ID to the top-level Main host. Main reads the
prepared descriptors with its controller credentials and uses the existing host
tools to create each child, then records the returned receipts with `schedule
ack`. `metis relay read <batch-id>` only reads a prepared request; it never
spawns a process or agent. The owner retains all subtree decisions, child
monitoring, and completion. Native `host-session` or `nested-agent` delivery
may be used only when the host provides separately verified support; an Agent
tool or Codex feature flag alone is not evidence.

Example opt-in configuration (the default remains disabled):

```json
{
  "delegation": {
    "ownerExecution": {
      "hosts": {
        "codex": {
          "mode": "host-relay",
          "childSpawning": true,
          "evidence": "사용자가 확인한 Codex 최상위 host spawn/receipt 지원"
        },
        "claude": {
          "mode": "host-relay",
          "childSpawning": true,
          "evidence": "사용자가 확인한 Claude 최상위 host spawn/receipt 지원"
        }
      }
    }
  }
}
```

There is no ownerExecution-specific `metis config set` command. Preserve the
existing `.metis/config.json` write/approval path when applying this opt-in; do
not claim that `metis init` or installation proves host support. With the
controller credentials supplied by the top-level Main host, the actual relay
CLI syntax is:

```sh
$METIS relay list --controller-session "$METIS_CONTROLLER_SESSION" --controller-owner "$METIS_CONTROLLER_OWNER" --controller-token "$METIS_CONTROLLER_TOKEN" --controller-fence "$METIS_CONTROLLER_FENCE" --pretty
$METIS relay read <batch-id> --controller-session "$METIS_CONTROLLER_SESSION" --controller-owner "$METIS_CONTROLLER_OWNER" --controller-token "$METIS_CONTROLLER_TOKEN" --controller-fence "$METIS_CONTROLLER_FENCE" --pretty
```

The returned `relay read` batch is input to the active Claude or Codex host
executor. After each real child/session receipt is returned, use the existing
owner or schedule ACK path; never synthesize receipts and never pass controller
credentials to a child.

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

Use parallel fan-out for independent work when the slices are large enough to
repay coordination cost and the host has capacity, such as:

- architecture, tests, and dependency scouts;
- official guidance and established-pattern research;
- non-overlapping implementation slices;
- independent review and verification dimensions.

Do not split work merely to increase parallelism. Follow the runtime's
eligible gate: four dependency-independent, non-overlapping mutable
implementation slices require at least four same-wave worker or integrator
tasks with exclusive paths and distinct acceptance criteria. Below that gate,
keep genuinely atomic or coupled work atomic. Preserve an explicit parallel
requirement and record the evidence-based rationale. Use a synthesis or
integration wave after fan-out when one canonical artifact is required.

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

Use lower-cost routes for bounded execution and mechanical work when the
runtime-selected profile permits it. Use stronger routes only where the
returned profile/action or evidence requires them. A coordinator remains an
owner, not an implementation or verification worker.

Retry only transient failures on the same route.
Escalate reasoning failures.
Return contract and graph failures to task compilation, design, or planning.
