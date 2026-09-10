# 남은 native 검증 실행 기록

날짜: 2026-09-08

## 요청과 범위

사용자는 이전 인수 결과의 미검증 항목을 모두 검증하도록 요청했다. 대상은 native Main의 자율 `$metis` 전체 흐름, 실제 host 종료·compact 복원, Codex 실제 실행, 모델·effort 적용 확인이다. 이번 요청을 전역 설정 변경, 기존 권한 거부 우회, 실제 청구액 추정의 승인으로 해석하지 않는다.

## 실행 원칙

- Sonnet이 모델 inventory, host 실행 경계, OS process 복원 회귀를 분담하고 Main이 실제 실행·판정·결과를 통합한다.
- 기존 dirty tree를 보존하며 commit·push·PR·release를 하지 않는다.
- 기존에 거부된 native parent/helper/entryresolve 명령은 다른 도구나 allowlist 확장으로 우회하지 않는다.
- native Main 전체 흐름과 no-tools host session 복원, OS process runtime 회귀를 각각 별개 증거로 기록한다. 부분 통과를 전체 통과로 승격하지 않는다.
- provider 내부 적용과 CLI가 관측·기록한 model/effort를 구분한다. 존재하지 않는 model inventory나 비용 상한 옵션을 가정하지 않는다.
- controller·인증 비밀과 raw child transcript는 공개 결과에 넣지 않는다.

## 조사 중 확인한 경계

이전 실패는 native Main 자체가 실행 불가능하다는 증거가 아니다. 로컬 Claude CLI와 plugin 로드는 가능했지만, 비대화형 host에서 `entry resolve`와 child 생성 helper의 tool 권한 승인을 받을 수 없었다. 이를 실제 child 모델의 거절과 혼동하지 않는다. Codex의 project hook trust 차단도 별도 경계다.

현재 CLI help에서 Claude의 model/effort/budget 옵션과 Codex의 model/config 옵션을 확인했다. Codex help에 effort 전용 flag가 없다는 이유만으로 reasoning effort 설정이 불가능하다고 판정하지 않는다. 구체적인 로컬 모델 inventory와 config 지원 근거를 추가 조사한다.

## 결과

### 실제 Claude session 강제 종료·재개 및 compact

`scripts/test-native-session-recovery.mjs`를 실제 provider에 실행했다. scope는 `no-tools-native-session-recovery-only`이며 `nativeMetisLoopVerified: false`다.

- 실제 session: `0e548e24-48f9-4a31-8f88-8552eea35f49`.
- seed turn에서 무작위 목표 ID, answer 42, 무작위 제약 문자열을 기록했다.
- 다음 turn의 첫 실제 text delta에서 테스트 소유 CLI process group만 `SIGKILL`했다. timeout이 아니라 의도한 강제 종료였다. private 증거의 별도 감사에서 text delta 1개, terminal result 없음도 확인했다.
- 새 CLI process의 `--resume`에서 같은 session을 재개했다. 목표 ID·값·제약을 prompt에 다시 넣지 않고도 세 값이 모두 정확히 일치했다.
- 이어 `/compact`를 실제 실행했다. host의 `system / compact_boundary` 이벤트를 관측했고, 다시 시작한 다음 turn에서도 같은 session과 원래 세 값을 유지했다. 독립 검토에서 자동 compact도 허용하던 판정기 공백을 발견해 `trigger: manual`만 통과하도록 강화했다. 추가 provider 호출 없이 기존 실제 증거를 재판정한 결과 manual boundary 1개가 확인됐다. host가 보고한 compact metadata는 pre_tokens 6,829, post_tokens 269, duration_ms 4,311이었다. 이는 해당 session의 처리 metadata이지 Metis 전체 성능 개선율이 아니다.
- 정상 turn들은 terminal receipt, exit 0, tool use 없음, permission denial 없음으로 확인했다. SIGKILL turn은 transport 성공으로 세지 않는다.
- 요청 `sonnet / medium`, 실제 model 필드 `gpt-5.6-luna`. 실제 응답의 allowlisted metadata에도 effort 확인 필드는 없었다.

증거:

