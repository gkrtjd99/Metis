# Verification

Metis 1.1.0 verifies the runtime control plane and the subagent-first workflow
contract. The local 1.1.0 package check passed with 466 tests passing, zero
failures, and one Chromium-unavailable skip out of 467. This includes offline
tarball installation and installed CLI initialization. These local results are
recorded separately from any final-tag rerun.

## Release command

Run:

```sh
npm run check
```

This command performs:

```text
JavaScript syntax checks
  -> generated reference drift check
  -> structural release validation
  -> complete Node.js test suite
```

The bounded native execution-stage evidence currently recorded for Claude Code
and Codex is: owner → worker → independent verifier → same-owner resume →
complete, with actual host receipts, an immutable test hash, and audited
SQLite state. These actual CLI checks passed on commit `162dbff` before the
1.1.0 release metadata updates; the published 1.1.0 artifact preserved that runtime
implementation. The unreleased continuation changes require separate evidence
and are not covered by those results. The fixture's `forcePhase`
supplies plan-stage setup, so
the passed flow covers execution rather than autonomous plan generation.
Multi-owner real parallelism, real-host failure recovery, and performance
improvement were not measured by this smoke test. The local 1.1.0 package result
above was obtained separately after the version and conformance-test updates.

Generate the reference after changing metadata, defaults, layout, or CLI help:

```sh
npm run docs:generate
```

## 미출시 실행 정책의 인수 검증

기존 릴리즈의 통과 건수나 native 실행 증거를 새 실행 정책의 검증 결과로 재사용하지 않는다. 이번 보강의 재현 명령과 검증 경계는 다음과 같다.

```sh
# 실제 파일 실행과 매 호출 별도 CLI process를 포함하는 인수 테스트
node --no-warnings --test tests/execution-policy-process-cli.test.js tests/host-capacity-cli.test.js

# 실제 provider를 호출하지 않는 native receipt 판정기 테스트
node --no-warnings --test tests/native-effort-delivery.test.js

# disposable 소스 사본에서 방어 로직을 제거해 탐지력을 검증
node --no-warnings scripts/test-execution-policy-mutations.mjs
```

공개 CLI 테스트는 정상 흐름을 `forcePhase`나 raw SQL로 건너뛰지 않는다. 사용자 승인과 worker/verifier는 자동 fixture이지만 verifier는 실제 산출물을 별도 Node process에서 실행한다. 성공을 주장하는 worker가 잘못된 값을 쓰면 runtime 완료가 차단되어야 한다.

변이 검증은 승인 설정 검사, host cap 적용, plan seal rollback의 세 방어 로직을 대상으로 한다. baseline이 먼저 통과해야 하고, 각 변이가 assertion 실패를 일으켜야 한다. syntax/import 오류·일반 runtime 오류·timeout을 탐지 성공으로 세지 않는다. 이는 선정한 방어 로직의 검증이지 전체 mutation coverage가 아니다.

실제 native 전달 smoke는 별도 opt-in이다. 정상 테스트나 변이 검증은 provider 네트워크를 호출하지 않는다. native child의 응답과 session receipt가 있어도 요청한 모델·effort의 provider 내부 적용이나 전체 Metis parent loop 완료가 입증되는 것은 아니다.

결과와 남은 한계는 [실행 정책 테스트 보강 기록](plans/metis-execution-policy-test-hardening.md) 및 [native 전달 증거](plans/metis-native-effort-delivery.md)를 따른다.

### 실제 CLI child 인수 검증 (2026-09-08)

후속 검증에서 deterministic parent harness가 공개 CLI로 계획·fixture 승인·상태 조정을 수행하고, 실제 로컬 Claude CLI worker와 별도 verifier를 연결해 `COMPLETE`에 도달했다. Main의 read-only DB 감사에서 서로 다른 실제 session receipt 두 개와 ACK가 일치했고, 두 task 모두 한 번의 attempt로 완료됐다. 최종 산출물을 별도 Node process에서 실행했으며 worker 완료 후 graceful `pause` / `resume`에서도 같은 run과 완료 상태를 유지했다.

이는 native Main의 자율 `$metis` 전체 loop나 host session 강제 종료·compact 복원 검증이 아니다. 요청 argv는 `sonnet` / `medium`이지만 관측 model은 `gpt-5.6-luna`여서 모델 매핑과 provider 내부 effort는 미확인이다. 초기 잘못된 판정기의 호출은 인수 성공에서 제외했다.

