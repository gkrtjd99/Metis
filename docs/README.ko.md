# Metis 1.2.0

[English](../README.md) | [한국어](README.ko.md)

Metis는 장기 repository 목표를 위한 subagent 우선 engineering
오케스트레이터입니다. Codex, Claude Code, OpenCode용 adapter preview를 통해
discovery, research, design, planning, implementation, review, verification을
구조화합니다. **1.2.0은 현재 public release입니다.**

Managed goal 하나를 시작하면 됩니다.

```text
/goal $metis "<목표>"
```

또는 내구성 있는 목표 문서 워크플로우 진입점을 사용할 수 있습니다:

```text
$metis prd "<요구사항>"
$metis plan "<목표>"
$metis run
$metis resume
$metis status
```

Metis는 목표를 완료하거나 사용자 또는 외부 권한의 명시적인 결정이 필요할
때까지 workflow를 계속합니다.

## 빠른 시작

요구 사항:

- Node.js 22.16.0 이상
- Git
- Host adapter를 평가할 Codex, Claude Code, OpenCode 중 하나
- 선택한 host에서 활성화된 Metis plugin

Release package는 macOS(darwin)와 Linux만 지원합니다. Windows는 지원 대상이
아닙니다.

1.2.0 public release host 상태:

| Host | 상태 | Release evidence |
| --- | --- | --- |
| Codex | 실제 실행 단계 통합 검사 통과 | 실제 host receipt, immutable test hash, audited database state와 함께 owner → worker → independent verifier → same-owner resume 완료 |
| Claude Code | 실제 실행 단계 통합 검사 통과 | 동일한 제한된 execution-stage flow를 실제 host receipt, immutable test hash, audited database state로 확인 |
| OpenCode | Adapter preview | 설치와 generic spawn contract 검증 완료; native host execution evidence는 아직 대기 |

Package test 통과를 native-host E2E 증거로 간주하지 않습니다. 인증된 release
환경에서 goal 시작부터 verification까지 전체 flow가 통과한 host만 supported로
승격합니다.

1.2.0 release는 세션 턴 및 크래시 경계를 넘는 상태 기반 실행 지속 훅(`metis continuation`),
PRD/계획/실행을 분리하는 마크다운 기반 목표 문서 체계(`$metis prd/plan/run`),
하위 에이전트의 모델 고정을 해제하여 활성 호스트 세션 모델(Gemini, Fable 등 포함)의 자연스러운 상속,
작업 난이도(Strong vs Worker) 기반 가변 모델 라우팅, 그리고 호스트 용량 모델링(`host-capacity.js`)을
포함합니다. [릴리즈 가이드](RELEASING.md)에서 현재 릴리즈 기록과 향후
패키징·공개 절차를 확인하세요.

