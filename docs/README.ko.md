# Metis 1.0.1

[English](../README.md) | [한국어](README.ko.md)

Metis는 장기 repository 목표를 위한 subagent 우선 engineering
오케스트레이터입니다. Codex, Claude Code, OpenCode용 adapter preview를 통해
discovery, research, design, planning, implementation, review, verification을
구조화합니다. 1.0.1은 현재 public release입니다.

Managed goal 하나를 시작하면 됩니다.

```text
/goal $metis "<목표>"
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

1.0.1 host 상태:

| Host | 상태 | Release evidence |
| --- | --- | --- |
| Codex | E2E 검증 preview | Package-equivalent release candidate에서 native goal lifecycle 통과; exact tag 재검증 대기 |
| Claude Code | Adapter preview | 설치, contract, spawn descriptor 검증 완료; native goal E2E 대기 |
| OpenCode | Adapter preview | 설치와 generic spawn contract 검증 완료; native goal E2E 대기 |

Package test 통과를 native-host E2E 증거로 간주하지 않습니다. 인증된 release
환경에서 goal 시작부터 verification까지 전체 flow가 통과한 host만 supported로
승격합니다.

1.0.1은 pinned security 및 supply-chain CI, npm lockfile과 Dependabot 및
SECURITY policy, scanner-safe fixture, 명시적인 benchmark child environment,
task-ID/worktree containment으로 release integrity를 강화합니다. 이는
validation과 containment control이며, untrusted-code sandbox를 의미하지
않습니다. 이번 release는 성능 향상을 주장하지 않습니다.

[`v1.0.1` release](https://github.com/gkrtjd99/Metis/releases/tag/v1.0.1)에서
`metis-orchestrator-1.0.1.tgz`를 내려받아 설치합니다.

```sh
npm install -g ./metis-orchestrator-1.0.1.tgz
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
`/model` 같은 host 기본 selector로 선택합니다. Metis는 확인된 Main 기대값을
저장하고 자신이 spawn하는 subagent를 설정합니다.

Override는 goal을 시작하기 전에 설정해야 합니다. Active 또는 blocked run
중에는 model 설정을 변경하지 않습니다. Provider별 effort argument는 host가
선택된 model의 지원 여부를 증명한 경우에만 적용합니다.

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