전체 회귀 검사는 **627 tests / 626 pass / 0 fail / 1 Chromium skip**이다. 이 건수는 실제 provider 인수 테스트 건수가 아니다. 실패 이력·비용·실제 receipt·재현 명령은 [실제 CLI child 인수 검증 기록](plans/metis-native-acceptance-2026-09-08.md)에 보존했다.

### 실제 session 강제 종료·compact 후 복원 (2026-09-08)

후속 no-tools Claude CLI 실험에서는 실제 응답의 첫 text delta 뒤 process group을 `SIGKILL`하고, 새 process로 동일 session을 재개했다. 목표 ID·값·제약을 다시 제공하지 않고도 원래 값이 유지됐다. 이어 실제 `/compact`의 `manual` boundary를 관측했으며 압축 후 재개에서도 같은 session과 값이 유지됐다. 강제 종료한 turn은 terminal result가 없으며 성공 응답으로 세지 않는다.

이는 host session의 지속성·강제 종료 복구·압축 검증이다. native Main이 Metis controller/task를 조정하는 전체 흐름의 복원은 아니며, 기존 tool permission 및 Codex hook trust 경계를 우회하지 않았다. 모델 catalog 조사, 추가 검증 결과 및 남은 차단 사유는 [남은 native 검증 기록](plans/metis-native-remaining-verification-2026-09-08.md)에 기록한다.

### Codex 승인 descriptor와 실제 child 완주 (2026-09-08)

로컬 bundled catalog에서 `gpt-5.6-luna`와 medium 지원을 확인한 뒤, Codex로 명시 승인한 plan에서 실제 Codex descriptor를 생성하고 worker·verifier를 호출했다. 수동 strict flag 없이 승인에서 strict가 자동 적용됐고, DB의 selected model 및 requested/effective effort와 descriptor의 reasoning effort가 일치했다. 서로 다른 실제 receipt 두 개가 ACK와 일치했으며 두 task 모두 한 번의 attempt로 완료됐다. Main의 read-only DB 감사와 별도 Node 산출물 실행도 통과했다.

최종 전체 검사는 **641 tests / 640 pass / 0 fail / 1 Chromium skip**이다. 검사 전후 소스 해시가 동일했다. 초기 Claude descriptor 재사용 실행은 Codex adapter 증거에서 제외했고, stdin 안내문으로 중단한 실패도 별도 보존했다. [후속 기록](plans/metis-native-remaining-verification-2026-09-08.md)에 최종 실제 run·receipt·실패 이력과 검사 로그를 기록했다.

계획·승인은 여전히 deterministic harness가 수행했으므로 native Main 자율 loop는 검증한 것이 아니다. provider 내부 model/effort 적용과 실제 청구액도 미확인이다.

### 실제 native Main의 계획·실행 조정: 미통과 (2026-09-08)

사용자의 명시 승인을 받은 새 임시 프로젝트에서만 제한된 CLI helper를 허용했다. 전역 설정·bypass·다른 프로젝트 도구 접근은 허용하지 않았다. 초기 restricted 인증 구성과 임시 helper의 인자 처리 실패를 분리해 보존한 뒤, 실제 native Main이 같은 세션의 plan/run 두 turn으로 목표·계획 승인 대기·실행 승인·worker claim까지 수행했다. permission denial은 없었다.

그러나 **전체 인수는 미통과**다. 초기 설정 순서를 안내하지 않은 run은 start 뒤 model configure를 호출해 실패했다. 이를 안내한 마지막 run도 기본 모델 설정만 저장하고 계획의 명시적 `executionSettings` 확인을 빠뜨렸다. 실제 claim은 sonnet/medium이었지만 `effort_exact_required: false`였으며, runtime claim 뒤 테스트 helper가 child 생성을 거부했다. 독립 DB 감사에서도 plan executionSettings는 없었고 미실행 verifier의 route는 high였다. 이는 저장된 명시 승인값을 runtime이 무시한 결과가 아니라, Main이 승인 의도를 durable 설정으로 저장하지 않은 결과다. worker/verifier 실제 호출·ACK·COMPLETE는 없고 `nativeMainVerified: false`다. CLI exit 0이나 일부 lifecycle 진행을 전체 완료로 세지 않는다.

회귀 재검사는 **641 tests / 640 pass / 0 fail / 1 Chromium skip**, 고정 소스 해시 일치였다. 이 통과와 native Main 인수 실패는 동시에 성립한다. [후속 기록](plans/metis-native-remaining-verification-2026-09-08.md)에 실제 실패 run·session·비용·helper 결함과 남은 경계를 보존했다. 이번 단계에서는 제품 runtime·스킬을 수정하지 않았다.