최신 public release인 [`v1.2.0` release](https://github.com/gkrtjd99/Metis/releases/tag/v1.2.0)에서
`metis-orchestrator-1.2.0.tgz`를 내려받아 설치합니다.

```sh
npm install -g ./metis-orchestrator-1.2.0.tgz
```

GitHub source에서 직접 설치할 수도 있습니다.

```sh
git clone https://github.com/gkrtjd99/Metis.git
cd Metis
npm install
npm link
```

Git project를 만들거나 기존 project로 이동한 뒤 host adapter를 설치합니다.

```sh
git init /absolute/project
metis init --host codex --root /absolute/project
metis doctor --pretty
```

Project root에서는 짧게 실행할 수 있습니다.

```sh
metis init --host codex
```

다른 adapter preview도 같은 방식으로 설치합니다.

```sh
metis init --host claude
metis init --host opencode
metis init --host all
```

Host에서 `/metis`가 resolve되고 명시적인 `$metis` marker를 인식해야 합니다.
Project 초기화는 project adapter를 설치하지만, 누락된 global host plugin까지
설치하지는 않습니다.

Host에서 첫 goal을 시작합니다.

```text
/goal $metis "분산 rate limit을 추가하고 검증과 문서를 완료해"
```

`$metis`를 명시하지 않은 일반 요청에는 Metis가 개입하지 않습니다.

## Continuation preview (명시적 opt-in)

Continuation은 host에 연결되는 별도 preview 기능입니다. 기존
`/goal $metis` 진입점은 legacy native evaluator 경로로 그대로 유지하며,
standalone continuation으로 묵시적으로 바꾸지 않습니다. standalone `$metis`의
전체 goal E2E는 아직 검증되지 않았으므로 supported라고 주장하지 않습니다.
파일 설치만으로 host의 hook 신뢰 승인이 부여되지는 않습니다. Codex에서는
native UI의 명시적인 project hook 승인이 필요할 수 있으며, 이를 우회하거나
hooks 기능이 켜져 있다는 이유만으로 실행 준비가 됐다고 판단하면 안 됩니다.

Preview hook은 명시적으로 설치·제거합니다.

```sh
metis continuation install --host claude
metis continuation install --host codex
metis continuation uninstall --host claude
metis continuation uninstall --host codex
```

Claude에는 `Stop`, `SessionStart`, `StopFailure`, `SessionEnd`, Codex에는
`Stop`, `SessionStart` hook이 설치됩니다. 일반 `metis uninstall` 전에
continuation hook을 먼저 제거해야 합니다. `init`은 hook을 자동 설치하지
않습니다. 실제 native host가 제공한 session ID만
bind에 사용하며, host의 native goal이 inactive라는 명시적 확인이 필요합니다.
기존 controller credentials와 비어 있지 않은 evidence도 필요합니다.

```sh
metis continuation inspect --host claude --session-id <native-session-id>
metis continuation bind --host claude --session-id <native-session-id> \
  --native-goal-inactive --evidence "운영자가 native goal 비활성 확인" \
  --controller-session <id> --controller-owner <owner> \
  --controller-token <token> --controller-fence <fence>
metis continuation detach --host claude --session-id <native-session-id> \
  --controller-session <id> --controller-owner <owner> \
  --controller-token <token> --controller-fence <fence>
```

`inspect`는 read-only입니다. Hook은 host가 전달한 실제 session ID를 사용하고
임의 ID를 만들지 않으며, native goal 상태를 자동 감지하거나 clear하지 않습니다.
Pause, cap, no-progress 또는 hook failure 뒤에는 명시적으로 rebind/resume해야
합니다. `--rebind`는 delivery bookkeeping만 reset합니다. Stop hook은
deterministic이며 evaluator를 실행하지 않습니다. `COMPLETE`는
runtime의 durable completion만 인정합니다. `WAIT`는 실제 host background
증거가 있을 때만 대기하며 lease 자동 갱신은 없습니다. Host의 no-progress/block
cap으로 continuation은 bounded이므로 무제한 무인 실행을 보장하지 않습니다.
Claude와 Codex만 이 continuation preview 대상이며 OpenCode에는 지원하지 않습니다.

## Durable skill workflow (preview)

별도의 durable-skill workflow는 기존 native `/goal $metis` 경로를 바꾸지 않고
PRD나 plan artifact를 run에 연결할 수 있습니다.

```text
$metis prd "idea" -> $metis plan @path -> $metis run
```

`prd`는 인터뷰와 문서만 기록하며 작업을 시작하지 않습니다. `plan`은
plan-only 모드로 시작할 수 있으며, 이때
`Goal Contract.route.executionApprovalRequired: true`를 기록하고 기존
seal/review authority checkpoint에서 멈춥니다. 명시적인 승인만 현재 승인으로
기록하여 실행을 허용합니다. 예를 들어 `plan execute --reason "..."`를
사용합니다. `resume`은 일시 중단된 run을 이어갈 뿐 승인·controller takeover·
session rebind가 아닙니다. 빈 입력, `status`, `resume`은 새 goal을 몰래 만들지
않고 현재 run context를 유지합니다. 기존 `$metis:model`도 계속 사용할 수
있습니다.

PRD snapshot은 기존 artifact 경로로 저장합니다. route는
`sourceDocument: { artifactId, contentRef }`를 보유하며 저장된 snapshot은
immutable이지만 원본 디스크 파일은 변경 가능합니다. 제한된 `goal restore`는 현재 contract·plan·decision·runtime
state의 handle을 복원합니다. 이는 read-only 재오픈이 아니라 context/object/token
참조를 기록하는 변경입니다. raw PRD, worker 출력, credential은 기록하지
않습니다. restore와 실행은 source가 같은 run에 속하고 변조되지 않았는지
검증합니다.

새 PRD workflow는 `docs/metis/<goal-slug>/{prd.md,plan.md,decisions.md}`를 사용합니다.
`metis goal prd --title "목표 제목" --file draft.md`는 폴더와 PRD만 생성하고
설치/config/DB/run을 만들지 않습니다. slug는 정규화한 ASCII stem(없으면 `goal`)과
제목 hash로 결정하며 기존 폴더 충돌 시 덮어쓰기·자동 suffix 없이 실패합니다.
부모/문서 symlink, hardlink, 파일 종류 충돌을 거절합니다. 반환된 상대 PRD 경로를
`artifact put prd --path ...`에 저장한 뒤 기존 `sourceDocument` 쌍으로 연결합니다.
`goal restore.documents`는 제목이 아니라 그 저장된 artifact.path에서 같은 폴더를
복원합니다. 외부/기존 경로 PRD와 source 없는 run은 `unbound`이고 자동 폴더/run 생성은
없습니다. 원본 파일 수정·삭제는 snapshot을 바꾸지 않습니다. `plan.md`와 `decisions.md`는
봉인 plan/durable decisions를 host가 쓰는 파생 표현이며 자동 export나 별도 상태가 아닙니다.
충돌·갱신·출처와 동시 부모 교체의 안전 한계는 [목표 문서 규칙](../skills/metis/references/prd.md)을 따릅니다.

이 workflow는 native `/goal`과 분리되어 있으며 native 상태를 자동 clear하지
않습니다. Host별 문법과 실제 full-goal E2E 동작은 아직 검증되지 않았습니다.
OpenCode skill 배포와 OpenCode continuation hook 지원은 별개입니다. skill을
설치했다고 hook 지원이 생기는 것은 아닙니다. 위 continuation preview 제한도
그대로 적용됩니다.

## Public Node API

Package root는 가벼운 ESM facade를 제공합니다.

```js
import { init } from "metis-orchestrator";

const attachment = await init({ root: "/absolute/project", host: "codex" });
```

`init(options)`는 비동기 함수이며 호출될 때만 runtime을 lazy-load합니다. 기존
Git project root가 필요하고(`cwd`에서 enclosing Git root를 찾을 수도 있음),
`codex`, `claude`, `opencode`, `all` host를 받습니다. 반환값은 host attachment
결과입니다. Attachment는 host file과 config를 설치하지만
`.metis/state/state.db` runtime database를 만들거나 repository를 scan하지
않습니다. Option은 `root?: string`, `cwd?: string`,
`host?: string | string[]`, `force?: boolean`이며 반환값에는 `projectRoot`,
`rootSource`, `gitRoot`, `installed`, `config`, `lifecycle`가 들어갑니다.

지원하는 named export는 `init`, alias인 `attach`,
`assertSupportedNodeVersion`입니다. 지원하지 않는 Node에서는
`ERR_METIS_NODE_VERSION`으로 reject됩니다. Root, Git worktree, host, config,
managed file conflict 오류도 programmatic handling이 가능한 안정된 `code`를
가진 typed error로 reject됩니다. Public entry point는 package root와
`metis-orchestrator/package.json`뿐입니다. `src/**` module은 internal이며
호환성을 보장하지 않습니다.

## Model 선택

설치 후 별도의 model 설정은 필요하지 않습니다. 기본 동작은 다음과 같습니다.

- Main은 현재 host session에서 선택된 model을 사용합니다.
- Spawn된 subagent는 host가 선택한 기본 model을 사용합니다.
- Metis는 Codex, Claude Code, OpenCode의 특정 model을 고정하지 않습니다.

이후 goal에 project별 model과 effort routing을 적용하고 싶을 때만
`$metis:model`을 사용합니다.

```text
$metis:model
$metis:model Main은 현재 model을 유지하고 subagent는 <model> <effort>로 설정해줘.
$metis:model 현재 설정을 보여줘.
$metis:model host 기본 model로 초기화해줘.
```

원하는 설정을 명령에 쓰지 않으면 agent가 대화형으로 질문합니다. Main은
`/model` 같은 host 기본 selector로 선택합니다. 계획 단계의 host dialog는 현재
model/effort를 미리 채워 독립 역할과 선택적 owner 설정을 확인받고, 확인된 값과
변경 승인만 runtime durable state에 저장합니다. 실행과 resume는 저장값을 엄격히
재사용하며 owner를 자동으로 추가하지 않습니다.

Override는 goal을 시작하기 전에 설정해야 합니다. Active 또는 blocked run
중에는 model 설정을 변경하지 않습니다. Provider별 effort argument는 host가
선택된 model의 지원 여부를 증명한 경우에만 적용합니다. 개인의 model·effort 조합을
다른 사용자에게 강제하지 않습니다. 요청 effort, 생성 명령에 전달한 값, host가 확인한
값, provider 내부 적용 여부는 별개이며 마지막 항목은 별도 증거가 없으면 미확인입니다.
Native Agent가 per-child effort 인자를 지원하지 않으면 prompt의 지시만으로 적용됐다고
판단하지 않습니다. 운영자가 내부 strict 검사 flag를 외울 필요 없이 지원 불가·거부·
미확인을 보고하며, 권한 거부를 우회하지 않습니다.

## 동작 방식

Main은 goal을 조정하고, fresh subagent가 repository 조사, 외부 조사, 구현,
review, verification을 수행합니다.

```text
사용자 목표
    |
    v
Main: 판단, 분해, scheduling, routing
    |
    +-- discovery scout ----------+
    +-- external researcher ------+--> synthesis
    +-- designer와 planner ----------> task graph
    +-- 병렬 worker wave ------------> integration
    +-- reviewer와 verifier ---------> repair 또는 complete
```

Managed lifecycle:

```text
intake -> discover -> research -> design -> plan
       -> execute -> review -> verify -> curate -> complete
```

같은 open wave의 독립 task는 설정된 concurrency 한도까지 병렬 dispatch됩니다.
이전 wave가 terminal 상태가 되기 전에는 다음 wave를 열지 않습니다. Mutable
task는 격리된 Git worktree에서 실행하고 통제된 순서로 integration합니다.

각 child는 scope, dependency, frozen interface, acceptance criteria, authority,
verification plan이 포함된 compiled Task Packet을 받습니다. Main에는 raw worker
transcript, 긴 log, patch, screenshot 대신 작은 structured state만 전달합니다.

Metis는 다음 기능도 제공합니다.

- 병렬 repository discovery와 external research
- 병렬 구현 전 shared interface freeze
- stale packet, dependency, mutable path 충돌 검사
- 실패한 task의 retry 전 diagnosis
- 독립적인 review와 verification wave
- repair task 이후 fresh review
- durable controller, lease, journal, evidence state
- 명시적인 complete와 blocker 상태

Shell, network, tool 권한은 host가 관리합니다.

## Run 확인

주요 명령어:

```sh
metis next --pretty
metis status --context --pretty
metis report --markdown
metis task packet list --pretty
metis interface list --pretty
metis review status --pretty
metis budget status --pretty
metis journal replay --pretty
```

Controller는 runtime이 다음 결과 중 하나를 반환할 때까지 계속합니다.

```text
COMPLETE
USER_OR_AUTHORITY_REQUIRED
BUDGET_DECISION_REQUIRED
복구할 수 없는 recorded blocker
```

## Local state와 cleanup

Project runtime state는 `.metis/` 아래에 저장됩니다. Canonical database path:

```text
.metis/state/state.db
```

Runtime state, worktree, log, cache, temporary file은 project에만 저장되며 설치된
repository policy에 따라 ignore됩니다.

Cache cleanup preview:

```sh
metis clean --scope cache --dry-run --pretty
```

실제 적용:

```sh
metis clean --scope cache --pretty
```

## 상세 문서

- [GitHub repository](https://github.com/gkrtjd99/Metis)
- [Releases](https://github.com/gkrtjd99/Metis/releases)
- [Issues](https://github.com/gkrtjd99/Metis/issues)
- [Architecture](ARCHITECTURE.md)
- [Changelog](../CHANGELOG.md)
- [Operations](OPERATIONS.md)
- [CLI와 API reference](REFERENCE.md)
- [English README](../README.md)
