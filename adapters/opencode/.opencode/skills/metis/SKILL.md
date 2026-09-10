---
name: metis
description: 사용자가 $metis를 명시할 때만 목표 문서 작성(prd), 계획(plan), 실행(run), 복원(resume), 상태(status)를 분기하는 subagent-first workflow. 일반 요청에는 개입하지 않는다. $metis:model은 별도 스킬이며 /goal $metis는 legacy 실행 경로다.
metadata:
  short-description: Orchestrate one repository goal through fresh subagents
---

# Metis

Activate this skill only for the literal `$metis` marker.
`$metis`는 목표 기록과 engineering lifecycle을 Metis에 위임한다.
`/goal $metis`는 legacy native evaluator 경로다. `prd`/`plan`을 native goal과
결합하지 않으며, native goal을 임의로 clear하지 않는다.

## 사용자 진입점

시작·attach·next보다 먼저 [entrypoints.md](references/entrypoints.md)를 읽고
`$METIS entry resolve --input=<literal text after $metis>`로 mode를 확인한다.
인자를 shell 명령에 보간하지 말고 안전한 argv 또는 host의 인용 기능을 사용한다.

| 입력 | 동작 |
| --- | --- |
| `$metis prd "<아이디어>"` | 목표 문서만 작성. [prd.md](references/prd.md) 사용 |
| `$metis plan "<목표>"` 또는 `$metis plan @<문서>` | 목표 저장·계획까지만 진행. [planning.md](references/planning.md) 사용 |
| `$metis run` | 현재 계획을 명시적으로 실행. 새 목표를 추정하지 않음 |
| `$metis resume` | 기록 복원 후 허용된 실행만 재개. 승인·takeover·rebind가 아님 |
| `$metis status` 또는 빈 입력 | 상태만 보고. 새 run·작업을 시작하지 않음 |
| `$metis "<목표>"` | 작은 목표 계약을 포함한 기존 전체 실행 |

`$metis:model`은 기존 별도 모델 설정 스킬이다. 인용된 `"plan"`은 verb가 아닌 목표다.
위 문법은 스킬 분기이며 존재하지 않는 `metis prd/run` CLI를 호출하지 않는다. 입력 entry
verb는 `prd|plan|run|resume|status`뿐이다. `$metis execute`는 user-facing verb가 아니며
`execute`는 runtime action/phase 이름일 뿐이다. 실행 mode만 `COMPLETE` 또는 recorded stop state까지 반복한다.
PRD/plan 산출물, child result, review, passing test는 전체 목표 완료가 아니다.
새 PRD는 `goal prd --title <제목> --file <본문>`으로 `docs/metis/<goal-slug>/prd.md`에
저장한다. 같은 폴더의 `plan.md`/`decisions.md`는 봉인 plan/durable decisions의 파생 표현이다.
저장·갱신 경계는 [prd.md](references/prd.md)를 따른다. run/resume/compact는
`goal restore`의 `documents`만 사용하며 제목으로 새 폴더나 새 run을 만들지 않는다.
PRD 생성·경로 복원은 CLI가 강제하고, 파생 Markdown 갱신은 host 지침이지 자동 export가 아니다.

## Product boundary
Metis is an orchestration boundary.
It controls lifecycle state, task graphs, Task Packets, ownership, integration, evidence, and completion gates.
The host controls process, network, shell, and tool permissions.
Read [operations.md](references/operations.md) for cleanup, recovery, and runtime commands.

## Main is an orchestrator: coordinates the goal, documents, and task owners
Main keeps only goal-level state and coordinates the Goal Contract, canonical
artifacts, and task-owner handoffs. Main can:

- interpret and freeze the Goal Contract;
- read compact runtime state and follow the runtime-returned action/profile;
- create the exact task specs returned by the runtime;
- assign and monitor bounded task owners;
- submit terminal results and present user or authority blockers.
Main must not:

- inspect the repository broadly or perform external research;
- write discovery, design, or plan artifacts or long worker prompts;
- implement, repair, or self-verify code;
- review its own result or operate a browser;
- treat child prose as durable state.

### Task owners

An existing `coordinator` task is the task owner for one bounded subtree. Main
and the planner approve its direct-child subtree in the sealed plan; dynamic
child-task creation changes that plan and must be requested from Main for
approval and re-sealing. The owner preserves the subtree lifecycle through
normal completion, coordinates low-cost execution agents and an independent
verifier, and receives local progress and normal completion. The owner does not
implement or self-verify. It escalates only contract, scope, interface,
authority, or budget changes, or an unresolved blocker. A child task handles
only its packet outcome and its terminal handoff goes to the parent owner; it
must not repeat the full goal lifecycle. Only the root owner reports through
Main's `next`/action boundary.