### Quote-aware native Main 재실행 (2026-09-09)

실제 denial command의 quoted launcher 경로만 임시 allowlist에 추가한 뒤 disposable fixture에서 native Main plan/run을 한 번 재실행했다. plan turn은 실행 승인 대기까지, run turn은 명시적 `plan execute`·execute 진입·worker claim·한 건의 host receipt ACK까지 도달했다. 그러나 child SDK가 `gpt-5.6-luna`를 `unrecognized_model`로 거부했고 `$1.50` bounded budget도 초과해 verifier 전에 중단됐다. read-only DB에서 worker는 running, verifier는 pending, run은 `execute/active`, candidate는 answer 41이었으며 `COMPLETE`가 아니었다. `nativeMainVerified: false`를 유지하고 추가 provider 재시도는 하지 않았다. 상세 report와 한계는 [남은 native 검증 기록](plans/metis-native-remaining-verification-2026-09-08.md)에 보존했다.

이번 단계에서 `next`가 controller 인증 없이 checkpoint/progress 상태를 변경하지 않도록 공개 CLI guard를 보강하고 회귀 테스트를 추가했다. focused execution-policy CLI test는 **4/4 통과**했다.

## 1.1.0 orchestration coverage

The performance release coverage additionally verifies:

- lifecycle profile selection is deterministic; unsafe `fast` requests are
  rejected and `balanced`/`full` retain their required gates;
- eligible `fast` plans receive an exact deterministic review after all packets
  compile, while integration review and verification run as independent
  read-only siblings against the same candidate;
- `drive` advances bounded controller actions without bypassing Main's fences;
- discovery/research general atomic materialization is idempotent;
- progressive effort is negotiated against capability evidence and rendered by
  the selected host adapter;
- every claim creates append-only attempt provenance and retries do not erase
  prior attempts;
- `metis performance report` exposes verified completion, phase and
  concurrency evidence without raw child output;
- token packet-budget warnings are durable; they do not become silent success.

The release tests verify that the lifecycle is executed by subagents instead of Main.

## Release security and supply-chain coverage

Release readiness also records:

- commit-pinned checkout, setup, and plugin security scanner actions in CI;
- `npm ci` coverage for the committed lockfile, plus Dependabot and SECURITY
  policy surfaces;
- scanner-safe deterministic fixtures whose behavior is verified externally;
- disposable benchmark workspaces with explicit child environments, bounded
  process cleanup, and scoped host/model evidence;
- task-ID validation before filesystem mutation, detached worktrees, and
  declared path ownership for mutable tasks.

These controls establish release integrity and containment. They do not assert
or imply a performance improvement.

### Discovery and research

Tests verify:

- discovery creates parallel scout tasks;
- Main does not perform repository discovery itself;
- a synthesizer follows completed scouts;
- researcher and synthesizer roles use bounded structured results;
- child evidence, not Main transcript, becomes the phase artifact.

### Planning and task decomposition

Tests verify:

- a planner returns a typed `PlanDraft`;
- the runtime atomically ingests interfaces, milestones, tasks, dependencies, and waves;
- unknown dependencies and graph cycles are rejected;
- task risk, effort, slice type, verification modes, and capabilities remain structured;
- the scheduler dispatches only the earliest open wave;
- a running or blocked earlier wave prevents later-wave dispatch;
- plan-time compiler tasks share one parallel compilation wave.

### Task Packet compilation

Tests verify:

- deterministic packets contain role protocol, scope, selected context, capability procedures, acceptance criteria, verification, stop conditions, and result schema;
- complex and high-risk tasks create a fresh task-compiler task;
- the target waits until the compiler completes;
- compiler overlays cannot change protected contract fields;
- unresolved ambiguity blocks dispatch;
- Main context excludes complete packet text.

Protected fields include:

```text
scope
mutable paths
authority
dependencies
acceptance criteria
frozen interfaces
```

### Frozen interfaces

Tests verify:

- only frozen interfaces can bind to tasks;
- interface content is included in the Task Packet;
- a replacement version supersedes the previous version;
- linked Task Packets become stale;
- stale packets cannot dispatch;
- completed tasks attest every declared input and output with the exact frozen content hash;
- stale, undeclared, or missing interface reports are rejected.

### Failure diagnosis

Tests verify:

- failed children become blocked when diagnosis-first policy is active;
- the controller requests a fresh diagnostician task;
- Main does not immediately retry or repair the task;
- a diagnosis returns a classified failure and one recommended route.

