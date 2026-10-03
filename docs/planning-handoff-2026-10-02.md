# 후속 Astra 기획 검토 인수 — 실제 구현 기준

이 문서는 2026-10-02 로컬 감사와 안전 수정의 인수 자료다. 다국어 확대를 구현하거나 새 아키텍처를 확정하지 않았다. 제품은 **일반 출시 No-Go**이며 상세 심각도·재현·검증은 [출시 감사](release-audit-2026-10-02.md)에 있다. 구현 존재, 테스트 통과, 프로덕션 지원 보장은 서로 다른 단계다.

## 기준 상태와 변경 구분

- 시작 `codex/e2e-docs-scripts` / `ebe3ab1`; 시작 시 tracked 변경 없음. 현재 수정은 미커밋 상태다. 기존 desktop stage/dist/.app는 보존했고 새 소스로 교체하지 않았다.
- 최초 감사 F1–F7: 정적 앱 asset 인증, main 전용 폴더 승인 capability, runtime 재기동/관리 작업 직렬화, 실제 OAuth callback 포트, 비밀 마스킹, desktop CI/테스트와 문서.
- 후속 F8–F10: 501파일 프로젝트 문맥과 byte budget, CANCELLING/V21·프로젝트 잠금·retry CAS, 같은 설치 backup 무결성·rollback·crash marker.
- 추가 읽기 전용 감사 제보 F11–F12: gitlink 누락 객체 중단을 재현 후 제외 근거 기록; AI 응답 뒤 검증/저장 실패의 집계 누락과 요약/task 미집계를 수정. 동시 예약·embedding 집계는 미구현.
- 현재 Electron + Spring Boot Java21 + PostgreSQL16/pgvector + Redis + React/Vite + ts-morph sidecar를 유지한다. 별도 tree-sitter sidecar는 코드에 있지만 desktop stage/start에 포함되지 않는다. 대체 앱 설치/운영 설정 변경/유료 호출/커밋/배포 없음.

## 현재 사용자 기능

로컬 폴더 선택/preview/copy 기반 snapshot, GitHub 저장소 가져오기 및 인증 코드, 분석 job 진행·SSE·취소·재시도, ReactFlow/ELK 기반 구조 탐색, flow/impact/feature/finding, 원본 근거 보기, snapshot 비교, 노트/task, 선택형 AI 질문/요약/리뷰, runtime 진단·백업/복원 UI가 존재한다.

이는 새 기기에서 사용자가 개발 도구 없이 모든 흐름을 완료했다는 뜻이 아니다. 실제 OAuth 계약은 미완, IDE 외부 열기 경계는 미검증, local copy의 비밀 폴더·용량 제한은 부족하다. 브라우저 E2E 2개는 mock API다. 원본 소스 실행이나 사용자 앱 빌드는 분석 필수 경로가 아니다.

## 언어·프레임워크별 지원 깊이

여기서 “심볼”은 클래스/함수 등의 위치, “호출”은 호출 대상 연결, “API”는 endpoint 또는 client 요청, “데이터”는 ORM/테이블 등의 관계다. 파일 확장자 표시만 되는 언어를 의미 분석 지원으로 세지 않는다.

