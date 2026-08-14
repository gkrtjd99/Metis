# Architecture

Metis 1.0.0 uses schema version 11, configuration version 6, and runtime layout version 4.

## System purpose

Metis converts one repository objective into a complete subagent workflow.
It keeps Main small and durable.
It moves actual engineering work to fresh, bounded subagents.

```text
Host Main
  |
  | compact state and controller actions
  v
Metis runtime
  |
  +-- Goal Contract and requirements
  +-- lifecycle phase machine
  +-- universal task DAG
  +-- wave scheduler
  +-- Task Packet compiler
  +-- frozen interface contracts
  +-- capability catalog
  +-- SQLite state and object store
  +-- worktree and integration control
  +-- evidence, review, and completion gates
  |
  v
Fresh subagents
  scout, researcher, synthesizer, designer, planner,
  task-compiler, worker, reviewer, verifier, curator
```

Metis is an orchestration boundary.
The host controls process, network, shell, and tool permissions.

## Project attachment boundary

Host adapters self-attach only at an explicit project directory or the
enclosing Git top-level of the current working directory. A non-Git root is
rejected before adapter or runtime mutation. Attachment installs only the
declared host integration, does not start a goal, and does not perform an
unrelated repository scan; an existing runtime may be read to report its
lifecycle route.

The attachment installer is invoked with `force=false`. Existing differing
project-owned host files, configuration, and plugin entries are preserved and
reported. Replacement requires the explicit CLI `--force` path. Lifecycle
inspection is read-only and never performs automatic controller takeover.

The route is `no-run`, `active-live-controller`, `active-expired-controller`,
`paused`, or `completed`. An expired controller can be replaced only through an
explicit, authorized takeover after the previous controller is no longer
active; fencing prevents stale controller writes.

## Responsibility split

### Main

Main performs goal-level control only.

- Interpret the user objective.
- Freeze or amend the Goal Contract.
- Read compact runtime state.
- Execute the next controller action.
- Create the task specs returned by the runtime.
- Spawn the claimed batch.
- Record terminal child results.
- Choose a transition from a completed diagnosis.
- Present real user or authority blockers.

Main does not:

- scan the repository broadly;
- perform external research;
- write design or plan artifacts;
- compile long worker prompts;
- modify implementation code;
- review its own work;
- operate a browser for verification;
- infer child completion from prose.

### Runtime

The runtime performs deterministic control.

- Persist contracts, requirements, artifacts, tasks, and evidence.
- Validate phase transitions.
- Validate milestone and task graphs.
- Freeze interface versions.
- Compile and version Task Packets.
- Select local capabilities.
- Compute runnable waves and batches.
- Enforce ownership, leases, and fencing.
- Prepare and integrate worktrees.
- Track evidence currentness.
- Enforce budgets and progress.
- Build compact Main context.
- Record the journal.

### Subagents

Subagents perform the actual engineering work.

- Scout repository structure.
- Research current external facts.
- Synthesize evidence.
- Design the solution.
- Plan milestones and tasks.
- Compile complex task packets.
- Implement bounded changes.
- Diagnose failures.
- Review integrated changes.
- Verify acceptance criteria.
- Curate documentation.

Each child receives one Task Packet and no Main transcript.

## Persistent phase machine

## Lifecycle profiles and controller drive

The runtime resolves one deterministic lifecycle profile before materializing a
run. `fast` is reserved for explicitly low-risk, local, non-external, isolated
work; `balanced` is the default for ordinary repository work; `full` is used
for high-risk, externally dependent, shared-interface, or otherwise review-
critical work. An unsafe fast request is rejected rather than silently
weakening the gates. The `metis drive` command advances the controller through
the same persisted actions as Main, with a bounded iteration limit for
automation and tests. It never bypasses task, lease, budget, review, or
integration fencing.

For an eligible `fast` run, the controller validates and compiles the complete
canonical graph in one fenced transaction and records a deterministic approval
bound to the exact sealed plan and packet set. It does not spawn a semantic
plan critic for controller-authored canonical records. After implementation,
the independent integration reviewer and verifier consume the same immutable
repository candidate in parallel. The verification candidate, adversarial
completion review, and curation remain later gated steps.

Discovery and current external research may be fused into one read-only
general atomic materialization wave. The wave writes stable task identities and
canonical artifacts, so a replay is idempotent and later phases do not need to
rescan the repository. Mutable implementation and integration remain separate
waves behind the same immutable packet and interface barriers.

## Effort negotiation and attempt provenance

