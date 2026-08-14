---
description: Explicitly run one repository objective through the Metis subagent-first workflow. Native /goal remains unchanged.
---

Use the `$metis` skill for this objective:

```text
$ARGUMENTS
```

Self-attach first with `metis attach --host codex`, `metis attach --host claude`, or `metis attach --host opencode` according to the active host (force false, explicit or enclosing Git root only), then inspect lifecycle and route before starting or resuming: no-run -> doctor then start the objective; paused -> resume then continue; completed -> start a new run; active-live-controller -> refuse a second Main and leave the current owner; active-expired-controller -> require explicit authority and safe takeover, never automatic. Global/plugin command availability is a prerequisite. Do not scan unrelated repository content.
Keep Main at goal-level orchestration.
Dispatch discovery, research, design, planning, Task Packet compilation, implementation, review, verification, diagnosis, and curation through fresh subagents.
Continue until `COMPLETE` or a recorded user, authority, budget, or unrecoverable blocker.
