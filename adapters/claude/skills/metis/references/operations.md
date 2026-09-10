# Runtime Operations

Metis controls orchestration and repository integration.
The host controls process, network, shell, and tool permissions.

## Goal documents

`goal prd --title <제목> --file <본문>`는 DB/run 없이 안전하게 새
`docs/metis/<goal-slug>/prd.md`를 생성한다. 기존 폴더는 보존하고 충돌 시 멈춘다.
계획 run에는 반환된 상대 artifact.path와 기존 sourceDocument 쌍을 연결한다.
`goal restore.documents`는 저장 참조에서 같은 폴더의 `plan.md`/`decisions.md`를
식별한다. 자동 export가 아니므로 Main은 seal/결정 변경 뒤 runtime에서 요약을
파생·저장한다. 자세한 안전·갱신·legacy/unbound 규칙은 `prd.md`를 읽는다.

## Controller

Preserve the controller credentials returned by `metis start`:

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

Use takeover only after the old Main is inactive.

## State-driven continuation preview

The legacy `/goal $metis` path remains native-evaluator managed. Standalone
continuation is opt-in and currently a Claude/Codex preview; it is not a claim
of full-goal native E2E support. Install hooks explicitly:

```sh
metis continuation install --host claude|codex
metis continuation uninstall --host claude|codex
```

`init` does not install them. Bind only an actual host session ID, with
`--native-goal-inactive`, non-empty `--evidence`, and the existing controller
credentials. `inspect` is read-only. It must not initialize `.metis`, sample
progress, renew leases, or execute actions. `--rebind` is an explicit
same-controller/session delivery-bookkeeping reset, not takeover; normal bind is
idempotent. Stop is deterministic and evaluator-free; `WAIT` requires visible
host background evidence, `COMPLETE` requires durable runtime completion, and
bounded host no-progress/cap rules prevent an unlimited unattended-run claim.

## Host spawn and completion protocol

When `next` returns `SPAWN_BATCH`, follow the returned typed invocation and
protocol rather than re-proposing the same batch. The sequence is
`next → claim → prepared → spawn every descriptor → one bundled ACK with the
real receipts → wait for host completion`. Typed invocations have only
`{executable, args, cwd}` and are additive convenience metadata; execute argv
without shell evaluation. Controller credentials stay in the Main host
environment and are never copied into child arguments or packets.

`prepared` means descriptors and workspaces are ready, not that a child exists.
The host must create every child and then submit the actual receipt for every
item in one ACK. Partial ACK remains a recovery path only. A host-native process
or session completion notification, when available, only tells the host to
collect the terminal handoff. It is not a Metis runtime event and is not
promised by documentation. The host checks durable task state first, ingests
the result, and runs the typed terminal-handoff `task finish` only when the task
is nonterminal; an already-terminal task must not be finished again. Only the
durable `task.finished` state permits Main to call `next` again. If no native host notification exists, wait one
bounded interval and run the returned heartbeat commands as needed; do not
repeat `ScheduleWakeup`, `ListAgents`, or equivalent discovery calls.

## Inspect orchestration state

```sh
metis doctor --pretty
metis status --context --pretty
metis task packet list --pretty
metis interface list --pretty
metis schedule propose --pretty
metis journal replay --pretty
metis metrics --pretty
```

Main context is compact.
Load a complete Task Packet or object only when the current child needs it.

## Runtime layout

The canonical database path is:

```text
.metis/state/state.db
```

See `docs/REFERENCE.md` for generated layout and defaults.
Treat runtime state as project-sensitive data.

## Cleanup

Preview:

```sh
metis clean --scope cache --dry-run --pretty
```

Apply:

```sh
metis clean --scope cache --pretty
```

There is no `--apply` flag.
Valid scopes are `cache`, `worktrees`, `generated`, `benchmarks`, and `all`.
Active task worktrees remain protected.

Garbage collection:

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

The uninstaller rejects manifest and symbolic-link traversal.
Modified managed files remain unless destructive behavior is explicit.

## Benchmark

Benchmark commands are structured objects.
Repository execution needs explicit confirmation:

```sh
metis benchmark run --yes --allow-repository-exec --file <file>
```

Use scenario and variant labels for baseline, candidate, and plain-host
controls. Reports use verified-only median and nearest-rank P95 and retain
pass-rate/failure counts separately. Inspect runtime performance evidence with:

```sh
metis performance report --pretty
```

The report includes phase duration, verified completion time, concurrency, slot
utilization, repository-sync cache hits/misses, and effort negotiation counts.
Packet budget crossings or truncation emit durable warnings.