- 강제 종료·resume: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-native-session-recovery-h594sC/evidence/report.json`.
- compact: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-native-session-recovery-h594sC/compact-evidence-rgSYNr/report.json`.

실제 CLI 호출은 5회다. 확인 가능한 CLI estimate는 seed $0.0144100, resumed $0.0036856, compact $0.0070696, post-compact $0.0037636으로 소계 **$0.0289288**이다. 강제 종료한 호출의 비용은 terminal report가 없어 알 수 없다. 이 소계는 전체 실제 청구액이 아니며 supervisor 비용도 포함하지 않는다.

이는 실제 host의 session 저장·강제 종료 복구·압축 후 기억 유지 증거다. Metis controller/task를 native Main이 직접 다룬 상태의 복원과는 별개다.

### Codex inventory 정정

`~/.codex/models_cache.json`과 네트워크 refresh 없는 `codex debug models --bundled`에서 구체적 `gpt-5.6-luna`를 확인했다. 지원 effort는 `low, medium, high, xhigh, max`, 기본값은 `medium`이다. `model_reasoning_effort` config 구문도 로컬 parser가 수용했다.

이전 `scripts/test-native-effort-delivery.mjs`의 `codexLocalEvidence()`는 실제 inventory를 조회하지 않고 항상 근거 없음으로 반환했다. 따라서 그 결과를 현재 host의 모델 부재 증거로 쓰지 않는다. catalog 지원, 실제 CLI 호출, provider 내부 적용은 여전히 서로 다른 증거다.

기존 smoke의 반환값도 `localModelEvidence: null`, `reason: codex-catalog-not-inspected-by-this-smoke`로 정정했다. 모델 부재와 해당 smoke의 미조사를 구분한다.

### Codex 실제 child 연결: 첫 실행의 범위

실제 Codex worker·verifier 두 호출로 `run_2716c0f975a244b6`이 `COMPLETE`에 도달했다. Main은 read-only DB 감사에서 두 completed task의 attempts 1, 실제 receipt ACK 일치, 별도 Node import answer 42를 확인했다.

