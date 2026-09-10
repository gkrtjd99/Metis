# Metis 상태 기반 실행 지속 구현 계획

- 작성일: 2026-09-07
- 브랜치: `feat/metis-state-driven-continuation`
- 기준: `v1.1.0` / `34c976c72a6441a8f1cdfd9f53477b6e7a6758b0`
- 상태: preview 구현 및 로컬 전체 검사 완료. `npm run check`: 510개 중 509개 통과, 실패 0개, Chromium 미설치로 1개 건너뜀. 현재 작업 트리의 runtime/CLI 구현은 실제 Metis native goal E2E 통과나 공개 지원·배포 완료를 의미하지 않는다.
- 요청 범위: continuation 구현과 문서 계약 정리. commit, push, PR 생성, 공개 배포는 수행하지 않는다.
- 실제 host 검증: Claude 2.1.263의 최소 hook에서 Stop block 후 두 번째 모델 턴을 확인했다. 실제 Metis runner 또는 전체 목표 E2E 검증은 아니다. Codex 0.153.4는 project hook 신뢰 승인에 막혀 실제 전달을 확인하지 못했고 우회하지 않았다. 세부 증거와 권한 모드 제한은 `docs/VERIFICATION.md`에 기록했다.
- 읽기 전용 경계: WAL·공유 메모리·rollback journal이 남은 DB는 안전하게 중단한다. 보조 파일이 없는 DB만 immutable 조회하고 파일 식별자·변경 시각·보조 파일 존재 여부를 조회 전후 대조한다. 기존 runtime의 journal mode를 바꾸거나 WAL을 삭제하지 않는다.

현재 구현된 CLI 표면은 다음과 같다. Hook 설치·제거는 명시적이며 `init`에
포함되지 않는다.

```text
metis continuation install|uninstall --host claude|codex
metis continuation inspect --host <host> --session-id <native-session-id>
metis continuation bind --host <host> --session-id <native-session-id> \
  --native-goal-inactive --evidence <nonempty> [controller credentials]
metis continuation detach --host <host> --session-id <native-session-id> [controller credentials]
```

`inspect`는 read-only이고, bind/detach는 기존 controller credentials를
요구한다. `--rebind`는 같은 controller/session의 delivery bookkeeping만
명시적으로 reset하며 takeover가 아니다. 기존 `/goal $metis`는 legacy native
evaluator 경로로 유지하고, standalone `$metis`는 Claude/Codex opt-in preview로
기록한다. 실제 full-goal E2E가 통과하기 전에는 supported라고 주장하지 않는다.

## 1. 목표와 결정

사용자는 `$metis "목표"`로 Metis를 명시적으로 시작한다. 목표 계약·다음 행동·작업 검증·완료 판단은 Metis가 관리한다. Host는 Metis 상태에 따라 Main의 실행을 지속하거나 대기·중단하며, 별도의 모델로 같은 목표의 달성 여부를 재평가하지 않는다.

기존 Main → owner → worker / 독립 verifier 구조를 유지한다. 새로운 상위 감독 agent나 목표 evaluator를 추가하지 않는다. 변경 대상은 작업 오케스트레이션 자체가 아니라 **host 세션과 runtime 사이의 실행 지속 연결**이다.

권장 구현은 다음과 같다.

```text
명시적인 $metis 요청
  → host별 skill/command 진입
  → 안전한 project attachment와 lifecycle 확인
  → host Main 세션과 Metis run 연결
  → Main이 next/action/result 반복
  → host가 턴 종료 또는 child 결과 이벤트 수신
  → Metis의 순수 continuation 판정 조회
      CONTINUE → 동일 Main/run의 다음 행동 진행
      WAIT     → 기존 child 결과 대기와 제한된 liveness 유지
      PAUSE    → 사용자·권한·예산·복구 판단을 보고하고 자동 진행 중단
      COMPLETE → runtime 완료를 보고하고 종료
      DETACHED → 활성 Metis 연결이 없으므로 일반 host 동작 유지
```

`CONTINUE` 등의 이름은 **제안하는 새 continuation ABI의 판정값**이다. 현재 CLI에 이미 존재하는 명령이나 상태라고 설명하지 않는다.

