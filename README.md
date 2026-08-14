# Metis 1.0.0

[English](README.md) | [한국어](docs/README.ko.md)

Metis is a subagent-first engineering orchestrator for long repository goals.
It provides Codex, Claude Code, and OpenCode adapter previews for structured
discovery, research, design, planning, implementation, review, and
verification. This is the first public release.

Start one managed goal:

```text
/goal $metis "<objective>"
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

Host status for 1.0.0:

| Host | Status | Release evidence |
| --- | --- | --- |
| Codex | E2E-verified preview | Native goal lifecycle passed on the package-equivalent release candidate; exact-tag rerun pending |
| Claude Code | Adapter preview | Installation, contracts, and spawn descriptors tested; native goal E2E pending |
| OpenCode | Adapter preview | Installation and generic spawn contract tested; native goal E2E pending |

Do not treat a green package test as native-host E2E evidence. Promote a host
to supported only after the complete goal-to-verification flow passes in an
authenticated release environment.

Download `metis-orchestrator-1.0.0.tgz` from the
[v1.0.0 release](https://github.com/gkrtjd99/Metis/releases/tag/v1.0.0), then
install it:

```sh
npm install -g ./metis-orchestrator-1.0.0.tgz
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
