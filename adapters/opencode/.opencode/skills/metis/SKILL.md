---
name: metis
description: Explicitly opt into the Metis subagent-first engineering workflow for a native goal. Use only when the user writes $metis, normally as /goal $metis with a quoted objective. Do not invoke it for ordinary requests or native goals without $metis.
metadata:
  short-description: Orchestrate one repository goal through fresh subagents
---

# Metis

`/goal` keeps the host goal active.
`$metis` transfers the engineering lifecycle to Metis.

Activate this skill only for the literal `$metis` marker.
Continue until the runtime returns `COMPLETE` or a recorded user, authority, budget, or unrecoverable blocker.
A plan, child result, review, or passing test is not completion.

## Product boundary

Metis is an orchestration boundary.
It controls lifecycle state, task graphs, Task Packets, ownership, integration, evidence, and completion gates.
The host controls process, network, shell, and tool permissions.

Read [operations.md](references/operations.md) for cleanup, recovery, and runtime commands.

## Main is an orchestrator

Main keeps goal-level state only.
Main can:

- interpret and freeze the Goal Contract;
- read compact runtime state;
- execute the next controller action;
- create the exact task specs returned by the runtime;
- claim and spawn the current task wave;
- submit terminal child results;
- select a route from completed diagnosis;
- present real user or authority blockers.

Main must not:

- inspect the repository broadly;
- perform external research;
- write discovery, design, or plan artifacts;
- write long worker prompts;
- implement or repair code;
- review its own result;
- operate a browser for verification;
- treat child prose as durable state.

### Terminal child handoff (Codex host) The spawn descriptor carries a task-scoped result file and lease-fenced handoff command. The child must write only the packet-schema JSON to that exact file, then execute the command with `--file`; never interpolate result JSON into a shell command. This is the durable completion and is fenced by the lease. Never pass raw transcripts or worker output into Main. Main must first inspect durable task state and must not submit a duplicate finish for an already-terminal task. For hosts without an executable handoff descriptor, write the bounded packet-schema JSON to a task-scoped file and run `$METIS task finish <task-id> --lease <lease-token> --file <result-file> --pretty`.
Run `$METIS next --pretty` in a bounded loop, executing returned Main actions, especially `$METIS plan ingest <planner-task-id> --pretty` for `INGEST_PLAN_DRAFT`, before `$METIS drive --max-iterations N` (drive cannot replace Main actions). Heartbeat while waiting; a terminal result always triggers the finish -> next -> required-action handoff.

Fresh subagents perform discovery, research, synthesis, design, planning, task compilation, implementation, diagnosis, review, verification, and curation.

## Runtime launcher

Run from the repository root.
Resolve this skill directory from the loaded `SKILL.md` path.
Set `METIS` to:

```sh
node --no-warnings <skill-directory>/scripts/metis.mjs
```

A project installation can replace this with its local launcher.

## Profiles, effort, and performance

The runtime chooses `fast`, `balanced`, or `full` deterministically from the
Goal Contract and risk evidence. Unsafe fast work is rejected. Use
`$METIS drive --max-iterations N` only for bounded controller advancement; it
does not bypass Main ownership, task, budget, review, or integration fences.
For a trivial single-behavior goal, keep the Goal Contract structurally exact:
put only repository-relative paths in `scope`, keep the single functional must
as the sole requirement, and record path boundaries plus test commands in
constraints and success criteria instead of inventing extra requirements.

Task effort progresses from `low` through `medium`, `high`, `xhigh`, and `max`,
then is negotiated against host/model capability evidence. The host adapter
renders provider-specific spawn flags. Every claim creates append-only attempt
provenance with requested/effective effort and capability evidence. Transient
failures may retry; contract, dependency, plan, and external failures require
diagnosis or an explicit route.

Use `$METIS performance report --pretty` for verified completion, phase,
concurrency, slot-utilization, cache, and effort evidence. Benchmark reports
must keep baseline, candidate, and plain-host variants, use verified-only
median/nearest-rank P95, and retain failure/pass-rate counts separately.

## Start and controller ownership

1. Extract the exact objective after `$metis`.
2. Resolve the launcher, and confirm global/plugin command availability; this prerequisite must hold before continuing.
3. Self-attach by running `$METIS attach --host codex`, `$METIS attach --host claude`, or `$METIS attach --host opencode` according to the active host, with force false and only an explicit root or the enclosing Git root.
4. Inspect the returned lifecycle (or run `$METIS lifecycle --pretty`) before doctor or start, and route it as follows:
   - `no-run`: run `$METIS doctor --pretty`, then start the objective.
   - `paused`: resume the existing run, then continue.
   - `completed`: start a new run for the new objective.
   - `active-live-controller`: refuse a second Main and leave the current owner in place.
   - `active-expired-controller`: require explicit authority and a safe takeover; never take over automatically.
5. Preserve the returned controller credentials.
6. Supply them to every state-changing command.
7. Run `$METIS next --pretty`.
8. Execute the returned action exactly.
9. Persist child results and evidence through `metis`.
10. Repeat from step 7.

Do not scan unrelated repository content during attachment or routing.

Controller credentials use:

```text
METIS_CONTROLLER_SESSION
METIS_CONTROLLER_OWNER
METIS_CONTROLLER_FENCE
METIS_CONTROLLER_TOKEN
```

Do not attach a second Main to a live run.
Renew controller ownership at the interval returned by the runtime.
Use takeover only after the previous Main is inactive.

## Durable-state rule

The runtime is the source of truth.
Conversation history is not the source of truth.
Do not bypass phase gates.
Do not edit SQLite directly.
Do not keep raw source, patches, logs, screenshots, or child transcripts in Main context.
Store large material as typed evidence, artifacts, or runtime objects.

Inspect state with:

```sh
$METIS status --context --pretty
$METIS journal replay --pretty
```

## Goal Contract

Freeze one Goal Contract during intake.
It must contain:

- objective;
- scope;
- non-goals;
- constraints;
- measurable success criteria;
- complexity and lifecycle route;
- atomic requirements with acceptance criteria.

Use:

```sh
$METIS contract freeze --data '<json>' --pretty
```

Do not silently change the contract.
Use `contract amend` with a reason.
A material amendment needs user approval and invalidates dependent state.

Read [contracts.md](references/contracts.md) for traceability.
Read [approval.md](references/approval.md) for authority boundaries.

## Universal task graph

Use runtime tasks for the complete lifecycle:

```text
discovery
research
synthesis
design
planning
compilation
implementation
integration
diagnosis
repair
review
verification
curation
```

Every task has one independently verifiable outcome.
It also has a role, phase, wave, dependencies, scope, interfaces, acceptance criteria, evidence, authority, stop conditions, and result schema.

A wave is a parallel boundary.
The scheduler dispatches only the earliest open wave.
Do not start a later wave until every task in the earlier wave is terminal.

Read [lifecycle.md](references/lifecycle.md) for phase rules.
Read [delegation.md](references/delegation.md) for scheduling rules.

## Discovery and research

Main does not inspect or browse.

For discovery:

1. Create the independent scout task specs returned by `metis next`.
2. Claim and dispatch them in one wave.
3. Wait for terminal structured results.
4. Create the requested synthesizer task.
5. Let the synthesizer produce the canonical discovery artifact.

For research:

1. Create bounded researcher questions.
2. Separate official technical facts from established workflow patterns.
3. Dispatch independent questions in parallel.
4. Let a synthesizer produce the canonical research artifact.

A synthesizer can use only supplied child evidence.
It must not perform new inspection or research.

Capability procedure and current research are different:

```text
capability = how to perform this class of work
research evidence = what is currently true for this goal
```

Do not search the web for a new skill on every task.

## Design

Dispatch a designer subagent.
The designer consumes current discovery and research artifacts.
It must choose the simplest complete design and define shared interfaces before parallel implementation.

UI work can require:

```text
experience-contract
visual-contract
browser-acceptance
```

The visual contract must use existing repository conventions.
The browser contract must define executable user flows and assertions.

Seal the design and dispatch an independent `design-critic` against the exact seal.
Main must not rewrite the critic result.

## Planning and PlanDraft

Dispatch a planner subagent after the design is approved.
The planner returns a typed `PlanDraft`.
It does not write child prompts.

The draft defines:

- frozen interface candidates;
- milestones with observable outcomes and exit criteria;
- tasks with kinds and waves;
- dependencies and parents;
- scope and mutable paths;
- interface inputs and outputs;
- acceptance criteria and evidence;
- risk, effort, and slice type;
- verification modes and capabilities.

After the planner completes, execute this action standalone: `$METIS plan ingest
<planner-task-id> --pretty`. Capture exit/result first; never chain with `next` or
`jq`. On success run `$METIS next --pretty` alone; its generic `Sealed plan is
missing` future gate is not an ingest error. On error preserve the typed error,
run standalone `next` only to rediscover the action; execute only that action; never diagnose/materialize unless it explicitly returns a diagnosis action.

The runtime validates IDs, dependencies, cycles, interfaces, waves, and task boundaries.
It then creates deterministic Task Packets and any required compiler tasks.

Seal the graph only after all required Task Packets are ready.
Dispatch an independent `plan-critic` against the sealed plan.

## Task Packets

Never send a one-line instruction such as “implement this and test it.”
Every child receives one compiled Task Packet and no Main transcript.

A packet includes:

- role protocol;
- objective and rationale;
- owned scope and non-goals;
- frozen interfaces;
- upstream contracts;
- selected context;
- selected capability procedures;
- execution steps;
- acceptance criteria;
- verification plan;
- authority boundary;
- stop conditions;
- structured result schema.

Inspect a packet with:

```sh
$METIS task packet status <task-id> --pretty
$METIS task contract <task-id> --pretty
```

If the compact host contract contains a packet object reference, load the full object before execution.

### Task compiler

Ordinary tasks use deterministic packet assembly.
Complex, high-risk, critical, or large execution tasks can require a fresh `task-compiler` subagent.

The compiler can improve:

- objective clarity;
- execution order;
- context priority;
- interface notes;
- verification detail;
- additional stop conditions;
- handoff notes.

