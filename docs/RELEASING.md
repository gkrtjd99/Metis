# Metis 릴리즈와 공개 배포

## 현재 1.2.0 릴리즈와 승인 범위

1.2.0은 현재 public release이며, 이 문서는 해당 릴리즈의 패키징·검증 기록과
향후 공개 절차를 구분한다. 로컬 검증과 패키지 생성 자체는 commit, push, PR
병합, 태그 생성, GitHub release 또는 npm registry 공개를 수행하지 않는다.
이 저장소의 외부 반영은 release owner가 승인 경계에 따라 별도로 수행한다.

Schema 11, configuration 6, runtime layout 4는 1.1.0과 동일하다.
이번 변경으로 마이그레이션은 필요하지 않다. `ownerExecution`은 기본 비활성화이며,
실제 host capability와 그 증거 없이 활성화하거나 중첩 Agent 지원을 주장하지 않는다.

Claude Code와 Codex에서는 실제 세션 receipt를 사용한 owner → worker → 독립
verifier → 같은 owner 세션 복귀 및 완료를 확인했다. 계획 단계는 `forcePhase`
테스트 fixture로 대체했으므로, 전체 계획 E2E·다중 owner 실제 병렬 부하·실제
실패 복구·성능 개선은 이 결과로 입증되지 않는다. 패키지 검사를 native 모델
실행 검사로 설명하지 않는다.

## 1.2.0 패키지 검증

저장소 루트에서 실행한다. 매번 새 임시 디렉터리를 사용해 이전 증거를 덮어쓰지 않는다.
미커밋 변경이 있다면 기준 HEAD뿐 아니라 변경 diff와 검사 결과도 보존한다.

```sh
release_dir=$(mktemp -d "${TMPDIR:-/tmp}/metis-1.2.0-release.XXXXXX") &&
npm run docs:generate &&
npm run check > "$release_dir/check.log" 2>&1 &&
npm pack --json --pack-destination "$release_dir" > "$release_dir/pack.json"
```

각 명령이 성공한 경우에만 다음 단계로 진행한다. `docs/REFERENCE.md`는 직접
편집하지 않고 생성한다. `npm run check`는 생성 문서·메타데이터·전체 테스트와
패키지 conformance를 검사한다. 패키지 테스트는 tarball 오프라인 설치와 설치된
CLI의 `init --host all`, owner/relay 도움말, 기본 capability 비활성화도 확인한다.
현재 `.github/workflows/`에는 CI와 보안 검사만 있으며 공개 배포 workflow는 없다.

## 별도 설치와 체크섬 확인

아래는 npm이 `metis-orchestrator-1.2.0.tgz`를 생성한 경우다. 실제 파일명은
`pack.json`과 대조한다. 전역 설치나 사용자 프로젝트 초기화는 하지 않는다.

```sh
test -n "$release_dir" &&
tarball="$release_dir/metis-orchestrator-1.2.0.tgz" &&
mkdir "$release_dir/extracted" "$release_dir/consumer" "$release_dir/fixture" &&
tar -xzf "$tarball" -C "$release_dir/extracted" &&
node --no-warnings "$release_dir/extracted/package/src/cli.js" --help &&
npm install --offline --ignore-scripts --no-audit --no-fund \
  --prefix "$release_dir/consumer" "$tarball" &&
node --no-warnings "$release_dir/consumer/node_modules/.bin/metis" --help &&
git -C "$release_dir/fixture" init -q &&
node --no-warnings "$release_dir/consumer/node_modules/.bin/metis" \
  --root "$release_dir/fixture" init --host all &&
(cd "$release_dir" && shasum -a 256 metis-orchestrator-1.2.0.tgz > SHA256SUMS) &&
(cd "$release_dir" && shasum -a 256 -c SHA256SUMS)
```
node --no-warnings "$release_dir/consumer/node_modules/.bin/metis" --help &&
git -C "$release_dir/fixture" init -q &&
node --no-warnings "$release_dir/consumer/node_modules/.bin/metis" \
  --root "$release_dir/fixture" init --host all &&
