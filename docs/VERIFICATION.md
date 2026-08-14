# Verification

Metis 1.0.0 verifies both the runtime control plane and the subagent-first workflow contract.
The release suite must pass from source and from the packed npm archive.

## Release command

Run:

```sh
npm run check
```

This command performs:

```text
JavaScript syntax checks
  -> generated reference drift check
  -> structural release validation
  -> complete Node.js test suite
```

Generate the reference after changing metadata, defaults, layout, or CLI help:

```sh
npm run docs:generate
```

## 1.0.0 orchestration coverage

The performance release coverage additionally verifies:

- lifecycle profile selection is deterministic; unsafe `fast` requests are
  rejected and `balanced`/`full` retain their required gates;
- eligible `fast` plans receive an exact deterministic review after all packets
  compile, while integration review and verification run as independent
  read-only siblings against the same candidate;
- `drive` advances bounded controller actions without bypassing Main's fences;
- discovery/research general atomic materialization is idempotent;
- progressive effort is negotiated against capability evidence and rendered by
  the selected host adapter;
- every claim creates append-only attempt provenance and retries do not erase
  prior attempts;
- `metis performance report` exposes verified completion, phase and
  concurrency evidence without raw child output;
- token packet-budget warnings are durable; they do not become silent success.

The release tests verify that the lifecycle is executed by subagents instead of Main.

### Discovery and research

Tests verify:

- discovery creates parallel scout tasks;
- Main does not perform repository discovery itself;
- a synthesizer follows completed scouts;
- researcher and synthesizer roles use bounded structured results;
- child evidence, not Main transcript, becomes the phase artifact.

### Planning and task decomposition

Tests verify:

- a planner returns a typed `PlanDraft`;
- the runtime atomically ingests interfaces, milestones, tasks, dependencies, and waves;
- unknown dependencies and graph cycles are rejected;
- task risk, effort, slice type, verification modes, and capabilities remain structured;
- the scheduler dispatches only the earliest open wave;
- a running or blocked earlier wave prevents later-wave dispatch;
- plan-time compiler tasks share one parallel compilation wave.

### Task Packet compilation

Tests verify:

- deterministic packets contain role protocol, scope, selected context, capability procedures, acceptance criteria, verification, stop conditions, and result schema;
- complex and high-risk tasks create a fresh task-compiler task;
- the target waits until the compiler completes;
- compiler overlays cannot change protected contract fields;
- unresolved ambiguity blocks dispatch;
- Main context excludes complete packet text.

Protected fields include:

```text
scope
mutable paths
authority
dependencies
acceptance criteria
frozen interfaces
```

### Frozen interfaces

Tests verify:

- only frozen interfaces can bind to tasks;
- interface content is included in the Task Packet;
- a replacement version supersedes the previous version;
- linked Task Packets become stale;
- stale packets cannot dispatch;
- completed tasks attest every declared input and output with the exact frozen content hash;
- stale, undeclared, or missing interface reports are rejected.

### Failure diagnosis

Tests verify:

- failed children become blocked when diagnosis-first policy is active;
- the controller requests a fresh diagnostician task;
- Main does not immediately retry or repair the task;
- a diagnosis returns a classified failure and one recommended route.

## Scheduler and process concurrency

Concurrency tests use separate Node.js processes against the same SQLite database and Git repository.
They verify:

- only one controller owns a repository run;
- controller fencing rejects stale writers;
- eight scheduler processes cannot claim the same task batch;
- a batch claim is atomic;
- spawn budget changes only after acknowledgement;
- task and controller heartbeats renew leases;
- expired attempts fail closed;
- stale results cannot finish a newer attempt;
- integration ownership cannot be stolen during a long operation;
- concurrent progress sampling is idempotent.

These tests exercise real operating-system process contention.
They do not simulate concurrency only inside one JavaScript call stack.

## Worktree and integration coverage

Tests verify:

- every mutable task receives a detached Git worktree;
- no shared mutable fallback exists;
- overlapping mutable path ownership is rejected;
- unreported changed files are rejected;
- out-of-scope changes are rejected;
- main-workspace races are detected;
- symbolic-link escapes are rejected;
- integration uses the current baseline;
- a stale worker cannot integrate a newer attempt.

