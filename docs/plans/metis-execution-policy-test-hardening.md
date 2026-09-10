# 실행 정책 인수 검증 보강

날짜: 2026-09-08

## 목적

사용자는 전체 테스트 통과 건수만으로 실제 요구사항 충족을 입증할 수 없다는 점을 지적하고 테스트 보강을 요청했다. 기존 599개 테스트는 내부 회귀 근거이며 실제 host 인수 검증의 대체물이 아니다.

## 검증 경계

1. 공개 CLI를 별도 프로세스로 호출하여 실제 진입·설정 승인·실행·복원 흐름을 확인한다. 정상 경로를 `forcePhase`, raw SQL 상태 변경, 가짜 승인으로 건너뛰지 않는다. 자동 테스트의 사용자 승인과 child 결과는 fixture라는 사실을 명시한다.
2. 방어 로직을 disposable 소스 사본에서 제거하는 변이 실험으로 테스트의 탐지력을 확인한다. 정상 baseline은 통과해야 하며, syntax/import 오류는 mutant 탐지 성공으로 세지 않는다.
3. 실제 설치 host의 모델·effort 전달은 별도 opt-in smoke로 검증한다. 실제 receipt와 bounded 응답을 확인하되 provider 내부 effort 적용, 전체 Metis 완료, 성능 개선율로 확대 해석하지 않는다.
4. 권한 거부·지원 불명·실행하지 않은 host 경로는 미검증 또는 차단으로 남긴다. 기존에 거부된 native parent 실행 경로를 재시도하거나 우회하지 않는다.

## 범위와 분담

- Sonnet: 공개 CLI 인수 테스트 공백 조사, 변이 검증 스크립트, 실제 host 전달 smoke.
- Main: 공개 CLI 회귀 구현·통합, 전체 검사, 요구사항별 결과 기록.
- 기존 dirty tree를 보존한다. runtime 수정은 테스트가 실제 결함을 재현한 경우에만 수행한다.
- commit·push·PR·release, dependency 추가, global host 설정 변경, 권한 확장은 하지 않는다.
- 실제 native 실행은 no-tools/read-only 최소 응답에 한정하고 비용·시간 상한을 둔다. raw 로그와 비밀값을 공개 결과에 넣지 않는다.

## 합격 기준

- 정상 공개 명령 경로가 승인 설정을 보존한다.
- 새 프로세스의 복원·재개가 기존 승인을 잊지 않는다.
- 설정 변경·잘못된 입력·누락된 승인은 실행 전에 차단된다.
- 최소 두 개의 서로 다른 방어 로직을 제거했을 때 테스트 assertion이 실패한다.
- 실제 host 테스트는 관측된 전달 범위와 미확인 범위를 명확히 분리한다.

## 결과

공개 CLI·실제 산출물·실패 판정·변이 검증 보강과 최종 통합 검사를 완료했다. 실제 Claude/Codex 전체 parent loop 인수 검증은 완료 범위가 아니다.

### 기존 테스트의 검증 공백 재현

기존 `approved fast-v2 settings complete through worker and verifier only`는 worker가 쓴 JavaScript에 실제 개행 대신 `\\n` 문자가 들어 있어도 verifier 결과 fixture를 신뢰해 `COMPLETE`에 도달했다. verifier workspace의 모듈을 별도 Node process에서 import하고 export 값을 assertion하는 검증을 추가하자 **0 pass / 1 fail**로 실패했다. fixture의 개행을 수정한 뒤 같은 검증은 **1 pass / 0 fail**이었다. 이 검증은 native LLM이 아니라 실제 파일 실행을 포함하는 runtime fixture 검증이다.

- 실패 증거: `/private/tmp/metis-fixture-real-import-before.log`.
- 정상·잘못된 산출물의 완료 허용 여부는 별도의 공개 CLI process 테스트에서도 검증한다.

### 공개 CLI에서 재현한 runtime 결함과 수정

1. 이미 실행 승인된 plan에 `drive --data`로 변경 설정을 넣으면 입력을 무시하고 `ADVANCE_PHASE`를 적용했다. 이제 해당 입력을 적용할 수 없는 단계에서는 `DRIVE_EXECUTION_SETTINGS_UNEXPECTED` blocker를 반환하고 phase·plan·승인을 바꾸지 않는다. `drive`는 blocker도 exit 0의 구조화 응답으로 반환하는 기존 API이므로 테스트는 exit code만이 아니라 `type`, `blocker.code`, `applied`, 실제 복원 상태를 검증한다.
2. `reopen discover` 후 stale canonical task가 남아 재계획 materialization으로 진입하지 못했다. controller의 eligibility 검사에서 해당 stale fast plan의 canonical task와 결속된 실행 승인 checkpoint만 재계획 대상으로 취급하도록 연결했다. 설정 누락과 `confirmed: false`는 차단하고 새 설정으로 만든 plan에는 새 `plan execute`를 요구한다.
3. 명시적으로 승인한 verifier `medium`이 strong-role 기본 floor 때문에 `high`로 저장되었다. 명시 승인 경로는 기본 추천과 분리하고, route의 requested/effective 값이 **원래 승인 입력값**과 모두 같아야 저장하도록 수정했다. 일반 추천과 retry의 strong-role 기본 정책은 유지한다.

