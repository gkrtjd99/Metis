# 작은 작업 직접 실행과 host 생성 설정 전달

날짜: 2026-09-07

## 원래 요청과 결정

- 사용자의 개인 모델·effort 조합은 플러그인 기본값이나 다른 사용자에 대한 강제 정책이 아니다.
- subagent 생성 시 요청한 effort 변경이 무시되거나 거부되는 문제에 대해 실제 host 지원 생성 경로가 필요하다.
- 불필요한 조정 호출을 줄인다.
- 작은 작업은 별도 task 분해·owner 하위 트리를 요구하지 않고 worker와 독립 verifier를 바로 실행한다.
- 변경 후 같은 모델·effort·권한·입력 조건으로 실제 실행을 비교한다.

## 유지할 경계

- 모델은 사용자/host 선택을 따른다. 요청값과 협상값, 실제 생성 인자, host 확인값을 구분한다.
- 지원되지 않는 native Agent 인자를 prompt 지시로 적용했다고 주장하지 않는다. 지원되는 명시적 CLI 생성은 기존 권한 범위에서만 사용한다. 권한 거부를 다른 도구로 우회하지 않는다.
- CLI가 명령을 수용한 것은 provider 내부 effort를 확인했다는 뜻이 아니다. 확인값이 없으면 미확인으로 남긴다.
- 내부 실행 기록은 receipt, lease, attempt fence, 결과, 복원을 위해 유지한다. 'task 없이'는 별도 계획용 task 분해와 owner·검토 역할 그래프를 사용자/모델이 작성하지 않는다는 뜻이며, 내부 기록을 지운다는 뜻이 아니다.
- 작은 작업도 worker와 verifier는 서로 다른 실제 host receipt를 가진다. 동일한 immutable 통합 후보에 대한 독립 검증이 없으면 완료할 수 없다.
- balanced/full 작업, 기존 실행, plan-only 명시 승인, controller fencing, scope·traceability·증거 검사는 약화하지 않는다.
- 별도 reviewer/adversarial reviewer/curator를 실행하지 않은 경우 실행했다고 표시하거나 검토 결과를 위조하지 않는다. 작은 작업의 통합 독립 검증에서 파생된 상태 기록으로 명시한다.

## 구현 범위

1. 모델·effort 생성 계약
   - 선택 모델을 명시적 CLI argv에도 반영한다.
   - 요청 effort alias와 일반/빠른 경로의 저장 필드를 일관되게 처리한다.
   - native Agent의 per-child 인자 지원 여부와 CLI 생성 경로를 구분한다.
   - 요청·전달·수용·거부·확인 불가를 구분한다.
2. 조정 프로토콜
   - runtime action에 run/root가 결속된 typed argv를 추가하고 기존 문자열 projection은 호환 목적으로 유지한다.
   - `schedule claim`이 준비를 수행한다. 별도 `schedule prepare` 명령은 만들지 않는다.
   - prepared 이후 전체 spawn, 실제 receipt 묶음 ACK, host 완료 알림 또는 bounded wait를 사용한다.
   - runtime `task.finished`와 host-native 완료 알림은 다른 사건이다. 이미 종료된 task는 중복 finish하지 않는다.
   - 반복적인 ListAgents/ScheduleWakeup 대신 완료 알림과 필수 heartbeat를 사용한다.
3. 작은 작업 직접 실행
   - 새 bounded fast 경로는 worker·독립 verifier 2실행을 사용한다.
   - 기존 fast 5역할 실행은 기존 기록에 따라 복원한다.
   - 작은 작업의 eligibility와 승인 근거는 runtime이 검증하며, 사용자 route 문자열만으로 일반 검토 게이트를 면제하지 않는다.
   - 최소 문서/진행 기록은 verified evidence로 생성하되 의미 검토를 수행했다고 주장하지 않는다.

## 검증 기준