## Structured command coverage

Verification and benchmark commands use an executable plus argument array.
They disable shell interpretation.

Tests verify:

- command arguments are not reinterpreted by a shell;
- a successful check that modifies protected repository state fails;
- a successful non-mutating check passes;
- repository benchmark execution requires explicit opt-in;
- benchmark timeout cleanup settles once even when an escaped descendant keeps
  inherited stdout and stderr open;
- Linux descendant containment exercises the runtime `/proc` inventory path;
- benchmark and uninstall manifest traversal is rejected.

## Evidence and currentness

Tests verify:

- source evidence records current hashes;
- changed source makes dependent evidence stale;
- changed code fingerprints make old checks and reviews stale;
- typed evidence remains reachable through garbage collection;
- large child output moves outside active Main state;
- object payloads remain addressable by reference;
- observed host token usage updates hard budgets.

Performance benchmark verification also requires scenario and variant labels,
verified-only duration statistics (median and nearest-rank P95), pass-rate and
failure counts, and a plain-host control. Repository benchmark execution stays
explicitly opt-in. A claimed threshold is invalid when failed or unverified
runs are included in completion-time statistics.

## Browser verification

The suite contains a native browser smoke test.
When a compatible Chromium executable is available, the test starts a real browser process and communicates through the Chrome DevTools Protocol.
It verifies:

- navigation to the test document;
- DOM assertion execution;
- viewport handling;
- screenshot capture;
- console and network result collection;
- browser evidence ingestion;
- code fingerprint binding.

Browser evidence is still a child responsibility in the managed workflow.
Main does not operate the browser or decide that a screenshot is correct.

Environment policy can block ordinary HTTP navigation.
The smoke test can use an inline document while still exercising the real browser process and protocol.

## Lifecycle and completion coverage

The suite verifies:

- explicit `$metis` opt-in;
- Goal Contract freeze and amendment;
- ten canonical phases;
- discovery, research, design, plan, execute, review, verify, curate, and complete gates;
- independent design and plan critics;
- review findings converted to repair tasks;
- current verification candidate generation;
- adversarial completion review;
- traceability from requirement to implementation and verification;
- assumptions, invariants, risks, and authority gates;
- documentation impact and knowledge synchronization;
- budget and progress-stop states;
- structured journal replay.

A plan, child result, review, or passing test does not complete the run by itself.
Completion uses current runtime state only.

## Installation and packaging coverage

Tests verify installations for Codex, Claude Code, and OpenCode.
They check:

- managed files and plugin manifests;
- exact skill and reference mirrors;
- existing host configuration preservation;
- forced installation backup and restoration;
- partial uninstall behavior;
- modified managed-file preservation;
- dry-run cleanup and uninstall behavior;
- npm pack archive extraction and public entrypoint/CLI smoke;
- generated documentation conformance.

Attachment coverage also verifies that project adapters resolve an explicit or
enclosing Git root, reject non-Git roots before mutation, perform no unrelated
repository scan, preserve differing files under `force=false`, and report the
`no-run`, live-controller, expired-controller, paused, and completed routes
without automatic takeover.

The packed archive must include the 1.0.0 Task Packet, interface, plan-ingestion,
and role runtime surfaces. Development tests remain in Git for CI and are
excluded from the installable package.

## Native host boundary

The normal release suite validates host adapters, installed role files, task contracts, spawn descriptors, scheduler acknowledgement, and task result ingestion.

Actual native Codex, Claude Code, and OpenCode end-to-end tests require those CLIs to be installed and authenticated in the release environment.
If they are unavailable, the release metadata must state that limitation.
A green package suite must not be described as a native-host agent-spawn test.
For 1.0.0, all three native host integrations remain adapter previews until
that release-environment evidence is recorded.

## Release evidence

A release record should contain:

- source test result;
- packed archive extraction and smoke result;
- package and archive file counts;
- SHA-256 checksums;
- Node.js, npm, and Git versions;
- native host CLI availability;
- browser smoke availability and result;
- schema, configuration, and runtime layout versions.

The canonical 1.0.0 versions are:

```text
package: 1.0.0
schema: 11
configuration: 6
runtime layout: 4
```