(cd "$release_dir" && shasum -a 256 metis-orchestrator-1.1.0.tgz > SHA256SUMS) &&
(cd "$release_dir" && shasum -a 256 -c SHA256SUMS)
```

`init`은 adapter와 설정만 준비하며 run이나 runtime DB를 생성하지 않는다.
`--ignore-scripts`는 로컬 패키지 설치 과정의 lifecycle script를 실행하지 않는
검사 조건이다. Metis에는 설치 script나 제3자 runtime dependency가 없다.

`npm pack`은 `package.json`의 `files` 목록을 따른다. 로컬 미커밋 소스에서
만든 tarball은 특정 commit의 공개 산출물이라고 주장하지 않는다. 이 파일과
checksum은 해당 검증에만 사용하고 공개 파일로 재사용하지 않는다.

## 보존할 증거

- 후보 기준 commit, 미커밋 변경 여부와 diff
- 전체 검사 로그와 skip 사유
- tarball 파일명, 설치·초기화 결과, SHA-256 및 checksum 대조 결과
- Node.js, npm, Git 버전과 OS
- package/schema/configuration/layout 버전
- native host 검사에 사용한 코드 기준과 실제 검증 범위

검사 결과는 해당 실행의 실제 로그를 기준으로 기록한다. 이전 1.1.0 코드의
통과 결과를 1.2.0 검사 결과로 재사용하지 않는다. Chromium이 없는 경우
브라우저 검사를 통과로 바꾸지 않고 skip 사유를 남긴다.

## 향후 태그·공개 절차

다음 단계는 release owner가 별도 승인 경계 안에서 수행하는 향후 절차다. 아래
명령은 fail-fast 검증 예시이며, 이 문서는 최종 태그 검사를 이미 실행했다고
주장하지 않는다.

1. `CHANGELOG.md`의 `Unreleased`를 실제 공개 날짜로 바꾸고, README 양언어와
   관련 문서의 준비 상태·최신 공개 버전·다운로드 링크를 최종화한다.
2. 변경을 commit하고 PR의 CI·보안 검사 통과 후 `main`에 병합한다.
3. 깨끗한 최종 checkout에서 `npm run check`를 실행하고, 승인된 release
   commit에 `v1.2.0` 태그를 만든다. 로컬 HEAD와 태그 commit의 일치를 확인한다.
4. 그 checkout에서 새 `npm pack` 파일을 만들고 설치 검사를 반복한다. 소스
   아카이브는 같은 태그를 사용한다.

```sh
release_dir=$(mktemp -d "${TMPDIR:-/tmp}/metis-1.2.0-release.XXXXXX") &&
source_status=$(git status --porcelain) &&
test -z "$source_status" &&
source_commit=$(git rev-parse HEAD) &&
tag_commit=$(git rev-parse 'v1.2.0^{commit}') &&
test "$source_commit" = "$tag_commit" &&
git archive --format=tar.gz --prefix=Metis-1.2.0/ \
  --output="$release_dir/Metis-1.2.0.tar.gz" v1.2.0 &&
npm pack --json --pack-destination "$release_dir" > "$release_dir/pack.json" &&
(cd "$release_dir" && shasum -a 256 Metis-1.2.0.tar.gz metis-orchestrator-1.2.0.tgz > SHA256SUMS) &&
(cd "$release_dir" && shasum -a 256 -c SHA256SUMS)
```

공개 단계에서도 후보용 디렉터리를 재사용하지 않고 새 `release_dir`를 만든다.
GitHub release에는 동일한 commit에서 만든 source tar.gz, npm tgz, SHA256SUMS를
첨부한다. 태그 push와 GitHub 공개는 승인 후 수행하고, npm registry publish는
추가로 그 대상에 대한 승인을 받은 경우에만 수행한다.

기존 `metis-pre-1.0-baseline` / `metis-1.0.1-candidate` 식별자는 과거 비교용
preset 및 검증 gate에 연결되어 있다. 이번 버전 정리에서 이름을 바꾸거나 이를
1.2.0 성능 증거로 해석하지 않는다.
