# S1 — snapshot 근거 소스 안전 열람

2026-10-02. 승인된 [S1 착수 계약](../multilanguage-plan-2026-10-02/11-first-implementation.md)의 후속 구현 기록이다. 기획 v1.1과 기존 출시 감사는 수정하지 않는다. 이 문서는 source-viewer 계약의 결과만 다루며 제품 일반 출시 승인과 분리한다.

**S1 수용기준 PASS. 일반 제품 출시는 No-Go.** S1 12변형, 관련 backend 47개, frontend 93개와 실제 UI 경로를 확인했다. 실패를 수정한 뒤 해당 변형만 재검증한 합산 결과이며, 최종 12개 전체를 한 번에 다시 실행한 결과라고 주장하지 않는다. 상세 case·실행 기록·source hash는 [검증 JSON](s1-validation-2026-10-02.json)에 있다.

## 변경과 원인

P1은 High/우선 수정, P2는 Medium/이번 묶음 수정, P3는 Low/계약 정합성 수정으로 분류했다. 아래 발견은 모두 수정·검증했다.

| 우선순위 | 확인한 문제·사용자 영향 | 수정 |
|---|---|---|
| P1 | `FileService`가 snapshot inventory 대신 현재 working file을 읽어 과거 근거에 새 코드가 표시될 수 있음 | owner/project/snapshot/path로 inventory를 찾은 후 서버가 보관한 Git blob OID만 조회. working-tree fallback 제거 |
| P1 | UI 요청·cache·Monaco model이 snapshot을 구분하지 못함 | 명시 snapshot 선택, project/snapshot/path/evidence별 query key, project/snapshot/OID/path별 editor model, 응답 identity 검증과 fetch/error 시 editor 제거 |
| P1 | 검색 evidence/unknown IDE shortcut/graph symbol 이동으로 legacy 근거의 현재 줄을 열거나 강조할 수 있음 | 문맥 없는 versioned 링크는 unknown. 검색 FILE과 일반 note만 명시 current. evidence IDE shortcut 제거. graph/feature provenance 미검증 표시와 줄 강조 억제 |
| P2 | JGit small-object 선할당과 malformed loose header가 bounded 검사를 앞서거나 HTTP 500으로 빠질 수 있음 | per-reader streaming 강제, 사전 size 검사, 제한 read, 길이·type·OID·binary·UTF-8 검증. 알려진 JGit header array 오류를 409로 분류 |
| P2 | 기존 `./path`, 반복 slash, Windows 구분자 note 링크가 canonical 응답 path와 달라 잘못 stale 처리될 수 있음 | 안전한 상대 경로 표기만 request/cache 전에 정규화. `..`/absolute/encoded traversal은 정규화로 허용하지 않고 서버가 계속 거부 |
| P2 | S1 refresh 완료 감지가 실제 `DONE`과 다른 문자열을 기다림 | typed terminal 판정으로 수정. 완료 시 project/snapshot/file/graph/feature query 무효화. project 변경 시 refresh UI state 분리 |
| P2 | built UI의 Monaco worker가 상대 ESM 경로를 해석하지 못해 실제 열람 중 runtime 오류 발생. unit 환경의 editor mock에는 드러나지 않음 | `monacoSetup.ts`에서 editor/언어 worker를 Vite의 로컬 자산으로 묶어 명시적으로 선택. 실제 browser page error를 검사 |
| P3 | snapshot subject가 해석되지 않는 legacy evidence를 알려진 불일치와 혼동 | 인식 가능한 subject snapshot이 없으면 unknown, 확인된 snapshot/path 불일치만 stale |

검토는 Astra Max 하위 작업 3개가 backend, frontend, gate를 분담했다. 테스트 리뷰에서 발견한 거짓 통과 가능성도 수정 대상에 포함했다. 모델의 Fast 설정은 도구에 노출되지 않아 사용 여부를 주장하지 않는다.