- worker receipt: `01a07e78-ad17-76d1-9d83-74ba7b6eab36`.
- verifier receipt: `01a07e78-c487-7752-82e2-1ffc3ba52d12`.
- private 증거: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-native-accept-V3g31R/evidence`.
- 실제 child는 `gpt-5.6-luna`, `model_reasoning_effort="medium"`, read-only sandbox, JSON events로 실행했다. tool use는 관측되지 않았지만 Codex의 no-tools 설정 강제 기능을 입증한 것은 아니다.

**이 첫 실행은 Claude-shaped 승인 descriptor를 사용하는 기존 harness에 Codex provider를 연결했다. 따라서 실제 Codex child 결과와 runtime 연결의 증거일 뿐, Codex adapter의 승인 route/descriptor E2E로 세지 않는다.** 이 공백을 발견해 host/model을 parameter화하고 실제 Codex 승인 descriptor와 동일한 argv를 사용하도록 후속 검증을 진행한다.

선행 두 준비 시도는 지원되지 않는 exec argument와 tools config 형식 오류로 provider 호출 전에 중단됐다. raw 로그를 보존했으며 native 성공으로 세지 않는다. Codex에는 확인된 dollar 상한 옵션이 없고, 90초·256KiB는 시간·출력 제한이지 비용 상한이 아니다. 실제 청구액은 미확인이다.

### 실제 controller OS process 강제 종료 회귀

`tests/controller-crash-process.test.js`를 추가했다. 종료 대상 process가 공개 CLI로 직접 목표·계약·명시 모델/effort 계획·실행 승인을 만들고 task를 claim한 뒤 heartbeat한다. 그 process를 `SIGKILL`하고 lease 만료 후 새로운 OS process가 정식 takeover, `goal restore`, `drive`를 수행했다.

Main 재검사에서 다음을 확인했다.

- run ID, execute/active 상태, 실행 승인 required/pass, 기존 batch와 running task 유지.
- 실제 durable plan의 ID·content reference·executionSettings가 종료 전후 동일하며 모델과 requested/effective high가 보존됨. argv를 그대로 echo하는 검사를 실제 artifact 비교로 교체했다.
- 살아 있는 controller의 lease를 다른 controller가 빼앗으려 하면 `CONTROLLER_ACTIVE`.
- takeover 뒤 이전 controller의 heartbeat·실행 승인·drive·claim은 모두 `CONTROLLER_FENCED`.
- 기존 batch로 `WAIT_FOR_AGENTS`를 반환하고 중복 dispatch를 만들지 않음.

집중 검사 **1/1 통과**, 약 3.7초. 이 테스트의 worker는 native provider가 아닌 runtime claim 상태이며, 실제 host-visible background WAIT나 native Main 복원으로 확대하지 않는다.

### Codex 승인 route·strict descriptor·실제 child 완주

기존 인수 실행기를 host/model/effort parameter로 확장하되 Claude 기본값을 유지했다. worker·verifier 양쪽의 실제 descriptor가 승인값과 일치하고 `effort_exact_required` / `effort_launch_ready`가 모두 true여야 실행한다. host parameter화 중 누락된 strict flag 검사도 Main 검토로 복원했다.

중간 run `run_96be1243f2944fc2`는 worker 응답 뒤 stderr 검사로 중단했다. Main이 원문을 노출하지 않고 정확히 대조한 결과 stderr는 표준 안내문 `Reading prompt from stdin...` 하나였다. 실패를 성공으로 바꾸지 않고 보존했다. stderr 검사를 무시하지 않는 대신 공식 `-` 인자로 stdin 입력을 명시하도록 호출을 고쳤다.

또한 인수 실행기에 추가됐던 수동 `--require-exact-effort` flag를 제거했다. 공개 plan에서 승인한 설정만으로 strict가 자동 적용되는지를 검증하기 위해서다. flag 없이 offline 전체 경로 14개 검사를 통과한 뒤 실제 Codex worker·verifier를 다시 실행했다.

최종 결과:

- run: `run_08839a31a7844afb`, host `codex`, phase `complete`, status `completed`, terminal `COMPLETE`.
- worker: `01a07e8d-2d14-7213-8ebc-5ec5fea08cdc`.
- verifier: `01a07e8d-475e-7802-afda-e1879a926801`.
- 두 task 모두 attempts 1 / attempt fence 1.
- DB의 selected model은 `gpt-5.6-luna`, requested/effective effort는 모두 `medium`.
- 실제 Codex descriptor의 host/model/reasoning_effort와 strict·launch-ready flag를 확인했다. CLI argv는 해당 descriptor에서 만든다.
- 두 실제 session receipt와 ACK가 일치했다. 최종 산출물을 별도 Node process에서 import해 answer 42와 exit 0을 확인했다.
- Main이 DB를 read-only로 열어 위 내용을 독립 감사했다.

증거:

- 최종 report: `/private/tmp/metis-codex-strict-final-odgedd8i.json`.
- 감사: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-native-accept-ek3Jhe/evidence/main-audit.json`.
- 중간 실패 report: `/tmp/metis-native-codex-final-sanitized.json`.
- 중간 실패 private 증거: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-native-accept-T4AN1T/evidence`.

이번 요청에서 실제 응답을 받은 Codex child는 총 5회다: 첫 child-only worker/verifier 2회, stderr 중단 worker 1회, 최종 Codex route worker/verifier 2회. 준비 단계 parser 오류는 실제 provider 성공으로 세지 않는다. Codex CLI/실청구 비용은 알 수 없으며 이를 0원으로 계산하지 않는다.

## 최종 통합 검사

- `npm run check`: **641 tests / 640 pass / 0 fail / 1 Chromium skip**, 약 43.5초.
- 로그: `/private/tmp/metis-remaining-verified-ovhdzt0w.log`.
- 검사 전후 `src` / `scripts` / `tests` JS·MJS 168개 파일의 합성 SHA-256이 동일했다: `b4bbae261af97b24b4a93c395c90e0bba3391b6f582b2144fc5e074d0c7c08b2`.
- 앞선 동시 수정 중 전체 검사는 통과했지만 source hash가 달라 최종 고정 소스 근거에서 제외했다.
- package dry-run: 버전 1.1.0, 220 files. 개발 테스트·native 실험 스크립트·DB·raw 로그 비포함.
- 이 통과 건수는 전체 회귀 suite이며 native provider 인수 건수가 아니다.
- 이번 단계에서 제품 runtime, dependency, 전역 host 설정을 변경하지 않았고 commit·push·PR·release를 하지 않았다.

## 후속 native Main 검증의 명시 승인

사용자는 후속 검증 요청 뒤 다음 범위를 제시받고 “승인한다”라고 명시 승인했다.

- 새 임시 테스트 프로젝트에서만 실행한다.
- 해당 프로젝트의 Metis CLI 호출, worker·verifier 생성, 테스트 명령에 필요한 임시 host 도구 권한만 허용한다.
- 전역 설정 변경, `bypassPermissions`, 다른 프로젝트 접근, commit·push는 허용하지 않는다.
- 테스트 종료 후 임시 권한 설정을 재사용하지 않는다.

이는 앞선 권한 거부를 일반 테스트 요청만으로 우회하는 것과 구분되는 새 승인이다. 아래 native Main 차단 설명은 이 승인 이전의 결과이며, 승인 자체는 실제 실행·완료 증거가 아니다. 후속 실험도 native Main의 lifecycle 판단과 bounded child 실행 helper를 구분하고, runtime 상태·실제 receipt·독립 산출물 실행으로 판정한다.

### 승인 후 실제 native Main 실험의 실패 이력

임시 runner `/private/tmp/metis-native-main-probe.mjs`는 native Main에게 현재 스킬과 공개 CLI를 제공한다. helper는 프로젝트 범위·명령·승인값을 제한하고 controller credential을 주입하지만, lifecycle 진행·claim·ACK·finish는 Main이 요청한 명령만 수행한다. worker 원문은 private evidence에만 두고 bounded 결과 handle만 Main에 반환한다. 각 fixture는 종료 시 `closed.json`으로 helper 재사용을 차단한다.

1. 첫 호출은 `--restricted`가 기존 user settings의 인증 경로까지 제외해 도구 실행 전에 실패했다. session `121a42ec-234d-4850-9d29-4b123616ce40`, exit 1, 232ms, 도구 0회, 권한 거부 0회, child 0회였다. 오류 문구는 OAuth 만료였지만 같은 환경의 일반 `auth status`는 api_key 로그인, restricted는 인증 없음이었다. 따라서 전역 인증 만료로 단정하지 않는다. report: `/private/tmp/metis-native-main-probe-result.json`.
2. Main은 `--restricted`·단일 Bash helper allowlist·`dontAsk`·`permission-prompts none`·strict MCP 제한을 유지한 채, 기존 provider 인증과 Sonnet 매핑에 필요한 allowlisted 환경값만 메모리에서 전달했다. 비밀을 출력하거나 별도 인증 파일을 만들지 않았고 전역 permission·hook 설정을 불러오지 않았다. session `301f5b98-247b-4cd1-b5d4-8a355b9bcb22`는 실제 Bash 8회로 `run_70b7fa96b89d4519`를 생성했다. 이후 helper가 정상 `--data=...` 표기를 잘못 읽어 계약을 거부했다. 계약 내용은 승인 범위와 일치했으며 제품 runtime 결함이 아니라 임시 실행기 결함이었다. 실패를 보존하고 등호 인자를 정규화했다. report: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-native-main-auth-preserved-ze_txujk.json`.
3. 수정 후 session `9676fcb4-81eb-4302-820b-7d31dc2bc12d`는 실제 Bash 14회로 `run_4701834911d84364`의 계약을 저장하고 discover까지 진행했다. Main이 start 이후 `model configure`를 호출해 `MODEL_CONFIG_ACTIVE_RUN`으로 차단됐다. 이어 승인된 medium으로 drive했으나 지원 근거가 없어 `PLAN_EXECUTION_SETTINGS_EFFORT_UNAVAILABLE`을 반환했다. 이는 승인 대기·완료가 아니라 실제 실행 순서 실패다. report: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-native-main-argv-fixed-jmqhm6fh.json`.

두 인증 정상 호출의 관측 model은 `gpt-5.6-luna`, permission denial은 0회였다. 기존 로컬 Sonnet 별칭 설정도 `gpt-5.6-luna`인 것은 확인했지만 provider 내부 모델·effort 적용 증거로 확대하지 않는다. 두 호출의 CLI estimate는 각각 $0.225269, $0.364258이며 실패 비용도 제외하지 않는다. 임시 판정기 검사는 등호 인자·외부 root 차단을 포함해 9개 통과했다. 이는 checked-in 전체 회귀 건수나 native 성공 건수가 아니다.

### 초기 설정 순서를 안내한 최종 bounded 실험

마지막 실험에는 비어 있는 fixture의 model configure를 start 전에 수행해야 한다는 조건만 추가했다. 이는 무보조 스킬이 초기 설정을 이미 처리한다는 증거가 아니다. 실제 Main session `ae5fff99-775e-4238-a211-c7378f7d3300`의 두 CLI turn에서 다음을 확인했다.

- plan turn: Bash 15회, exit 0, 약 85초. 설정·계약 저장과 계획 승인 대기까지 도달했다. 처음 잘못 작성한 requirement를 runtime의 `REQUIREMENT_FIELDS` 오류에 따라 Main이 수정했다.
- run turn: 같은 session, Bash 10회, exit 0, 약 58초. 기존 목표 복원, `plan execute` 승인, execute 진입, worker task claim까지 진행했다. 승인 prompt는 자동 fixture가 전달했으며 사람 대화식 승인 검증이 아니다.
- run: `run_0702117b4fa94526`.
- 실제 claim batch: `batch_3010840e83564277`.
- worker descriptor는 sonnet/medium, requested/effective medium, launch-ready true였으나 **`effort_exact_required: false`**였다. helper가 `descriptor-route-mismatch`로 실제 child 생성을 거부했다.
- `model configure` 기본 설정은 있었지만 Main이 `drive --data`로 계획의 `executionSettings` 확인을 기록하지 않았다. 모델 기본 설정과 계획 승인 결속은 같지 않다. runtime이 claim 자체를 차단한 결과가 아니라, claim 뒤 테스트 helper가 strict 부재를 발견한 결과다.
- 독립 read-only DB 감사에서 실행 authority checkpoint는 resolved였지만 sealed plan의 `executionSettings`는 없었다. worker 기록은 running/medium/attempt 1/fence 1이며, 아직 실행하지 않은 verifier 기록은 **pending/high/attempt 0/fence 0**이었다. prompt에서 두 역할 medium을 승인한 것만으로 DB에 명시적 승인이 생기지 않음을 실제 확인했다.
- 실제 worker·verifier 호출, receipt ACK, 산출물 완성, runtime COMPLETE는 모두 없음. `nativeMainVerified: false`를 유지한다. verifier high는 실제 provider 호출값이 아니라 실행 전 저장된 route다.
- helper가 `entry resolve`에 불필요한 controller flag를 주입해 `ENTRY_FLAGS`를 만든 부수적 실행기 결함도 있었다. 이를 제품 parser 결함으로 분류하지 않는다.

report: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-native-main-setup-guided-xdj954cw.json`.

