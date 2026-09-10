# Metis 목표 기록과 스킬 진입점 개편

- 작성일: 2026-09-07
- 상태: 기존 preview 검증 위에 목표별 문서 규칙 추가 구현·집중/전체 로컬 검사 완료. 실제 host compact/전체 goal E2E는 미검증.
- 작업 위치: 기존 `feat/metis-state-driven-continuation` 브랜치의 미커밋 continuation 구현 위에 추가한다.
- 사용자 승인: PRD로 목표를 기록하고 계획·실행·compact 후 복원에 연결하는 스킬 개편을 진행한다.
- 범위 밖: commit/push/PR/release, 실제 사용자 프로젝트의 hook 설치, 전역 설정 변경, native goal clear, 새로운 외부 실행기.

## 목표

대화는 임시 컨텍스트이며 Goal Contract·canonical artifacts·runtime DB가 영구 기준이다. 기존 목표·작업·복원 시스템을 중복 구현하지 않고, 명시적인 사용자 진입점과 목표 문서 연결을 추가한다.

## 사용자 진입점

대표 `$metis` 스킬은 유지한다. `prd`, `plan`, `run`, `resume`, `status`를 분기하고 그 외 입력은 기존 목표 실행으로 처리한다. `$metis:model`은 별도 기존 스킬로 유지한다. host가 아닌 runtime의 결정적 parser로 인용된 목표와 verb를 구분하며 입력 문자열을 shell로 평가하지 않는다.

- `prd`: 사용자의 원래 요청·목표·요구·수용 조건·가정 구조화. 구현하지 않는다.
- `plan`: PRD 또는 목표와 저장소를 조사해 기존 planner/PlanDraft로 계획한다. 명시적인 실행 요청 전 구현에 진입하지 않는다.
- `run`: 저장된 목표 계약과 계획을 복원하고 기존 gate를 통과한 작업을 실행한다.
- `resume`: 복원 후 기존 권한·lease·blocker 경계에 따라 재개한다. takeover나 continuation suppression 해제를 뜻하지 않는다.
- `status`: 새 목표나 작업을 시작하지 않고 현재 상태를 요약한다.

## 저장과 복원

1. PRD는 고정된 요구 ID·수용 조건, 원래 요청, 비범위·제약, 사실과 가정을 분리한다.
2. 제품 성공 지표와 개발 완료 조건은 구분한다. 작은 변경에는 축약 형식을 허용한다.
3. 문서는 Goal Contract 및 canonical artifact와 연결한다. 문서/DB에 별도의 작업 상태를 중복 저장하지 않는다.
4. Plan은 요구와 작업·검증을 연결한다. 실행 중 계획 수정으로 요구를 임의 변경하지 않는다.
5. 복원은 기존 context/journal/contract/artifact/decision 경로를 사용하고, 짧은 파생 패킷으로 제공한다.
6. 실행 시작·resume·compact 이후 공통 복원 절차를 적용한다. 모든 host의 compact hook 지원을 가정하지 않는다.
7. 복원 시 controller token이나 raw worker output을 전달하지 않는다. stale 계약·누락 문서는 추측하지 않는다.

## 구현 순서

1. 기존 runtime의 목표·plan-only gate·복원 연결점 확인.
2. 순수 진입 parser와 side-effect-free CLI 연결.
3. 필요한 최소 runtime 경계 및 복원 패킷 구현.
4. 대표 스킬을 분기 중심으로 정리하고 PRD/계획/복원 reference와 template 추가.
5. canonical/mirror, installer, reference generator, 공개 문서 동기화.
6. 독립 회귀 검토, focused tests, `npm run check`, package dry-run.

## 검증 경계

단위·fixture 검증과 실제 host compact/전체 goal E2E는 구분한다. 현재 continuation preview 제한은 유지하며, 이번 작업에서 native 모델 호출·trust 우회를 추가하지 않는다.

## 목표별 문서 정리 추가 구현 (2026-09-07)

사용자 승인으로 `docs/metis/<goal-slug>/{prd.md,plan.md,decisions.md}` 규칙을 구현한다.
이 메타 작업을 위한 실제 사용자 목표 폴더는 만들지 않고 본 계획만 갱신한다.

