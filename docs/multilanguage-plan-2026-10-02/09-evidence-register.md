# 근거 레지스터와 검증 경계

읽은 날짜 2026-10-02. 외부 조회는 공식 문서·공개 페이지 읽기만 수행했다. 사용자 소스/토큰/파일은 외부에 업로드하지 않았다. 새 계정·자격증명 발급·유료 API·배포·커밋·푸시·제품 코드 변경 없음.

## A. 로컬 원문과 소스

| ID | 원문 | 관찰과 설계 반영 |
|---|---|---|
| L01 | [기획서](../../기획서.md) §1/10/11/12/18 | deterministic·evidence·영역중립·소스 무실행 유지. 이름/path만으로 확정하던 규칙은 새 설계에서 강등 |
| L02 | [release audit](../release-audit-2026-10-02.md) | F1–F12 수정/시험과 B1–B13 잔여를 구별, 원문 No-Go 유지 |
| L03 | [planning handoff](../planning-handoff-2026-10-02.md) | desktop tree 미포함·generic fallback·운영 선택·IR 재사용 기반 |
| L04 | [backend build](../../backend/build.gradle.kts), [desktop package](../../desktop/package.json), [stage](../../desktop/scripts/stage-runtime.mjs) | Java21/JavaParser3.28.2, Electron44.4.5, mac arm64 stage. 버전 pin은 지원 검증과 다름 |
| L05 | [TS package](../../analyzers/ts-analyzer/package.json), [tree package](../../analyzers/tree-analyzer/package.json), [generic](../../analyzers/ts-analyzer/src/generic-extractor.ts) | ts-morph27/TS5.9, tree0.25 native ABI, Python/Go regex의 실제 깊이 |
| L06 | [CodeAnalyzer](../../backend/src/main/java/dev/codeintelligence/analysis/core/CodeAnalyzer.java), [GraphNodeDraft](../../backend/src/main/java/dev/codeintelligence/analysis/core/GraphNodeDraft.java), [GraphEdgeDraft](../../backend/src/main/java/dev/codeintelligence/analysis/core/GraphEdgeDraft.java), [AnalyzerEvidence](../../backend/src/main/java/dev/codeintelligence/analysis/core/AnalyzerEvidence.java) | 공통 결과 확장, evidence subject·version·span·owner 필요 |
| L07 | [CoverageService](../../backend/src/main/java/dev/codeintelligence/analysis/coverage/CoverageService.java) | inventory=analyzed와 고정 supported 목록 오류, generation별 outcome 도입 |
| L08 | [CrossDomainStep](../../backend/src/main/java/dev/codeintelligence/analysis/cross/CrossDomainStep.java), [NaturalKeys](../../backend/src/main/java/dev/codeintelligence/analysis/core/NaturalKeys.java), [V8](../../backend/src/main/resources/db/migration/V8__endpoints_entities_features.sql) | best match·service 없는 endpoint/table key, 조건별 namespace 필요 |
| L09 | [GraphPersistenceService](../../backend/src/main/java/dev/codeintelligence/analysis/graph/GraphPersistenceService.java) | node loop에 evidence 저장, edge-only evidence persist 계약 부족 |
| L10 | [FileService](../../backend/src/main/java/dev/codeintelligence/analysis/core/FileService.java), [LocalImportService](../../backend/src/main/java/dev/codeintelligence/project/LocalImportService.java) | snapshot metadata+current clonePath 읽기, 불변 source bytes store와 legacy unavailable 필요 |
| L11 | [ImpactService](../../backend/src/main/java/dev/codeintelligence/analysis/impact/ImpactService.java) | confidence/관계별 필터 없음·경로 중복 weight, typed unique traversal 설계 |
| L12 | [TsParsingStep](../../backend/src/main/java/dev/codeintelligence/analysis/ts/TsParsingStep.java), [TsRequestBudget](../../backend/src/main/java/dev/codeintelligence/analysis/ts/TsRequestBudget.java) | 단일 프로젝트10MiB/20k 유지, session before scale 원칙 |
| L13 | [main](../../desktop/src/main.cjs), [backup](../../desktop/src/backup.cjs) | lifecycle·rollback·marker 재사용. 새 native/암호화/키 수명은 추가 검증 대상 |
| L14 | [accuracy-gate](../../accuracy-gate), [accuracy tests](../../backend/src/test/java/dev/codeintelligence/analysis/accuracy/) | 실제 TS+DB 기반 기존 gate 유지, 신규 corpus/runner는 미구현 |

상위 `/AGENTS.md`, `/Users/AGENTS.md`, `/Users/minseokchae/AGENTS.md`, `/Users/minseokchae/Dev/AGENTS.md`, repo 및 하위 AGENTS.md를 확인했으나 발견하지 못했다. 관련 로컬 `chatgpt-pro-plan-handoff/SKILL.md`를 읽어 workflow 경계를 확인했지만 Oracle/외부 DevSpace 단계 실행은 이 위임과 다르므로 적용하지 않았다. 사용자가 명시한 Astra 기획·독립 검토·부모 max 구현 순서가 우선한다. 원본 기획의 보안 검토 역할(sc) 요구는 향후 SEC 독립 게이트에 연결한다.