## 2. 현재 확인한 구현과 한계

- `skills/metis/SKILL.md:10-13`은 `/goal`이 host goal을 유지하고 `$metis`가 engineering lifecycle을 Metis에 넘기는 역할 분담을 기술한다.
- 같은 문서의 `111-114`에는 `next → action → 결과 저장 → next` 반복이 있다. 따라서 작업 반복 규칙은 존재하지만, 종료된 host 턴을 다시 시작하는 독립 실행기는 아니다.
- `commands/metis.md`와 host adapter의 command/skill이 진입점을 제공한다. Native `/goal` 자체는 이 저장소가 구현하지 않는다.
- Goal Contract freeze/amend, runtime completion gate, owner 권한, controller/task lease와 attempt fence는 이미 존재한다.
- `nextControllerAction`은 progress sampling뿐 아니라 `gateReport` 경유 repository sync·milestone 갱신에도 연결된다. CLI `next`의 context 생성은 object/context snapshot을 저장한다. Hook에서 기존 `metis next`나 `status --context`를 조회처럼 호출하지 않는다.
- 일반 `openDatabase`는 runtime layout 생성, schema setup, capability registry 동기화, integration recovery를 수행한다. 기존 `project-bootstrap.js`의 `routeLifecycle`가 사용하는 pre-existing DB의 `DatabaseSync({ readOnly: true })` 경로를 순수 조회 설계의 기준으로 삼는다.
- `metis drive`는 제한된 deterministic transition 실행기다. 실제 host agent 생성·Main 행동·host 턴 재호출을 대체하지 않는다.
- 기존 `SELF_EVALUATE` / `metis evaluate`는 deterministic runtime 정책이다. 이번에 제거하려는 별도 host 모델 evaluator와 혼동하여 기존 lifecycle gate를 삭제하지 않는다.
- Host의 native goal 상태와 Metis의 COMPLETE·blocker 상태를 직접 동기화하는 계약은 현재 없다.
- 기존 Claude/Codex 실제 검증은 owner → worker → 독립 verifier → 같은 owner resume 실행 단계에 관한 것이다. `$metis` 단독의 여러 턴 자동 실행·중단 동작을 이미 통과한 것으로 재사용하지 않는다.

## 3. 범위와 비목표

### 포함

1. 부작용 없는 continuation 상태 조회와 versioned 응답 계약.
2. Host Main session ↔ project ↔ Metis run의 명시적 연결과 해제.
3. 지원 근거가 있는 host의 deterministic continuation adapter.
4. child 대기, heartbeat, blocker, 완료, 중복 이벤트 및 세션 재개의 제어 경계.
5. `$metis` 단독 진입 설명과 capability 검사, 설치·업데이트·제거 시 기존 설정 보존.
6. 실제 host에서 여러 턴에 걸친 실행 지속과 종료를 입증하는 검사.

### 제외

- 새로운 목표 평가 모델, task 분해 모델 또는 추가 owner 계층.
- runtime의 기존 검증·예산·권한 gate 완화.
- 자동 강제 takeover, stale lease 재활성화, SQLite 직접 수정.
- 모든 host에 대한 지원을 일괄 선언하거나 미지원 기능을 `/goal`로 몰래 대체하는 fallback.
- 1초 단위 Main 재호출, busy polling, 무제한 background daemon.
- 기존 native `/goal` 구현의 수정·가로채기 및 사용자 활성 goal의 묵시적 삭제.
- Host 기능이 부족하다는 이유만으로 새 외부 executor/TUI 자동 조작 시스템을 추가하는 것. 별도 제품 범위 결정이 필요하다.
- OpenCode의 새 자동 지속 지원. 기존 adapter preview와 수동 경로를 보존한다.
- 성능 개선율·비용 절감률 또는 미검증 장애 복구 보장.

## 4. 불변 조건

