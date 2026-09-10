# 실제 CLI child와 Metis runtime 인수 검증

날짜: 2026-09-08

## 최종 판정

**실제 로컬 Claude CLI worker·verifier를 연결한 제한된 runtime 인수 경로는 통과했다.** Main의 별도 read-only DB 감사와 산출물 실행에서도 `COMPLETE`를 확인했다.

검증한 것은 **deterministic parent harness + 실제 native child 두 개**다. native Main의 자율 계획 수립, `$metis` 전체 parent loop, 실제 host session의 강제 종료·compact 복원을 검증한 것은 아니다. 기존에 권한이 거부된 native parent/helper/entryresolve 경로는 재시도하거나 우회하지 않았다.

- 최종 report: `/private/tmp/metis-native-esmodule.UdHkeh`
- 실제 run: `run_8aee4f673408497a`
- private 증거: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-native-accept-lf4HRp/evidence`
- 최종 상태: phase `complete`, status `completed`, controller action `COMPLETE`

## 실제로 실행한 경로

```text
공개 CLI init / model configure / start --plan-only
→ contract freeze / advance discover
→ drive로 fast plan과 명시 실행 설정 저장
→ plan execute: 자동 인수 fixture의 실행 승인
→ advance execute / pause / resume / goal restore
→ worker claim / 실제 CLI source 생성 / 별도 Node import
→ 실제 session receipt ACK / worker finish
→ pause / resume / goal restore / 완료 worker attempt 확인
→ drive / verifier claim
→ 실제 CLI verifier의 candidate 관측 / 별도 Node 실행값과 대조
→ 실제 session receipt ACK / verifier finish
→ drive COMPLETE / goal restore
```

계획·사용자 승인·상태 조정은 테스트 harness가 담당했다. 승인 입력은 사용자가 허가한 테스트의 자동 fixture이며, 실제 host 대화에서 새로운 사용자 승인을 받은 것처럼 표현하지 않는다.

worker는 no-tools CLI에서 source 원문을 생성했다. parent는 부작용 없는 단일 ES module numeric export 문법인지 검사한 뒤 **반환된 원문 그대로** 파일에 저장했다. parent가 정답 파일로 대체하지 않았다. 별도 Node process의 import로 실제 export 값을 측정했다.

verifier는 worker 대화나 성공 주장이 아니라 **현재 candidate의 실제 파일 내용과 요구사항**을 받았다. 고정 `passed: true`가 아니라 `observed_answer`와 `syntax_ok`를 반환하게 했고, 별도 Node 실행과 값이 일치해야 완료 결과를 제출했다. 실제 파일 쓰기·실행과 CLI 상태 조정은 parent가 수행했으므로 child의 자율 파일 도구 사용까지 검증한 것은 아니다.

## 최종 실제 receipt와 독립 감사

| 역할 | 실제 CLI session receipt | CLI estimate | child 시간 |
|---|---|---:|---:|
| worker | `177db8f7-cb57-4cf6-bbd5-3ea82dd30bd6` | $0.013816 | 4.077초 |
| verifier | `a03ec0c0-f409-4184-80e3-cd269ca25a61` | $0.013352 | 3.846초 |

두 child 모두:

- 요청 argv: `--model sonnet --effort medium`.
- runtime descriptor의 `effort_exact_required`와 `effort_launch_ready`가 true.
- 관측 model: `gpt-5.6-luna`.
- 모델 확인: `mismatch-unconfirmed`, provider 내부 effort 확인: `unconfirmed`.
- exit 0, timeout 없음, permission denial 0, tool use 없음, 유효 terminal result와 session receipt 확인.

Main이 최종 DB를 read-only로 열어 다음을 별도로 확인했다.

- worker와 verifier 모두 `completed`, 각각 attempts 1 / attempt fence 1.
- spawn ACK 두 개가 위의 서로 다른 실제 session receipt와 정확히 일치.
- run phase `complete`, status `completed`.
- 최종 파일을 별도 Node process에서 다시 import한 결과 answer 42, exit 0.

worker 완료 후 공개 `pause` / `resume`에서 같은 run, 유효한 실행 승인, 완료 worker, 동일 attempt fence가 유지되었다. worker 재호출은 없었다. 이는 **graceful runtime pause/resume**이며, 실행 중 child 강제 종료나 native Main의 crash/compact 복원과 구분한다.

## 실패 시도와 판정기 수정 이력

실패 DB와 raw 로그는 삭제하지 않았고, 나중의 성공으로 과거 실패를 덮지 않았다.

### 초기 판정기가 잘못된 네 번의 호출

초기 실행기는 worker에게 answer 42를 그대로 반환하게 하고 parent가 파일을 하드코딩했다. verifier prompt는 실제 판단 없이 `passed: true`를 반환하도록 지시했다. child 수집기도 stdout/stderr를 섞고 non-JSON 출력을 버려 기존 fail-closed 검사 일부를 누락했다.

Main 검토에서 이 결함을 발견했으므로 **다음 네 호출은 transport 관측만 인정**하며 실제 구현·독립 검증 성공으로 세지 않는다. 실제 verifier 호출까지 도달한 시도도 없었다.

| private fixture 접미사 | CLI estimate | 중단 단계 |
|---|---:|---|
| `bKTJdw` | $0.013350 | worker finish: `WORKTREE_INTEGRATION_CONFLICT` |
| `EjM8RD` | $0.013402 | verifier claim: `TASK_PACKET_NOT_READY` |
| `1JfRHo` | $0.013264 | verifier claim: `TASK_PACKET_NOT_READY` |
| `J5HWna` | $0.013262 | verifier claim: `TASK_PACKET_NOT_READY` |

합계 $0.053278. 실제 receipt는 private 증거에 보존했다. 별도의 초기 CLI 준비 fixture `/private/tmp/metis-accept-probe-rBIZPW`에서는 controller 필드 추출 오류로 `CONTROLLER_FENCED`가 발생했으며 provider 호출은 없었다.

### 네트워크 없이 실행기 자체를 재현·수정

Main은 provider만 offline fixture로 대체하고 **실제 인수 실행기의 전체 공개 CLI 경로**를 실행했다.

1. 정상 source에서도 `TASK_PACKET_NOT_READY`로 실패함을 재현했다. 증거 로그가 fixture 저장소 내부 `.evidence`에 계속 추가되어 repository/packet freshness를 무효화하고 있었다. 증거 디렉터리를 프로젝트의 private sibling으로 분리하자 verifier 단계까지 도달했다.
2. 이후 `FAST_PATH_APPROVAL_EVIDENCE`로 완료가 차단됐다. 결과가 실제 criterion 대신 requirement ID와 잘못된 status 형식을 사용하고 있었다. 실제로 검증한 두 criterion에 대해 공식 `criterion` / `status: passed` 형식으로 제출하도록 수정했다.
3. 같은 전체 실행기에서 실제 answer 41은 worker 이후 차단되고, 파일 관측 없이 고정 성공을 반환한 verifier도 차단되는지 확인했다.

재현 로그:

- `/private/tmp/metis-native-acceptance-offline-before.log`
- `/private/tmp/metis-native-acceptance-offline-separated.log`

### 수정판의 실제 source 계약 실패와 제약 전달 수정

첫 수정판 실제 호출은 `worker-source-invalid`로 차단됐다.

- report: `/private/tmp/metis-native-corrected.rKiTJa`
- run: `run_ccb9dcb024054868`
- session: `975453d7-b5dc-4e71-bc4b-cd1d858557bd`
- CLI estimate: $0.013830.
- 별도 공개 status 확인: run `active` / `execute`, worker `running` / attempts 1, verifier `pending` / attempts 0.

원문을 Main에 노출하지 않는 형태 분류에서 worker source가 CommonJS이고 요구한 named ES module export가 아님을 확인했다. 실행기가 Goal Contract의 ES module 제약을 worker 요청에 명시적으로 전달하지 않고 있었다. **합격 문법을 완화하지 않고** 누락된 module 형식과 bounded 출력 계약을 prompt에 전달했다. 그 차이를 검증한 다음 실행이 위의 최종 성공 run이다. 실패 run을 완료 상태로 바꾸거나 receipt를 다른 task/attempt에 재사용하지 않았다.

## 모델·effort와 비용의 해석

요청 `sonnet`과 관측 `gpt-5.6-luna` 사이의 host/provider 매핑은 입증하지 못했다. 로컬 Claude CLI가 요청 argv를 받아 실제 응답한 것은 확인했지만 **Sonnet 자체가 실행되었다거나 내부 effort가 medium으로 적용되었다고 주장하지 않는다.**

이번 인수 관련 실제 child 호출은 총 7회다: 초기 잘못된 판정기 worker 4회, source 계약 실패 worker 1회, 최종 worker·verifier 2회.

- 최종 성공 pair의 CLI estimate: **$0.027168**.
- 실패·무효 시도를 포함한 확인 가능한 인수 CLI estimate 소계: **$0.094276**.
- 별도 transport smoke 1회가 있었고 해당 report에는 estimate가 없어 위 소계에 포함하지 않았다. 상한 $0.15는 지출액이 아니다.
- 따라서 실제 provider 호출 수는 smoke 포함 **8회**이며, 전체 실청구액은 알 수 없다.
- supervisor Agent 비용은 위 CLI estimate에 포함하지 않는다.
- child당 CLI 예산 상한 $1, 실제 호출 timeout 최대 90초, no-tools. 거부된 경로나 skip/bypass permission 설정을 사용하지 않았다.
- Codex는 구체적인 Luna 모델 지원 및 비용 제어 근거가 확보되지 않아 실제 네트워크 child를 실행하지 않았다.

## 코드 및 오프라인 회귀

- `scripts/test-native-acceptance.mjs`: 기본 실행/import에서 provider 호출 없음. 실제 실행은 `--run`으로만 opt-in.
- `scripts/test-native-effort-delivery.mjs`: 기존 bounded `runChild`에 fixture `cwd` 지원만 추가. receipt/terminal/tool/denial/truncation/timeout 검증 재사용.
- `tests/native-acceptance.test.js`: 전체 공개 CLI 정상·부정 경로, 고정 성공 거부, default no-network 검증. 주입된 fixture receipt는 `offline-fixture-only`로 표시하며 native 결과로 세지 않는다.
- `npm run check`: **627 tests / 626 pass / 0 fail / 1 skip**, 약 62.0초. skip은 Chromium 미설치.
- 검사 로그: `/private/tmp/metis-native-acceptance-check-final.log`.

제품 runtime, 버전, dependency 및 global host 설정은 변경하지 않았다. 기존 dirty tree와 브랜치를 유지했고 commit·push·PR·release는 하지 않았다. controller를 포함한 raw CLI 응답은 parent 전용 private 증거 파일에만 남기며 child prompt/env와 공개 report에는 전달하지 않는다.

## 재현 명령과 남은 한계

```sh
# 네트워크 없음
node scripts/test-native-acceptance.mjs
node --no-warnings --test tests/native-acceptance.test.js tests/native-effort-delivery.test.js

# 명시적으로 승인된 실제 provider 테스트에만 사용
node --no-warnings scripts/test-native-acceptance.mjs --run
```

이번 통과는 작은 단일 산출물의 deterministic runtime 조정과 실제 native child 응답을 연결한 인수 증거다. native Main의 자율 계획·전체 host loop, Codex 실제 child, provider 내부 model/effort 적용, 실행 중 host session 강제 종료·compact 복원, 성능 개선율은 여전히 미검증이다.