독립 감사: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-native-main-vLUOJk/evidence/bounded-main-audit.json`.

코드 대조 결과, `src/core/tasks.js:2352-2416`은 plan에 executionSettings가 없으면 exact 검사를 required false로 취급한다. `src/core/state.js:1058-1093`의 실행 authority 승인과는 별개다. 따라서 이미 저장된 명시 승인값을 runtime이 무시했다는 증거는 아니다. strict 인수가 목표인 이번 실험에서 Main이 `skills/metis/references/planning.md:117-127`의 설정 승인 저장을 빠뜨린 것이며, host 대화의 승인 의도가 durable state까지 전달되는 전체 흐름은 아직 신뢰성 검증을 통과하지 못했다. 초기 configure 순서는 스킬 안내의 공백이고, 설정 승인 기록은 존재하는 절차의 불이행으로 구분한다.

이번 후속 실험의 native parent CLI 호출은 인증 실패 1회와 인증 정상 4회, 총 5회다. 정상 4회의 관측 CLI estimate 합계는 **$1.397519**이며 실패 호출도 포함한다. 실제 청구액이나 supervisor 비용을 포함한 총비용은 아니다. 모든 fixture의 임시 권한은 invocation 한정이며 종료 marker로 helper 재사용을 막았다. 제한을 풀거나 strict 조건을 완화해 성공으로 만드는 추가 재시도는 하지 않았다.

전체 회귀를 다시 실행한 결과 **641 tests / 640 pass / 0 fail / 1 Chromium skip**, 약 44.3초였다. 검사 전후 168개 JS·MJS의 해시는 위 최종 통합 검사와 동일했다. 로그: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-native-main-check-sfh03_wg.log`. 이번 단계의 저장소 변경은 검증 문서뿐이며 제품 runtime·스킬·dependency는 변경하지 않았다.

