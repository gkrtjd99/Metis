# Metis native model/effort delivery smoke

Date: 2026-09-08

## 목적과 경계

이 문서는 Metis parent loop, task graph, continuation, host 권한 계약을 실행하지 않고,
설치된 provider CLI child 하나에 Metis adapter descriptor의 model/effort 전달이 실제로
도달하는지만 확인하는 bounded smoke의 계획·증거 경계다.

소유 파일은 다음 세 개로 제한한다.

- `scripts/test-native-effort-delivery.mjs`
- `docs/plans/metis-native-effort-delivery.md`
- `tests/native-effort-delivery.test.js`

runtime/package, global 설정, 인증 조회, 권한 모드 확장, skip-permissions, worktree,
다른 프로젝트 조사는 범위 밖이다. native parent helper/entry resolve 경로는 재시도하지 않는다.

## 실행 정책

- 기본 실행은 opt-in이며 `node scripts/test-native-effort-delivery.mjs --run`일 때만 child를 시작한다.
- Claude는 descriptor를 `renderSpawnDescriptor("claude", ...)`로 만들고 descriptor의 `args`
  (특히 `--model sonnet`, `--effort medium`)를 그대로 provider argv에 넣는다. model/effort를
  문자열로 재작성하거나 하드코딩한 대체 argv를 만들지 않는다.
- Claude 실행은 `--print`, `--output-format stream-json`, `--tools ""`,
  `--max-budget-usd 0.15`를 사용하고 90초 wall timeout, 성공 시도 최대 1회로 제한한다.
  prompt는 짧은 read-only/no-tools JSON 응답만 요구하며 실제 child 응답을 Metis `COMPLETE`로
  변환하지 않는다.
- Claude의 개인 선호인 xhigh/max를 제품 정책으로 강제하지 않는다. smoke 요청은 설치된 CLI가
  `--effort`를 지원한다는 help 증거를 확인한 뒤 보수적인 `medium`으로 협상한다.
- Codex는 `--help`와 버전 같은 비인증 local probe만 수행한다. 구체적인 Luna 모델과 해당
  effort 지원을 입증하는 host-local 증거가 없으면 네트워크 child 실행을 하지 않고
  `no-local-concrete-luna-evidence`로 기록한다. model 이름을 추측하지 않는다.
- child 환경에서 controller/session/run/lease/owner/auth 관련 Metis 변수와 API key,
  token, secret, password, credential 형태의 환경 변수를 제거한다. raw stdout/stderr는
  OS temporary directory의 mode `0600` 파일에만 보관한다.
- receipt에서 `requested_cli`(전달 요청), `observed`(bounded session/model),
  `structured_response`의 status/tool boolean, `provider_confirmation`(provider가 effort를
  확인했는지), permission denial count, exit/signal/timeout/error code를 별도 필드로
  구분한다. 원문 child 응답·denial·오류는 public JSON에 복사하지 않는다.
  `api_billed_usd`는 알 수 없으면 `unavailable`이고 `--max-budget-usd`/CLI estimate와
  실제 청구를 합치지 않는다.

## 허용 명령

```sh
node scripts/test-native-effort-delivery.mjs --help
node scripts/test-native-effort-delivery.mjs --run --provider claude --json
node scripts/test-native-effort-delivery.mjs --run --provider codex --json
```

실행 전후 `claude --help`, `claude --version`, `codex --help`, `codex --version` 같은
비인증 CLI capability probe만 허용한다. 권한 거부가 나오면 재시도·allowlist 변경 없이
그 결과를 receipt에 남기고 중지한다.

## 결과 기록 양식

실행 결과는 JSON stdout으로 반환하며, 최상위 `status`는 `validated`, `failed`,
`unavailable` 중 하나다. 예전의 `completed` 상태는 합격을 뜻하지 않으며 더 이상
성공 판정으로 사용하지 않는다. `validated`여도 결론은 native transport 검증뿐이고,
observed canonical model이 requested alias와 다르면 `mismatch-unconfirmed`로 별도
기록한다. provider별로 다음을 확인한다.

1. descriptor command와 원본 args가 기대한 model/effort를 포함하는가.
2. child session receipt의 observed model/session id가 존재하는가.
3. 짧은 구조화 응답이 JSON인지와 `tools_used: false`인지 확인 가능한가.
4. effort는 `requested_cli`와 `provider_confirmation`을 혼동하지 않는가.
5. permission denial, non-zero exit, timeout, stderr 오류를 성공으로 분류하지 않는가.
6. Codex는 local Luna 지원 증거가 없을 때 `attempted: false`, `networkAttempted: false`인가.

## 기존 Claude receipt의 재판정

추가 native 호출 없이 기존 private raw receipt를 새 validator로 로컬 재판정했다.

- validator: `valid: true`, 결론: `transport-validated-only`
- session receipt와 구조화 `status: ok` 존재, `tools_used: false`, permission denial count `0`
- observed `gpt-5.6-luna`는 requested `sonnet`과 달라 `mismatch-unconfirmed`로 기록
- effort provider confirmation은 `unconfirmed`
- 이 재판정은 transport 증거를 확인할 뿐 model/effort 적용이나 실제 API 청구를 주장하지 않는다.

이 smoke의 성공은 native delivery 증거일 뿐이며 full host parent loop 또는 Metis task
완료를 의미하지 않는다.
