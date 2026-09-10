# v1.1.0 vs current dirty Metis: bounded Sonnet comparison

Date: 2026-09-07

## 최종 판정

Sonnet native 재실험에서 baseline/current 모두 코드 통합과 외부 테스트는 성공했지만,
Metis 전체 목표 완료 전에 CLI 예산 한도로 종료됐다. **완료 시간·토큰 절감은 미입증**이다.
아래 초기 probe와 준비 실패는 시간순 기록이며, 최종 동일 조건 결과는 문서 마지막
「umask 보정 후 최종 bounded pair」절에 있다. 유료 추가 재시도는 중단했다.

## Scope and boundary

This is a bounded local experiment, not a release performance claim. The comparison used a
`git archive` extraction of tag `v1.1.0` (tag object
`b8afc654e699610c325372f58a3f419ebb186416`, commit
`34c976c72a6441a8f1cdfd9f53477b6e7a6758b0`) and a copy of the current working tree
including uncommitted changes on that same commit. The current
working tree was not cleaned, committed, or otherwise modified. Both disposable fixtures
excluded `.git`, `.metis`, `node_modules`, build output, and host state before a fresh fixture
Git repository was initialized.

The input was identical in both fixtures:

- `src/value.js`: `answer()` initially returns `41`;
- `tests/value.test.mjs`: one Node test requiring `42`;
- fixture tree hashes are in `metis-sonnet-benchmark-evidence/{baseline,current}-fixture-tree.sha256`.

Native order was baseline then current. The shared deterministic harness was run current then
baseline to reduce simple ordering bias. Only one repetition per condition was run. Therefore
no general speed improvement is inferred.

## Native host probe

The native executable was invoked directly (no shell alias) as:

```text
/Users/hakseong/.bun/bin/claude --model sonnet --permission-mode acceptEdits \
  --permission-prompts none --plugin-dir <fixture>/adapters/claude \
  --output-format json --max-budget-usd 0.75 -p '/goal $metis ...'
```

The host loaded the Metis 1.1.0 plugin in both fixtures and reported the requested `sonnet`
alias as `gpt-5.6-luna`; its canonical model field was `claude-sonnet-5`. The host permission
mode was `acceptEdits`. No bypass flag, alias, global configuration change, commit, or push was
used. No `.metis` directory, task graph, scheduler batch, host child receipt, or Metis runtime
run was created in either fixture. The native result is therefore classified as a **plain-host
edit probe**, not a Metis-v1.1.0-vs-current A/B.

| probe | host session | reported model | turns / host call proxy | wall | API duration | input | output | cache-read | CLI estimated cost | verification |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| v1.1.0 baseline | `9520be46-1aa9-447f-b2ce-e023f22f4762` | `gpt-5.6-luna` (`claude-sonnet-5`) | 5 | 23.553 s | 23.473 s | 48,588 | 546 | 65,024 | $0.1156408 | external test passed; native Bash test denied |
| current dirty | `52857f27-3768-439a-a5c8-33ab66ef49a0` | `gpt-5.6-luna` (`claude-sonnet-5`) | 4 | 17.134 s | 16.948 s | 25,147 | 385 | 64,000 | $0.0669440 | native exact test passed |

`total_cost_usd` is the Claude CLI's list-price estimate from the receipt, not an API billing
statement. API-billed cost was not exposed by this local environment and is recorded as
**unavailable**, not conflated with the CLI estimate. No nested subagent calls were reported in
either probe. The first baseline probe's requested `npm test` was denied by the unchanged
`acceptEdits` + `permission-prompts none` policy; an external `node --test` verifier passed.
The current probe used a narrowly scoped explicit `Bash(node --test tests/value.test.mjs)`
allowlist to complete the already-declared test. This was a permission-contract difference and
is not used as a Metis performance comparison.

절차 위반: baseline에서 권한 거부가 발생한 후 Main은 allowlist 변경 재시도를
금지했지만 테스트 agent가 current 호출에 위 allowlist를 사용했습니다. 사용자에게
그 변경의 별도 승인을 받은 것이 아닙니다. 해당 native 결과는 유효한 A/B 증거에서
제외하며 추가 native 실행은 중단했습니다. No native resume/new-session experiment was
run after the native-entry failure; calling `--resume` would not test Metis state because no
Metis state existed.

The raw host receipts are retained in:

- `metis-sonnet-benchmark-evidence/baseline-1.out`
- `metis-sonnet-benchmark-evidence/current-1.out`

