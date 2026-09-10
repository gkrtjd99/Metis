# 계획 실행 설정 승인과 host별 동시 실행 정책 분리

날짜: 2026-09-08

## 목표와 승인 범위

사용자가 검토 내용을 반영한 계획 작성과 구현·검증을 승인했다. 구현과 지침 작업은 Sonnet agent에 분담하고 Main은 통합·검증을 수행한다. 기존 미커밋 변경은 보존하며 commit·push·PR·release, global host 설정 변경, runtime dependency 추가는 하지 않는다.

## 설계 결정

1. 계획의 task 경계는 독립 산출물·완료 기준·실제 결합도를 따른다. host 동시 실행 슬롯을 채우려고 task를 분해하지 않는다.
2. host별 동시 실행 한도는 scheduler 책임이다. Codex 환경의 제한을 Claude Code 공통 규칙이나 계획의 최소 task 수로 적용하지 않는다. 제품의 보편적 Codex 한도를 추정하여 하드코딩하지 않는다.
3. 기존 lint의 dependency·path 충돌·검증·예산·fence 검사는 유지하고, 최소 네 task 또는 네 수정 경로를 근거로 분해를 강제하는 정책은 제거·수정한다.
4. 새 분해 엔진을 만들지 않는다. 기존 planner/Main이 근거를 제출하고 기존 plan-critic이 과분해·과소분해를 검토한다. critic은 task를 수정하는 인터페이스가 아니며 필요 시 Main이 수정·재봉인한다.
5. plan 단계에서 host 대화를 통해 필요한 역할의 모델·effort를 확인한다. 기존 설정은 제안값으로 사용하고 개인 조합은 강제하지 않는다. 작은 작업에 owner를 추가하지 않으며 일반 작업도 조정 필요성과 host 지원이 있을 때만 owner를 둔다.
6. 사용자가 승인한 실행 설정은 durable 계획과 결속한다. run/resume에서 내부적으로 적용하고 사용자가 매번 strict CLI flag를 입력하지 않게 한다. 지원 불가·거부·승인 이후 설정 변경은 무음 fallback/escalation하지 않는다.
7. requested/effective/전달/host 확인을 구분한다. CLI 수용은 provider 내부 적용 확인이 아니다. 명시적 선택이 없는 기존 inherited/unknown 흐름을 임의의 exact 요구로 승격하지 않는다.
8. runtime 완료 authority, plan-only 명시 승인, 독립 verifier, 실제 host receipt, current candidate와 seal 검사를 유지한다.

## 작업 분담과 순서

### A. 작업 분해와 실행 한도

Sonnet이 plan-review와 scheduler/config의 실제 host별 한도 인터페이스를 확인하고 기존 경로를 재사용한다. 최소 task 수·파일 수 강제 조건과 desired width의 강제적 최대 슬롯 사용 여부를 정리한다. task graph 수와 dispatch 수를 분리하는 회귀 테스트를 작성한다.

### B. 실행 설정 승인

Sonnet이 기존 task/plan snapshot, checkpoint, skill-entry와 CLI를 재사용하여 실행 설정 확인·승인의 durable 계약을 연결한다. scheduler automatic strict 접점은 A 담당자 및 Main과 조정한다. approval의 current plan binding과 설정 변경·재개를 테스트한다.

### C. host 지침과 문서

Sonnet이 planner/critic 지침, plan skill·template와 host mirrors를 수정한다. 실제 구현된 CLI/API에 맞춰 확인 질문·승인·실행·변경 흐름을 기술한다. canonical SKILL 500줄 이하를 유지한다. generated REFERENCE는 Main이 generator로 갱신한다.

### D. 통합과 검증

Main은 경계 연결을 검토하고 focused 검사 및 전체 `npm run check`, docs/mirror/package/whitespace 검사를 실행한다. 독립 Sonnet 검토는 완성된 변경의 승인 우회와 host 격리에 집중하며 불필요한 재조사·추가 orchestration은 피한다.

## 수락 테스트

- 독립 변경 두 개를 최소 네 task 요구 없이 계획할 수 있다.
- 독립 변경 여덟 개의 task graph는 그대로이며 한도 네 개인 host fixture에서 동시 실행만 네 개로 제한된다.
- 결합된 네 수정 경로는 개수만으로 분해를 강제하지 않는다.
- 동일 graph를 다른 host에서 평가할 때 Codex 전용 설정이 Claude에 적용되지 않는다.
- path overlap, 실제 dependency, 병렬 요구사항, budget/concurrency/fence 안전 검사는 유지된다.
- plan에서 승인한 모델·effort가 실행·재개에 적용되며 승인 후 변경·지원 불가·거부는 실행 전에 차단된다.
- 명시적 effort 요청에서 strict flag를 생략한 일반 host 실행도 승인 설정을 우회하지 않는다.
- plan-only 사용자 실행 승인, legacy fast-v1 및 bounded fast-v2와 일반 계획의 검증 게이트가 유지된다.
- 사용자 입력·동작을 가장한 승인이나 synthetic receipt로 native 완료를 만들지 않는다.

