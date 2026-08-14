# Runtime Operations

Metis controls orchestration and repository integration.
The host controls process, network, shell, and tool permissions.

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
