# Contracts and Traceability

The Goal Contract is the stable authority for one run.
Conversation history is not the contract.

## Goal Contract

The contract contains:

- objective;
- scope;
- non-goals;
- constraints;
- measurable success criteria;
- complexity;
- lifecycle route;
- atomic requirements with acceptance criteria.

Freeze it during intake:

```sh
metis contract freeze --data '<json>' --pretty
```

Use an explicit amendment for material changes:

```sh
metis contract amend --data '<json>' --pretty
```

A material amendment needs `approvedByUser: true`.
It invalidates dependent discovery, design, plan, Task Packets, review, verification, and knowledge state.

## PRD 출처와 계획 전용 계약

`plan` mode는 기존 route에 `executionApprovalRequired: true`를 기록한다.
`start --plan-only`로 시작한 의도는 동결 전에도 보존하며, 이 flag를 내려 실행
승인을 우회하지 않는다. 현재 계약·plan seal·review에 결속된 실행 승인 checkpoint가
필요하며, 승인 기록은 계약 내용 변경과 별개다. 명시적 사용자 확인은 plan seal의
`executionSettings` 입력에서 `model`, `requestedEffort`, `confirmed`, 선택적 `evidence`
로 제출하며, runtime이 `mode: "exact"`와 `userApproval`을 durable하게 생성한다.
역할·task별 설정은 `executionSettings.tasks`/`entries`/`roles`에 보존한다. provider
runtime의 `effectiveEffort`·`effortStatus`·`effortSource`·`supportedEfforts`는 사용자가
제출하지 않는 별도 산출물이다. `executionSettings.mode: "exact"`는 명시 승인 seal에서만
runtime이 생성한다. Fast `drive --data`/`--file`도 같은 입력 계약을 사용하지만 child
route만 바꾸며 현재 Main host-session model/effort는 바꾸지 않는다.

PRD를 사용하면 `artifact put prd`로 저장한 snapshot의 `id`와 `content_ref`를
`route.sourceDocument: {artifactId, contentRef}`에 연결한다. 다른 run, 잘못된 kind,
미검증·stale artifact, 불일치 object는 요구 출처가 될 수 없다. 경로는 설명일 뿐
snapshot의 authority가 아니다. 다만 `docs/metis/<goal-slug>/prd.md` 상대 artifact.path는
목표 폴더 binding으로 재사용한다. `sourceDocument`에 path/slug 필드를 추가하지 않는다.
계약에 연결된 artifact.path의 제자리 수정은 거절되며 새 snapshot+amend로 바꾼다.
검증된 snapshot 저장은 사용자 의도의 증명이 아니다.
새 PRD 버전은 새 snapshot과 명시적 amendment로 연결하며, 원래 요구 ID와 변경 이유를
보존한다. PRD/계획 파일에서 runtime과 별개의 작업 완료 상태를 관리하지 않는다.

## Requirements

Use stable IDs such as `REQ-AUTH-001`.
Use one priority: `must`, `should`, or `could`.
Do not combine independent requirements in one record.

Requirement kinds include functional, UI, security, database, migration, accessibility, and performance work.
Kinds help capability routing.
A task title alone must not select a capability.

## Interface contracts

Parallel tasks must consume frozen shared boundaries.
An interface contract can define a function, API, event, record, UI state, or file exchange.

Only a frozen interface can bind to a task.
A new frozen version supersedes the previous version and makes linked Task Packets stale.
A worker can report a conflict.
It cannot silently change the frozen interface.

## Parallel decomposition and host capacity

The plan records an evidence-based decomposition rationale: which slices are
independent, which paths are coupled or overlapping, why the selected graph width
is safe, and why any explicit parallel requirement is satisfied. Independence is
not a request to manufacture slices; unsafe overlap remains atomic or is routed
through an integration boundary. The graph width and the host's simultaneous-child
capacity are separate values. A host cap may defer part of an independent wave
without changing the sealed graph or requiring a smaller plan. Use the active
host's actual setting plus Metis budgets, not a universal or provider-specific
constant. Existing plan-critic checks reuse this rationale to detect both
under-splitting and unsafe over-splitting; they do not imply an additional
classifier, critic, or owner.

## Task blueprint and Task Packet

The structured task blueprint is the source of truth.
The Task Packet is its executable projection.

Protected task fields include:

- scope and mutable paths;
- dependencies;
- authority;
- acceptance criteria;
- frozen interfaces.

A task-compiler can clarify execution but cannot change protected fields.
An unresolved ambiguity blocks dispatch.

## Traceability

Each must requirement must trace through applicable stages:

```text
requirement
  -> discovery or research evidence
  -> design or decision
  -> planned task and interface
  -> implementation evidence
  -> verification evidence
  -> documentation when required
```

Inspect current coverage:

```sh
metis trace report --pretty
```

A stale source, command, browser run, interface, packet, or artifact makes dependent evidence stale.

## Product evidence

UI requirements can require:

- `experience-contract`;
- `visual-contract`;
- `browser-acceptance`;
- current browser evidence;
- a conditional human-verification checkpoint.

Milestones need observable outcomes and exit criteria.
Tasks need task kind, wave, risk, effort, slice type, verification modes, capabilities, interfaces, and expected outputs.

## Governance

Record uncertain statements as assumptions.
Record enduring rules as invariants.
Record credible failure or delivery concerns as risks.
Record durable choices as decisions.

High-impact open assumptions block execution.
Violated critical invariants block completion.
Open critical risks need mitigation or explicit acceptance.