## Scheduler and process concurrency

Concurrency tests use separate Node.js processes against the same SQLite database and Git repository.
They verify:

- only one controller owns a repository run;
- controller fencing rejects stale writers;
- eight scheduler processes cannot claim the same task batch;
- a batch claim is atomic;
- spawn budget changes only after acknowledgement;
- task and controller heartbeats renew leases;
- expired attempts fail closed;
- stale results cannot finish a newer attempt;
- integration ownership cannot be stolen during a long operation;
- concurrent progress sampling is idempotent.

These tests exercise real operating-system process contention.
They do not simulate concurrency only inside one JavaScript call stack.

## Worktree and integration coverage

Tests verify:

- every mutable task receives a detached Git worktree;
- path-like or unsafe task IDs are rejected before task/worktree filesystem
  mutation;
- no shared mutable fallback exists;
- overlapping mutable path ownership is rejected;
- unreported changed files are rejected;
- out-of-scope changes are rejected;
- main-workspace races are detected;
- symbolic-link escapes are rejected;
- integration uses the current baseline;
- a stale worker cannot integrate a newer attempt.

## Structured command coverage

Verification and benchmark commands use an executable plus argument array.
They disable shell interpretation.

Tests verify:

- command arguments are not reinterpreted by a shell;
- a successful check that modifies protected repository state fails;
- a successful non-mutating check passes;
- repository benchmark execution requires explicit opt-in;
- each benchmark run uses a disposable workspace with an explicit child
  environment and keeps its process/cleanup evidence bounded to that run;
- benchmark timeout cleanup settles once even when an escaped descendant keeps
  inherited stdout and stderr open;
- Linux descendant containment exercises the runtime `/proc` inventory path;
- benchmark and uninstall manifest traversal is rejected.

## Evidence and currentness

Tests verify:

- source evidence records current hashes;
- changed source makes dependent evidence stale;
- changed code fingerprints make old checks and reviews stale;
- typed evidence remains reachable through garbage collection;
- large child output moves outside active Main state;
- object payloads remain addressable by reference;
- observed host token usage updates hard budgets.

Performance benchmark verification also requires scenario and variant labels,
verified-only duration statistics (median and nearest-rank P95), pass-rate and
failure counts, and a plain-host control. Repository benchmark execution stays
explicitly opt-in. A claimed threshold is invalid when failed or unverified
runs are included in completion-time statistics.

## Browser verification

The suite contains a native browser smoke test.
When a compatible Chromium executable is available, the test starts a real browser process and communicates through the Chrome DevTools Protocol.
It verifies:

- navigation to the test document;
- DOM assertion execution;
- viewport handling;
- screenshot capture;
- console and network result collection;
- browser evidence ingestion;
- code fingerprint binding.

Browser evidence is still a child responsibility in the managed workflow.
Main does not operate the browser or decide that a screenshot is correct.

Environment policy can block ordinary HTTP navigation.
The smoke test can use an inline document while still exercising the real browser process and protocol.

## Lifecycle and completion coverage

The suite verifies:

- explicit `$metis` opt-in;
- Goal Contract freeze and amendment;
- ten canonical phases;
- discovery, research, design, plan, execute, review, verify, curate, and complete gates;
- independent design and plan critics;
- review findings converted to repair tasks;
- current verification candidate generation;
- adversarial completion review;
- traceability from requirement to implementation and verification;
- assumptions, invariants, risks, and authority gates;
- documentation impact and knowledge synchronization;
- budget and progress-stop states;
- structured journal replay.

A plan, child result, review, or passing test does not complete the run by itself.
Completion uses current runtime state only.

## Installation and packaging coverage

Tests verify installations for Codex, Claude Code, and OpenCode.
They check:

- managed files and plugin manifests;
- exact skill and reference mirrors;
- existing host configuration preservation;
- forced installation backup and restoration;
- partial uninstall behavior;
- modified managed-file preservation;
- dry-run cleanup and uninstall behavior;
- npm pack archive extraction and public entrypoint/CLI smoke;
- generated documentation conformance.

Attachment coverage also verifies that project adapters resolve an explicit or
enclosing Git root, reject non-Git roots before mutation, perform no unrelated
repository scan, preserve differing files under `force=false`, and report the
`no-run`, live-controller, expired-controller, paused, and completed routes
without automatic takeover.

The 1.1.0 packed archive includes the current Task Packet, interface,
plan-ingestion, and role runtime surfaces. Development tests remain in Git for
CI and are excluded from the installable package.