- `goal prd --title <제목> --file <본문>`: bootstrap 이전 명령. 결정적 NFC/공백 정규화
  제목의 ASCII stem(최대 48자, fallback goal)+SHA-256 앞 12자리로 폴더와 PRD를 생성.
  DB/config/run/adapter 생성 없음. 기존 폴더는 빈 폴더라도 실패, 덮어쓰기/자동 suffix 없음.
- 경로 검사: 신뢰하는 real repository root 아래 symlink(부모·세 문서·dangling 포함),
  hardlink, 종류 충돌 거절. exclusive mkdir/file 생성, final-component no-follow.
  다른 프로세스의 동시 부모 교체까지 보장하는 sandbox는 아님을 명시.
- 저장 연결: 기존 `sourceDocument: {artifactId, contentRef}` 유지, 해당 artifact.path로
  폴더를 복원. 계약이 참조한 artifact.path 변경은 새 snapshot+명시적 amend로만 가능.
- `goal restore.documents`: bound 경로와 각 문서 존재 여부 또는 unbound 사유 반환.
  현재 run의 저장 참조만 사용; 목표 문자열/최근 폴더 검색/새 run·폴더 생성 없음.
  legacy/external PRD와 source 없는 작은 목표 호환. 원본 수정·삭제와 snapshot 무결성 분리.
- Main/host는 봉인 계획 후 같은 폴더의 plan.md에 파생 요약, durable 결정 add/status 후
  decisions.md에 전체 list/get의 파생 표현을 저장한다. 자동 runtime export/hook이나
  별도 상태 authority를 만들지 않는다. 미정·stale·기존 사용자 편집은 정직하게 보고한다.
- canonical SKILL/refs/templates/command, Claude/OpenCode mirrors, EN/KO README 및 docs,
  구조 검사·설치 검사·집중 경로/복원/CLI 테스트를 연결했다.
- 추가 focused 검사: 29/29 통과. 최초 신규 fixture 4개는 acceptance 누락으로 실패했으며
  fixture에 필수 acceptance를 보완한 뒤 전체 focused 재실행 통과.
- 최종 전체 검사: 559개 중 558개 통과, 실패 0, Chromium 미설치로 1 skip.
  `docs:check`, `validate`, `git diff --check` 통과. 설치 launcher 추가 검사 4/4 통과.
- Package dry-run: 219개 파일, 신규 core 포함, tests/.metis/docs/plans/docs/metis 제외,
  tarball 생성 없음. 로그 `/tmp/metis-goal-documents-check.log`, `/tmp/metis-goal-documents-pack.json`.
- 독립 추가 read-only 검토에서 확정 correctness 결함 없음. host compact/파생 문서 작성
  semantic E2E 및 동시 부모 교체 방어는 검증 주장하지 않음.
- schema/dependency/package 버전 변경 없음. 기존 continuation/durable 미커밋 작업 보존.

## 이전 단계 완료 증거

- 순수 mode parser, `start --plan-only`, PRD snapshot 계약 연결, 현재 seal/review에 결속된 실행 승인, `goal restore` 및 스킬·설치 mirror 연결을 구현했다.
- 집중 통합 검사: 39/39 통과.
- 최종 `npm run check`: 총 549개, 548개 통과, 실패 0개, Chromium 미설치로 1개 건너뜀.
- 전체 검사 로그: `/tmp/metis-durable-workflow-final.0cdYDT`.
- 독립 리뷰: 확정된 결함 없음. 리뷰 fixture의 승인 후 claim은 Git HEAD 부재로 제한되었으며, 전체 suite의 별도 Git fixture에서 승인 후 claim 통과를 확인했다.
- Package dry-run: 218개 파일, 신규 core/reference/template 포함, tests·.metis·docs/plans 제외. 개인 PRD 프롬프트 경로를 포함하지 않는다.
- package 1.1.0 / schema 11 / configuration 6 / layout 4 유지. 새 dependency·migration·commit·push·PR·release 없음.
