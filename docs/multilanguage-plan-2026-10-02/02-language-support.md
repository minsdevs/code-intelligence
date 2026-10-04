# 언어·프레임워크 지원 계약

## 2026-10-05 실행 범위

아래 버전·언어별 확장표는 목표이며 구현 완료표가 아니다. 이번 개편은 기존 Java/TypeScript/JavaScript 분석 결과로 세 핵심 질문을 해결하는 데 집중한다. 파일 목록(I), 구문(P), 심볼(S), 호출(C), 프레임워크 연결(F)은 별개 능력이다. 파일을 발견하거나 단계가 DONE인 것만으로 성공·지원·정확도를 선언하지 않는다. 새 결과는 실제 파일별 결과(성공/부분/실패/미지원/미측정)를 기록하고, 과거 UNKNOWN/LEGACY_UNMEASURED는 소급 보정하지 않는다. 제외 폴더 내부의 발견하지 않은 파일 수는 추정하지 않는다.

JavaParser 및 TS 분석기의 정적 선언·심볼·명시 관계를 재사용한다. 동적 dispatch/reflection, runtime DI, 서비스 경계가 불명확한 동일 경로, 모듈이 다른 동명 심볼은 미확인/후보로 표시한다. package manifest의 선언은 실행 사용의 증거가 아니다. Python/Go 등 확장은 이번 핵심 맥 경로 완료 후 검토한다.


## 1. 읽는 방법과 순서 근거

아래 버전/패턴은 단계 전체의 목표다. 최초 R1의 required/experimental 구분·정확 버전·표본수는 [최초 공개 셀18개](10-r1-public-cells.md)가 우선한다. 첫 R1 지원을 모든 표의 버전 조합으로 넓혀 해석하지 않는다.

**현재 구현**, **패키지 포함**, **검증된 지원**, **개발 목표**는 별도 축이다. 아래 목표는 구현 완료 주장이 아니다. I=목록/언어 인식, P=구문 트리, S=심볼/소스 범위, C=호출 대상, F=프레임워크 경로, X=언어 간 계약이다. P/S가 있어도 C/F/X를 의미하지 않는다. 표의 `제한`은 명시 패턴만, `없음`은 미지원, `후보`는 추정만이다.