Task effort is progressive (`low -> medium -> high -> xhigh -> max`) and is
negotiated against the selected host/model capability evidence. The scheduler
records both requested and effective effort, the source of the capability
decision, the supported-effort evidence, and whether capability is known or
unknown. No host receives a default worker model. Model-neutral routes retain
the requested policy value as deferred state, and host adapters render a
provider-specific effort flag only after concrete model capability evidence is
available at the spawn boundary.

Every claim creates an append-only attempt record. A retry therefore creates a
new fenced attempt rather than overwriting history. Attempt records retain host,
role, model, requested/effective effort, batch, lease, failure class, and token
usage references. Transient retries are counted separately; contract,
dependency, plan, and external failures require diagnosis or an explicit route.

## Performance evidence

The runtime records durable repository-sync and worktree lifecycle events,
packet budget warnings, and scheduler/attempt timings. `metis performance
report` summarizes verified completion time, concurrency and slot utilization,
phase durations, critical-path approximation, repository-sync cache hit rate,
and requested/effective effort counts without placing raw worker output in
Main. Benchmark reports use verified-only median and nearest-rank P95 and keep
scenario, variant, pass-rate, and failure evidence separate. The benchmark
suite is opt-in for repository execution and must compare baseline, candidate,
and plain-host controls before claiming a performance threshold.

The runtime uses ten phases:

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

Optional work is waived inside the same phase machine.
The runtime does not create alternative phase models.

A backward transition uses `reopen`.
The runtime invalidates downstream state.

## Universal task graph

Metis 1.0.0 uses tasks for the complete lifecycle.
Implementation is not a special scheduling system.

Task kinds:

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

Each task records:

- role;
- task kind;
- phase;
- wave;
- milestone;
- parent coordinator;
- dependencies;
- scope and non-goals;
- mutable paths or read-only state;
- requirements;
- acceptance criteria;
- required evidence;
- expected outputs;
- risk, effort, and slice type;
- verification modes;
- capabilities;
- interface inputs and outputs;
- selected context references;
- authority and stop conditions;
- model route and attempt state;
- Task Packet state.

## Wave scheduler

A wave is an explicit parallel boundary.
The scheduler selects the earliest open wave in the current phase.

```text
phase tasks
  -> completed dependencies
  -> current Task Packet
  -> frozen interfaces
  -> earliest open wave
  -> path and lease conflicts
  -> thread and spawn budget
  -> deterministic score
  -> atomic batch claim
```

The score uses priority, critical path, role, complexity, risk, and escalation.
The scheduler persists selected and deferred tasks.

A task in wave 2 cannot depend on a task in wave 3 of the same phase.
Two concurrent mutable tasks cannot own overlapping paths.

## Discovery and research fan-out

Discovery begins with independent scout questions.
Typical questions cover architecture, tests, dependencies, conventions, and similar local code.

Research begins with independent external questions.
Typical questions cover official APIs, version constraints, and established patterns.

Scout and researcher outputs use structured fields.
They include facts, sources, paths, interfaces, risks, recommendations, and unknowns.

A synthesizer consumes only the completed child results.
It produces the canonical phase artifact.
It does not perform new inspection or research.

This split keeps Main context small.
It also keeps source evidence separate from synthesis judgment.

## Predesign overlap boundary

Predesign scheduling uses a bounded, read-only fan-out. With
`orchestration.lifecycleOverlap.predesign = true`, the controller emits three
scouts and two goal-contract-only researchers in `discover` wave 1. The
scheduler admits as many as the current `maxConcurrent` capacity allows and
keeps the remaining descriptors deferred in the same wave.

After wave 1 reaches terminal state, the controller emits two wave-2
synthesizers. Discovery synthesis depends only on the three scouts; research
synthesis depends only on the two researchers. The scheduler claims each batch
atomically, and the host submits every returned descriptor before waiting.

This overlap is deliberately limited to independent read-only work and its
synthesis. It does not overlap any mutable or committing phase. The design,
plan, review, verification candidate, and curation remain behind their gates.
In particular:

- sealing must operate on one immutable subject and commit through a single revision/CAS barrier;
- review and reconciliation must bind to one repository/artifact fingerprint and cannot approve a stale read;
- verification must build one immutable candidate before read-only checks fan out;
- curation and source synchronization must reject changed inputs and serialize their durable writes;
- plan invalidation must fence downstream attempts and packets before new work is admitted;
- budget reservation, controller fencing, lease heartbeat, and coordinator ancestry must be checked atomically at dispatch and completion.

The blockers for broader phase overlap are concrete races, not just ordering preferences:

| Area | Adversarial interleaving | Required blocker/fence |
| --- | --- | --- |
| Sealing | Two actors read one draft, both seal or revise it, and the later write changes the subject after a review has started. | Immutable subject revision plus one serialized CAS seal. |
| Review | A reviewer approves fingerprint A while a source or integration write produces fingerprint B; the approval then clears findings for the wrong repository. | Review fingerprint and currentness check at reconcile/commit. |
| Verify | Checks read different artifact versions, or a candidate is replaced while verifiers still report against the old candidate. | Build one immutable candidate first; fan out read-only checks against that candidate only. |
| Curate | Curation writes knowledge while verification or another curator reads the previous state, producing completion from mixed evidence. | Current evidence fence and serialized curation commit. |
| Source mutation | Repository sync or source edits interleave with packet compilation and artifact reads, so execution observes mixed repository state. | Task repository baseline plus source-invalidation fence; reject stale mutable integration. |
| Plan invalidation | Reopen marks downstream work stale after the scheduler has claimed it; the old child later advances the new plan. | Invalidate packets and attempts before admission; reject stale completion. |
| Budget | Concurrent workers pass a separate budget check and consume the same remaining allowance; retries or duplicate acknowledgements spend it again. | Atomic reservation ledger keyed by idempotency key. |
| Controller fencing | A superseded controller acknowledges a batch or heartbeats a lease after losing leadership. | Validate the current controller fence on every mutating command, ack, and heartbeat. |
| Coordinator ancestry | A child coordinator's immediate parent is live while an older ancestor run has been reopened or superseded. | Validate the full ancestor attempt chain, or prohibit nested coordinator fan-out. |

These races are blockers for overlapping commit-capable lifecycle phases. The safe design is therefore: parallelize independent read-only work against one frozen subject; cross a single serialized reconcile/commit barrier; then admit the next phase only after all hard gates and fences pass.

Every child consumes a packet basis consisting of its task blueprint, frozen interface and dependency inputs, the run contract version, and exact upstream artifact identities and content references. A mutation of that basis invalidates the packet. Repository source mutation is fenced separately through task baselines and source-invalidation paths. The scheduler fails closed, rebinds/recompiles, and creates a new attempt fence before retrying. Stable generated task IDs make repeated controller actions idempotent, so replay cannot duplicate work or spend budget twice.

## Design and plan production

A designer subagent consumes discovery and research artifacts.
It produces the technical design.
UI work can also produce:

```text
experience-contract
visual-contract
browser-acceptance
```

The runtime seals the design.
A fresh design critic reviews the exact seal.

A planner subagent consumes the approved design.
It returns a typed `PlanDraft`:

```json
{
  "interfaces": [],
  "milestones": [],
  "tasks": []
}
```

The runtime ingests this draft in one transaction. A failed interface, milestone, or task validation rolls back the complete materialization.
It creates interface contracts, milestones, dependencies, waves, capabilities, and task blueprints.
It rejects missing IDs, unknown dependencies, cycles, and invalid parents.

## Frozen interface contracts

An interface contract is a versioned runtime object.
It has a name, description, schema, requirement links, content hash, and status.

Status values:

```text
draft
frozen
superseded
```

Only a frozen interface can bind to a task.
A task binds an interface as input or output.
An output link can explicitly allow a new version.

A new frozen version supersedes the previous frozen version.
It marks linked Task Packets stale.
The plan must rebind affected tasks.

A completed child attests every consumed and produced interface with its exact ID or name and frozen content hash.
The runtime rejects missing, undeclared, or stale interface reports before integration.

This rule prevents parallel workers from inventing incompatible boundaries.

## Task Packet pipeline

The structured task blueprint is the source of truth.
The rendered prompt is a projection.

```text
task blueprint
  + role protocol
  + frozen interfaces
  + upstream contracts
  + resolved artifact context
  + selected capabilities
  + result schema
        |
        v
deterministic packet assembly
        |
        +-- ordinary task: ready
        |
        +-- complex task: task-compiler overlay
                          |
                          v
                     ready packet
```

The packet contains:

- role protocol;
- objective and rationale;
- owned scope;
- non-goals and constraints;
- frozen interfaces;
- upstream contracts;
- selected context;
- capability procedures;
- execution steps;
- acceptance criteria;
- verification plan;
- expected outputs;
- authority;
- stop conditions;
- result schema.

The runtime stores each packet as a versioned database row and an encrypted object.
The blueprint hash detects stale packets.

### Deterministic compilation

