# Operations

Metis 1.0.0 runs one managed repository objective through a subagent-first lifecycle.
Main remains the controller.
Fresh subagents perform repository inspection, research, design, planning, implementation, review, verification, diagnosis, and curation.

## Install

From a packaged archive:

```sh
npm install -g ./metis-orchestrator-1.0.0.tgz
```

Install one or all host adapters from the repository root:

```sh
metis init --host codex
metis init --host claude
metis init --host opencode
metis init --host all

metis doctor --pretty
```

The plugin remains passive until the user writes the literal `$metis` marker.

Before starting a goal, the host must expose the globally installed Metis
plugin/command surface: `/metis` must resolve and `/goal $metis "<objective>"`
must be recognized. Project initialization does not supply a missing global/plugin
capability. Install or enable the plugin first and confirm it with
`metis doctor --pretty`.

## Initialize your first project

Create a Git repository for the project, then initialize Metis at its root. Use
an explicit project path when initializing from another directory:

```sh
git init /absolute/project
metis init --host codex --root /absolute/project
```

From the project root, use:

```sh
metis init --host codex
```

The equivalent programmatic entry point is:

```js
import { init } from "metis-orchestrator";

await init({ host: "codex", root: "/absolute/project" });
```

The programmatic `init()` facade installs and configures the selected host
integration at the explicit or enclosing Git root. It does not start a goal or
perform an unrelated repository scan. A non-Git root is rejected before host or
runtime mutation. Start a managed goal separately by writing `$metis` in the
host.

Use `metis lifecycle --root /absolute/project --pretty` to read the project
route without creating runtime state or changing controller ownership. Routes
are `no-run`, `active-live-controller`, `active-expired-controller`, `paused`,
and `completed`. An expired controller requires an explicit takeover; Metis
never performs automatic takeover.

## Start one managed goal

```text
/goal $metis "<objective>"
```

The host Main follows the action returned by:

```sh
metis next --pretty
```

Main must not replace a requested subagent action with its own repository inspection, web research, code edit, review, or browser operation.
It creates the declared task specs, claims the current wave, spawns the returned descriptors, and records terminal results.

Before task materialization, the controller resolves a lifecycle profile:
`fast` (only explicitly low-risk, local, isolated work), `balanced` (the
default), or `full` (high-risk, external, shared-interface, or review-critical
work). Unsafe `fast` requests are rejected. `metis drive --max-iterations N`
can execute bounded controller actions for automation; it uses the same
fences, task contracts, budgets, and serialized integration as Main.

## Controller ownership

`metis start` returns one controller session for the active run.
Preserve these values:

```text
METIS_CONTROLLER_SESSION
METIS_CONTROLLER_OWNER
METIS_CONTROLLER_FENCE
METIS_CONTROLLER_TOKEN
```

Inspect and renew ownership:

```sh
metis controller status --pretty
metis controller heartbeat --pretty
```

Do not attach a second Main to a live controller.
Use takeover only after the previous controller is no longer active:

```sh
metis controller takeover --force --yes --pretty
```

A controller fence prevents an older Main from changing the current run.

## Compact Main context

Inspect the current goal-level projection:

```sh
metis status --context --pretty
metis context --pretty
```

Main context contains the Goal Contract, current phase, blockers, requirements, wave summary, next action, budget, and governance state.
It does not contain complete Task Packets or child transcripts.

Raw source, long logs, patches, screenshots, check output, and detailed child results remain in runtime objects and artifacts.

## Subagent lifecycle

The runtime uses tasks for every phase:

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

Discovery and research normally start with a parallel fan-out.
A synthesizer then creates the canonical phase artifact from completed child evidence.
Designer and planner tasks create design and plan output.
Main does not author those artifacts.

The planner must return a typed `PlanDraft`.
After the planner completes, ingest it with the command returned by the controller:

```sh
metis plan ingest <planner-task-id> --pretty
```

The runtime validates and atomically materializes the complete draft. A failed interface, milestone, or task validation leaves no partial graph. It materializes:

- frozen interface contracts;
- milestones;
- task dependencies;
- waves;
- capability selections;
- deterministic Task Packets;
- task-compiler tasks when required.

The default discovery route may materialize scouts and goal-contract-only
researchers in one read-only general atomic wave, then create stable discovery
and research synthesis tasks. Replaying the controller action is idempotent;
it does not duplicate tasks or consume budget twice.

No model setup is required before starting a goal. Main and spawned subagents
inherit the host-selected models by default. Use `$metis:model` only when the
project needs explicit model or effort routing: choose Main through the host's
native selector and let the skill configure spawned subagents. The same skill
can show or reset the saved selection. Configure overrides before a run, not
during an active goal.

