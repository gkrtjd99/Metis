# 계획 요약 — [목표 제목]

> **TEMPLATE NOT COMPLETE** — 이 문서는 사람이 읽는 파생 요약이다. runtime의
> 봉인된 `PlanDraft`와 `tasks`가 기준이며, 이 문서에 수동 상태·진행률·일정을
> 만들어 runtime 상태를 흉내 내지 않는다. 확인되지 않은 값을 채우지 않는다.

## 출처와 상태

- 저장 경로: `docs/metis/<goal-slug>/plan.md` — `goal restore.documents.plan`과 일치
- Run ID / Goal Contract hash: [현재 runtime 참조]
- Seal artifact ID / contentRef: [현재 봉인 계획 참조; stale/초안으로 대체하지 않음]
- 파생 시점: [실제 조회·갱신 시점; 자동 동기화 아님]
- Goal/PRD 식별자: [식별자 또는 `미정`]
- PRD 경로: [예: `docs/metis/<goal-slug>/prd.md` 또는 `미정`]
- PlanDraft 식별자·버전: [runtime이 제공한 값 또는 `미정`]
- PlanDraft 봉인 시점: [runtime 값 또는 `미정`]
- 요약 갱신 근거: [PlanDraft/런타임 참조 또는 `미정`]

> 이 요약에 표시된 내용이 runtime과 다르면 runtime을 우선한다. 본 문서는
> task 상태의 별도 authority가 아니다.

## 실행 설정 확인

- 기존 model/effort 설정: [runtime durable 설정에서 미리 채운 값 또는 `미정`]
- 독립 역할별 model/effort: [계획에 필요한 역할과 확인된 값의 요약 또는 `미정`]
- 선택적 owner: [사용자가 선택·확인한 owner 또는 `없음`]
- 사용자 확인: [host dialog 확인 기록과 runtime `userApproval` 참조 또는 `대기`]
- 변경 승인: [명시적 승인 참조 또는 `없음`]
- 실행 설정 seal: [`executionSettings` 참조, `mode: exact` 여부, 또는 `미정`]
- provider runtime 상태: [`effectiveEffort`/`effortStatus`/`effortSource`/`supportedEfforts` 참조 또는 `미확인`]
- 적용 범위: [worker/verifier child route만 적용; Main host-session model/effort는 변경하지 않음]

이 항목은 계획 단계에서 host dialog가 보여 준 현재 설정과 사용자의 확인을
요약한다. owner를 자동으로 추가하거나 모든 task에 배정하지 않는다. host dialog의
확인과 provider 내부 적용 증거는 구분하며, 내부 적용이 확인되지 않으면 `미확인`으로
표시한다. 실행·resume은 runtime durable state를 기준으로 엄격히 재사용한다.
이 요약에는 CLI flag나 수동 진행 상태를 별도로 만들지 않는다.

## 목표와 완료 결과

- 목표: [승인된 목표의 한 문장]
- 제품 결과: [제품 지표 또는 기대 결과의 요약]
- engineering 완료조건: [PRD에서 분리한 검증·문서·운영 완료조건의 요약]

## 봉인된 설계·인터페이스 요약

- 주요 인터페이스: [PlanDraft가 봉인한 인터페이스 요약 또는 `미정`]
- 중요한 의존성: [runtime이 기록한 의존성의 요약 또는 `미정`]
- 변경 경로 경계: [봉인된 scope/mutable paths의 요약 또는 `미정`]

## 마일스톤 요약

PlanDraft의 마일스톤을 사람이 읽기 쉽게 요약한다. 상태, 완료율, 담당자,
예정일을 이 문서에서 수동으로 관리하지 않는다.

| 마일스톤 ID | 관찰 가능한 결과 | 종료 기준 |
| --- | --- | --- |
| `[runtime milestone id]` | [PlanDraft의 결과] | [PlanDraft의 종료 기준] |

## 작업 구성 요약

아래는 task의 목적과 관계를 설명하는 요약일 뿐이다. 각 task의 현재 상태,
lease, attempt, receipt, 진행률 또는 수동 체크박스를 기록하지 않는다. 상세
계약, scope, 의존성, acceptance criteria, evidence, verification mode는
runtime이 봉인한 task/Task Packet을 참조한다.

| Task ID | 목적/산출물 | 선행 관계 | 검증 방식 |
| --- | --- | --- | --- |
| `[runtime task id]` | [봉인된 task outcome] | [task ID 또는 `없음`] | [봉인된 방식 또는 `미정`] |

## 위험과 미정

- runtime이 기록한 위험: [요약 또는 `미정`]
- 외부 권한·결정 대기: [요약 또는 `없음`]
- PlanDraft가 정하지 않은 사항: [질문과 영향]

## Authority 경계

- 계획의 기준: runtime의 봉인된 `PlanDraft` 및 `tasks`
- 목표 계약/요구사항의 기준: 승인된 PRD와 Goal Contract
- durable decision의 기준: 기존 decision 기록 체계
- 이 문서의 역할: 위 기준을 사람이 읽기 쉽게 요약
- 이 문서에서 금지: runtime 상태의 수동 복제, 임의 task 추가·삭제·상태 변경,
  구현 지시의 발명