1. **완료 권위:** runtime이 완료 gate를 통과해 완료 상태를 기록한 경우에만 `COMPLETE`를 반환한다. Hook 종료, 모델의 완료 문장, 테스트 한 번의 성공은 완료 증거가 아니다.
2. **판정과 실행 분리:** snapshot/hook은 task claim, spawn, ACK, phase advance, retry, controller takeover를 하지 않는다. 기존 Main의 인증된 명령 경로만 상태를 변경한다.
3. **기존 동작 보존:** `next`의 기존 progress sampling과 `drive` 계약을 우연히 바꾸지 않는다. 순수 projection을 분리하거나 명시적인 read-only 경로를 추가한다.
4. **조회 부작용 금지:** 설정 생성, DB 초기화·migration, lease 갱신, event/progress 기록, cleanup까지 읽기 경로에서 제외한다. `sampleProgress: false`만으로 충족했다고 간주하지 않는다.
5. **명시적 연결:** 실제 host가 제공하는 session identity와 project/run을 연결한다. 로그의 임의 문자열이나 하위 agent의 `$metis` 언급으로 활성화하지 않는다.
6. **권한 보존:** Main controller credential을 hook 응답, child, 로그, status 화면에 노출하지 않는다. 읽기 binding은 runtime mutation 권한이 아니다.
7. **안전한 실패:** 조회 오류·DB 잠금·binding 불일치·미지원 host는 자동 진행을 멈추고 원인을 알린다. 성공으로 처리하거나 반복 block으로 무한 재호출하지 않는다.
8. **대기와 정지 구분:** 실행 중 child는 목표 실패가 아니다. 반대로 사용자 승인·예산 blocker는 자동 재시도 대상이 아니다. 단순히 task의 `blocked` 문자열만 보고 분류하지 않는다.
9. **격리:** 현재 연결된 project/run/Main만 다룬다. 다른 프로젝트, 다른 native goal, 다른 host 세션의 설정·상태를 변경하지 않는다.
10. **중단 존중:** 사용자의 중단·취소 후 다음 자동 이벤트가 작업을 재활성화하지 않는다. Process 종료·인증 오류·사용자 취소를 동일한 정상 완료로 기록하지 않는다.

## 5. 공통 continuation 계약

### 5.1 순수 snapshot과 판정

`src/core/continuation.js`와 읽기 전용 `metis continuation inspect` CLI 표면을
사용한다. `--json`은 별도 필수가 아니며 기존 CLI 출력 규칙을 따른다.

응답에는 다음의 최소 정보만 둔다.

- ABI 버전, run 식별자, host binding 식별자.
- `CONTINUE | WAIT | PAUSE | COMPLETE | DETACHED` 판정.
- allowlist 기반 reason code.
- 현재 state revision 또는 검증 가능한 상태 fingerprint.
- 필요할 때만 compact Main action 종류 및 liveness 관련 기한.

원문 목표·Task Packet·child transcript·controller token을 넣지 않는다. Hook 응답 문자열을 shell command로 평가하지 않는다.

완료·blocker·복구·예산 우선순위는 기존 runtime 정책을 재사용한다. 새로운 상태 판정기가 controller와 별개로 phase gate를 복제하지 않도록 공통의 순수 판정 부분을 분리한다. Phase advance, plan ingest, relay 전달 등 **Main이 해야 할 행동이 남으면** 계속 실행 대상으로 분류한다.

### 5.2 Session/run binding

- 최초 명시적 진입 시 project 경로·host·host Main session·run을 연결한다.
- 기존 live controller가 다른 Main에 속하면 연결을 거부한다.
- Resume 시 저장된 binding만 믿지 않고 현재 controller/session/lease/fence와 다시 대조한다.
- 만료된 controller는 기존의 명시적 takeover 절차로 넘긴다.
- Hook binding은 Main에만 적용하고 worker/verifier의 종료 이벤트가 root 종료 판단을 대신하지 않게 한다.
- 연결 메타데이터를 `.metis/` 내부의 작은 versioned host-session 자료로 둘지 기존 persistence를 확장할지는 실제 host session 정보와 원자성 요구를 확인해 결정한다. 별도 파일을 두더라도 목표·완료 상태의 두 번째 원본으로 사용하지 않는다.
- 중복 이벤트 억제용 기록은 delivery bookkeeping으로 한정한다. Runtime 상태 조회와 host delivery 기록의 쓰기를 명확히 분리한다.

