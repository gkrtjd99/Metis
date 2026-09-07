---
description: Explicitly run one repository objective through the Metis subagent-first workflow. Native /goal remains unchanged.
name: metis
---

Use the `$metis` skill for this objective:

```text
$ARGUMENTS
```

Self-attach first with `metis attach --host codex`, `metis attach --host claude`, or `metis attach --host opencode` according to the active host (force false, explicit or enclosing Git root only), then inspect lifecycle and route before starting or resuming: no-run -> doctor then start the objective; paused -> resume then continue; completed -> start a new run; active-live-controller -> refuse a second Main and leave the current owner; active-expired-controller -> require explicit authority and safe takeover, never automatic. Global/plugin command availability is a prerequisite. Do not scan unrelated repository content.
Keep Main at goal, canonical-document, and task-owner coordination.
The existing coordinator role owns each bounded subtree through normal completion;
Main and the planner approve its direct-child subtree in the sealed plan. It
manages low-cost execution and a separate receipt-backed verifier, does not
implement or self-verify, and reports local progress to Main. Dynamic child
creation requires Main approval and plan re-sealing. Escalate only contract,
scope, interface, authority, or budget changes, or unresolved blockers. Child
terminal handoff goes to the parent owner; only the root owner uses Main's
`next`/action boundary. Owner lifecycle uses `metis owner next|claim|ack|heartbeat|abort|child-failure|status <owner-task-id> --lease <owner-lease>`; `ack`, `abort`, `status`, and `child-failure` also use `--batch <id>` and existing receipts/data flags.

Follow the runtime-returned profile/action and do not add critics or fan-out
outside the runtime gates; preserve an explicit parallel requirement and honor
an eligible four-way implementation wave. Owner execution requires explicit
`config delegation.ownerExecution.hosts.<host>` capability with
`childSpawning: true` and verified evidence; unknown/false is unsupported. Use
`mode: "host-relay"` for the common Claude/Codex fallback when native nested
execution is unavailable: the owner claims/prepares and relays only a batch ID;
the top-level Main host uses its controller credentials with `metis relay read
<batch-id>` to load descriptors, while existing host tools create children and
`metis schedule ack` records actual receipts. `relay read` does not spawn, and
controller credentials stay with Main. The owner retains decisions and finish.
Use `metis relay list` to inspect pending requests. Do not claim that install or
`metis init` enables this capability, and do not claim Agent-tool support without
host evidence. Apply global `maxConcurrent` and per-owner
`maxConcurrentChildren` (default 4, configurable positive integer, subject to
the global cap). Dispatch discovery, research, design, planning, Task Packet
compilation, implementation, review, verification, diagnosis, and curation
through fresh subagents as returned by the runtime.
Continue until `COMPLETE` or a recorded user, authority, budget, or unrecoverable blocker.