사용량 근거는 [GitHub Octoverse 2025](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/)의 TS·Python·JS 활동과 [Stack Overflow 2025](https://survey.stackoverflow.co/2025/technology)의 Python/FastAPI 성장이다. 저장소 활동과 설문은 유료 수요나 전체 개발자 점유율과 같지 않다. 추출된 설문 표가 일부 범주만 보여 정확한 언어별 % 순위를 인용하지 않았다. Java/웹의 기존 자산, Python/Go의 백엔드 교차 탐색 가치, Roslyn 등의 의미 API, 무실행 제약과 번들 비용을 함께 판단했다.

| 순서 | 수요/가치 판단(기획 판단) | 분석 생태계/비용 | 결정 |
|---|---|---|---|
| R1 Java + TS/JS | 기업 서비스·웹 흐름, 현재 사용자 자료와 코드 있음 | JavaParser/ts-morph 재사용, 추가 런타임 최소 | 가장 먼저 정확도 보강 |
| R2 Python → Go | API·AI 서비스와 웹의 혼합, 작은 서버 구조 탐색 | 기존 tree grammar 있음; 동적 Python 호출/Go package context 제한 | P/S/F와 보수 C부터 |
| R3a C# → Kotlin | .NET 서비스, 기존 JVM 프로젝트와 함께 유용 | Roslyn 의미 API 성숙, Kotlin compiler API 통합/배포 부담 | C# 제한 의미분석, Kotlin 먼저 P/S+명시 annotation |
| R3b PHP → Ruby | 기존 웹 시스템 이해에 가치 | PHP-Parser/Prism 등 AST 선택지; Laravel/Rails 동적 관례 비용 | P/S 우선, 명시 route만 별도 게이트 |
| R3c C/C++ → Rust → Swift | 시스템·native code 구조와 경계 표시 | compile flags/macros/toolchain/SDK·build scripts 때문에 무실행 의미분석 비용 큼 | 구조 탐색 먼저; deep C/F를 약속하지 않음 |

장래 언어의 순서는 고정된 출시 날짜가 아니다. 실제 사용성 8명 시험과 (별도 동의한) 저장소 분포에서 우선순위 변경 근거를 남길 수 있으나 capability 임계치를 낮추지는 않는다.

## 2. 현재 기준선과 첫 목표

현재 근거는 [인수 문서](../planning-handoff-2026-10-02.md), [LanguageDetector](../../backend/src/main/java/dev/codeintelligence/analysis/core/LanguageDetector.java), [TS generic](../../analyzers/ts-analyzer/src/generic-extractor.ts), [tree source](../../analyzers/tree-analyzer/src/)이다. `.h`는 현재 C로 라벨되지만 문맥에 따라 C++일 수 있어 목표 inventory에서 ambiguous로 수정한다.

| 언어 / 현재 desktop | 목표 버전 fixture 범위* / 단계 | P / S | C | F: 첫 공개 패턴 | X와 제한 |
|---|---|---|---|---|---|
| Java: JavaParser 3.28.2 backend 포함 | Java 17/21, preview 제외; R1 | AST/타입·메서드·상속 | 동일 snapshot source symbol solver, unresolved 별도 | Spring MVC 6.x/7.x annotation mappings; Boot 3.x/4.x 설정의 정적 상수; JPA 명시 entity/table | HTTP, schema-qualified SQL, 명시 Kafka topic 후보. reflection·AOP·동적 bean 런타임 경로 없음 |
| TS: ts-morph 27.x 포함 | TS 5.9, R1; 새 compiler 문법은 별도 fixture | AST/함수·타입·module | project config/alias를 포함한 source call; 동적 dispatch 후보 | Nest 10/11 decorator/controller/prefix/module, React 18/19 component, React Router 6/7 명시 route, fetch/axios 상수 URL | TypeORM 0.3/Prisma schema 명시 매핑만; generated client 메서드 이름만이면 후보. Next 전용 routing/SSR는 R2 후 별도 셀 |
| JS/JSX: TS 엔진 포함 | ECMAScript 2022 표준 구문+JSX; R1 | AST/함수·component | source lexical/명시 import. 타입 부재는 미해결 | React, Express 4/5의 literal router는 R2 셀 | computed property/prototype patch는 후보. TS만 통과해도 JS 통과로 세지 않음 |
| Python: regex class/def; tree는 desktop 미포함 | Python 3.10–3.13의 문법 표본; R2 | tree-sitter AST+정확한 범위 | lexical 직접 함수·명시 import만; 동적 method는 후보 | FastAPI 0.115 계열 app/APIRouter include prefix, Django 5.2 path/include 정적 선언; SQLAlchemy 2.x 명시 table 후보 | Pyright는 추후 C 보강 후보일 뿐 첫 R2 의존 아님. decorator 재정의·monkey patch·Django runtime 설정 미지원 |
| Go: regex type/func; tree 미포함 | Go 1.22/1.23 구문 표본; R2 | tree AST package/struct/function/method | 파일/package 내 직접 명시 호출, receiver 타입 불명이면 후보 | net/http ServeMux literal method/path, Gin 1.10 route/group 상수 | go/packages 자동 load/go list 안 함; interface dispatch/cgo 없음 |
| C#: 현재 I만 | C# 12/.NET8 구문 fixture; R3a | bundled Roslyn parse/선언 | 명시 source+제품 포함 reference pack으로 해결 가능한 호출만 | ASP.NET Core 8 controller/Minimal API literal route; EF Core 명시 model은 후보 | MSBuildWorkspace/build/source generator/analyzer DLL 실행 금지; target framework 미일치→S만 |
| Kotlin: 현재 I만 | Kotlin 2.1 JVM 문법 표본; R3a | pinned Kotlin parser PSI를 같은 bundled JVM에서 별도 worker | 첫 릴리스 C 없음 | Spring 명시 annotation 및 Ktor literal routing은 후보 셀 | Java 상호 참조도 symbol identity를 실제 풀기 전 후보. KMP/Gradle script 실행 없음 |
| PHP: 현재 I만 | PHP 8.2/8.3 문법; R3b | tree-sitter PHP AST/S | 첫 릴리스 C 후보만 | Laravel 11의 literal route는 추가 셀 검증 후 후보 | PHP-Parser는 대안; PHP runtime 추가를 피하려 tree 우선. magic method/container runtime 없음 |
| Ruby: 현재 I만 | Ruby 3.3 문법; R3b | tree-sitter Ruby AST/S | 첫 릴리스 C 후보만 | Rails 7.1 literal route는 추가 셀 검증 후 후보 | Prism 대안. metaprogramming/eval/동적 route 실행 없음 |
| C/C++: 현재 I만 | C17/C++17/20, R3c | tree AST/S, 전처리 조건 기록 | 첫 릴리스 없음 | 프레임워크 경로 없음 | compile_commands.json은 데이터로만 읽고 명령 실행 금지. macro branch 다중/헤더 불명, FFI 연결 미지원 |
| Rust: 현재 I만 | editions 2021/2024 문법 표본; R3c | tree AST/S | 첫 릴리스 없음 | 없음 | cargo/build.rs/proc macro 실행 금지, macro 생성 심볼 미포함 표시 |
| Swift: 현재 I만 | Swift 5.10/6.0 문법 표본; R3c | pinned SwiftSyntax parser worker/S | 첫 릴리스 없음 | SwiftUI view 선언은 구조 후보, 화면↔API 자동 경로 없음 | Xcode/SDK를 사용자에게 요구하지 않음; SourceKit-LSP deep는 미지원 |
| Vue/Svelte: tree 경로만, 미포함 | Vue3/Svelte5 일부 SFC, R2 후 | script AST+원본 offset map부터 | TS script는 TS adapter 조건부 | template/event 연결은 별도 미지원 표시 | 기존 line offset 수정 필수. 전체 SPA 흐름 약속 없음 |
| SQL/YAML/Docker/Terraform | 현재 backend 패턴 추출, R1 | 설정·DDL 범위와 parser 실패 보고 | C 개념 적용 안 함 | SQL table/schema, compose service, literal resource | SQL dialect별 검증, config의 secret value는 저장/전송 제외 |

*버전은 **테스트할 목표 범위**이며 상위 모든 patch/조합의 지원 선언이 아니다. 각 공개 build는 parser/runtime/grammar 정확한 버전·SHA와 통과한 fixture 언어/프레임워크 버전의 `capability-manifest.json`을 포함한다. 지정 범위 미확인·unknown version은 “호환 미검증”으로 S/P만 시도, F/C 확정 승격 금지. 첫 구현에서 exact fixture lockfile을 확정하고 라이선스·보안 패치 상태를 재확인해야 한다. 현재 tree-sitter 0.25.x와 각 grammar native ABI 호환은 패키지 시험으로 증명한다.

## 3. 생태계가 곧 지원은 아니다

- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)는 incremental syntax tree 기반이다. 프로젝트 타입 해석·호출 그래프·프레임워크 의미는 제품 adapter가 구현한다. grammar마다 오류 복구·최신 문법 상태가 달라 registry에 버전·test hash를 넣는다.
- [JavaParser upstream](https://github.com/javaparser/javaparser)와 [ts-morph](https://ts-morph.com/)를 현재 재사용한다. JavaParser 홈페이지의 오래된 Java12 설명을 최신 버전 지원표로 쓰지 않았다. library가 최신 문법을 읽어도 제품이 해당 문법을 검증했다는 뜻은 아니다.
- [Pyright](https://github.com/microsoft/pyright)는 별도 semantic 보강 가능성이 있지만 공개 안정 call-graph API를 가정하지 않는다. [go/packages](https://pkg.go.dev/golang.org/x/tools/go/packages)의 외부 driver/toolchain 경로를 첫 R2에서는 호출하지 않는다.
- [Roslyn](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/)은 구문/의미 API 기반 후보이며 build 실행 없이 직접 compilation을 구성한다. [Kotlin Analysis API](https://github.com/Kotlin/analysis-api)는 장래 의미 보강 후보로 남기고 현재 R3a 확정 범위는 PSI 구문으로 한정한다.
- [Clang compilation database](https://clang.llvm.org/docs/JSONCompilationDatabase.html)는 컴파일 문맥 입력이다. 파일 존재만으로 헤더/flags 재현이 되지는 않는다. [rust-analyzer 보안 설명](https://rust-analyzer.github.io/book/security.html)은 기본 build script/proc macro 실행 위험을 명시한다. 첫 제품에서는 rust-analyzer를 자동 기동하지 않는다.
- [SourceKit-LSP](https://github.com/swiftlang/sourcekit-lsp)는 toolchain과 빌드 index 의존을 갖는다. SwiftSyntax 구문 단계와 분리한다. [PHP-Parser](https://github.com/nikic/PHP-Parser), [Prism](https://ruby.github.io/prism/)은 대체 AST 후보이며 PHP/Ruby 실행환경 추가 비용 때문에 초기 tree 경로를 선택했다.

## 4. 프레임워크/혼합 경계의 승격 규칙

Spring [mapping 조건](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-requestmapping.html), Nest [controller](https://docs.nestjs.com/controllers), FastAPI [router include](https://fastapi.tiangolo.com/tutorial/bigger-applications/), Django [URL dispatcher](https://docs.djangoproject.com/en/5.2/topics/http/urls/)를 각 rule의 공식 근거로 사용한다. method/path만 같아도 host/service/profile/headers/media type/version 조건이 다르면 별 endpoint다.

R1 HTTP는 호출 위치·HTTP method·URL template·해석된 서비스 경계와 handler 선언을 함께 보존한다. 문자열 일치뿐이면 추정이다. R2 OpenAPI 3.0/3.1·protobuf/gRPC는 **명시적으로 프로젝트에 포함된 계약 파일의 정적 심볼 연결만** 추가 실험하며 네트워크 schema fetch/code generation을 하지 않는다. 계약 참조와 실제 호출/handler 구현 검증을 각각 저장한다. gRPC runtime payload/serialization 동일성은 주장하지 않는다.

Queue는 broker/namespace/topic+명시 producer/consumer 설정이 일치할 때 후보 연결한다. 동일 topic 문자열만으로 확정하지 않는다. FFI/JNI/cgo/Python native extension은 경계 노드와 UNKNOWN을 남기고 끊는다. 요청→메시지→DB의 실제 실행 순서/트랜잭션 의미를 선으로 증명하지 않는다.

언어당 승격은 06의 gold/negative/holdout 문턱을 통과한 셀만 가능하다. 실패 셀은 상태를 낮추고 사용자를 속이지 않으며, 수용된 범위를 줄일 때 공개 지원표/fixture manifest를 함께 버전 올린다.