Worker 수정은 설치된 Monaco 0.56의 worker service 코드와 [Microsoft의 ESM/Vite 통합 지침](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md#using-vite)을 확인했다. npm/CDN 버전을 바꾸거나 외부 worker를 사용하지 않는다.

파일·라인 근거:

- snapshot source: [FileService:77](../../backend/src/main/java/dev/codeintelligence/analysis/core/FileService.java#L77), bounded/type/OID/encoding: [SnapshotBlobReader:37](../../backend/src/main/java/dev/codeintelligence/analysis/core/SnapshotBlobReader.java#L37), legacy subject 판별: [FileService:114](../../backend/src/main/java/dev/codeintelligence/analysis/core/FileService.java#L114).
- UI identity/cache: [CodeViewer:36](../../frontend/src/features/code/CodeViewer.tsx#L36), legacy/줄 강조: [CodeViewer:49](../../frontend/src/features/code/CodeViewer.tsx#L49), snapshot/model: [CodeExplorerPage:79](../../frontend/src/features/code/CodeExplorerPage.tsx#L79), [CodeViewer:205](../../frontend/src/features/code/CodeViewer.tsx#L205).
- 우회 제거: [SearchPage:99](../../frontend/src/features/search/SearchPage.tsx#L99), [EvidenceList:28](../../frontend/src/components/EvidenceList.tsx#L28), [CodeExplorerPage:140](../../frontend/src/features/code/CodeExplorerPage.tsx#L140). 경로 호환: [codeLocation:51](../../frontend/src/features/code/codeLocation.ts#L51).
- refresh 완료: [LocalSourceStatus:7](../../frontend/src/features/projects/LocalSourceStatus.tsx#L7), worker: [monacoSetup:18](../../frontend/src/lib/monacoSetup.ts#L18), 기존 note current 링크: [noteRefs:43](../../frontend/src/features/notes/noteRefs.ts#L43).

## API와 UX 계약

- `GET /api/projects/{projectId}/files?snapshotId={id}`: 기존 array/필드를 유지하고 각 항목에 `resolvedSnapshotId`를 추가한다.
- `GET /api/projects/{projectId}/file-content?path={path}&snapshotId={id}&evidenceId={id}`: `snapshotId`, `evidenceId`는 optional이다. 기존 current 의미는 snapshot 생략·evidence 생략일 때 유지한다. evidence 요청은 명시 snapshot과 인증된 subject 관계를 요구한다.
- 기존 `path/language/content`에 `resolvedSnapshotId/contentOid/sourceState/snapshotTime/currentSnapshot/evidenceState`를 추가한다. `files.content_hash`와 `contentOid`는 기존 Git blob OID이며 SHA-256이 아니다.
- 성공은 inventory의 exact UTF-8 source bytes와 `AVAILABLE`이다. 줄바꿈을 바꾸지 않는다. missing repo/object는 410 `SOURCE_UNAVAILABLE`, legacy 문맥 미확인은 410 `SOURCE_CONTEXT_UNKNOWN`, type/OID/길이/확인된 evidence 관계 불일치는 409 `EVIDENCE_STALE`, 크기 초과는 413, binary/invalid UTF-8은 415이다. 오류는 source content를 포함하지 않는다.
- Feature 응답의 `resolvedSnapshotId`와 evidence의 `snapshotId/evidenceId/sourceState`는 서버가 실제 조회한 문맥이다. 다른 project/user/snapshot의 내용은 반환하지 않는다.
- legacy graph fact가 inventory blob과 같은 bytes에서 만들어졌다는 소급 보증은 없다. 확인된 feature/graph 문맥도 `LEGACY_SOURCE_UNVERIFIED`를 표시하고 해당 근거의 줄을 강조하지 않는다. 문맥이 없는 flow/AI/search evidence는 current ID를 추측하지 않는다.
- unavailable/unknown 상태에서는 별도 현재 소스 열기를 제공한다. 일반 note의 기존 본문·ID·reference는 바꾸지 않고 링크 버튼에 “현재 소스”를 명시한다. Snapshot 선택은 별도의 원본 탐색 행위이며 근거 검증 상태를 승격하지 않는다.

## 재현과 검증 경계

설치된 JDK 21, Node, Docker, frontend dependencies와 Playwright Chromium을 사용한다. 운영 계정/자격증명, 사용자 source, 앱 설치 데이터는 필요하지 않다.

```sh
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend test -- --run
./backend/gradlew --offline -p backend spotlessCheck snapshotSourceTest --console=plain
```

`snapshotSourceTest`는 frontend build를 직접 의존하며 `processResources`는 그 뒤 실제 build를 복사한다. 자동 실행의 누락을 피하도록 CI에도 별도 gate를 추가했다. 일반 `test`에서는 이 browser gate를 제외하므로 `test` 성공만으로 S1 PASS라고 볼 수 없다. CI workflow 자체의 원격 실행은 이번 작업에서 하지 않는다.

테스트는 격리된 Testcontainers PostgreSQL/Redis, 실제 Spring HTTP server, 실제 local import/JGit reader, 별도 headless Chromium을 쓴다. Java와 TypeScript 각각 6개 그룹을 실행한다. TypeScript analyzer는 끄며 language semantic accuracy를 측정했다고 주장하지 않는다. browser의 race 제어는 실제 HTTP 응답의 전달만 지연하며 source/API 응답 내용을 합성하지 않는다. feature/flow/note/task의 탐색 fixture 행은 명시적으로 seed한다.

개발 중 실패는 다음과 같이 원인을 구별했다. 실패 실행 전체를 PASS 증거로 집계하지 않는다.

- 처음에는 helper가 실제 `DONE` 대신 `SUCCEEDED`를 기다렸다. helper와 동일 오류가 있던 S1 refresh UI를 함께 수정했다.
- 익명 테스트에 남은 정상 session cookie, fixture의 잘못된 DB column 이름, JGit read-only fixture object 변경 권한을 바로잡았다. 애플리케이션 인증·object 권한을 완화하지 않았다.
- Browser harness가 첫 HTML에도 API token을 보내 `Sec-Fetch-Site: none` 검사를 위반했다. 앱 preload처럼 API에만 token을 보낸다.
- 그 뒤 실제 navigation/race assertions는 통과했지만 page error 검사에서 기존 Monaco worker 누락이 드러나 제품 코드를 수정했다. 오류를 무시하도록 test를 바꾸지 않았다.

## 최종 검증 결과

| 항목 | 결과 | 실행 근거 |
|---|---|---|
| S1 그룹 1/2/6 × Java/TS | 6 PASS | `/tmp/ci-s1-full-first.xml`의 해당 testcase. 같은 실행에서 미통과한 다른 6개는 아래에서 재검증 |
| S1 그룹 3 권한/문맥 × Java/TS | 2 PASS | `/tmp/ci-s1-ui-first.xml`의 해당 testcase. 이 실행의 UI 4개는 worker 오류로 실패했으므로 아래 결과로 대체 |
| S1 그룹 4/5 실제 UI × Java/TS | 4 PASS, page error 0 | `/tmp/ci-s1-ui-final.xml`, `/tmp/ci-s1-ui-final.log` |
| 기존 backend 회귀 8 suites | 47 PASS, 실패/오류/skip 0 | `backend/build/test-results/test`, `/tmp/ci-s1-related-regression.log` |
| frontend unit 22 files | 93 PASS, 실패/skip 0 | `/tmp/ci-s1-frontend-results.json` |
| frontend lint/typecheck/build·e2e typecheck·runner 문법 | PASS | 마지막 worker 포함 build는 위 UI gate가 실행. e2e typecheck와 `node --check` 별도 통과 |
| backend format/compile/bootJar | PASS | `spotlessCheck test … bootJar`, `/tmp/ci-s1-related-regression.log` |
| 원격 CI, native 설치, 실 OAuth/운영 설정, 서명·공증·배포 | NOT RUN | 이번 범위의 합성 local test로 대신 검증했다고 주장하지 않음 |

관련 backend 명령은 다음과 같다. 일반 `test` 전체나 언어 정확도 대형 gate를 불필요하게 반복하지 않았다.

```sh
./backend/gradlew --offline -p backend spotlessCheck test \
  --tests '*FileApiIntegrationTest' --tests '*ProjectJobApiIntegrationTest' \
  --tests '*LocalImportServiceTest' --tests '*LocalSourceStatusServiceTest' \
  --tests '*GraphApiIntegrationTest' --tests '*SpringMiniEndpointsFeaturesGoldenTest' \
  --tests '*NotesTasksApiIntegrationTest' --tests '*SearchApiIntegrationTest' \
  bootJar --console=plain
```

[전용 fixture](../../backend/src/test/java/dev/codeintelligence/analysis/core/SnapshotSourceContractIntegrationTest.java)와 [browser runner](../../frontend/e2e/snapshot-source-real.cjs)는 다음을 실제로 검사했다: 동일 길이/동일 파일 수 변경 후 B exact bytes와 A 410; working-file 변경/symlink 무시; 한도 1023/1024/1025 및 위조 metadata 크기; malformed header 2종·잘못된 type/OID·invalid UTF-8·binary·missing repo/object; 익명/다른 owner/project/snapshot/path 차단; evidence subject mismatch/unknown; 지연 응답 소비 후 DOM 감시; A/B selector·같은 경로의 별도 project/서로 다른 내용·정확한 Monaco model URI; 이미 있던 highlight 제거; 실제 refresh 후 cache 갱신.

Java 25회·TS 29회의 A read가 실제 refresh 동안 수행됐으며 exact A 또는 410만 반환했다(각 20/24회 unavailable). 파일 교체의 극히 짧은 순간에 read가 걸렸다고 결정적으로 입증하는 검사는 아니며, 별도로 repo 자체를 없앤 410 경로를 검사했다. 탐색용 feature/flow evidence는 seed 데이터이고, historical feature 테스트의 metadata는 실제 A 응답을 변경 없이 재생한다. source bytes는 항상 실제 API/JGit에서 읽는다.

처음 기록한 735파일 중 삭제 0, S1 수정 대상 29파일이며 나머지는 byte hash가 같다. 기획 패키지 20파일은 전부 시작 hash와 일치한다. 노트·reference·task·goal·learning record·evidence link의 전체 행과 source `.git`을 포함한 전체 원본 트리를 fixture에서 비교했다. 실제 사용자 설치 데이터와 운영 credential은 사용하지 않았으며 import/refresh 검증은 합성 source에만 수행했다. commit/push/PR/배포를 하지 않았다.

## 남은 경계

- local refresh가 managed object store를 교체하면 과거 snapshot의 bytes는 410이 된다. S1은 immutable/encrypted source store나 과거 blob 복구를 구현하지 않는다.
- Git pack 총 압축 해제량, delta chain, CPU/RSS/timeout 예산은 기획 N1 및 후속 import/성능 gate의 미완료 항목이다. 파일별 source read 상한 검증과 구분한다.
- native 설치/폴더 picker, 운영 OAuth, clean Mac, 서명·공증·업데이트, 전체 백업복원·언어 정확도 gate는 이번 S1 실행으로 검증되지 않는다.
- 제품 일반 출시 **No-Go**를 유지한다. S1 완료 후에는 부모의 다음 명시 범위를 기다리며 S2/T00을 자동 착수하지 않는다.
- 부모 중간 전송 승인은 있었으나 이 실행 환경에서 thread-send 도구가 사라졌다. 공유 status 문서와 현재 세션 commentary에 체크포인트를 남겼고 최종 자동 부모 알림으로 인계한다.