| 대상 | 현재 엔진/desktop 포함 | 파싱·심볼 | 호출·API·데이터 | 실제 한계와 근거 |
|---|---|---|---|---|
| Java / Spring | JavaParser + symbol solver, backend 포함 | 타입·메서드·상속·구현·imports | in-source CALLS, 미해결 fallback; Spring mappings, JPA entity/table, Kafka topic publish/subscribe 추출 | 의존 라이브러리 해석·동적 DI/reflective dispatch의 완전성 보장 없음. [JavaAnalyzer](../backend/src/main/java/dev/codeintelligence/analysis/java/JavaAnalyzer.java), [Java 추출기](../backend/src/main/java/dev/codeintelligence/analysis/java/) |
| TS/JS / NestJS | ts-morph sidecar 포함 | 선언·imports/reexports, tsconfig/package 문맥 | controller endpoint, global prefix, module/provider/DI, guard/middleware, service CALLS; TypeORM/Prisma 이름·패턴 기반 READS_WRITES | 10MiB JSON/20,000파일 단일 문맥 제한. 동적 등록·alias·함수명 fallback의 오탐 oracle 필요. ORM 연결은 LIKELY이며 완전한 데이터 흐름이 아님. [semantic-extractor](../analyzers/ts-analyzer/src/semantic-extractor.ts), [TsParsingStep](../backend/src/main/java/dev/codeintelligence/analysis/ts/TsParsingStep.java) |
| React / TSX/JSX | 같은 sidecar 포함 | component, 함수·hooks/store 등의 추출 | FE route, fetch/axios 요청, 구조 관계 | 동적 URL/래퍼/상태 전파/런타임 조건의 완전한 실행 추적 아님. [TS analyzer 소스](../analyzers/ts-analyzer/src/) |
| Python | desktop TS sidecar의 regex fallback; 별도 tree-sitter는 미포함 | fallback class/def 위치; tree 활성 시 AST 심볼/imports | tree 활성 시 app/router decorator, Django URL, SQLAlchemy 유사 entity 패턴 | 기본 desktop에서는 얕은 심볼 수준. tree도 일반 호출·변수/dataflow 분석은 아님. [generic-extractor](../analyzers/ts-analyzer/src/generic-extractor.ts), [python.ts](../analyzers/tree-analyzer/src/python.ts) |
| Go | 위와 동일 | fallback type/func; tree AST struct/func/method | tree 활성 시 receiver 이름/HTTP 메서드 패턴 endpoint | 프로젝트 type-check·package 간 호출·데이터 흐름 보장 없음. [go.ts](../analyzers/tree-analyzer/src/go.ts) |
| Vue / Svelte | 별도 tree-sitter 경로만, desktop 미포함 | 파일명 component, script block 일부 | JS 문법으로 fetch/axios, SvelteKit 경로 패턴 | 전체 SFC/TS script/template 의미 분석 아님. script 추출 후 행 offset 미반영으로 원본 근거 줄이 어긋날 수 있음(정적 관찰, 이번 수정 범위 밖). [vue-svelte.ts:40](../analyzers/tree-analyzer/src/vue-svelte.ts) |
| SQL / YAML / Docker / Terraform / build·CI config | backend 추출기 포함 | schema/resource/service/config metadata | 테이블/배포·서비스 연결 패턴 | 일반 프로그래밍 언어 call/dataflow 지원과 구분. [config 추출기](../backend/src/main/java/dev/codeintelligence/analysis/config/) |
| Kotlin, Rust, C/C++, C#, Swift, Ruby, PHP 등 | 확장자 inventory 식별 | 전용 semantic adapter 확인 안 됨 | 범용 심층 호출/API/데이터 지원 확인 안 됨 | [LanguageDetector](../backend/src/main/java/dev/codeintelligence/analysis/core/LanguageDetector.java)의 라벨은 지원 보장이 아님. CoverageService의 지원 목록과 실제 adapter가 불일치. |

Python/Go가 TS fallback과 tree 양쪽에 들어가는 실행 설정에서는 결과 provenance/중복 정책도 검토해야 한다. tree 경로는 파일 단위 40개 batch와 전체 payload 누적을 유지하므로 TS의 새 byte budget을 모든 analyzer의 제한으로 설명하면 안 된다.

## 혼합 언어 연결의 현재 의미

[CrossDomainStep](../backend/src/main/java/dev/codeintelligence/analysis/cross/CrossDomainStep.java)는 client URL·HTTP method와 endpoint, ORM/table·service 관계를 연결한다. path 일치/정규화/추정에 따라 confidence를 둔다. 따라서 React→Nest/Spring의 일부 연결을 표현할 기반은 있으나 “모든 언어의 화면→API→서비스→데이터를 증명”하지는 않는다. Java의 Kafka 추출도 범용 다국어 메시지 payload 추적을 뜻하지 않는다. FFI, gRPC/protobuf, queue envelope, serialization 계약 전반을 해결한 공통 언어 간 분석은 확인하지 못했다.