## Continuation preview boundary

2026-09-07 로컬 작업 트리의 `npm run check` 결과: 총 510개 중 509개 통과,
실패 0개, Chromium 미설치로 1개 건너뜀. 이 명령은 reference 동기화,
정적 validation과 전체 테스트를 포함합니다. 종료된 WAL database 조회 시
보조 파일을 생성하지 않는 회귀 검사와 WAL·shared-memory·rollback journal
존재 시 파일 변경 없이 `PAUSE / STATE_BUSY`를 반환하는 검사도 통과했습니다.
이는 미공개 preview의 로컬 검사 결과이며 native goal E2E 증거가 아닙니다.

The continuation tests validate the deterministic, read-only boundary and its
host response contract; they do not establish full native goal E2E. Coverage
includes:

- `inspect` returns `DETACHED` without a binding and does not create `.metis`,
  initialize a database, sample progress, renew a lease, or mutate runtime state;
- binding rejects unsupported hosts, missing or malformed session IDs, absent
  native-goal-inactive confirmation, empty evidence, mismatched projects, and
  stale or foreign controller credentials; the operator must supply the actual
  native session ID because the CLI cannot prove an arbitrary ID's origin;
- repeated binding for the same authenticated session is idempotent, while
  explicit `--rebind` is limited to resetting delivery bookkeeping;
- `CONTINUE`, `WAIT`, `PAUSE`, `COMPLETE`, and `DETACHED` map deterministically;
  `WAIT` does not continue without host-visible background evidence;
- durable completion is required for `COMPLETE`, and blocker, stale lease,
  unreadable state, budget, and no-progress/cap conditions pause safely;
- Claude hooks use `Stop`, `SessionStart`, `StopFailure`, and `SessionEnd`,
  while Codex uses `Stop` and `SessionStart`; they use actual host session
  input, never run an evaluator, preserve unrelated hook settings, and uninstall
  only managed content; delivery bookkeeping is separate from runtime state;
- after a pause, block cap, no-progress boundary, or hook failure, continuation
  stays stopped until the operator explicitly rebinds/resumes; native user
  interrupt/cancellation is not treated as a universally observable event;

The existing `/goal $metis` path remains the legacy native-evaluator path.
Standalone continuation is an opt-in preview. Claude and Codex hook adapter
coverage is not a claim that standalone `$metis` has passed a complete real-goal
multi-turn E2E; that evidence is still pending. OpenCode remains outside this
continuation support boundary.

### Native continuation contract probe (2026-09-07)

- Claude Code 2.1.263 delivered `SessionStart`, `Stop`, and `SessionEnd` in a
  disposable Git fixture. The first Stop returned `decision: "block"`; the host
  ran a second model iteration, and the second Stop returned `{}`. The process
  exited 0 with `is_error: false` and `num_turns: 2`. The requested `sonnet` alias
  was observed as `gpt-5.6-luna`. The host reported an inherited
  `bypassPermissions` mode although the probe did not enable it; this is not
  evidence of behavior under constrained tool permissions.
- Claude Stop input included `stop_hook_active` and a `background_tasks` array,
  but no `turn_id`. Active background-task element shapes and StopFailure
  delivery were not exercised.
- Codex 0.153.4 exposed the native hooks feature, but project hook trust prevented
  execution in the noninteractive fixture. Hook trust was not bypassed. Model
  calls completing without hook delivery do not count as a passing hook probe.
- This used a minimal fixture hook, not the actual Metis continuation runner.
  It proves only the Claude native blocking contract, not a full Metis goal or
  real Codex continuation. An earlier Claude attempt outside the fixture cwd
  did not load the hooks and is excluded from the passing evidence.

## Durable skill workflow coverage boundary

2026-09-07 목표별 문서 추가 구현 검증: `npm run check` 총 559개 중 558개 통과,
실패 0개, Chromium 미설치로 1개 건너뜀. 집중 검사 29/29 및 설치 launcher의
`goal prd` 호출을 포함한 CLI 검사 4/4 통과. `docs:check`, `validate`, `git diff --check` 통과.
Package dry-run은 219개 파일이며 `src/core/goal-documents.js` 포함,
tests/runtime 상태/docs/plans/실제 docs/metis 목표 폴더 및 tarball 생성 없음.
추가 독립 read-only 검토에서 확정 correctness 결함 없음(실제 host E2E 미실행).
로그: `/tmp/metis-goal-documents-check.log`, `/tmp/metis-goal-documents-pack.json`.

