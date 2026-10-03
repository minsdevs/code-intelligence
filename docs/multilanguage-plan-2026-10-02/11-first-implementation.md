# 다음 Astra Max의 첫 구현 묶음 — S1 근거 소스 안전 열람

**이 파일이 다음 구현의 착수 범위다.** 01–10은 전체 제품/검증 로드맵이며 한 번에 완성할 작업 지시가 아니다. 사용자가 승인한 다음 모델은 부모가 명시하는 Astra Max다. 기획 작성자는 구현을 시작하지 않는다.

## 사용자 가치와 수직 흐름

로그인 없이 기존 local import→분석→코드/근거 열람→원본 수정 후 refresh→이전 snapshot의 같은 파일 열람을 수행한다. 이때 **그 snapshot에 실제 연결된 소스 bytes만 표시하고, 없으면 정직하게 unavailable을 표시**한다. 과거 근거를 현재 파일의 같은 행으로 바꿔 보여주는 위험을 먼저 제거한다. 기존 graph 생성·언어 지원·노트/task·GitHub 연결·백업은 이 묶음에서 재작성하지 않는다.

현재 저장 구조를 추가 확인했다: [V4 files.content_hash](../../backend/src/main/resources/db/migration/V4__inventory_area_evidence.sql)는 이름과 달리 [FileInventoryScanner](../../backend/src/main/java/dev/codeintelligence/analysis/core/FileInventoryScanner.java)에서 `treeWalk.getObjectId(0).name()`으로 채운 **Git blob OID**다. plain SHA-256로 비교하거나 기존 필드를 SHA-256라고 재해석하면 안 된다. [FileService](../../backend/src/main/java/dev/codeintelligence/analysis/core/FileService.java)는 이 OID를 쓰지 않고 현재 clonePath 파일을 읽는다. [frontend files API](../../frontend/src/api/files.ts)/[CodeViewer](../../frontend/src/features/code/CodeViewer.tsx)는 snapshotId를 전달/cache-key에 넣지 않는다.

## 구현할 것(총4개 소작업)

| ID | 변경 | 수용기준 |
|---|---|---|
| S1.1 blob 기반 reader | owner+project+snapshot+path로 files row 조회→서버가 보관한 Git blob OID로 해당 managed repo object를 제한 크기 읽기. object type/blob OID 무결성·encoding·binary 검사. clone working-file 직접 읽기 제거 | source가 수정돼도 남아 있는 blob이면 원래 bytes 반환. object missing은410 SOURCE_UNAVAILABLE, hash/type 불일치는409 EVIDENCE_STALE; 절대 current file fallback하지 않음 |
| S1.2 snapshot 전달 | 기존 file/list API의 optional snapshotId 사용, UI snapshot 선택/근거 context에서 명시 ID 전달, React Query와 Monaco model key에 project/snapshot/path 포함 | old/new 왕복·빠른 연속 선택에서 응답이 뒤집히지 않음. snapshotId 미지정은 기존 current 의미 유지하되 서버가 실제 선택 ID를 응답에 포함 |
| S1.3 UX/호환 | viewer에 snapshot 시간/현재 여부, unavailable 원인·현재 snapshot 별도 열기 액션. versioned evidence의 snapshot을 알 수 없으면 미확인 표시. snapshot 없는 일반 note path 링크는 명시적으로 “현재 소스”로 보존 | 잘못된 과거 줄 강조0, 오류에서 old/current 내용을 재사용하지 않음. notes/task 본문·ID·링크 삭제/재작성0 |
| S1.4 통합 검증 | 아래 disposable local fixture의 real backend+DB+실제 JGit reader→UI 경로, 기존 관련 회귀 | fixture golden과 evidence navigation이 일치. API mock 단독으로 통과 선언 금지 |

FileContent 응답에는 기존 path/language/content를 유지하고 resolvedSnapshotId/contentOid/sourceState를 additive로 제공한다. UI의 versioned evidence 클릭은 실제 graph/feature/snapshot 문맥에서 얻은 ID만 전달한다. 서버가 증거 subject와 snapshot 소유 관계를 검증한다. 해석할 수 없는 legacy evidence는 SOURCE_CONTEXT_UNKNOWN, 사용자가 “현재 소스 열기”를 별도로 선택하기 전 임의 latest ID를 붙이지 않는다. 기록 없는 과거 bytes를 새로 만들거나 보존됐다고 주장하지 않는다.

Git blob reader는 JGit을 재사용하고 사용자에게 git CLI 설치를 요구하지 않는다. `content_hash`는 legacy Git OID로 유지한다. 전송받은 OID나 임의 경로로 blob을 조회하지 않고 인증된 DB row에서만 얻는다. 읽는 bytes의 길이와 기존 max-file-size를 모두 검사하며 oversized blob을 한꺼번에 할당하지 않는다. race로 repo가 교체/삭제되면 unavailable/재시도 안내, 읽은 exact bytes를 그대로 응답하며 나중의 working file을 다시 읽지 않는다. 파일 content는 기존 렌더러 escape/read-only 정책을 유지한다.

## 검증 묶음과 통과 조건

합성 fixture2개(Java+TS)에 아래6개 scenario group을 각각 적용한 최소12 runs로 이 **소스열람 계약**을 검증한다. 각 group 안의 negative assertions도 빠짐없이 수행한다. 06의 언어 의미정확도18셀/5,400 annotation 게이트를 통과했다는 뜻이 아니다.