### 5.3 대기·heartbeat·무진행 제한

- Native background completion 이벤트가 있으면 그것을 우선 사용한다.
- child가 살아 있는 동안 동일 task를 다시 생성하거나 Main을 목표 재평가 목적으로 깨우지 않는다.
- 대기 중 필요한 heartbeat는 기존 권한 있는 경로와 현재 lease 기한을 사용한다. Hook 자체가 controller 권한을 획득하지 않는다.
- 장시간 대기에 필요한 host별 bounded keepalive 경로와 종료 조건을 실제 기능 조사에서 확정한다. Event 대기만으로 lease가 유지된다고 가정하지 않는다.
- 동일 이벤트와 동일 revision의 재전달을 억제하되, 정상적으로 상태가 바뀐 후 다음 턴까지 차단하지 않는다.
- 무진행 재호출의 횟수·시간 제한을 두고 한계 도달 시 진단 가능한 `PAUSE`로 끝낸다. 기존 runtime budget/progress guard를 대체하지 않는다.

## 6. Host별 구현 원칙

### Claude Code

- 로컬 확인 버전은 `2.1.263`이다. 공식 command hook 표면인 `Stop`, `SessionStart`, `StopFailure`, `SessionEnd`를 사용한다. 실제 Metis 연결 실행은 M0/M5에서 별도로 검증한다.
- Stop hook의 read-only continuation 조회 결과를 `{ "decision": "block", "reason": "..." }` 등 해당 버전의 공식 응답으로 변환한다. Prompt/agent 기반 hook은 별도 모델 평가이므로 사용하지 않는다. StopFailure와 SessionEnd는 실패·세션 종료 bookkeeping 경계이며 native user interrupt를 완전히 관측한다고 주장하지 않는다.
- `stop_hook_active`는 Stop hook 때문에 이미 이어서 실행 중임을 뜻하며, 공식 문서상 기본 연속 block cap은 8회다. 이 값이 있다는 이유로 무조건 종료하거나 무조건 반복시키지 않는다. 정상 progress와 무진행을 구분하고 cap 도달 시 명시적 중단을 보고한다. 전역 cap을 임의로 올리지 않는다.
- 따라서 이 경로의 1차 보장은 **host cap 안에서의 bounded 자동 지속**이다. 횟수 제한 없는 장기 무인 실행을 주장하지 않는다. 이를 넘어서는 요구는 별도 검증된 host continuation 경로가 필요하다.
- `StopFailure`는 API 오류 시 출력/종료 코드로 continuation을 제어할 수 없고, `SessionStart`는 startup/resume 등의 context 주입 용도다. 둘을 Stop의 대체 실행기로 사용하지 않는다. `SubagentStop`은 root Main continuation이 아니라 해당 subagent에 대한 이벤트다.
- Native background 작업 완료 시 자동 재개와 Metis `WAIT`가 중복 실행을 만들지 않게 한다.
- 기존 사용자 hook·managed settings·plugin 설정을 보존한다. Hook 실행이 금지된 host에서는 자동 지속 지원을 표시하지 않는다.

### Codex