`tests/goal-documents.test.js`는 결정적 slug, 충돌·기존 파일 보존, 경로 escape,
각 부모/문서의 symlink·dangling link·hardlink·종류 충돌, Git/root 및 no-bootstrap CLI,
DB 재open 후 같은 폴더 복원, 원본 수정·삭제와 snapshot 분리, legacy/external/source-free
unbound, bound artifact.path 제자리 변경 금지를 검증한다. `plan.md`/`decisions.md`의
실제 host 작성·갱신은 스킬 지침이며 자동 export 또는 이 테스트의 semantic E2E 증거가 아니다.
동시 부모 디렉터리 교체를 막는 OS sandbox 보장도 하지 않는다.

이전 단계(목표 폴더 추가 전) 로컬 `npm run check` 결과는 총 549개 중 548개 통과,
실패 0개, Chromium 미설치로 1개 건너뜀입니다. 신규 흐름 집중 검사도
39/39 통과했습니다. 최초 전체 검사에서 누락된 구체적인 host별 attach 명령을
복원한 뒤 전체 검사를 다시 통과했습니다. 독립 리뷰에서 확정된 결함은 없었으며,
리뷰 fixture의 승인 후 task claim은 Git HEAD 부재로 동적 검증이 제한되었습니다.
전체 suite의 별도 Git fixture에서는 승인 후 claim까지 통과했습니다.
Package dry-run은 218개 파일에 신규 core/reference/template이 포함되고,
개발 테스트·runtime 상태·내부 계획 문서가 제외됨을 확인했습니다.
이는 미커밋 preview의 로컬 증거이며 실제 host compact나 전체 goal E2E 증거가 아닙니다.

검증 범위는 다음과 같습니다:

- `$metis prd "idea" -> $metis plan @path -> $metis run` remains separate from
  native `/goal $metis` and preserves the existing `$metis:model` behavior;
- PRD records the interview/document only, while plan-only start sets
  `Goal Contract.route.executionApprovalRequired: true` and stops at the existing
  seal/review authority checkpoint;
- only explicit `plan execute --reason ...` approval permits execution, and
  `resume`, empty input, and `status` do not act as approval, takeover, or
  rebind;
- the PRD snapshot uses the existing artifact path and
  `sourceDocument: { artifactId, contentRef }`로 저장된 snapshot을 연결합니다.
  원본 디스크 파일은 변경 가능하며 snapshot과 구분합니다;
- bounded `goal restore` records context/object/token handles for the current
  contract, plan, decisions, and state, is not read-only, does not reopen the
  original source, and does not inline raw PRD, worker output, or credentials
  in the recovery packet;
- same-run source identity and tamper checks are required before restore or
  execution, without automatic native-state clearing;
- OpenCode skill deployment remains distinct from OpenCode continuation-hook
  support, and continuation preview limits remain in force.

Complete native host syntax and full-goal E2E evidence for this workflow remain
unverified. These bullets are coverage and evidence boundaries, not a claim that
those host flows have passed.

## Native host boundary

The normal release suite validates host adapters, installed role files, task contracts, spawn descriptors, scheduler acknowledgement, and task result ingestion.

Actual native Codex, Claude Code, and OpenCode end-to-end tests require those CLIs to be installed and authenticated in the release environment.
If they are unavailable, the release metadata must state that limitation.
A green package suite must not be described as a native-host agent-spawn test.
For the 1.1.0 public release, Claude Code and Codex have the bounded
execution-stage evidence described above; this does not establish full native
release-environment E2E. OpenCode remains an adapter preview. Full native
release-environment evidence is still pending.

## Release evidence

A release record should contain:

- source test result;
- packed archive extraction and smoke result;
- package and archive file counts;
- SHA-256 checksums;
- Node.js, npm, and Git versions;
- native host CLI availability;
- browser smoke availability and result;
- schema, configuration, and runtime layout versions.

The 1.2.0 release versions are:

```text
package: 1.2.0
schema: 11
configuration: 6
runtime layout: 4
```

Schema, configuration, and runtime layout remain unchanged from the latest
public 1.0.1 release; no migration is required.

The benchmark variant `metis-pre-1.0-baseline` intentionally names the
historical pre-1.0 source. Separate compatibility fixtures describe the
unmodified 1.0.0 schema. The existing comparison preset remains `metis-1.0.1-candidate`; it is a
historical required-suite identifier, not 1.1.0 performance evidence. None of
these names is a performance claim.
