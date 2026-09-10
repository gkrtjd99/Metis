---
description: Metis subagent-first workflow의 PRD·계획·실행·복원·상태 진입점. Native /goal은 변경하지 않는다.
name: metis
---

아래 원문을 `$metis` 스킬의 진입점 parser에 전달한다. verb도 포함하므로 전체를
새 objective로 취급하거나 attach/start를 먼저 실행하지 않는다:

```text
$ARGUMENTS
```

스킬의 `references/entrypoints.md`를 먼저 읽고 `entry resolve --input=<원문>`으로
prd/plan/run/resume/status를 구분한다. 입력은 shell로 평가하지 않는다. parser가 bare
objective에 반환하는 `execute`는 internal result일 뿐이며, `$metis execute` user-facing
entry verb나 `metis execute` CLI를 만들거나 호출하지 않는다.
PRD는 문서 작성만, plan은 `start --plan-only`와 실행 승인 gate까지, run은 현재
계획의 명시적 실행, resume는 승인 없는 복원, status는 보고만 한다.
새 목표/빈 fixture는 `$METIS model show`로 실제 host/model/effort 지원값을 확인한 뒤
`$METIS model configure --data '<configuration>'`를 `start` 또는 `start --plan-only` 전에
완료한다. 이후 plan seal 직전 사용자에게 `executionSettings`의 host/model/requestedEffort/
confirmed/evidence를 확인받고 durable plan에 저장한다.
Runtime이 필요한 mode만 현재 host에 맞는 명령 하나로 연결한다:
Codex는 `$METIS attach --host codex`, Claude Code는 `$METIS attach --host claude`,
OpenCode는 `$METIS attach --host opencode`를 사용한다. force false를 유지하고
이어서 lifecycle을 확인한다.
기존 run에서는 `goal restore` 후 action을 따르고, 다른 live Main·expired lease·
paused 원인을 자동으로 무시하지 않는다. run/resume는 새 목표를 시작하지 않는다.
새 PRD는 `goal prd --title <제목> --file <본문>`으로 `docs/metis/<goal-slug>/prd.md`에
저장하고 같은 폴더의 `plan.md`, `decisions.md`는 runtime 기록에서 파생한다.
run/resume/compact는 `goal restore`의 저장된 `documents` 참조를 재사용한다.
seal 후에는 `artifact latest plan`과 `goal restore --pretty`로 artifact `id`/`content_ref`,
`planHash`, exact executionSettings 및 모든 execution task binding을 대조한다. 저장 실패,
unsupported/unknown capability, requested/effective mismatch, hash/contentRef/task 불일치는
`plan execute`·claim 전에 fail closed 한다. resume에서는 같은 검사를 통과한 뒤에만 `next`를
따르며, provider 내부 effort 적용은 별도 증거 없이는 주장하지 않는다.
slug 충돌·기존 파일·경로/symlink 안전과 host 갱신 책임은 스킬 `references/prd.md`를 따른다.
폴더가 unbound이면 임의 새 폴더/새 run을 만들지 않는다. 자동 Markdown export는 없다.
Global/plugin command availability는 별도 선행 조건이며 관련 없는 저장소를 조사하지 않는다.
The existing `/goal $metis` path remains legacy native-evaluator; standalone
continuation is an opt-in Claude/Codex preview, not a full-goal E2E support claim.
Use explicit `metis continuation install|uninstall`, then bind an actual host
session only with `--native-goal-inactive`, non-empty `--evidence`, and existing
controller credentials; `init` never installs hooks. Inspect is read-only, Stop
is deterministic/evaluator-free, and WAIT requires host background evidence.
After pause/cap/no-progress/failure, explicit rebind/resume is required;
`--rebind` resets delivery bookkeeping only. Keep Main at goal,
canonical-document, and task-owner coordination.
The existing coordinator role owns each bounded subtree through normal completion;
Main and the planner approve its direct-child subtree in the sealed plan. It
manages low-cost execution and a separate receipt-backed verifier, does not
implement or self-verify, and reports local progress to Main. Dynamic child
creation requires Main approval and plan re-sealing. Escalate only contract,
scope, interface, authority, or budget changes, or unresolved blockers. Child
terminal handoff goes to the parent owner; only the root owner uses Main's
`next`/action boundary. Owner lifecycle uses `metis owner next|claim|ack|heartbeat|abort|child-failure|status <owner-task-id> --lease <owner-lease>`; `ack`, `abort`, `status`, and `child-failure` also use `--batch <id>` and existing receipts/data flags.

Follow the runtime-returned profile/action and do not add critics or fan-out
outside the runtime gates. Preserve an explicit parallel requirement while
keeping unsafe or overlapping slices atomic. The sealed graph's independent
width is separate from the active host's configured simultaneous-child capacity
and Metis budgets; an eight-task graph may run four at a time when that host is
configured for four. Do not infer a universal or Codex/Claude-specific cap.
Owner execution requires explicit
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
host evidence. Apply the host's actual capacity and Metis budgets; do not assume
an undocumented per-owner default. Dispatch discovery, research, design,
planning, Task Packet compilation, implementation, review, verification,
diagnosis, and curation through fresh subagents as returned by the runtime.
PRD/status는 해당 산출물에서, plan은 실행 승인 대기에서 종료한다. 실행 mode만
`COMPLETE` 또는 recorded user/authority/budget/unrecoverable blocker까지 계속한다.
`resume`와 continuation hook은 `plan execute` 승인 근거가 아니다.