- 로컬 확인 버전은 `0.153.4`이며 `codex features list`에서 `hooks stable true`를 확인했다. 정확한 버전의 공식 `rust-v0.153.4` 소스에도 native blocking Stop hook과 input/output schema가 존재한다. 따라서 **외부 실행기보다 native Stop hook을 우선 구현 경로로 선택**한다. Codex 설치 표면은 `Stop`과 `SessionStart`이며, native user interrupt/cancellation을 완전히 관측한다고 주장하지 않는다.
- Stop input에는 `session_id`, `turn_id`, `cwd`, `hook_event_name: "Stop"`, `stop_hook_active`, `last_assistant_message` 등이 있다. 실제 session/run binding에는 host가 전달한 identity를 사용한다.
- 공식 parser는 `{ "decision": "block", "reason": "비어 있지 않은 사유" }`를 받아 reason을 continuation prompt로 전달한다. `continue: false`는 실행 지속이 아니라 중단을 뜻하므로 반대로 처리하지 않는다.
- `notify`의 `agent-turn-complete`는 별도의 사후 알림 경로다. Native Stop hook과 혼동하여 Codex continuation을 미지원이라고 결론내리지 않는다.
- M0에서 hook 등록·설정 우선순위·interactive/exec 차이·재진입 제한·child 대기·실제 Stop 전달을 현재 버전으로 확인한다. 소스/schema 확인은 Metis와 연결한 실제 세션 검사 통과와 구분한다.
- 실제 interactive `$metis` 경로에서 지원이 검증된 기능만 활성화한다. Feature가 꺼져 있거나 지원 불가/미확인인 환경에서는 자동 지속은 비활성화하고 명시적 상태 조회·resume 경로를 유지한다.
- Version-matched app-server에 `thread/resume`, `turn/start`, `turn/completed`가 존재하지만 현재 우선안에는 별도 app-server runner를 추가하지 않는다. 필요해지면 실행 환경 변경과 승인 범위를 별도로 결정한다. Native `thread/goal/*`는 별도 goal 상태 관리 경로이므로 이번 단일 완료 권위 구현의 대체 수단으로 사용하지 않는다.

### Native `/goal`과의 공존

- standalone continuation을 native goal과 동시에 자동 활성화하지 않는다.
- Native goal 활성 여부를 안전하게 관측할 수 있는 host에서는 충돌을 명시적으로 검출한다.
- 관측 API가 없으면 없다고 기록하고, 사용자가 native goal을 해제한 새/확인된 세션에서 단독 모드를 시작하도록 진입 계약을 제한한다. 확인할 수 없는 것을 자동 감지했다고 주장하지 않는다.
- 기존 `/goal $metis` 사용법을 즉시 삭제하지 않는다. 검증된 standalone 모드와 host-managed legacy 모드를 구분하고, legacy에서는 새 continuation hook이 중복 개입하지 않게 한다.
- 사용자 활성 goal을 임의로 지우거나 기본 모델·권한 설정을 변경하지 않는다.

## 7. 작업 단계와 완료 기준

| 단계 | 산출물 | 완료 기준 |
| --- | --- | --- |
| M0: host 계약 probe | Claude/Codex 버전·실제 hook 응답·event·resume·native goal 관측 지원표 | 모델 작업을 시작하기 전 실제 지원/미지원/미확인 구분. 미지원 host의 대체 경로를 묵시적으로 추가하지 않음 |
| M1: 순수 continuation core | versioned snapshot, 판정, CLI, 단위 테스트 | 반복 조회가 DB/config/filesystem 상태를 바꾸지 않고 기존 next/drive 의미 보존 |
| M2: binding과 delivery 안전성 | session/run 연결·해제, 중복 억제, 재개 및 pause 경계 | stale/foreign session, child impersonation, 중복 이벤트, 취소 후 재활성화 거부 |
| M3: host adapter | 지원이 확인된 Claude/Codex continuation 연결 | Main 턴 종료·child 대기·완료·blocker를 실제 host 계약으로 처리. 설치 설정 보존 |
| M4: 진입점·문서·doctor | `$metis` 단독 모드, legacy 구분, capability 진단, mirrors | 준비되지 않은 host에서 지원을 주장하지 않으며 기존 설치·제거 동작 유지 |
| M5: 실제 통합·회귀 검증 | native 여러 턴 증거, 설치형 패키지 검사, 전체 check | 아래 검증 행렬 통과와 한계 기록 후에만 host별 standalone 지원 승격 |

M1/M2의 공통 core를 먼저 확정한다. M3의 host별 구현은 파일 소유 범위를 분리해 병렬화할 수 있다. 진입점 기본값 변경과 지원 선언은 M5 이후에만 통합한다.

## 8. 변경 파일 후보