- 모델·effort 요청이 전달 과정에서 무음 누락되지 않는지 검사한다.
- 지원 불명/지원 불가/거부/확인 불가를 성공으로 표시하지 않는다.
- run 결속 argv, 실제 receipt binding, 중복 ACK, stale controller/attempt, 준비 중 spawn 방지, 완료 시 중복 finish 방지를 검사한다.
- 새 fast 실행 2개와 기존 fast/balanced/full 격리, 독립 verifier·candidate·scope·증거 drift·plan-only 승인 검사를 수행한다.
- `npm run check`와 설치 mirror/문서 검사를 실행한다.
- native 비교에서는 양쪽 전체 runtime 완료 여부를 먼저 보고한다. 중단 시간을 완료 속도로 계산하지 않는다.
- raw host 로그·controller 자격정보는 비공개 임시 fixture에만 보존한다. 비용은 CLI 추정치와 실제 청구액을 구분한다.

## 선행 native effort 경로 probe

명시적 `claude --model sonnet --effort max`로 도구 없는 단일 응답을 요청했다.
CLI는 exit 0 / success, wall 2.985초, CLI 추정 $0.01367을 반환했다.
실행 인자 전달과 CLI 수용은 확인했지만 host/provider effort 확인 필드는 없어 미확인이다.
이 probe는 Metis 전체 실행 또는 per-child native Agent 전달 증거가 아니다.
증거: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-effort-flow-70aljvoi/summary.json`.

## 개선 전 native 실행 결과

직전 개선 전 snapshot을 설치한 별도 fixture에서 Sonnet/max, parent CLI 예산 $2.00, 제한 600초로 실행했다. child는 동일 모델·effort의 명시적 CLI 생성 helper를 사용하도록 했으며, 기본 권한 경계는 변경하지 않았다.

- parent CLI: exit 0 / success, 260.411초, 34 turns, CLI 추정 $0.6919244.
- 실제 목표: **미완료**. runtime은 `active / execute`, worker를 포함한 내부 실행 5개 모두 pending이다.
- helper의 child 생성 Bash 명령이 권한 거부되어 child 실행·receipt·ACK는 모두 0개다. 승인 경로를 바꾸거나 거부된 명령을 우회하지 않았다.
- 원래 테스트 파일은 유지됐다. 구현은 실행되지 않아 root 값은 41이고 외부 테스트는 실패했다.
- CLI의 정상 종료를 runtime 완료로 계산하지 않는다. 이 시간은 완료 지연시간 비교나 속도 향상 계산에 사용할 수 없다.
- 비용은 해당 parent CLI의 list-price 추정치이며, 감독 agent 비용이나 실제 provider 청구액이 아니다.

증거: `/private/tmp/metis-small-work-bench-hnjsjme8/before-summary.json`.

## 구현에 반영한 조정 감소

- 새 bounded fast 경로의 내부 실행 역할은 5개에서 2개로 줄었다. **역할 실행 수 기준 60% 감소**이며, 전체 지연시간·토큰·비용 60% 감소를 뜻하지 않는다.
- `schedule claim` 한 번이 작업 claim과 workspace·baseline·contract 준비를 함께 처리한다. 별도 prepare 호출은 필요하지 않다.
- 준비된 batch 전체를 생성한 뒤 실제 receipt를 한 번의 batch ACK로 제출하는 host 프로토콜을 제공한다. 필요한 controller heartbeat는 유지한다.
- 종료 알림 뒤 durable 상태를 먼저 확인하도록 하여 중복 finish를 피한다. host 알림이 없을 때는 bounded wait를 사용한다.
- fast v2에서 독립 verifier가 완료되면 인증된 `drive` 호출이 파생 승인·verification candidate·지식 기록·self-evaluation·완료 전이를 처리한다. 별도 reviewer나 curator가 실행했다고 표시하지 않는다.

## effort 전달 범위

`--require-exact-effort`는 concrete model, 요청/협상값 일치, 지원 근거, 실제 adapter 전달 경로를 claim 전에 확인한다. 현재 strict 전달 adapter는 Claude와 Codex이며, OpenCode/generic host는 capability 목록만으로 전달 성공을 주장하지 않고 차단한다. 알 수 없는 상태나 명시적 미확인은 strict 성공으로 승격하지 않는다.

## 개선 후 native 실행 결과와 비교 판정

동일 fixture 설치 절차, 입력, Sonnet/max, CLI 예산·시간 한도, 권한 목록과 helper를 사용했다. 변경된 runtime source 71개 파일의 SHA-256을 snapshot으로 고정했다.

| 관측값 | 개선 전 | 개선 후 |
| --- | ---: | ---: |
| parent CLI 종료 시간 | 260.411초 | 117.434초 |
| parent CLI turns | 34 | 6 |
| parent CLI 추정 비용 | $0.6919244 | $0.1629952 |
| child 실행 / ACK | 0 / 0 | 0 / 0 |
| 권한 거부 횟수 | 1 | 2 |
| runtime 상태 | active / execute | run 생성 전 |
| 전체 목표 완료 | 아니오 | 아니오 |

개선 전에는 child 생성 helper 명령이 거부됐다. 개선 후에는 `entry resolve`의 Node 호출이 거부됐고, native Main이 시도한 Python argv 호출 역시 거부됐다. 둘 다 승인 surface 부재로 종료했으며, 권한 설정을 확장하거나 controller 상태를 복구 조작하지 않았다. 개선 후 최종 응답의 'Python helper'라는 표현과 달리 구조화된 거부 증거는 child 생성이 아니라 진입 명령의 Python 호출이었다.

두 조건 모두 원래 테스트 파일은 유지됐지만 구현이 실행되지 않아 root 값은 41이고 외부 테스트는 실패했다. CLI exit 0 / success는 모델 세션 종료일 뿐 runtime 완료가 아니다. 중단 단계부터 서로 다르므로 위 숫자로 속도·토큰·비용 개선율을 계산하지 않는다. 양쪽 native CLI 추정 비용 합계는 $0.8549196이며, 선행 probe $0.01367과 감독 agent 비용·실제 provider 청구액은 포함하지 않는다.

**판정: 구조적 역할 수 감소와 runtime 자동화는 구현·테스트했으나, native 완료 성능 비교와 실제 child effort 전달 E2E는 권한 차단으로 미검증이다.** CLI Sonnet/max 수용 probe 역시 provider 내부 적용 확인을 대신하지 않는다.

증거: `/private/tmp/metis-small-work-bench-hnjsjme8/{before,after}-summary.json`, `after-source-hashes.json`. 비공개 raw 로그와 DB는 임시 fixture에 보존하며 저장소에 포함하지 않는다.

## 회귀 검증

- 공식 scheduler claim·ACK·finish와 controller drive를 사용하는 테스트용 receipt E2E에서 fast-v2 `COMPLETE` 및 두 task만 존재함을 확인했다. native 실행 증거가 아닌 자동화된 runtime 테스트다.
- failed verifier는 완료를 차단한다. 같은 receipt, stale candidate, forged plan marker, seal drift, packet binding 누락·중복도 거부한다.
- 상태 조회의 task/packet 무변경, 기존 fast-v1 5역할 replay, 일반 plan-only 명시 승인 보호를 검사했다.
- effort strict 검토에서 generic host 전달 누락과 알 수 없는 상태의 성공 승격을 수정하고 독립 재검증했다.
- 문서·skill mirrors·설치·패키징 검사를 통과했다. SKILL은 494줄, package dry-run은 219개 파일이며 runtime dependency와 package version 1.1.0은 유지했다.
- 최종 `npm run check`: **578 tests / 577 pass / 0 fail / 1 skip**. Chromium 미설치로 실제 browser process 테스트 1개만 skip했다. 로그: `/private/tmp/metis-small-work-check-complete.log`.
- 최종 검사 후 native snapshot과 작업 저장소의 runtime source 해시가 모두 일치함을 확인했다.
- commit·push·PR·release는 수행하지 않았다.
