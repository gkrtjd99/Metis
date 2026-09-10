# Recovery and Replanning

Use runtime state and the structured journal.
Do not reconstruct a run from the full conversation.

## 시작·compact·재개의 공통 복원

대화 요약을 새로운 계약으로 사용하지 않는다. 실행 시작, compact 후 첫 action,
세션 재개, owner 교체 전에 현재 역할에 필요한 durable 상태를 다시 읽는다.
Host compact hook의 존재나 자동 전달에만 의존하지 않는다.

1. `lifecycle`과 `controller status`로 현재 run과 소유권을 확인한다.
2. 유효한 현재 Main credentials로 `metis goal restore --pretty`를 호출한다.
3. 원래 목표·현재 Goal Contract·PRD snapshot handle·계획·결정·작업 상태를 확인한다.
4. `documents.plan`이 가리키는 현재 sealed plan artifact에서 durable `executionSettings`를
   복원한다. artifact `id`/`content_ref`, metadata와 payload의 `planHash`가 현재 계획 및
   plan review/checkpoint binding과 일치하는지 확인한다. `mode: "exact"`, host, model,
   `requestedEffort`, `userApproval`도 다시 확인한다.
5. execution task마다 plan entry와 현재 task row의 model, requested/effective effort,
   effort status/source, supported efforts가 일치하는지 runtime으로 재검증한다. 하나라도
   누락·변경·unsupported·unknown·mismatch이면 `next`, `schedule claim`, 실행을 호출하지
   않고 fail closed 상태와 재승인/reopen 필요를 보고한다.
6. source/plan/decision 본문이 필요하면 반환된 artifact/object handle 또는 해당 get
   명령으로 필요한 항목만 읽는다. 모든 기록을 Main에 한 번에 넣지 않는다.
7. `intake-required`면 아직 계약이 없으므로 기존 intake를 수행한다. plan-only 의도는
   유지한다. source 누락·변조 오류는 추측하지 않고 보고한다.
8. pending 실행 승인·blocker·lease 오류를 그대로 유지한다. 필요하면 runtime의
   정상 복구 절차를 거친 뒤 `next`에서 다음 action을 받는다.

`goal restore`는 파생 context snapshot/object와 token accounting을 기록할 수 있어
filesystem read-only 명령이 아니다. 작업을 생성·spawn하거나, 다음 phase로 넘기거나,
controller lease를 자동 갱신하거나, checkpoint를 승인하지 않는다. PRD 원본 경로를
재실행/재읽기하지 않으며 계약에 연결된 immutable snapshot을 사용한다. 원본 파일의
편집·삭제는 동결된 요구의 암묵적인 변경이 아니다.

`documents.status: bound`의 `directory/prd/plan/decisions`는 현재 계약 sourceDocument가
인증한 같은 run의 PRD artifact.path에서만 파생된다. `existing`은 파일 존재 여부일 뿐
최신성이나 승인 증거가 아니다. PRD 본문을 다시 읽지 않고 snapshot 무결성과 경로 안전을
별도로 확인한다. 경로 symlink/종류 충돌은 오류이며 파일 부재는 snapshot 복원을 막지 않는다.
`unbound`(source 없음 또는 legacy/external path)면 새 폴더/새 run을 만들지 않는다.
제목·대화·최근 폴더 검색으로 binding을 추측하지 않는다. plan/decisions 문서가 오래되면
`prd.md`의 안전 갱신 규칙으로 runtime에서 재파생하되 Markdown을 상태 authority로 쓰지 않는다.
복원 자체는 목표 문서 폴더나 파일을 생성·갱신하지 않는다.

복원 목록에는 limit/누락 개수가 있으므로 필요한 항목은 해당 task/decision/checkpoint
조회로 추가 확인한다. 이전 실패를 실제 근거 없이 반복하거나 running task를 새로
spawn하지 않는다. credentials가 없으면 복원 명령을 위해 token을 child에게 요구하거나
다른 Main을 자동으로 takeover하지 않는다.

Main은 전체 목표·owner 간 계약을, owner는 해당 subtree 상태·계약을, worker/verifier는
현재 attempt의 Task Packet을 복원한다. owner나 worker에게 Main의 `goal restore`
credentials를 전달하지 않는다. 기존 owner next/status와 task packet 경로를 사용한다.

`$metis resume`는 pending 계획을 승인하지 않는다. `plan-only`, `$metis resume`,
continuation/hook은 실행 승인 근거가 아니며, 실행 승인은 현재 계획에 대한 사용자의 명시적
`metis plan execute --reason <요청>`뿐이다. 명시적 `$metis run`도 그 승인만 기록할 수 있고,
continuation pause/cap 해제는 별도 explicit rebind다. DB 재open fixture 검사는 실제 host
compact 이벤트·전체 goal E2E 증거와 구분한다.

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

## Host completion recovery

A prepared batch is not a running child until the host has created it and ACKed
its real child/session/agent receipt. Use the normal sequence once:
`next → claim → prepared → spawn all → bundled ACK`, then wait for the host's
native completion notification if one exists. Metis does not provide that host
callback and `task.finished` is a later durable runtime event: after the host
notification, check durable task state; if nonterminal, ingest the terminal
handoff and execute `task finish`; if already terminal, do not finish again.
Call `next` only after that durable state is present.

If the host has no native notification, use the bounded wait interval from the
controller action and retain lease heartbeats for receipt-backed tasks. Do not
turn the fallback into repeated `ScheduleWakeup`, `ListAgents`, or equivalent
polling. A missing receipt is not completion; stop heartbeat advancement as
specified below and use the fenced stale-batch abort. Never pass controller
credentials to a child while recovering.

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