Owner lifecycle actions are `metis owner next|claim|ack|heartbeat|abort|child-failure|status <owner-task-id> --lease <owner-lease>`; `ack`, `abort`, `status`, and `child-failure` also carry `--batch <id>` and the existing receipts/data flags. Apply the host's configured simultaneous-child capacity and Metis's global/per-owner budgets independently; do not infer a universal value or a host-specific default from this guidance.

A verifier is a distinct host receipt/agent from the worker it verifies. Owner execution requires explicit `config delegation.ownerExecution.hosts.<host>` with `childSpawning: true` and verified `evidence`; unknown/false blocks it.
Use `mode: "host-relay"` as the common Claude/Codex fallback: owner prepares and relays only a batch ID to top-level Main. Main authenticates `metis relay read <batch-id>`; it returns descriptors but does not spawn.
Existing host tools create children and `schedule ack` records real receipts. Owner retains decisions and completion; credentials stay with Main. Native modes require separate evidence; an Agent tool or flag alone is insufficient.
Capability is false by default; see `references/delegation.md` for config and complete relay CLI flags.

### Terminal child handoff (Codex host) The spawn descriptor carries a task-scoped result file and lease-fenced handoff command. The child must write only the packet-schema JSON to that exact file, then execute the command with `--file`; never interpolate result JSON into a shell command. This is the durable completion and is fenced by the lease. Never pass raw transcripts or worker output into Main. Main must first inspect durable task state and must not submit a duplicate finish for an already-terminal task. For hosts without an executable handoff descriptor, write the bounded packet-schema JSON to a task-scoped file and run `$METIS task finish <task-id> --lease <lease-token> --file <result-file> --pretty`.
Run `$METIS next --pretty` in a bounded loop, executing returned Main actions, especially `$METIS plan ingest <planner-task-id> --pretty` for `INGEST_PLAN_DRAFT`, before `$METIS drive --max-iterations N` (drive cannot replace Main actions). Heartbeat while waiting; a terminal result always triggers the finish -> next -> required-action handoff.
Fresh subagents perform discovery, research, synthesis, design, planning, task compilation, implementation, diagnosis, review, verification, and curation.

## Runtime launcher
Run from the repository root.
Resolve this skill directory from the loaded `SKILL.md` path.
Set `METIS` to:

```sh
node --no-warnings <skill-directory>/scripts/metis.mjs
```
A project installation can replace this with its local launcher.
## Profiles, effort, and performance

The runtime chooses `fast`, `balanced`, or `full` deterministically from the
Goal Contract and risk evidence. Unsafe fast work is rejected. Treat the
runtime-returned profile and action as authoritative; do not invent a route or
force an unnecessary critic. Use `$METIS drive --max-iterations N` only for
bounded controller advancement; it does not bypass Main ownership, task,
budget, review, or integration fences. For a trivial single-behavior goal, keep
the Goal Contract structurally exact:
put only repository-relative paths in `scope`, keep the single functional must
as the sole requirement, and record path boundaries plus test commands in
constraints and success criteria instead of inventing extra requirements.
새 fast v2는 별도 task 분해·owner 없이 worker와 독립 verifier를 바로 실행한다.
내부 2실행 기록·seal·receipt·lease는 유지한다. 별도 reviewer/adversarial reviewer/curator를
임의로 추가하거나 실행했다고 표시하지 않는다. 독립 verifier 완료 후 `drive`가 현재 증거의
파생 승인·지식 기록을 처리한다. 기존 fast v1과 balanced/full은 기존 runtime 지침을 따른다.
새 목표/빈 fixture에서는 `$METIS model show`로 현재 host와 실제 model/effort 지원 근거를
확인하고, `$METIS model configure --data '<configuration>'`를 `start` 또는 `start --plan-only`
전에 완료한다. active/blocked run에서는 바꾸지 않는다. 계획 단계에서는 현재 설정을 prefill하고
실제 task별 설정을 사용자에게 확인받되 특정 model/낮은 effort를 강제하지 않는다.
`low`/`medium`/`high`/`xhigh`/`max`는 host·model 지원 근거에 따라 협상하며 같은 값으로
취급하지 않는다. 요청값·effective 값·생성 인자·host 확인값을 구분한다. unknown/unsupported/
mismatch/persistence failure는 실행을 중단하는 fail-closed 조건이다. provider 내부 적용은
별도 확인 전까지 미확인이다. native 도구가 effort 인자를 지원하지 않으면 prompt로 대체하지
않는다. exact-effort는 plan의 `executionSettings.mode: "exact"`와 내부 claim 진단·차단 경계로
검사하며 지원 근거를 꾸미거나 검사를 우회해 재시도하지 않는다.
Transient failures may retry; contract, dependency, plan, and external failures require diagnosis.
Use `$METIS performance report --pretty` for verified completion, phase,
concurrency, slot-utilization, cache, and effort evidence. Benchmark reports
must keep baseline, candidate, and plain-host variants, use verified-only
median/nearest-rank P95, and retain failure/pass-rate counts separately.
## Start and controller ownership
1. mode를 먼저 해석한다. PRD/status는 실행 루프에 들어가지 않는다.
2. launcher와 global/plugin command availability를 확인한다.
3. 새 목표/빈 fixture면 `$METIS model show`로 실제 지원 model/effort를 확인하고, 지원값으로
   `$METIS model configure --data '<configuration>'`를 `start` 또는 `--plan-only` start 전에
   완료한다. 기존 active/blocked run의 설정은 바꾸지 않는다.