특히 [CoverageService](../backend/src/main/java/dev/codeintelligence/analysis/coverage/CoverageService.java)의 inventory=analyzed 집계와 고정 supported-language 목록 때문에 현재 표시만으로 완전성 판정을 하면 안 된다. parser 실행 여부, 성공/실패/제외, 분석 capability, confidence를 각각 보여야 한다. 미지원 파일, 미해결 호출, 추정 연결은 “없음”과 구분되어야 한다.

## 다음 기획에서 재사용할 기반과 설계 항목

현재 [CodeAnalyzer SPI](../backend/src/main/java/dev/codeintelligence/analysis/core/CodeAnalyzer.java), [AnalysisResult](../backend/src/main/java/dev/codeintelligence/analysis/core/AnalysisResult.java), [GraphNodeDraft](../backend/src/main/java/dev/codeintelligence/analysis/core/GraphNodeDraft.java), [GraphEdgeDraft](../backend/src/main/java/dev/codeintelligence/analysis/core/GraphEdgeDraft.java), AnalyzerEvidence와 graph persistence가 공통 결과의 출발점이다. 이를 버리지 않고 adapter 계약을 구체화하는 방안이 자연스럽다. 다만 다음 내용은 **후속 설계 제안이며 미구현**이다.

1. 언어 인식, parser, project resolution, 호출, API, 데이터, framework plugin을 capability로 분리한다. 각 adapter가 지원 버전·실제 처리량·제외/실패 이유를 반환하게 한다.
2. 공통 결과에 snapshot/content hash, analyzer/version, 원본 source span, resolution provenance, confidence/reason을 정의한다. 추정 edge를 확정 edge와 구별하고 cross-language 연결은 별도 contract adapter로 제한한다.
3. 먼저 NestJS/React 혼합 fixture를 강화한다. framework wrapper, dynamic URL, monorepo aliases, 미해결 외부 라이브러리, 실패/취소/재시도까지 정확도와 누락률을 고정 oracle로 평가한다. 파싱 성공률과 호출 정확도를 하나의 수치로 합치지 않는다.
4. 대형 프로젝트의 project context는 보존하면서 request/session 수명·메모리 budget·취소 checkpoint·캐시 invalidation을 설계한다. 현재 단일 bounded request의 제한을 숨기지 않는다.
5. local copy의 공통 제외·byte budget(B6), preview digest(B7), coverage(B8)를 언어 확대보다 먼저 정리한다. backup crash 복구 UX와 실제 native 흐름도 출시 게이트에 넣는다.
6. AI는 반환 chat 집계 보강과 엄격한 상한을 구별한다. 예약·최대 출력·동시성·usage 없는 오류·embedding·정산 복구 정책을 고정하기 전 비용 보장을 약속하지 않는다.

## 사용자/제품 선택이 필요한 항목

| 선택 | 실제 결정할 내용 |
|---|---|
| 우선 사용자 저장소 | NestJS+React 중심 RC를 먼저 완성할지, 다음 언어를 Python/Go/Java 중 무엇으로 할지. 언어 수보다 요구되는 support depth와 대표 repo가 필요. |
| 인증 | GitHub App/OAuth App, device flow 또는 비밀을 서버에 보관하는 교환 서비스. 운영 등록과 사용자 권한 경험. |
| 설치 대상 | macOS arm64 우선인지, x64/Windows/Linux 동시인지. 서명·독립 runtime·업데이트 전략의 범위가 달라짐. |
| backup | 같은 설치 복구만 제공할지, 다른 기기 복원까지 제공할지. portable이면 identity/key 암호화 export와 분실 복구 정책 필요. |
| 크기·비밀 경계 | 지원 repo byte/file 상한, generated/vendor/submodule 처리, 상위/home 선택 시 UX, 비밀 제외 규칙. |
| AI 비용 | 단순 사용량 알림/soft guard인지 엄격한 토큰 예약 상한인지, embedding 포함 여부와 불확실 청구의 처리. |

현재 소스의 기능 존재를 근거로 높은 준비도 점수를 부여하지 않았다. 다음 검토는 고정된 평가 기준과 oracle, 독립 실행·복구 인수 증거로 판단해야 한다. 이 문서는 다음 기획에 필요한 사실과 선택지를 전달하며 구현 범위를 자동으로 확대하지 않는다.