## 검증과 결과 기록

### 구현 결과

- 최소 네 task·네 파일이라는 공통 분해 기준을 제거했다. 독립 산출물·의존성·경로 소유권·검증 기준은 기존 lint와 plan-critic으로 검토한다.
- 프로젝트 Codex 설정의 실제 동시 실행 한도를 scheduler proposal, claim transaction, direct claim에 적용했다. Claude에는 Codex 설정을 적용하지 않는다. 잘못된 설정과 symlink 경로는 실행 허용으로 해석하지 않는다.
- 계획의 `desiredWidth`는 task graph를 줄이지 않고 execute 단계의 동시 실행 폭만 제한한다. 이미 실행 중인 task도 포함해 반복 claim으로 초과하지 못하게 했다.
- 일반 계획은 `plan seal --data/--file`, fast 경로는 `drive --data/--file`을 통해 host 대화에서 확인한 실행 설정을 저장한다. 사용자는 내부 strict flag를 기억할 필요가 없다.
- 승인 설정은 현재 plan hash와 task 집합에 결속된다. scheduler와 direct claim에서 승인 후 모델·effort 변경, 지원 불가·미확인, 실제 전달 경로 부재를 차단한다. 승인 정책이 없는 legacy 흐름은 유지한다.
- transient 재시도는 승인 route를 유지하고, route를 바꾸는 직접 escalation은 재승인을 요구한다. 이전 plan이 stale이 되어도 승인 흔적을 잊지 않는다.
- fast 설정 변경은 실행 중 task가 없는 상태에서 `reopen discover` 후 새 설정을 넣은 `drive`로 처리한다. canonical worker/verifier 두 task와 plan/packet/review 결속을 다시 만들며, plan-only 실행 승인은 새로 받아야 한다.
- 현재 Main host session의 모델·effort는 child route 설정으로 변경하지 않는다. 사용자 승인과 provider 내부 적용 확인은 별개이며 개인 모델·effort 조합을 제품 공통 정책으로 강제하지 않는다.

### 검증

최종 `npm run check` 통과: **599 tests / 598 pass / 0 fail / 1 skip**, 약 60.7초. Chromium 미설치로 실제 browser evidence 테스트 한 개를 건너뛰었다. 이 결과는 이번 최종 소스 기준이며 이전 구현의 테스트 수를 재사용하지 않았다.

- 승인 설정을 포함한 공식 runtime worker·독립 verifier 경로가 `COMPLETE`에 도달하는 E2E를 확인했다. 이는 unit fixture이며 native host 완료 증거는 아니다.
- 독립 Sonnet 검토에서 발견한 seal 실패 시 route 변경 잔류를 수정했다. `sealPlan` 내부 변경과 CLI의 seal·artifact 저장을 transaction으로 묶었고, 순환 graph 실패 전후 모든 route 필드가 동일함을 독립 재검증했다. 파일 기반 object blob의 orphan 정리는 별도이며 실패한 artifact나 route 상태는 DB에 남기지 않는다.
- host 한도와 desiredWidth 제한, 직접 claim의 세 번째 task 차단, 승인 후 drift·malformed 설정 차단, transient 재시도 route 유지, plan-only 재승인과 legacy 호환 회귀를 통과했다.
- 최종 검사 전후 `src`·`tests` JavaScript 151개 파일의 합성 SHA-256이 동일했다: `698c808698eff63b08c9bb755cb3b7ce2326ae8880319eb24c42da5a654c3359`.

- canonical SKILL 499줄, host mirrors 동기화, 생성 REFERENCE 검사 및 공백 검사 통과.
- package dry-run: 버전 1.1.0, 220개 파일. 새 host-capacity helper 포함, DB·raw log·benchmark summary 등 비공개 증거 미포함.
- Sonnet으로 구현·문서·회귀 테스트·독립 검토를 분담하고 Main이 경계 연결과 통합 검증을 담당했다. Agent 도구의 모델 선택과 per-child effort 보장은 동일한 사실이 아니다.
- native host 실행이나 실제 성능 개선율을 이번 unit/runtime 테스트 결과로 주장하지 않는다. 이전 native 비교는 권한 거부로 미완료였으며 거부된 실행 경로나 global 권한을 우회하지 않았다.
- 기존 브랜치의 미커밋 변경을 유지했다. commit·push·PR·release, 버전 및 runtime dependency 변경은 없다.