4. 필요한 mode만 현재 host에 맞는 attach 명령을 force false로 실행한다: Codex는
   `$METIS attach --host codex`, Claude Code는 `$METIS attach --host claude`, OpenCode는
   `$METIS attach --host opencode`이며 explicit/enclosing Git root만 사용한다.
5. `$METIS lifecycle --pretty`를 확인하고 소유권·기존 run 규칙을 따른다. 새 `plan` 또는 bare
   objective의 internal `execute`는 plan-only start 경계를 사용하며 paused는 원인 확인 후 재개한다.
   다른 live Main이나 expired lease를 자동 인수하지 않는다.
6. Preserve the returned controller credentials. 모든 변경 명령에 제공한다.
7. `$METIS goal restore --pretty`로 목표·계약·출처·계획·상태를 복원한다. 계약이 없으면 intake를
   수행하고 source handle은 필요한 범위만 읽는다.
8. sealed plan 직전 executionSettings를 사용자에게 확인받아 저장·hash·contentRef·task binding을
   검증한다. persistence/지원/mismatch가 있으면 멈추며, `plan execute --reason`만 실행 승인이다.
9. `$METIS next --pretty`의 action만 실행하고 결과·증거를 저장한다. resume/continuation은 승인하지
   않으며 compact 후에는 restore와 executionSettings/task 재검증부터 반복한다.

Do not scan unrelated repository content during attachment or routing.
Controller credentials use:

```text
METIS_CONTROLLER_SESSION
METIS_CONTROLLER_OWNER
METIS_CONTROLLER_FENCE
METIS_CONTROLLER_TOKEN
```

Do not attach a second Main to a live run; renew at the runtime interval and use takeover only after the previous Main is inactive.
Continuation is a separate opt-in preview: `install|uninstall` and
`inspect|bind|detach` require actual host session IDs and explicit native-goal
inactive evidence; `/goal $metis` remains legacy native-evaluator, and standalone
continuation has no full-goal E2E support claim.
## Durable-state rule

The runtime is the source of truth.
Conversation history is not the source of truth.
Do not bypass phase gates.
Do not edit SQLite directly.
Do not keep raw source, patches, logs, screenshots, or child transcripts in Main context.
Store large material as typed evidence, artifacts, or runtime objects.
Inspect state with:

```sh
$METIS status --context --pretty
$METIS journal replay --pretty
```

## Goal Contract
Freeze one Goal Contract during intake.
It must contain:

- objective;
- scope;
- non-goals;
- constraints;
- measurable success criteria;
- complexity and lifecycle route;
- atomic requirements with acceptance criteria.

Use:

```sh
$METIS contract freeze --data '<json>' --pretty
```

Do not silently change the contract.
Use `contract amend` with a reason.
A material amendment needs user approval and invalidates dependent state.

Read [contracts.md](references/contracts.md) for traceability.
Read [approval.md](references/approval.md) for authority boundaries.

## Universal task graph
Use runtime tasks for the complete lifecycle:

```text
discovery
research
synthesis
design
planning
compilation
implementation
integration
diagnosis
repair
review
verification
curation
```

Every task has one independently verifiable outcome.
It also has a role, phase, wave, dependencies, scope, interfaces, acceptance criteria, evidence, authority, stop conditions, and result schema.