### Quote-aware allowlist bounded 재실행 (2026-09-09)

첫 권한 차단 뒤 임시 runner의 실제 denial command에만 맞춰 double-quoted launcher/runtime 경로와 quoted project 경로를 allowlist에 추가했다. `bypassPermissions`, `--dangerously-skip-permissions`, broad `Bash(*)`, 전역 설정 변경은 사용하지 않았고 동일한 disposable fixture에서 한 번만 재실행했다.

- fixture: `/private/tmp/metis-native-main-rerun-iS71Xc/project`; session `8755fb23-460d-42b3-92a1-039845f09ad9`; report `/private/tmp/metis-native-main-rerun-iS71Xc/evidence/report.json`.
- plan turn은 exit 0으로 `run_7cd4a2ef3c88495b`를 만들고 명시적 실행 승인 대기까지 도달했다. `value.js`는 수정되지 않았다.
- run turn은 같은 session에서 `plan execute` 승인, execute 진입, worker claim과 host receipt/ACK까지 진행했다. DB의 worker route는 selected `sonnet`, requested/effective `medium`이었다.
- 그러나 실제 child 호출 단계에서 Claude SDK가 `gpt-5.6-luna`를 `unrecognized_model`(`query_source: sdk`)로 거부했다. 실행 예산도 `$1.50` 한도에서 `$1.53`으로 도달해 background worker가 중단됐다. 이 오류는 runtime `COMPLETE`나 provider 내부 effort 적용의 증거가 아니다.
- read-only SQLite 감사에서 worker는 running/attempt 1/fence 1, verifier는 pending/attempt 0/fence 0, batch는 spawned, receipt는 worker 한 건뿐이었다. `value.js`는 여전히 answer 41이고 run은 `execute/active`였다. 따라서 worker/verifier 완료·독립 검증·두 receipt ACK·runtime `COMPLETE`는 모두 성립하지 않으며 `nativeMainVerified: false`를 유지한다.