Main의 공개 CLI·model-routing 재실행은 **28/28** 통과했다. 새 plan의 worker/verifier requested/effective 값이 모두 `medium`인지, 새 실행 승인 후 worker claim의 실제 descriptor가 `--effort medium`이며 strict가 자동 적용되는지 확인했다. 별도 regression은 benchmark 추천과 일반 verifier 기본값이 명시 승인을 덮지 않으면서 일반 추천에서는 기존 high floor를 유지하는지 검증한다.

### host 실행 한도와 native 판정기

Main 재실행에서 공개 host cap 3개와 native 판정기 12개, 총 **15/15**가 통과했다. host cap 테스트는 기본 ready-task-packet 게이트를 유지한다. Codex cap 4에서 task 8개 중 4개만 실행 상태가 되고 반복 claim이 추가 dispatch하지 않는다. Claude는 동일 Codex 설정을 무시해 runtime cap 8을 적용한다. invalid Codex cap은 task를 모두 pending으로 남긴다. 실제 provider child를 8개 생성한 테스트는 아니다.

native 판정기는 synthetic CLI/stream event로 nonzero exit, receipt 누락, terminal result 누락, permission denial, tool use, 잘린 출력, spawn error, timeout을 성공으로 오인하지 않는지 검증한다. 실제 native 전달 관측과 모델·effort 미확인은 [별도 문서](metis-native-effort-delivery.md)에 기록했다.

### 방어 로직 변이 실험

Main이 `node --no-warnings scripts/test-execution-policy-mutations.mjs`를 다시 실행했다. baseline과 oracle self-tests가 통과했고 다음 세 변이는 모두 assertion 실패로 탐지되었다.

- 승인 설정 drift 검사 제거: **KILLED**.
- Codex host cap 적용 제거: **KILLED**.
- plan seal transaction rollback 제거: **KILLED**.

syntax/import 오류, 일반 TypeError, timeout, signal 종료는 탐지 성공으로 세지 않는다. 이 실험은 선정한 세 방어 로직의 탐지력이며 전체 코드의 mutation coverage를 의미하지 않는다. 변이 fixture에는 의도적인 상태·순환 graph 주입이 있으며 공개 CLI 정상 경로 검증과 구분한다.

증거: `/private/tmp/metis-hardening-mutations-final.log`. disposable snapshot과 세부 로그는 그 파일에 적힌 private 임시 디렉터리에 보존한다. snapshot은 소스·필요 테스트 allowlist로만 복사하며 runtime DB와 인증 정보는 복사하지 않는다.

### 최종 통합 결과

- `npm run check`: **622 tests / 621 pass / 0 fail / 1 skip**, 약 **62.3초**. Chromium 미설치로 실제 browser evidence 테스트 한 개를 건너뛰었다. 신규 테스트는 23개이며 621개 전부를 신규 검증이라고 주장하지 않는다.
- 검사 로그: `/private/tmp/metis-hardening-check-final.log`.
- 최종 소스에서 변이 실험을 다시 실행해 baseline·oracle PASS, 세 변이 모두 KILLED를 확인했다. 증거 snapshot: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-execution-policy-mutations-1788803659423-90983`.
- 재계획 경계의 별도 unit API 테스트 3개는 canonical prefix만 공유하는 비정규 task, 별도 authority checkpoint, 같은 stale plan을 참조하는 비정규 authority checkpoint를 계속 차단한다. 초기 광범위 prefix 문제는 source 검토로 찾았고 동시 수정 후 부정 테스트를 실행했으므로, 수정 전 실패를 실행 재현했다고 주장하지 않는다.
- 검사 전후 `src`·`tests`·`scripts`의 JS/MJS **161개 파일** 합성 SHA-256이 동일했다: `3ef9e50ae1e863b4f1774ea894fe1c6340b84765832f331199d48ad1da9d7858`.
- 생성 문서·package 구조/mirror·공백 검사 통과. package dry-run: **1.1.0 / 220 files**, DB·raw log 비포함.
- Sonnet이 테스트 구현과 독립 경계 검토를 분담하고 Main이 재현 근거·합격 판정·runtime 수정 및 최종 결과를 통합 검토했다.
- 기존 브랜치와 dirty tree 유지. commit·push·PR·release, 버전·dependency·global 설정 변경 없음.

### 여전히 입증하지 않은 범위

- 실제 Claude/Codex parent의 계획 수립부터 Metis `COMPLETE`까지 이어지는 전체 host 인수 흐름.
- 요청한 `sonnet`과 관측된 `gpt-5.6-luna`의 동일성 및 provider 내부 effort 적용. 실제 Claude smoke는 transport만 관측했고, 후속 판정기 수정 검증은 기존 receipt와 synthetic 입력을 사용했다.
- Codex native child의 실제 호출, 실제 API 청구액, 속도·비용 개선율.

따라서 이번 결과는 단순 통과 건수 증가가 아니라 공개 경계에서 실제 결함을 찾고, 잘못된 산출물과 제거된 방어 로직을 탐지하는 검증 보강이다. 모든 실제 운영 경로를 검증했다는 의미는 아니다.