Effort is progressive (`low`, `medium`, `high`, `xhigh`, `max`) and negotiated
against runtime host/model capability evidence. Spawn descriptors are rendered
by the host adapter (for example Codex `reasoning_effort` or Claude
`--effort`), while core task contracts remain host-neutral. The default config
does not select a worker model for any host. A concrete model comes from the
host or from an explicit project/task route. Inspect the task attempt history
when diagnosing a route:

```sh
metis task attempts <task-id> --pretty
```

Each claim creates an append-only attempt with requested/effective effort,
capability evidence, host/model/role, batch and lease fences, failure class,
and token references. Only transient failures may retry automatically;
contract, dependency, plan, and external failures go through diagnosis or an
explicit route.

## Task Packets

Every child receives a compiled Task Packet.
A packet contains its role protocol, objective, scope, interfaces, selected context, capability procedures, acceptance criteria, verification plan, stop conditions, and result schema.

Inspect packet state:

```sh
metis task packet list --pretty
metis task packet status <task-id> --pretty
metis task packet get <task-id> --pretty
metis task contract <task-id> --pretty
```

Ordinary tasks use deterministic packet assembly.
Complex, high-risk, critical, or large execution tasks can receive a separate `task-compiler` task.
The compiler may improve wording, order, context priority, verification detail, and stop conditions.
It cannot change scope, authority, dependencies, acceptance criteria, or frozen interfaces.

A packet with unresolved ambiguity is not runnable.
Resolve the design or plan problem instead of asking the worker to guess.

## Interface contracts

Parallel work must consume explicit shared boundaries.
Create and freeze an interface contract before binding it to tasks:

```sh
metis interface add --data '<json>' --pretty
metis interface freeze <interface-id> --pretty
metis interface list --pretty
```

A new frozen version supersedes the old version and makes linked packets stale.
Rebind and recompile affected tasks before dispatch.

## Capability procedures

Capabilities are local curated procedures.
They are not discovered from the web during each task.

Inspect selection:

```sh
metis capability list --pretty
metis capability explain <task-id> --pretty
```

Current technical facts for an unfamiliar dependency belong in a researcher task.
They become run-specific evidence.
They do not become a permanent capability automatically.

## Wave scheduling

The scheduler dispatches only the earliest open wave in the current phase.
It does not dispatch a later wave while any task in the earlier wave is pending, running, blocked, or failed.
It also checks dependencies, packet readiness, frozen interfaces, path ownership, leases, thread capacity, and budgets.

Preview a batch:

```sh
metis schedule propose --pretty
```

Claim one atomic batch:

```sh
metis schedule claim --owner metis-main --pretty
```

Spawn only the returned descriptors.
After the host spawn tool returns a nonempty receipt for each accepted task,
acknowledge those exact task-to-receipt bindings:

```sh
metis schedule ack <batch-id> --tasks <id1,id2> --receipts '{"<id1>":{"receipt":"<host-receipt-1>","batchId":"<batch-id>","taskId":"<id1>","attemptFence":1},"<id2>":{"receipt":"<host-receipt-2>","batchId":"<batch-id>","taskId":"<id2>","attemptFence":1}}' --owner metis-main --pretty
```

A claim does not consume spawn budget.
Spawn acknowledgement consumes it once.
Abort a batch that the host cannot spawn:

```sh
metis schedule abort <batch-id> "<reason>" --pretty
```

Renew controller and task leases while children run:

```sh
metis schedule heartbeat <batch-id> --pretty
```

Claimed batches remain in preparation and must not be spawned or acknowledged
until they become `prepared`. Heartbeat renews only receipt-backed task
leases. When a claimed or prepared batch has a missing host receipt, its
watchdog `updated_at` is left unchanged so the controller can issue bounded
recovery after the lease timeout. Execute that controller-issued abort with
its expected status, timestamp, and controller fence; stale observations must
not be replaced by an unfenced abort.

Wait only for terminal child results.
Do not treat a progress message as completion.

## Predesign overlap policy

The production default is `orchestration.lifecycleOverlap.predesign = true`:

```text
discover wave 1: three scouts + two goal-contract-only researchers
discover wave 2: discovery synthesis + research synthesis
```

The two synthesizers have disjoint dependencies: discovery synthesis consumes only the three terminal scout results, and research synthesis consumes only the two terminal researcher results. Both produce canonical verified artifacts while the run is still in `discover`. After discovery advances, the populated research artifact allows the `research` phase to advance without creating researcher or synthesis work.

This policy does not precompute design, planning, review, verification, or
curation. With `maxConcurrent = 4`, four first-wave descriptors are claimed and
one remains deferred until a slot opens. With `maxConcurrent = 8`, all five are
claimed in one atomic batch. The host must submit every returned descriptor
before waiting for any child.

The following hard gates are retained in either lane:

- the controller fence and current task-attempt fence;
- frozen interfaces, packet readiness, dependencies, exact upstream artifact identities, and the run contract version;
- complete discovery and research artifacts before downstream design input;
- deterministic checks, independent review, verification candidate, and curation;
- budget/progress limits, leases, and serialized mutable integration.

Each packet is based on an immutable task blueprint plus frozen interface and dependency inputs, the run contract version, and exact upstream artifact identities and content references. If any packet basis changes, the packet is stale. Do not dispatch or accept the stale result: rebind/recompile against the new basis, create a new attempt/fence, and retry through the normal diagnosis path. Source mutation is fenced separately by task repository baselines and source-invalidation paths. A controller retry must also be idempotent by wave and task identity; duplicate spawn/ack actions cannot create extra work or consume budget twice.

Do not overlap sealing, review, verification-candidate creation, curation, source synchronization, plan invalidation, or mutable integration merely because their reads appear independent. Those operations can race with each other and must pass through a serialized commit/reconcile barrier under the current controller and ancestor fences. Read-only verification subchecks may fan out only against one frozen candidate and source fence.

The runtime records journal, progress, budget, and evidence state for each
claimed and acknowledged attempt.

## Mutable work

Each mutable task uses a detached Git worktree.
There is no shared mutable workspace fallback.

A task owns only its declared paths.
The runtime rejects:

- changed files outside the task scope;
- unreported changed files;
- overlapping live ownership;
- symbolic-link escapes;
- stale attempt results;
- integration against a changed baseline.

Integration is serialized. Before the main workspace is mutated, Metis activates a durable integration journal under `.metis/` containing the exact attempt fence and recoverable original path states. The journal and the SQLite integration transaction remain active through terminal task persistence. A normal failure restores the originals immediately; after a process crash, the next database open either removes a journal for an already committed `Integrated` result or restores the originals and marks the interrupted attempt failed.
A worker does not gain authority to change a frozen interface or another task's scope.
A completed child must report the exact frozen content hash for every declared interface input and output.

## Structured child results

A terminal child result must follow the packet result schema.
The runtime validates status, changed files, acceptance results, interface use, checks, artifacts, evidence, and blockers.

Record a terminal result through the task command returned by the host adapter.
A free-form statement such as “done” is not sufficient evidence.

## Diagnosis before retry

A failed or blocked child is not retried immediately.
When configured, the controller requests a fresh diagnostician task.
The diagnosis classifies the failure and identifies the earliest invalid state.

Possible routes include:

```text
transient     retry the bounded task
reasoning     use a stronger reasoning route
contract      revise the Task Packet blueprint
 dependency   add or repair a dependency
integration   reconcile repository state
plan          reopen planning
external      request user or authority input
```

After diagnosis, Main selects exactly one route.
It does not edit the failed task itself.

Retry only after the old worker has stopped:

```sh
metis task retry <task-id> "<reason>" --cause <class> --pretty
```

A retry creates a new attempt and fencing token.
An old result cannot finish it.

## Review and verification

Reviewers and verifiers are independent subagents.
Main does not review its own orchestration result.

Lifecycle candidates and approvals are produced only by their dedicated
commands. `artifact put` and `artifact waive` reject protected lifecycle kinds;
reviewer, verifier, and adversarial-reviewer tasks cannot be waived.

Blocking review findings become repair tasks.
After repair, run fresh review against the current code fingerprint.

Repository checks use structured commands:

```sh
metis check detect --pretty
metis check add --name test --command npm --args '["test"]' --pretty
metis check run --continue --pretty
```

UI work can require browser scenarios and browser evidence.
The controller requests verifier tasks for missing scenarios.
Main must not operate the browser or judge screenshots.

Completion can require:

- current deterministic checks;
- semantic verifier evidence;
- current review findings;
- required specialist review;
- browser evidence;
- resolved checkpoints;
- one immutable verification candidate;
- adversarial completion review;
- current documentation and knowledge state.

## Reopen and recovery

Inspect durable state first:

```sh
metis controller status --pretty
metis status --context --pretty
metis journal replay --pretty
metis task packet list --pretty
```

Reopen the earliest invalid phase:

```sh
metis reopen execute "<reason>" --pretty
metis reopen plan "<reason>" --pretty
metis reopen design "<reason>" --pretty
metis reopen discover "<reason>" --pretty
```

Reopen invalidates dependent packets, checks, reviews, browser evidence, verification candidates, and knowledge state.
Do not edit SQLite directly.

`STALLED_REPLAN` means repeated controller revisions made no durable progress.
Change the evidence search, design, task boundary, capability route, or model route.

`BUDGET_DECISION_REQUIRED` means a hard budget blocks further work.
Reduce scope or amend the budget explicitly.

## Runtime layout

```text
.metis/
├── layout.json
├── config.json
├── state/
│   └── state.db
├── objects/
├── generated/
├── cache/
├── logs/
├── tmp/
├── worktrees/
├── benchmarks/
└── backups/
```