- 신규 `src/core/continuation.js`: 순수 snapshot/판정.
- `src/core/controller.js`: 필요한 순수 projection 재사용 경계. 기존 `next`/`drive` 부작용·진행 표본 계약 보존.
- `src/core/project-bootstrap.js`, `src/core/db.js`: 일반 DB open/setup과 명확히 분리된 pre-existing DB 읽기 경계. 일반 open의 recovery 동작은 보존.
- `src/core/state.js`, `src/core/context.js`: `gateReport`/context 저장과 순수 판정의 분리 여부를 검토. 기존 lifecycle에서 필요한 sync·milestone refresh·snapshot 기록은 보존.
- `src/core/ownership.js`, `src/core/paths.js` 및 persistence 경계: 기존 권한·경로를 재사용하는 binding 설계가 필요한 경우에만 변경.
- `src/cli.js`, `src/core/metadata.js`: 실제 구현한 새 명령과 도움말 등록.
- `src/core/doctor.js`: host 기능이 존재한다는 사실과 실제 session continuation 지원을 구분.
- `src/adapters/` 및 host plugin/adapter 설치 표면: host별 hook 전달과 설정 보존. 정확한 installer 파일은 M0/M2 설계에서 확정.
- `skills/metis/SKILL.md`, `skills/metis/agents/openai.yaml`, `commands/metis.md`와 canonical references 및 mirrors: 단독 진입·대기·중단 규칙 동기화.
- README 양언어, `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`, `docs/VERIFICATION.md`: 검증된 지원 범위만 반영.
- 신규 continuation core/CLI/binding/host adapter 테스트와 기존 controller·install·lifecycle·owner 회귀 테스트.

Schema/configuration/layout 버전은 계획만으로 올리지 않는다. Binding 저장 설계가 기존 계약 변경을 요구하면 영향과 버전 변경을 별도 명시하며, 낡은 schema 호환 계층을 추가하지 않는다. Generated reference는 구현 후 생성기로 갱신한다.

## 9. 검증 행렬

### Deterministic core 및 adapter 계약

1. run/DB가 없는 일반 host 세션: 새 `.metis`·DB 생성 없이 `DETACHED`.
2. 수행 가능한 Main action, phase advance, plan ingest, pending owner relay: `CONTINUE`이며 조회 자체는 실행·진행 표본을 만들지 않음.
3. 실행 중 child: 중복 spawn 없이 `WAIT`; terminal event 뒤 현재 상태 재조회.
4. 자동 진단 가능한 실패와 사용자·권한·예산 blocker: 서로 다른 정책으로 분류.
5. worker 테스트 통과만으로는 완료되지 않음. 필수 gate가 끝난 runtime만 `COMPLETE`.
6. DB 잠금·손상·미지원 schema·binding 불일치·host 기능 차단: 정상 완료로 기록하지 않고 안전한 중단.
7. 오래된 controller fence·다른 host session·child session의 root binding 요청 거부.
8. 중복 Stop/terminal 이벤트·동시 조회·빠른 resume에서도 Main 실행/상태 전이가 중복되지 않음.
9. 사용자 취소·권한 거절·예산 한계 뒤 자동 재활성화 또는 blanket permission 확대 없음.
10. 조회 반복 전후 DB 테이블·journal/progress·설정·관련 파일을 대조해 read-only 성질 확인.
11. 설치/업데이트/제거가 기존 사용자 hook·설정·수정 파일·다른 plugin을 보존.
12. legacy `/goal` 경로와 standalone 경로의 동시 자동 활성화 방지.

### 실제 host 검사

- 검증 대상 host별로 하나의 작은 실제 목표를 `$metis` 단독 진입부터 runtime 완료까지 실행한다. 이 지원 판정에는 `forcePhase`나 synthetic host receipt를 사용하지 않는다.
- Main이 진행 중 턴을 끝내는 상황을 포함하여, 사용자의 추가 prompt 없이 동일 session/run이 실제로 이어지는지 기록한다.
- 실제 worker와 독립 verifier의 서로 다른 receipt, 결과·DB 상태·고정된 acceptance test를 보존한다.
- 이미 완료된 run에서 추가 worker 생성·재계획·재검증이 발생하지 않는지 확인한다.
- 별도 bounded fixture에서 사용자 blocker, 예산 중단, child 장시간 대기, 중단 후 명시적 resume를 검사한다. Fixture 검사를 전체 목표 E2E와 구분한다.
- 외부 목표 evaluator 모델 호출이 새 adapter 때문에 발생하지 않는지 관측 가능한 host 로그로 확인한다. Provider 내부 비공개 routing이나 실제 청구액까지 검증했다고 주장하지 않는다.
- 모델은 사용자 승인된 명시적 route를 사용하고 전역 설정을 바꾸지 않는다. Timeout·거부·부분 실행은 실패/중단으로 기록한다.
- 실제 host 계약을 실행할 수 없는 경우 단위 테스트 결과로 지원을 승격하지 않는다.