1. snapshot A의 blob+notes/task sentinel 보존→B로 refresh(동일 파일 수/동일 길이 내용 변경 포함). A blob이 남으면 A bytes만, local refresh로 object가 사라졌으면410만 허용. B는 B bytes.
2. working file만 바뀌거나 symlink로 교체돼도 viewer는 저장된 blob만 읽는다. binary/invalid encoding/크기 한도±1/없는 object/잘못된 object type·OID에서 명시 오류. 사용자 source와 .git을 쓰지 않는다.
3. 다른 project/user/snapshot ID와 path traversal은 기존401/403/404 경계를 유지하며 데이터0 반환. 기존 current-snapshot API 클라이언트는 정상 동작.
4. UI snapshot 전환 중 늦은 응답, refresh 뒤 cache invalidation, same path in two projects, 409/410/unknown-context에서 잘못된 content/line highlight0.
5. 코드 탐색에서 파일 열기, graph/feature의 **문맥을 확인할 수 있는** 근거 열기, 기존 일반 note path의 현재 소스 열기 세 경로를 real backend에서 확인한다. 과거 context 없는 증거는 모호하다고 표시한다.
6. 기존 FileApiIntegrationTest/관련 project import·refresh/owner 테스트, frontend codeExplorer·근거 연결 tests/lint/typecheck, 변경된 backend compilation/format을 실행한다. source read 경로 밖 전체 대형 gate를 무조건 반복하지 않되 회귀 발견 시 해당 gate로 확대한다.

PASS는 상기12 변형+3 UI 경로에서 wrong-snapshot bytes0, unauthorized bytes0, 데이터/노트/task 손실0, current 흐름 호환이며 변경 diff·실행 명령·fixture 결과를 인계한다. native 설치/실OAuth/백업 전체 출시 PASS를 뜻하지 않는다. OS/서비스가 필요한 검증은 격리 임시 userData/DB만 사용하고 실제 사용자 설치 데이터를 변형하지 않는다.

## 범위 밖과 중단 조건

S1이 확인하는 것은 inventory가 가리키는 blob bytes다. 기존 analyzer가 반드시 같은 bytes로 모든 graph fact를 만들었다는 소급 증명은 하지 않으며 legacy analysis evidence의 provenance 미검증 표시를 유지한다. 완전한 generation/source binding은 03의 후속 작업이다.

이번 묶음에는 새 언어, C/F/X 정확도 개선, XPC supervisor/worker 이행, 전체 immutable encrypted source store·GC, IR v1 DB migration, OAuth 앱 등록, AI 호출/원장, backup3·updater·서명·배포가 없다. 장기 ADR-01/02를 먼저 전면 구현해야만 이 읽기 경로를 고칠 수 있는 것은 아니다. S1은 현 저장 데이터로 가능한 안전한 읽기 경계를 추가하며 새로운 parser 실행 권한이나 source 수집을 만들지 않는다. 기존 감사 B1/B6/B8/B9/B13 등의 출시 No-Go는 유지한다.

다음이면 임의 scope 확대 대신 부모에게 근거와 선택지를 보고하고 S1 종결/축소 여부를 판단한다:

- 기존 `content_hash`가 해당 row에서 Git OID가 아닌 경우/옛 데이터 의미를 결정할 수 없음: UNKNOWN/UNAVAILABLE로 실패 폐쇄, 데이터 덮어쓰기 금지.
- Git blob이 다수 유실되어 사용성이 부족함: 과거 현재파일 fallback 금지. S2 immutable store 범위·비용을 별도 제안하되 자동 착수하지 않음.
- UI evidence의 snapshot 문맥을 안전하게 얻으려면 대규모 migration이 필요함: 검증된 source viewer 경로까지만 구현 결과를 구분하고 unknown evidence는 표시. “전체 evidence 완성”으로 보고하지 않음.
- notes/task ownership/공개 API 호환에 파괴적 변경이 필요함, 기존 사용자 변경과 충돌, 임시 DB 없는 환경, 운영 자격증명이 필요해짐: 원본 보존 후 명시 blocker 보고.
- 새 native sandbox·운영 등록을 해야 현재 코드를 시험할 수 있다는 요구가 생김: 합성 로컬 시험의 경계를 재확인하고 사용자 소스로 우회 시험하지 않음.

## 비용·후속 승인 경계

S1 예상 **사람 engineering2–4인일 + QA1–2인일**, 실제 코드 관계와 환경에 따라 재산정한다. 이는 AI agent wall-clock이나 모델 토큰/유료비용 추정이 아니다. AI 작업시간은 현재 측정 근거가 없어 제시하지 않는다.

전체 R0/R1의161–222인일은 넓은 공개지원18셀과 독립 annotation을 포함한 장기 사람 작업량 가정이다. 모든 언어 R2/R3와 운영 대기까지 포함한 최종 일정은 아니며 즉시 수행 약속이 아니다. S1 완료 후 부모가 결과를 검토해 T00 pilot 또는 S2 안전 import/immutable source store 중 다음 좁은 묶음을 명시한다. O1/O2는 실제 운영 등록·자격증명·배포 전 사용자 입력 게이트로 유지한다.