A wave is a parallel boundary.
The scheduler dispatches only the earliest open wave.
Do not start a later wave until every task in the earlier wave is terminal.
Do not split work merely to increase parallelism or to fill a host slot. The
planner must record why each slice is independent, why coupled work remains
atomic, and what graph width the evidence supports. Preserve an explicit
parallel requirement, but never create unsafe overlapping slices merely to
satisfy it. The graph's independent width is separate from the host's configured
simultaneous-child capacity: for example, an eight-task independent graph stays
width eight while a host configured for four runs at most four at once and
leaves the remainder eligible. Use the active host's actual setting plus Metis
budgets; do not infer a universal cap or a Codex/Claude-specific constant.
Read [lifecycle.md](references/lifecycle.md) for phase rules.
Read [delegation.md](references/delegation.md) for scheduling rules.

## Discovery, research, design

[lifecycle.md](references/lifecycle.md)의 현재 phase 지침만 읽는다.
Main은 broad 조사·구현·자가 검증을 하지 않는다. runtime의 scout/researcher wave,
synthesizer, designer와 필요한 independent critic을 사용한다. synthesizer는 공급된
증거만 합성하며 새 조사를 하지 않는다. 현재 사실인 research와 재사용 절차인
capability를 구분하고, 매 작업마다 새 스킬을 웹에서 찾지 않는다.
UI에는 필요한 experience-contract/visual-contract/browser-acceptance를 만들고
공유 interface와 정확한 design seal을 검증한 뒤 계획한다.

## Planning and PlanDraft
Dispatch a planner subagent after the design is approved.
The planner returns a typed `PlanDraft`.
It does not write child prompts.

The draft defines:

- frozen interface candidates;
- milestones with observable outcomes and exit criteria;
- tasks with kinds and waves;
- dependencies and parents;
- scope and mutable paths;
- interface inputs and outputs;
- acceptance criteria and evidence;
- risk, effort, and slice type;
- verification modes and capabilities.

After the planner completes, execute this action standalone: `$METIS plan ingest
<planner-task-id> --pretty`. Capture exit/result first; never chain with `next` or
`jq`. On success run `$METIS next --pretty` alone; its generic `Sealed plan is
missing` future gate is not an ingest error. On error preserve the typed error,
run standalone `next` only to rediscover the action; execute only that action; never diagnose/materialize unless it explicitly returns a diagnosis action.

The runtime validates IDs, dependencies, cycles, interfaces, waves, and task boundaries.
It then creates deterministic Task Packets and any required compiler tasks.
Seal the graph only after all required Task Packets are ready.
Dispatch an independent `plan-critic` against the sealed plan.

## Task Packets

Never send a one-line instruction such as “implement this and test it.”
Every child receives one compiled Task Packet and no Main transcript.
A packet includes:

- role protocol;
- objective and rationale;
- owned scope and non-goals;
- frozen interfaces;
- upstream contracts;
- selected context;
- selected capability procedures;
- execution steps;
- acceptance criteria;
- verification plan;
- authority boundary;
- stop conditions;
- structured result schema.
Inspect a packet with:

```sh
$METIS task packet status <task-id> --pretty
$METIS task contract <task-id> --pretty
```

If the compact host contract contains a packet object reference, load the full object before execution.

### Task compiler

Ordinary tasks use deterministic packet assembly.
Complex, high-risk, critical, or large execution tasks can require a fresh `task-compiler` subagent.

The compiler can improve:

- objective clarity;
- execution order;
- context priority;
- interface notes;
- verification detail;
- additional stop conditions;
- handoff notes.
The compiler cannot change:

- scope or mutable paths;
- authority;
- dependencies;
- acceptance criteria;
- frozen interfaces.

If the compiler reports ambiguity, block the target task.
Return to design or planning.
Do not ask the worker to guess.

## Frozen interfaces

Parallel workers must not invent shared boundaries.
Bind tasks only to frozen interface contracts.
Require every completed child to attest each consumed and produced interface with its exact frozen content hash.
Interfaces can define:

- function or module signatures;
- HTTP request and response forms;
- events or messages;
- database records;
- UI state contracts;
- files exchanged between tasks.
A new frozen version makes linked packets stale.
Rebind and recompile before dispatch.
A worker can report an interface conflict but cannot silently change the contract.

## Capabilities

A role defines responsibility.
A capability defines a focused procedure.
A tool performs an action.

```text
role + selected capabilities + task blueprint -> Task Packet
```

Use only local capabilities selected by the runtime.
Do not load every available skill.
Do not create a fixed specialist role for every framework.
Current dependency facts belong in researcher evidence.
Useful external workflow patterns must be curated into the local capability catalog outside the active task.

## Claim and spawn a wave

Preview when useful:

```sh
$METIS schedule propose --pretty
```

Claim the current atomic batch:

```sh
$METIS schedule claim --owner metis-main --pretty
```

Treat a claimed multi-item batch as one concurrent host fan-out. Spawn only the
returned descriptors, and submit spawn calls for every available descriptor
before any wait. Never alternate spawn and wait per child.
Use the exact role, model, reasoning effort, workspace, lease, and bounded contract.
Use `fork_turns: "none"` for Codex children.
Respect the host's actual child-slot capacity; Main may occupy one total thread.
Do not pretend rejected or unavailable spawns ran: explicitly abort or recover
each rejected or unavailable descriptor.
The owner, not Main, coordinates the active bounded subtree after handoff.
It may use low-cost agents for execution and a separate receipt-backed verifier
only when the configured host execution mode explicitly permits child spawning.
The owner reports local progress and normal completion to Main through the
parent result boundary; Main receives only the compact state needed for goal
coordination. Child terminal handoff goes to the parent owner, while only the
root owner uses Main's `next`/action boundary.
Acknowledge only after the host spawn tool returns a nonempty child/session/agent receipt for every descriptor, bound to its exact task and lease attempt:

```sh
$METIS schedule ack <batch-id> --tasks <id1,id2> --receipts '{"<id1>":{"receipt":"<host-receipt-1>","batchId":"<batch-id>","taskId":"<id1>","attemptFence":1},"<id2>":{"receipt":"<host-receipt-2>","batchId":"<batch-id>","taskId":"<id2>","attemptFence":1}}' --owner metis-main --pretty
```

A claim does not consume spawn budget. The spawn acknowledgement consumes it once
and persists only returned receipt identifiers, never raw child output. If a host
spawn is rejected or returns no receipt, do not acknowledge it; abort or recover
the unspawned descriptor explicitly.
Heartbeat active batches:

```sh
$METIS schedule heartbeat <batch-id> --pretty
```

This renews controller and task leases.
Wait in bounded intervals until every child result is terminal.

## Worktrees and results
Every mutable attempt uses a detached Git worktree.
There is no shared workspace fallback.

A child can change only its owned paths.
It must report every changed file.
It cannot cross symbolic links outside the repository.
It cannot finish a newer fenced attempt.

A terminal result must follow the packet result schema.
It must report acceptance results, interface use, checks, artifacts, evidence, blockers, and changed files.
A statement such as “done” is not a result.

## Diagnosis and repair
Do not retry a failed or blocked task immediately.
When requested, dispatch a fresh `diagnostician`.

The diagnostician identifies the earliest invalid state and recommends one route:

```text
retry
change reasoning route
revise contract
add dependency
reconcile integration
reopen plan or design
request external authority
```
Main selects one route from the completed diagnosis.
Main does not perform the repair.
A repair becomes a new bounded task.

## Review and verification

Review the integrated repository with fresh reviewer tasks.
Use only the specialist capabilities selected by current requirements, paths, interfaces, and risks.
Blocking findings become repair tasks.
After repair, run fresh review against the new fingerprint.
Verification can include:

- structured deterministic checks;
- semantic verifier tasks;
- browser verifier tasks;
- conditional human checkpoints;
- an immutable verification candidate;
- `adversarial-reviewer` completion review.

A verifier must be a distinct host receipt/agent from the worker and must
inspect the worker's result independently. Main must not operate the browser or
judge screenshots.
A browser verifier records assertions, viewport, screenshots, console errors, network failures, and code fingerprint as browser evidence.

## Curate and complete

Dispatch a curator for human documentation changes.
Run generated index and knowledge synchronization after current code is verified.
Completion requires current runtime state:

- requirements traced;
- required tasks terminal;
- interfaces current;
- checks current;
- reviews current;
- browser evidence current when required;
- checkpoints resolved;
- verification candidate current;
- adversarial completion review current when required;
- documentation and knowledge current;
- no blocking risk, budget, or progress state.

Run self-evaluation before completion.
Read [curation.md](references/curation.md).

## Stop states

PRD/status는 산출물에서 종료한다. plan은 현재 계획의 실행 승인 대기에서 종료하고 스스로 승인하지
않는다. `run`/`resume` 또는 bare objective의 internal `execute` 결과는 다음 상태에 반환한다:

- `COMPLETE`;
- `USER_OR_AUTHORITY_REQUIRED`;
- `BUDGET_DECISION_REQUIRED`;
- an unrecoverable recorded blocker.

For `STALLED_REPLAN`, change the evidence search, design, task boundary, capability route, or model route.
Do not repeat the same action.
Read [recovery.md](references/recovery.md) and [token-policy.md](references/token-policy.md) when those gates activate.