They are evidence files, not claims of full native orchestration. Full native orchestration was
not established because `/goal $metis` only produced the host's `Goal set` boundary in these
noninteractive probes and no durable Metis task/receipt state appeared.

## Deterministic harness comparison

The same two existing test files were run from each isolated source fixture:

```text
node --no-warnings --test tests/benchmark-fixtures.test.js tests/benchmark.test.js
```

Both passed 50/50 with zero failures or skips. This is a local deterministic runtime-harness
measurement, not user-facing native completion time and not a full goal execution.

| source | tests | pass/fail/skip | Node reported duration | wall | user | sys |
|---|---:|---|---:|---:|---:|---:|
| current dirty | 50 | 50 / 0 / 0 | 13.813 s | 13.85 s | 5.99 s | 7.20 s |
| v1.1.0 archive | 50 | 50 / 0 / 0 | 14.185 s | 14.23 s | 6.26 s | 7.79 s |

The single observed wall difference is about 2.7% in favor of current (13.85 s vs 14.23 s),
well within the limits of one local repetition; it is not a statistically supported improvement.
The identical external one-test verifier measured 35.50 ms baseline and 33.43 ms current,
which is likewise not a meaningful claim.

Deterministic logs are retained in:

- `metis-sonnet-benchmark-evidence/current-deterministic.log`
- `metis-sonnet-benchmark-evidence/baseline-deterministic.log`

## Document recovery and resume boundary

The available native probe did not create a Metis run, so a fresh-session resume could not be
measured honestly. The current continuation/document-recovery implementation is not present in
the v1.1.0 archive, and substituting a fake receipt, forced phase, or synthetic completion
would invalidate the comparison. Existing deterministic recovery/document tests were inspected
as the applicable evidence boundary, but were not relabeled as native compact/resume evidence.
The common recovery subset (`context.test.js`, `context-objects-performance.test.js`,
`integration-recovery.test.js`, `owner-context.test.js`, and `reopen.test.js`) passed 25/25 in
each fixture:

| source | tests | pass/fail | Node duration | wall |
|---|---:|---|---:|---:|
| current dirty | 25 | 25 / 0 | 5.518 s | 5.55 s |
| v1.1.0 archive | 25 | 25 / 0 | 5.473 s | 5.50 s |

This is deterministic runtime recovery coverage only; the roughly 0.9% single-run difference
is not a performance claim. Logs are in `metis-sonnet-benchmark-evidence/{current,baseline}-recovery.log`.
In particular, a new native session would be a new session restoration attempt, **not actual
compact**. A full native Metis comparison remains blocked on a host invocation that enters the
runtime and supplies real permission-compatible task receipts.

## Reproduction