The compiler cannot change:

- scope or mutable paths;
- authority;
- dependencies;
- acceptance criteria;
- frozen interfaces.

If the compiler reports ambiguity, block the target task.
Return to design or planning.
Do not ask the worker to guess.

## Frozen interfaces

Parallel workers must not invent shared boundaries.
Bind tasks only to frozen interface contracts.
Require every completed child to attest each consumed and produced interface with its exact frozen content hash.

Interfaces can define:

- function or module signatures;
- HTTP request and response forms;
- events or messages;
- database records;
- UI state contracts;
- files exchanged between tasks.

A new frozen version makes linked packets stale.
Rebind and recompile before dispatch.
A worker can report an interface conflict but cannot silently change the contract.

## Capabilities

A role defines responsibility.
A capability defines a focused procedure.
A tool performs an action.

```text
role + selected capabilities + task blueprint -> Task Packet
```

Use only local capabilities selected by the runtime.
Do not load every available skill.
Do not create a fixed specialist role for every framework.

Current dependency facts belong in researcher evidence.
Useful external workflow patterns must be curated into the local capability catalog outside the active task.

## Claim and spawn a wave

Preview when useful:

```sh
$METIS schedule propose --pretty
```

Claim the current atomic batch:

```sh
$METIS schedule claim --owner metis-main --pretty
```

Treat a claimed multi-item batch as one concurrent host fan-out. Spawn only the
returned descriptors, and submit spawn calls for every available descriptor
before any wait. Never alternate spawn and wait per child.
Use the exact role, model, reasoning effort, workspace, lease, and bounded contract.
Use `fork_turns: "none"` for Codex children.
Respect the host's actual child-slot capacity; Main may occupy one total thread.
Do not pretend rejected or unavailable spawns ran: explicitly abort or recover
each rejected or unavailable descriptor.

Acknowledge only after the host spawn tool returns a nonempty child/session/agent receipt for every descriptor, bound to its exact task and lease attempt:

```sh
$METIS schedule ack <batch-id> --tasks <id1,id2> --receipts '{"<id1>":{"receipt":"<host-receipt-1>","batchId":"<batch-id>","taskId":"<id1>","attemptFence":1},"<id2>":{"receipt":"<host-receipt-2>","batchId":"<batch-id>","taskId":"<id2>","attemptFence":1}}' --owner metis-main --pretty
```

A claim does not consume spawn budget. The spawn acknowledgement consumes it once
and persists only returned receipt identifiers, never raw child output. If a host
spawn is rejected or returns no receipt, do not acknowledge it; abort or recover
the unspawned descriptor explicitly.
Heartbeat active batches:

```sh
$METIS schedule heartbeat <batch-id> --pretty
```

This renews controller and task leases.
Wait in bounded intervals until every child result is terminal.

## Worktrees and results

Every mutable attempt uses a detached Git worktree.
There is no shared workspace fallback.

A child can change only its owned paths.
It must report every changed file.
It cannot cross symbolic links outside the repository.
It cannot finish a newer fenced attempt.

A terminal result must follow the packet result schema.
It must report acceptance results, interface use, checks, artifacts, evidence, blockers, and changed files.
A statement such as “done” is not a result.

## Diagnosis and repair

Do not retry a failed or blocked task immediately.
When requested, dispatch a fresh `diagnostician`.

The diagnostician identifies the earliest invalid state and recommends one route:

```text
retry
change reasoning route
revise contract
add dependency
reconcile integration
reopen plan or design
request external authority
```

Main selects one route from the completed diagnosis.
Main does not perform the repair.
A repair becomes a new bounded task.

## Review and verification

Review the integrated repository with fresh reviewer tasks.
Use only the specialist capabilities selected by current requirements, paths, interfaces, and risks.
Blocking findings become repair tasks.
After repair, run fresh review against the new fingerprint.

Verification can include:

- structured deterministic checks;
- semantic verifier tasks;
- browser verifier tasks;
- conditional human checkpoints;
- an immutable verification candidate;
- `adversarial-reviewer` completion review.

Main must not operate the browser or judge screenshots.
A browser verifier records assertions, viewport, screenshots, console errors, network failures, and code fingerprint as browser evidence.

## Curate and complete

Dispatch a curator for human documentation changes.
Run generated index and knowledge synchronization after current code is verified.

Completion requires current runtime state:

- requirements traced;
- required tasks terminal;
- interfaces current;
- checks current;
- reviews current;
- browser evidence current when required;
- checkpoints resolved;
- verification candidate current;
- adversarial completion review current when required;
- documentation and knowledge current;
- no blocking risk, budget, or progress state.

Run self-evaluation before completion.
Read [curation.md](references/curation.md).

## Stop states

Return to the user only for:

- `COMPLETE`;
- `USER_OR_AUTHORITY_REQUIRED`;
- `BUDGET_DECISION_REQUIRED`;
- an unrecoverable recorded blocker.

For `STALLED_REPLAN`, change the evidence search, design, task boundary, capability route, or model route.
Do not repeat the same action.

Read [recovery.md](references/recovery.md) and [token-policy.md](references/token-policy.md) when those gates activate.