시작 시 `git ls-files -co --exclude-standard`의 715개 실제 파일 SHA-256을 `/tmp/code-intelligence-planning-baseline-20261002.json`에 기록했다. 기존 미커밋 변경을 포함한 현재 bytes를 기준으로 한다. 최종 preservation-report에 비교 결과를 남긴다. 원래 ignored build/stage/node_modules는 읽기 필요 외에 조작하지 않았고 그 전체 내용 hash 검증은 수행하지 않는다.

## B. 공식 외부 근거와 한계

| ID | 공식 근거 | 확인한 사실 / 해석 경계 |
|---|---|---|
| E01 | [GitHub Octoverse 2025](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/) | TS/Python/JS 활동이 큼. 이 제품 유료 수요나 사용자의 언어 순위를 증명하지 않음 |
| E02 | [SO 2025 technology](https://survey.stackoverflow.co/2025/technology) | Python/FastAPI 성장. 응답 표 일부 추출 문제로 정확 언어별 점유율 재인용 안 함 |
| E03 | [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) | incremental syntax trees와 language bindings. semantic/call 정확도 보장 아님 |
| E04 | [JavaParser upstream](https://github.com/javaparser/javaparser), [homepage](https://javaparser.org/) | AST/symbol solver 생태계. 홈페이지 Java12 문구가 오래되어 pinned 제품 지원 버전 추론에 사용 안 함 |
| E05 | [ts-morph](https://ts-morph.com/) | TS compiler API wrapper. 제품 framework rule은 별도 구현 |
| E06 | [Pyright](https://github.com/microsoft/pyright), [Go packages](https://pkg.go.dev/golang.org/x/tools/go/packages) | semantic 생태계 후보. 외부 driver/toolchain 실행/프로젝트 문맥 비용을 범위 제한에 반영 |
| E07 | [Roslyn](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/), [Kotlin Analysis API](https://github.com/Kotlin/analysis-api) | compiler 분석 API 존재. arbitrary project build 없이 적용 가능한 깊이만 목표 |
| E08 | [Clang compilation DB](https://clang.llvm.org/docs/JSONCompilationDatabase.html) | per-file compilation context 입력 형식. commands 실행 권한 아님 |
| E09 | [rust-analyzer security](https://rust-analyzer.github.io/book/security.html) | 기본 proc macro/build script 실행 위험. 구조-only Rust 범위 선택의 근거 |
| E10 | [SourceKit-LSP](https://github.com/swiftlang/sourcekit-lsp), [SwiftSyntax](https://github.com/swiftlang/swift-syntax) | semantic index/toolchain 경로와 syntax parser를 구분; SwiftSyntax 버전/toolchain 번들 검증 필요 |
| E11 | [PHP-Parser](https://github.com/nikic/PHP-Parser), [Prism](https://ruby.github.io/prism/) | 언어 AST 대안. 선택한 tree grammar의 제품 품질은 따로 검증 |
| E12 | [Spring mapping](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-requestmapping.html), [Nest controllers](https://docs.nestjs.com/controllers) | path 이외 method/조건과 controller 구조를 gold에 반영 |
| E13 | [FastAPI router](https://fastapi.tiangolo.com/tutorial/bigger-applications/), [Django URLs](https://docs.djangoproject.com/en/5.2/topics/http/urls/), [Go net/http](https://pkg.go.dev/net/http#ServeMux) | router prefix/include/pattern의 rule 근거. 모든 runtime 등록 지원 아님 |
| E14 | [GitHub App user/device token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) | desktop device grant와 fine-grained repository 선택을 채택; web code 교환 secret 요구와 구분 |
| E15 | [GitHub token refresh](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) | device-origin token에 client_secret 예외 명시. 초안의 재인증-only 선택을 회전+재인증 fallback으로 보정 |
| E16 | [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) | sandbox/IPC와 OS별 secret storage 경계. 동일 사용자 악성 프로세스 완전 방어 보장 아님 |
| E17 | [Apple Developer ID](https://developer.apple.com/developer-id/) | signing/notarization·Gatekeeper 근거. JS-only notarization 상세 페이지는 본문 부족하여 검증 사실 확장 안 함 |
| E18 | [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater) | 플랫폼별 업데이트 제약. 첫 수동 확인 signed full package 결정을 자동 업데이트 구현 완료로 오인 금지 |
| E19 | [Apple App Sandbox entitlements](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html), [Apple DTS filesystem 설명](https://developer.apple.com/forums/thread/678819) | XPC 권한 분리·자식의 sandbox 상속. 모든 child exec 금지 기능으로 과장하지 않으며 signed production helper 실험으로 검증 |

404/본문 부족: 처음 사용한 Octoverse 짧은 URL은 열리지 않아 E01 실제 공식 문서로 대체; kotlin.github.io/analysis-api는 오류라 E07 upstream 문서 repo 사용; electron.build auto-update 페이지 오류는 E18로 대체. 검색 결과만 보고 서드파티 주장을 근거로 삼지 않았다.

릴리스 build 때 공식 upstream 버전/보안 advisory/license와 framework spec를 다시 확인한다. 2026-10-02에 읽은 문서는 미래 릴리스 호환성을 보장하지 않는다. 수치 성능 목표·우선순위·resource quota·quality score는 외부 기관의 사실이 아니라 이 기획에서 정한 검증 가능한 정책이다.