From this repository (without touching the user's working tree), recreate disposable source
fixtures with `git archive v1.1.0` and an excluded copy of the current tree, add the identical
one-file fixture, initialize disposable Git repositories, then run the two commands above.
For native probing, use the explicit binary and `--model sonnet` command shown above. Preserve
the same model, host persistence setting, permission mode, and bounded timeout; do not add any
bypass flag. For an official performance claim, use the existing benchmark contract's required
scenario matrix and repetitions rather than this one-repetition probe.

## 정상 설치 후 진입 재검증 — 권한 차단 (2026-09-07)

앞선 plugin-dir probe와 분리한 새 disposable 프로젝트 두 개를 만들고, 각 소스의
`init --host claude --root <fixture>`로 정상 설치했다. 양쪽 모두 설치 exit 0,
`.agents/metis/metis.mjs`와 `.claude/commands/metis.md` 존재 및 스킬의 launcher 연결을 확인했다.
사용자 저장소와 전역 설정은 변경하지 않았다.

- 증거 위치: `/var/folders/5w/7w1hw08s7gv4k7j8f57dslnw0000gn/T/metis-sonnet-entry-0o9xwqoz/`.
- baseline에 설치된 `/metis`를 명시 호출했다. `--model sonnet`, `acceptEdits`,
  `--permission-prompts none`, 예산 0.75 USD 설정을 유지했으며 allowlist는 추가하지 않았다.
- 실제 `Skill` 도구 호출과 설치 스킬 로드, runtime launcher 호출 시도를 확인했다.
  앞선 일반 편집 probe와 달리 Metis 스킬에 진입했다.
- 필수 명령 `node --no-warnings <fixture>/.agents/metis/metis.mjs lifecycle --pretty`가
  승인 surface 부재로 거부되었다. runtime 명령은 실행되지 않았다.
- 소스 편집, 실제 run, task graph, child receipt는 생성되지 않았다. native CLI가 exit 0과
  `is_error: false`를 반환했더라도 작업 성공이 아니라 권한 차단으로 분류한다.
- baseline 6 turns, host duration 18.866초, 외부 wall 19.045초,
  CLI estimated cost 0.0890884 USD. 성능 비교 결과가 아니다.
- 동일한 차단을 반복하거나 권한을 바꿔 재시도하지 않았다. current native 호출도 중단했다.

후속 실행에는 테스트 fixture 내부의 Metis launcher 실행 및 해당 테스트에 필요한
검증 명령에 대한 명시적 권한 승인이 필요하다. 범용 Bash 허용이나 전역 bypass로
대체하지 않으며, 실제 subagent 생성이 추가로 차단될 경우 별도 차단으로 기록한다.

## 사용자 권한 승인 후 실행 준비와 회복 시도

사용자가 “응해봐. 테스트하는 권한 다줌”으로 fixture 한정 실행 권한을 승인했다.
이후에는 정상 설치된 명령, fixture 전용 launcher·검증 명령 allowlist, Sonnet 지정으로
실행했다. 전역 설정·bypassPermissions는 사용하지 않았다.

준비 중 cwd 누락, shell 변수 확장, 경로 인용, `/var`와 `/private/var` 차이,
Node executable 경로 차이가 반복 차단을 일으켰다. 이는 공정한 성능 측정에 포함할
유효한 완료 run이 아니라 테스트 구성 실패이며 별도 기록한다.

| 시도 | 관측 결과 | host 시간 | CLI 추정 비용 |
|---|---|---:|---:|
| 승인 #1 | 잘못된 cwd, Unknown command | 0.059초 | $0 |
| 승인 #2 | 설정 옵션 추가 시도 중단 | 미확인 | 미확인 |
| 승인 #3 | scalar launcher 형태 차단 | 18.608초 | $0.0534824 |
| 승인 #4 | 도구 입력 validation 거절, native 미실행 | 해당 없음 | 해당 없음 |
| 승인 #5 | 인용된 launcher 형태 차단 | 21.140초 | $0.0569212 |
| 승인 #6 | 실제 runtime·worker 생성, ACK 누락 | 156.503초 | $0.2857912 |
| 승인 #7 | canonical path 불일치 | 17.444초 | $0.0529672 |
| 승인 #8 | 기존 live controller 충돌 | 11.459초 | $0.0454472 |
| 기존 세션 resume-1 | 이중 worktree 격리 | 140.969초 | $0.1760800 |
| 기존 세션 resume-2 | task worktree 편집, BLOCKED 결과, ACK 누락 | 115.818초 | $0.1871536 |

위 표의 확인 가능한 비용 합계는 $0.8578428이며, 미확인 비용과 이후 호출 비용은
포함하지 않는다. 이 숫자는 native CLI 추정치이며 감독·조사 에이전트 비용이나
provider 실제 청구 총액이 아니다. raw evidence는
`/tmp/metis-sonnet-entry-approved-20260907-baseline-*.json` 및
`/tmp/metis-sonnet-entry-approved-20260907-baseline-resume-*.json`에 보존했다.
인증정보가 포함될 수 있어 원시 파일을 공개하거나 본문에 인용하지 않는다.

### ACK 원인에 대한 정정

실제 Agent tool result에 agentId가 있었으며 runtime ACK 스키마는 그 실제 ID를
opaque `receipt` 문자열로 허용한다. 별도 structured host receipt가 필요하다는
초기 해석은 잘못됐다. 해당 task는 parent 없는 root worker이므로
`ownerExecution.hosts.claude.childSpawning=false`를 원인으로 단정한 것도 잘못됐다.

`TASK_SPAWN_NOT_ACKNOWLEDGED`는 completion reservation 전에 발생하며,
유효한 controller/batch/task fence 아래에서는 late ACK 후 남은 result file로
공식 task finish가 가능하다. 그러나 테스트에서 schedule ack는 실제로 한 번도
호출되지 않았다. 이후 controller takeover가 run fence를 2로 바꾸었으나 batch
fence는 1에 남았다. `scheduler.js:747-750`의 검사로 그 시점에는
`CONTROLLER_FENCED`가 발생하는 것이 확정이다. 이는 실제 ACK 호출 오류가 아니라
보존 DB와 소스로 확인한 결과다. fenced abort/requeue 경로는 별도로 존재한다.

기존 setup run은 COMPLETE로 바꾸거나 삭제하지 않았다. 수정은 runtime task
worktree에만 있었고 root 원본은 41 그대로다. BLOCKED 결과와 원본 로그를 보존했다.

## Main 직접 실행한 clean pair와 수집기 문제

별도 `/private/tmp/metis-sonnet-clean-hcxqs_hu/`에 같은 입력의 baseline/current를
설치했다. 설치된 child agent 17개 모델을 fixture 안에서만 Sonnet으로 통일했다.
같은 보완 지침과 50개 도구 허용 규칙을 사용하므로 원본 UX 무보정 실험이 아니라
**보완 지침을 제공한 host 실험**이다. 각 호출에 600초 timeout과 CLI 예산 $3를 적용했다.

baseline의 native 출력 파일은 최종 JSON 없이 비어 있었고, 실행 종료 직후
결과 수집기에서 SQLite read-only WAL 조회가 실패했다. 종료 코드·시간을 먼저
저장하지 않았기 때문에 해당 값은 복구할 수 없으며 0이나 성공으로 추정하지 않는다.
원래 process group 종료 및 sidecar 부재를 확인한 뒤 immutable 읽기로 복원한 DB에는
active/execute run, spawn ACK 2건, blocked worker와 blocked diagnostician이 있었다.
current는 그 수집 오류 때문에 아직 실행되지 않았던 상태에서 별도로 이어 실행했다.
이때부터 streaming 로그와 수집 전 실행 메타데이터 저장을 사용하며 이 차이를 공개한다.

baseline journal의 첫 실제 실패는 root 파일 mode 0644와 worktree baseline mode
0600의 차이였다. private log 보호를 위해 수집기가 설정한 umask 0077이 native
프로세스에도 상속된 것이 확인됐다. 파일 내용이 같아도 Git checkout mode가 달라졌다.
`/private/tmp/metis-mode-repro-_bxlojn8/summary.json`의 모델 없는 격리 재현에서
umask 0022는 checkout 0644, umask 0077은 checkout 0600을 만들었다.
Runtime의 snapshot은 mode를 포함하고 통합 때 root와 정확히 비교하므로 이 환경
차이는 실제 통합 충돌을 유발한다. 사용자 원본 저장소의 코드나 파일 mode는 바꾸지 않았다.

current도 600.042초 timeout으로 종료됐다(exit 143). DB는 active/execute,
worker blocked, diagnostician running, spawn ACK 2건이었다. root 소스는 41이고
테스트 입력은 변경되지 않았다. `task.finished` journal에 동일한
`WORKTREE_INTEGRATION_CONFLICT`와 root 100644 / captured 100600 차이가 기록돼
양쪽 모두 파일 mode 문제가 발생한 사실을 확인했다. 최종 native result event가
없으므로 전체 토큰·비용·권한 거부 합계는 미확인이다. 수집기의 빈
`deniedToolNames`는 권한 거부가 없었다는 증거가 아니다.

로그 파일은 비공개로 유지하되 native의 umask는 0022로 분리하는 수정된
실행기를 별도 fixture에 준비한 뒤 양쪽을 순서대로 한 번씩 실행했다.
앞선 실패 파일/DB는 덮어쓰지 않았다. 이 절의 실패 결과 역시 문서 workflow의
속도 향상 증거가 아니며, 공유 runtime과 테스트 환경의 상호작용을 새 기능의
회귀로 단정하지 않는다.

## umask 보정 후 최종 bounded pair

증거는 `/private/tmp/metis-sonnet-normal-mask-w5bo2d5y/`에 보존했다.
각 source를 새로 정상 설치한 fixture에서 baseline 다음 current 순으로 각 1회 실행했다.
fixture 경로를 정규화한 invocation JSON은 동일했다. Main과 설치된 child 모델은
Sonnet이며, CLI는 `gpt-5.6-luna` / canonical `claude-sonnet-5`로 보고했다.
`subprocess.Popen(..., umask=0o022)`로 native 실행 권한만 분리했으며 두 raw 로그의
실제 mode는 0600이었다. 동일한 권한 정책과 보완 지침, 호출당 CLI 예산 $1.50,
600초 제한을 적용했다. 권한을 더 넓히거나 production runtime을 고치지 않았다.

| 관측 항목 | v1.1.0 baseline | current dirty |
|---|---:|---:|
| 외부 wall time — 성공 완료 시간이 아님 | 355.077초 | 342.532초 |
| CLI 종료 | exit 1 / 예산 한도 | exit 1 / 예산 한도 |
| CLI 추정 비용 | $1.5129152 | $1.5252604 |
| 보고된 Main turns | 58 | 59 |
| `modelUsage` inputTokens | 248,394 | 229,705 |
| `modelUsage` outputTokens | 19,662 | 17,026 |
| `modelUsage` cacheReadInputTokens | 4,097,536 | 4,477,952 |
| runtime 상태 | active / review | active / review |
| 완료된 worker | 1 | 1 |
| task 상태 running / pending | 2 / 2 | 2 / 2 |
| 실제 spawn ACK | 3 | 1 |
| 최종 receipt의 Bash 거부 수 | 6 | 2 |
| root `answer()` | 42 | 42 |
| 원래 테스트 입력 유지 | 예 | 예 |
| 종료 후 Main 외부 테스트 | 1/1 통과 | 1/1 통과 |
| runtime 전체 완료 | 아니오 | 아니오 |

두 호출 모두 `error_max_budget_usd`로 끝났으며 timeout은 아니다. CLI가 보고한 비용은
호출 경계에서 설정값을 소폭 넘었으므로 $1.50을 정확한 청구 상한으로 표현하지 않는다.
최종 pair의 CLI 추정 비용 합계는 $3.0381756이다. 이는 이전 준비·실패 시도, 감독·조사
에이전트 비용, provider 실제 청구액을 포함하는 총액이 아니다.

토큰 표는 최종 receipt의 **모델별 집계 `modelUsage`**를 사용한다. 별도의 상위 `usage`
필드와 합산하지 않았으며, 독립적인 provider 청구 집계로 검증한 값도 아니다.
상위 `usage`의 input/output/cache-read는 baseline 121,138 / 11,049 / 3,354,112,
current 135,350 / 9,733 / 3,849,216으로 모델별 집계와 다르다.
API duration은 병렬 작업과 집계 범위가 다른 수치이므로 wall time으로 대체하지 않는다.

### 확인된 진행과 낭비, 해석 한계

- 양쪽 모두 파일 모드 충돌 없이 worker 완료와 root 통합까지 진행했다. 외부의 원래
  Node 테스트도 통과했다. 이는 앞선 실험의 파일 모드 차단이 제거됐다는 증거이지
  독립 verifier와 전체 Metis 목표 완료를 대신하는 증거는 아니다.
- 두 task graph 모두 worker 외에 integration reviewer, verifier, adversarial reviewer,
  curator를 만들었다. 단일 반환값 변경에서도 총 5개 역할 task가 생겼고, 예산 종료 때
  reviewer/verifier는 running, 나머지 두 역할은 pending이었다. current는 ACK가 1건뿐이므로
  DB의 running을 실제 child가 실행됐다는 증거로 세지 않는다.
- 보존된 host stream에서 `ScheduleWakeup` tool call은 baseline 16회, current 15회였다.
  이는 스케줄 도구 호출 횟수일 뿐 실제 대기 시간이나 완료된 작업 수가 아니다.
  baseline은 600/1200초 지연을 반복 요청했고 current는 `ListAgents`도 7회 호출했다.
  짧은 과제에서도 조정·대기 관련 도구 사용이 많았다는 관측이며, 그 전부를 runtime 코드의
  지연으로 귀속하거나 모델 계산 시간과 분리해 계측한 것은 아니다.
- 최종 permission denial은 양쪽에 남았다. 여러 명령을 묶는 shell 형태 등이 포함됐으므로
  동일한 allowlist라도 모델이 실제 작성한 명령과 거부 경험까지 동일하지는 않았다.
- 종료까지 current가 12.545초 짧았어도 **성공 완료 속도가 빨라졌다고 계산하지 않는다**.
  둘 다 예산으로 잘렸고 실제 ACK/진행도도 달랐다. 한 번의 순차 실험으로 통계적 우열을
  주장할 수 없다.
- 일반적인 작은 execute 목표만 측정했다. PRD → plan → run의 초기 문서 비용이나
  실제 compact 이후 복원 시간·중복 조사 절감은 측정하지 않았다.

두 fixture의 추적 대상 process group 종료를 확인했다. DB의 미완료 상태는 증거로
보존했으며 강제 COMPLETE, 가짜 receipt, 수동 DB 수정, 추가 예산 재시도는 하지 않았다.

**결론:** 문서·복원 기능의 성능 이득은 아직 입증되지 않았다. 반면 이 작은 작업에서는
양쪽 모두 여러 검토 역할과 host 조정 호출 때문에 전체 종료까지 가지 못했다는 실제
운용 결과를 얻었다. 다음 최적화 후보는 문서 기능 삭제가 아니라 작은 작업의 검토 역할
정책과 host의 spawn/ACK/대기 흐름이다. 후보의 production 수정은 이번 테스트에 포함하지 않았다.