The canonical database path is:

```text
.metis/state/state.db
```

## Inspect state

```sh
metis report --markdown
metis trace report --pretty
metis review status --pretty
metis budget status --pretty
metis progress status --pretty
metis journal replay --pretty
metis metrics --pretty
metis storage --installation --pretty
```

## Cleanup

Preview first:

```sh
metis clean --scope cache --dry-run --pretty
```

Apply by removing `--dry-run`:

```sh
metis clean --scope cache --pretty
```

There is no `--apply` flag.
Valid scopes are `cache`, `worktrees`, `generated`, `benchmarks`, and `all`.
Active task worktrees remain protected.

Object garbage collection:

```sh
metis gc --keep-contexts 20 --dry-run --pretty
metis gc --keep-contexts 20 --pretty
```

## Reset and uninstall

```sh
metis reset --dry-run --pretty
metis reset --yes --pretty

metis uninstall --host all --dry-run --pretty
metis uninstall --host all --pretty
metis uninstall --host all --purge-state --yes --pretty
```

The install manifest controls managed-file removal.
Modified managed files remain unless destructive behavior is explicit.

## Benchmark

Initialize, run, and compare local variants:

```sh
metis benchmark init --name repository-goals \
  --baseline-commit <baseline-sha> \
  --candidate-commit <candidate-sha>
metis benchmark run --yes --allow-repository-exec \
  --file .metis/benchmarks/benchmark.json \
  --baseline-commit <baseline-sha> \
  --candidate-commit <candidate-sha>
metis benchmark report --name repository-goals
metis benchmark compare repository-goals metis-pre-1.0-baseline metis-1.0.0-candidate \
  --baseline-commit <baseline-sha> \
  --candidate-commit <candidate-sha>
```

The official comparison fails closed unless both commits exist, differ, the
candidate equals the clean checkout at `HEAD`, every durable result names the
matching commit, and the measured release acceptance gates pass.

A benchmark that executes repository commands needs explicit opt-in:

```sh
metis benchmark run --yes --allow-repository-exec --file <file>
```

Use at least the documented scenario matrix and repeated runs when making a
performance claim. Reports calculate verified-only median and nearest-rank
P95; failed or unverified runs never contribute a completion duration. Include
a plain-host control and retain pass-rate/failure counts with the result.
The required nine-scenario suite materializes a small isolated project for
each run. Its verifier executes outside the agent-writable workspace, checks
real behavior and immutable fixture hashes, and does not trust a worker-written
success marker. Failure-policy and provider-rendering scenarios are local
deterministic probes of the selected candidate runtime; they do not require a
Claude account. Real host/model trials remain separate benchmark evidence.
The built-in Codex host command uses
`--dangerously-bypass-approvals-and-sandbox` because each benchmark workspace is
a disposable Git fixture. This does not remove the required explicit
`--allow-repository-exec` gate for starting repository benchmarks.
Runtime metrics are observed through a read-only, schema-aware database
connection, so measurement does not mutate stored state. Time-to-first-worker
uses the common host spawn-acceptance timestamp. A timed-out host process is a
failed run. Timeout handling sends `SIGTERM`, escalates to `SIGKILL`, and waits
for both child close and process-group disappearance within a bounded cleanup
window. Cleanup timeout is recorded as `BENCHMARK_CLEANUP_TIMEOUT`.
Runtime-state metrics assume the benchmarked host follows the Metis task
contract; they are orchestration telemetry, not a tamper-proof sandbox against
a deliberately malicious benchmark subject. Behavior verification remains an
independent external oracle.
Benchmark commands are trusted, explicitly approved repository commands, not a
security boundary for hostile code. Descendants must retain either the private
process group or the inherited benchmark process token for Metis to identify
and terminate them. If a command deliberately discards both, Metis still ends
the run with `BENCHMARK_CLEANUP_TIMEOUT` within the bounded cleanup window, but
cannot guarantee termination of that escaped operating-system process.
The bundled Codex benchmark pins its model only inside disposable benchmark
workspaces so repeated Codex trials are comparable. Claude Code and OpenCode
do not inherit that model; host-specific trials must use their own explicit
model contract when model-controlled evidence is required.

The baseline setup records `controller-lease-only` instrumentation and extends
only its controller liveness window to cover a normal multi-minute child turn;
lifecycle, routing, model, task, and verification policy remain unchanged.

Inspect durable runtime performance evidence with:

```sh
metis performance report --pretty
```

The report includes phase durations, critical-path approximation, concurrency,
slot utilization, repository-sync cache hits/misses, and requested/effective
effort counts. Worker packet truncation or an estimated token-budget crossing
emits a durable warning and is not silently treated as success.

## Boundary

Metis controls orchestration and repository integration.
The host controls process, network, shell, and tool permissions.