plan stderr는 비어 있고 run stderr의 비밀 없는 차단 사유는 `/private/tmp/metis-native-main-rerun-iS71Xc/evidence/02-run.stderr`에 보존했다. 추가 provider 재시도는 하지 않는다.

## 남은 차단과 관측 한계

1. **native Main의 자율 `$metis` 전체 loop 및 그 상태에서의 복원**: 최신 명시 승인으로 임시 프로젝트의 실제 도구 호출은 가능했고 permission denial 0회였다. 그러나 초기 모델 설정 순서와 계획의 명시적 effort 승인 기록을 Main이 빠뜨리는 경계가 드러났다. 마지막 run은 claim까지 허용됐지만 strict descriptor가 아니어서 helper가 실제 child 생성을 차단했다. 따라서 현재 차단을 단순한 권한 부재로 설명하지 않는다. 전체 완료·그 controller 상태에서의 crash/compact·hook continuation은 미검증이며 Codex native Main/project hook trust 경계도 별도로 남아 있다.
2. **provider 내부 모델·effort 적용과 실제 청구액**: Codex catalog 지원·승인값·실제 descriptor/CLI 전달과 응답은 확인했다. Claude 관측 model은 Luna이며 alias 매핑은 미확인이다. 이 자료로 provider 내부 reasoning effort의 적용이나 실제 청구액까지 확정할 수 없다. provider가 제공하는 확인 metadata/청구 자료가 필요하다.

따라서 실제 host 강제 종료·manual compact, runtime controller 복원, Codex 승인 descriptor를 통한 native child 완주는 통과했다. 모든 native Main 운영 경로 또는 provider 내부 동작을 검증했다고 주장하지 않는다.