Ordinary tasks use deterministic assembly.
Templates supply role rules, stop conditions, and result schema.
The blueprint supplies task-specific values.

### LLM compilation

Complex, high-risk, critical, or large execution tasks use a task-compiler subagent.
The compiler receives the target blueprint and selected evidence.
It returns an overlay.

Allowed overlay fields:

```text
ClarifiedObjective
ExecutionSteps
ContextPriorities
InterfaceNotes
VerificationPlan
AdditionalStopConditions
HandoffNotes
Ambiguities
```

The compiler cannot set protected fields.
The runtime rejects any protected key.
A non-empty ambiguity list blocks the target task.

## Context model

Main context is a semantic projection over runtime state.
It includes the Goal Contract, requirements, phase, next action, blockers, task wave summary, traceability, governance, and budget.

It does not include full Task Packets.
It does not include child transcripts.

A child context contains:

- its current Task Packet;
- current upstream structured results;
- runtime workspace and lease data;
- artifact references or bounded resolved artifact content.

When the host contract clips packet text, it retains the packet object reference.
The child can load the complete object.

## Capability catalog

Capabilities are local curated procedures.
They are not roles.

Built-in capabilities:

```text
frontend-ui
browser-testing
visual-review
security
database
migration
performance
accessibility
```

Each built-in capability is an internal document at
`skills/metis/capabilities/<capability>/CAPABILITY.md`; the containing skill
tree has only its root `SKILL.md` entrypoint.

The resolver uses explicit selections and deterministic repository signals.
The selected internal `CAPABILITY.md` procedures become packet content.

External research does not modify the capability catalog during a run.
Current API or framework facts remain run-specific evidence.

## Child result contract

A child returns structured data.
The base result contains:

```text
Status
Summary
Files
AcceptanceResults
InterfaceReport
Checks
ProducedArtifacts
EvidenceRefs
Blockers
```

Role-specific results add fields.
Examples:

- scouts add facts, paths, interfaces, risks, and unknowns;
- researchers add sources, findings, constraints, and recommendations;
- synthesizers add an artifact kind and content;
- planners add a `PlanDraft`;
- task compilers add a target task ID and packet overlay;
- diagnosticians add a structured diagnosis;
- reviewers add verdict and findings.

The runtime validates the result before it changes task state.
Large results move to the object store.
Main receives only compact fields and references.

## Failure diagnosis

A failed task becomes blocked when diagnosis-first recovery is enabled.
The controller creates a diagnostician task.

The diagnosis records:

- failure class;
- earliest invalid state;
- evidence;
- one recommended action.

Main then selects one runtime transition.
It does not retry blindly.

## Review and repair

Review tasks bind to an exact repository fingerprint.
They run after integration.

Review stages can include:

- task specification review for high-risk work;
- general integration review;
- conditional specialist review;
- visual and accessibility review;
- adversarial completion review.

Blocking findings become repair tasks.
A repair changes the repository fingerprint.
The runtime requires fresh review.

## Verification

Verification combines deterministic and semantic evidence.

- Checks use structured executable and argument arrays.
- A check fails if it mutates protected repository state.
- Verifier tasks prove semantic acceptance criteria.
- Browser verifiers prove user flows and visual states.
- The verification candidate binds all current evidence to one code fingerprint.
- The adversarial reviewer attacks that candidate.

## Control-plane concurrency

The runtime uses:

- one live run controller;
- controller fencing tokens;
- task attempt fencing tokens;
- SQLite transactions for graph and batch transitions;
- task leases and heartbeat;
- required Git worktrees for mutable tasks;
- exclusive path ownership;
- serialized integration;
- a durable write-ahead integration journal held through the terminal SQLite commit, with startup rollback for interrupted attempts.

These mechanisms control orchestration and repository integration.
They do not replace host permission controls.

## Persistence

SQLite is the canonical state store.
Important runtime tables include:

```text
runs
controller_sessions
goal_contracts
requirements
milestones
tasks
task_dependencies
interface_contracts
task_interface_links
capabilities
task_capabilities
task_packets
leases
worktrees
artifacts
checks
review_findings
scheduler_batches
task_spawn_acks
budget_state
progress_samples
context_snapshots
journal
```

Runtime layout:

```text
.metis/
  layout.json
  config.json
  state/state.db
  objects/
  generated/
  cache/
  logs/
  tmp/
  worktrees/
  benchmarks/
  backups/
```

## Version boundary

Version 1.0.0 rejects incompatible schema and configuration versions.
New projects create runtime state with the canonical versions above.
