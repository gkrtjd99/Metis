# Recovery and Replanning

Use runtime state and the structured journal.
Do not reconstruct a run from the full conversation.

## Controller recovery

Inspect ownership first:

```sh
metis controller status --pretty
metis status --context --pretty
metis journal replay --pretty
```

An active controller blocks a second Main.
An expired controller needs explicit takeover.
Use forced takeover only after checking the old process.

## Task recovery

Heartbeat active batches at the returned interval:

```sh
metis schedule heartbeat <batch-id> --pretty
```

A `claimed` batch is still preparing and must not be spawned or acknowledged.
Heartbeat renews only tasks with a nonempty host receipt. If any receipt is
missing, the scheduler does not advance the batch watchdog timestamp and
returns recovery-required state. Once the controller reports a stale batch,
run its fenced abort command with the expected status, timestamp, and
controller fence; do not use an unfenced recovery abort.

An expired mutable task fails closed.
It remains `blocked` and retains path ownership.
Verify the old worker is stopped before retry.

## Diagnosis before retry

Do not retry a failed child from its error text alone.
Dispatch the diagnostician requested by the controller.

A diagnosis identifies:

- failure class;
- earliest invalid state;
- supporting evidence;
- one recommended action.

Routes include retry, stronger reasoning, contract revision, dependency repair, integration recovery, plan reopen, or external authority.
Main selects one route.
It does not repair the task itself.

Retry after diagnosis and worker shutdown:

```sh
metis task retry <task-id> "<reason>" --cause <class> --pretty
```

A retry creates a new fence, lease, worktree, and current Task Packet.
A stale result cannot finish the new attempt.

## Packet and interface recovery

Inspect blocked packet state:

```sh
metis task packet status <task-id> --pretty
metis task packet get <task-id> --pretty
metis interface list --pretty
```

If an interface changed, rebind tasks and compile new packets.
If a compiler reported ambiguity, reopen design or plan.
Do not send the ambiguous task to a worker.

## Controlled reopen

Use the earliest invalid phase:

```sh
metis reopen execute "<reason>" --pretty
metis reopen plan "<reason>" --pretty
metis reopen design "<reason>" --pretty
metis reopen discover "<reason>" --pretty
```

Reopen invalidates dependent packets, checks, reviews, browser evidence, candidates, and knowledge state.
Do not edit SQLite directly.

## Stall and budget handling

`STALLED_REPLAN` means repeated revisions made no durable progress.
Change the search, design, interface, task boundary, capability route, or model route.

`BUDGET_DECISION_REQUIRED` means a hard limit blocks more work.
Reduce scope or amend the budget explicitly.

## Integration recovery

Integration holds serialized ownership.
A crash rolls back the active transaction.
No process should remove a live lock or force-delete an active worktree.
Use storage and journal inspection before cleanup.
