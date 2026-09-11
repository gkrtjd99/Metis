# Metis 1.2.0

[![HOL Guard](https://img.shields.io/endpoint?url=https%3A%2F%2Fhol.org%2Fapi%2Fregistry%2Fbadges%2Fplugin%3Fslug%3Daustin%252Fmetis%26metric%3Dtrust)](https://hol.org/go/guard/gkrtjd999?dest=%2Fguard%2Fbilling%3Fpromo%3DGUARD20-GKRTJD999%23upgrade&link_id=05597c15-b717-4217-8fc2-42dc2fa60b06&utm_source=insights_share&utm_medium=affiliate_cta&utm_campaign=share20)

[English](README.md) | [한국어](docs/README.ko.md)

Metis is a subagent-first engineering orchestrator for long repository goals.
It provides Codex, Claude Code, and OpenCode adapter previews for structured
discovery, research, design, planning, implementation, review, and
verification. **1.2.0 is the current public release.**

Start one managed goal:

```text
/goal $metis "<objective>"
```

Or use durable workflow entry points:

```text
$metis prd "<requirements>"
$metis plan "<objective>"
$metis run
$metis resume
$metis status
```

Metis continues until the goal is complete or requires an explicit user or
external-authority decision.

## Quick start

Requirements:

- Node.js 22.16.0 or newer
- Git
- Codex, Claude Code, or OpenCode when evaluating a host adapter
- The Metis plugin enabled in the selected host

The release package supports macOS (darwin) and Linux only. Windows is not a
supported installation target.

Host status for the 1.2.0 public release:

| Host | Status | Release evidence |
| --- | --- | --- |
| Codex | Execution-stage integration passed | Owner → worker → independent verifier → same-owner resume reached completion with actual host receipts, immutable test hash, and audited database state |
| Claude Code | Execution-stage integration passed | The same bounded execution-stage flow was observed with actual host receipts, immutable test hash, and audited database state |
| OpenCode | Adapter preview | Installation and generic spawn contract tested; native host execution evidence remains pending |

Do not treat a green package test as native-host E2E evidence. Promote a host
to supported only after the complete goal-to-verification flow passes in an
authenticated release environment.

The 1.2.0 release adds state-driven continuation hooks (`metis continuation`)
for deterministic execution across turns and crashes, durable markdown-based
goal documentation (`$metis prd/plan/run`), unpinned subagent model profiles
enabling host session inheritance (including Gemini, Fable, and newer models),
flexible task-difficulty model routing, and host capacity modeling.
See the [release guide](docs/RELEASING.md) for the current release record and future
packaging and publication procedure.

Download the latest public `metis-orchestrator-1.2.0.tgz` from the
[v1.2.0 release](https://github.com/gkrtjd99/Metis/releases/tag/v1.2.0), then
install it:

```sh
npm install -g ./metis-orchestrator-1.2.0.tgz
```

Or install directly from the GitHub source:

```sh
git clone https://github.com/gkrtjd99/Metis.git
cd Metis
npm install
npm link
```

Create or enter a Git project, then install its host adapter:

```sh
git init /absolute/project
metis init --host codex --root /absolute/project
metis doctor --pretty
```

From the project root, use the shorter form:

```sh
metis init --host codex
```

Other adapter previews:

```sh
metis init --host claude
metis init --host opencode
metis init --host all
```

The host must expose `/metis` and recognize the explicit `$metis` marker.
Project initialization installs the project adapter; it does not install a
missing global host plugin.

Start the first goal in the host:

```text
/goal $metis "Add distributed rate limiting, verify it, and update the documentation"
```

Metis remains passive for ordinary requests that do not explicitly include
`$metis`.

## Continuation preview (opt-in)

Continuation is a separate, host-bound preview. The existing `/goal $metis`
entrypoint remains the legacy native-evaluator path; it is not silently replaced
by standalone continuation. A standalone `$metis` session is not a supported
full-goal E2E claim yet. Installing the files does not grant host hook trust;
Codex may require explicit project hook approval in its native UI. Do not bypass
that approval or infer readiness from the enabled hooks feature alone.

Install or remove the preview hooks explicitly:

```sh
metis continuation install --host claude
metis continuation install --host codex
metis continuation uninstall --host claude
metis continuation uninstall --host codex
```

Claude installs `Stop`, `SessionStart`, `StopFailure`, and `SessionEnd`; Codex
installs `Stop` and `SessionStart`. Remove continuation hooks before the ordinary
`metis uninstall` path. `init` never installs these hooks automatically. Bind
only an actual native host session ID, and explicitly confirm that the host's
native goal is inactive. The binding also requires the existing controller
credentials and non-empty evidence:

```sh
metis continuation inspect --host claude --session-id <native-session-id>
metis continuation bind --host claude --session-id <native-session-id> \
  --native-goal-inactive --evidence "native goal disabled by operator" \
  --controller-session <id> --controller-owner <owner> \
  --controller-token <token> --controller-fence <fence>
metis continuation detach --host claude --session-id <native-session-id> \
  --controller-session <id> --controller-owner <owner> \
  --controller-token <token> --controller-fence <fence>
```

`inspect` is read-only. The hook uses the actual session ID supplied by the host;
it never invents one and cannot detect or clear native-goal state automatically.
After pause, cap, no-progress, or hook failure, explicitly rebind/resume before
continuing; `--rebind` resets delivery bookkeeping only. The Stop hook is
deterministic and does not run an evaluator. `COMPLETE` requires
durable runtime completion. `WAIT` is used only with actual host-visible
background evidence; there is no automatic lease renewal. Continuation is
bounded by host no-progress/block caps, so it does not promise unattended,
unlimited execution. Claude and Codex are preview hosts; OpenCode remains
unsupported for this continuation path.

## Durable skill workflow (preview)

A separate durable-skill workflow can keep a PRD or plan artifact attached to a
run without replacing the existing native `/goal $metis` path:

```text
$metis prd "idea" -> $metis plan @path -> $metis run
```

`prd` records the interview and document only; it does not start work. `plan`
can be started in plan-only mode, where the run records
`Goal Contract.route.executionApprovalRequired: true` and stops at the existing
seal/review authority checkpoint. Only an explicit approval such as
`plan execute --reason "..."` records the current approval and allows execution.
`resume` continues a paused run; it is not approval, controller takeover, or
session rebind. Empty input, `status`, and `resume` preserve the current run
context rather than silently creating a new goal. The existing `$metis:model`
preference remains available.

A PRD snapshot is stored through the existing artifact mechanism. The route keeps
`sourceDocument: { artifactId, contentRef }`, where the stored snapshot is
immutable but the original disk file is not. A bounded `goal restore` restores handles for the current contract,
plan, decisions, and runtime state; it is a mutating, recorded restore rather
than a read-only reopen. It records context/object/token references, never raw
PRD text, worker output, or credentials. Restore and execution validate that the
source belongs to the same run and has not been tampered with.

New PRD workflows use `docs/metis/<goal-slug>/{prd.md,plan.md,decisions.md}`.
`metis goal prd --title "Goal title" --file draft.md` creates only the folder and
PRD, without installing adapters or opening a DB/run. Slugs combine a normalized
ASCII stem (or `goal`) and a deterministic title hash; occupied directories fail
without overwriting or inventing a suffix. Descendant symlinks, hardlinks, and
file-kind conflicts are rejected. Bind the returned repository-relative PRD path
using `artifact put prd --path ...`, then the existing `sourceDocument` pair.
`goal restore.documents` identifies that same folder from the bound artifact path,
not the current title. Legacy/external PRDs and source-free runs remain `unbound`;
restore never creates a folder or run, and deleting/editing the source file does
not change the snapshot. `plan.md` and `decisions.md` are host-written derived
views of the sealed plan and durable decisions, not automatically exported state.
See [goal-document rules](skills/metis/references/prd.md) for collision, update,
provenance, and safety limits (including concurrent parent-directory swaps).

This workflow is separate from native `/goal` and does not automatically clear
native state. Host-specific syntax and complete full-goal E2E behavior remain
unverified. OpenCode skill deployment is separate from OpenCode continuation-hook
support; installing a skill does not imply hook support. Continuation preview
limits above still apply.

## Public Node API

The package root exports a lightweight ESM facade:

```js
import { init } from "metis-orchestrator";

const attachment = await init({ root: "/absolute/project", host: "codex" });
```

`init(options)` is asynchronous and lazy-loads the runtime only when called. It
requires an existing Git project root (or an enclosing Git root discovered from
`cwd`), accepts `codex`, `claude`, `opencode`, or `all`, and returns the host
attachment result. Attachment installs host files and configuration but does
not create the `.metis/state/state.db` runtime database or scan the repository.
Its options are `root?: string`, `cwd?: string`, `host?: string | string[]`, and
`force?: boolean`. The resolved value contains `projectRoot`, `rootSource`,
`gitRoot`, `installed`, `config`, and `lifecycle`.

Supported named exports are `init`, its alias `attach`, and
`assertSupportedNodeVersion`. Invalid Node versions reject with
`ERR_METIS_NODE_VERSION`; invalid roots, Git worktrees, hosts, configuration,
or managed-file conflicts reject with a typed error whose `code` is stable for
programmatic handling. Only the package root and
`metis-orchestrator/package.json` are public entry points. `src/**` modules are
internal and carry no compatibility guarantee.

## Model selection

No model setup is required after installation. By default:

- Main uses the model selected by the current host session.
- Spawned subagents use the host-selected default model.
- Metis does not hardcode a Codex, Claude Code, or OpenCode model.

Use `$metis:model` only when you want project-specific model and effort routing
for future goals:

```text
$metis:model
$metis:model Keep the current Main and use <model> <effort> for subagents.
$metis:model Show the current settings.
$metis:model Reset to host-selected models.
```

Without an inline preference, the agent asks for the selection interactively.
Choose Main with the host's native model selector, such as `/model`; Metis saves
the confirmed Main expectation and configures the subagents it spawns.

Configure overrides before starting a goal. Model configuration is not changed
during an active or blocked run. Provider-specific effort arguments are used
only when the host supplies evidence that the selected model supports them.
Personal model/effort combinations are not enforced on other users. Requested
policy, arguments sent to the host, and host-confirmed settings are separate
facts. If a native Agent tool cannot set per-child effort, a prompt instruction
is not proof of application: use an explicitly configured CLI launch within the
same permission boundary, or report unsupported, rejected, or unconfirmed
settings. Never switch tools to bypass a permission denial.

## How it works

Main coordinates the goal while fresh subagents perform repository inspection,
research, implementation, review, and verification.

```text
user objective
    |
    v
Main: decide, decompose, schedule, route
    |
    +-- discovery scouts ---------+
    +-- external researchers -----+--> synthesis
    +-- designer and planner --------> task graph
    +-- workers in parallel waves --> integration
    +-- reviewers and verifiers ----> repair or complete
```

The managed lifecycle is:

```text
intake -> discover -> research -> design -> plan
       -> execute -> review -> verify -> curate -> complete
```

Independent tasks in the same open wave are dispatched concurrently up to the
configured concurrency limit. A later wave stays closed until the earlier wave
is terminal. Mutable tasks use isolated Git worktrees and are integrated in a
controlled order.

Each child receives a compiled Task Packet containing its scope, dependencies,
frozen interfaces, acceptance criteria, authority, and verification plan.
Main receives compact structured state rather than raw worker transcripts,
large logs, patches, or screenshots.

Metis also provides:

- parallel repository discovery and external research;
- frozen shared interfaces before parallel implementation;
- stale packet, dependency, and mutable-path conflict checks;
- diagnosis before retrying a failed task;
- independent review and verification waves;
- repair tasks followed by fresh review;
- durable controller, lease, journal, and evidence state;
- explicit completion and blocker states.

The host remains responsible for shell, network, and tool permissions.

## Inspect a run

Useful commands:

```sh
metis next --pretty
metis status --context --pretty
metis report --markdown
metis task packet list --pretty
metis interface list --pretty
metis review status --pretty
metis budget status --pretty
metis journal replay --pretty
```

The controller continues until the runtime reports one of these outcomes:

```text
COMPLETE
USER_OR_AUTHORITY_REQUIRED
BUDGET_DECISION_REQUIRED
an unrecoverable recorded blocker
```

## Local state and cleanup

Project runtime state is stored under `.metis/`. The canonical database is:

```text
.metis/state/state.db
```

Runtime state, worktrees, logs, caches, and temporary files are project-local
and ignored by the installed repository policy.

Preview cache cleanup:

```sh
metis clean --scope cache --dry-run --pretty
```

Apply it:

```sh
metis clean --scope cache --pretty
```

## Documentation

- [GitHub repository](https://github.com/gkrtjd99/Metis)
- [Releases](https://github.com/gkrtjd99/Metis/releases)
- [Issues](https://github.com/gkrtjd99/Metis/issues)
- [Architecture](docs/ARCHITECTURE.md)
- [Changelog](CHANGELOG.md)
- [Operations](docs/OPERATIONS.md)
- [CLI and API reference](docs/REFERENCE.md)
- [한국어 README](docs/README.ko.md)