### 최종 회귀·패키징

- `npm run docs:generate`, `npm run check`, `git diff --check`.
- Packed archive 설치와 필요한 hook/script 포함, 개발용 문서·테스트 제외.
- 설치된 CLI의 continuation 명령과 기존 owner/relay/help/init 동작 확인.
- 모든 테스트·package·native 증거를 정확한 commit에 연결하고 로그·fixture DB를 보존.

## 10. 승인·출시 판단

사용자 목표는 Claude·Codex에서 동일한 Metis 제어 계약을 사용하는 것이다. 공통 ABI를 만들었다는 이유만으로 두 host의 실행 지속까지 동일하게 검증됐다고 설명하지 않는다.

출시 판단은 host별이다. 실제 standalone 여러 턴 검사가 통과한 host만 기본 진입점 승격 대상이다. 미지원 host는 명시적 legacy/manual 경로를 보존한다. 두 host 동시 지원이 필수인 출시라면 한쪽 미검증 상태는 출시 보류 사유로 기록한다.

이 계획의 결론은 **기존 owner 오케스트레이션을 유지하고, 별도의 목표 evaluator 없이 Metis 상태에 종속된 host continuation 연결을 추가하는 것**이다. 구현·PR·릴리즈는 이 계획 작성과 별개의 후속 작업이다.

## 11. Host 조사 근거와 증거 수준

2026-09-07 읽기 전용 조사 기준이다. 실제 hook 설치·모델 실행·설정 변경은 수행하지 않았다.

| 대상 | 확인된 근거 | 아직 구현·검증할 부분 |
| --- | --- | --- |
| Claude Code 2.1.263 | 로컬 version, 공식 command Stop hook 및 block 응답·기본 8회 cap | 실제 Metis 연결, session identity, native goal 공존, heartbeat와 background 대기 |
| Codex 0.153.4 | 로컬 version/features, 같은 버전 소스의 native Stop parser와 생성 schema | 실제 hook 등록·설정 우선순위·interactive 동작·재진입/대기 제한 |
| 공통 core | 현재 next/context/DB open의 쓰기 경계와 기존 lifecycle 읽기 경로 | 순수 continuation API, session/run binding, 독립성·부작용·통합 검사 |

공식 출처:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks): Stop, StopFailure, SessionStart, SubagentStop 및 command hook 입출력.
- [Claude Code hooks guide](https://code.claude.com/docs/en/hooks-guide): 반복 block 제한 및 loop 방지.
- [Claude Code goal](https://code.claude.com/docs/en/goal): native goal의 별도 모델 evaluator와 background 동작. 이 evaluator는 새 standalone 모드에서 사용하지 않는다.
- [Codex 0.153.4 Stop 구현](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/hooks/src/events/stop.rs): 버전이 일치하는 blocking Stop parser.
- [Codex 0.153.4 생성 hook schema](https://github.com/openai/codex/tree/rust-v0.153.4/codex-rs/hooks/schema/generated): `stop.command.input.schema.json`, `stop.command.output.schema.json`.
- [Codex 0.153.4 app-server](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/README.md): 별도 runner 대안에 대한 근거이며 현재 구현 범위는 아니다.

Codex 일반 hooks 문서는 URL redirect 이후 조회 도구 오류로 본문을 확인하지 못했으므로 지원 판단 근거로 사용하지 않았다. 대신 설치 버전과 일치하는 공식 source tag를 확인했다. 향후 문서나 최신 main 소스의 기능을 현재 설치 버전의 실제 실행 증거로 바꿔 적지 않는다.
