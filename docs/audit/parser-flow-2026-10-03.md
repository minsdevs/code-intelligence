# TypeScript module 수집·구문 진단 전달 후속 — 2026-10-03

`.mts/.cts` 수집과 구문 진단 API/UI 연결 코드를 추가했다. **Java 경로는 정적 검토만
수행했으며 실제 동작 완료로 판단하지 않는다. 출시 No-Go를 유지한다.**
순수 Node/Vitest의 파서·서비스 직접 호출 156개, 프런트엔드 모의 시험 10개와 두 범위의
제한된 strict TypeScript 검사는 통과했다.

## 적용 범위와 결정

기존 job의 `error`와 `failureCode` 저장·API/SSE 전달 경로를 재사용했다. DB migration,
새 저장소, 전체 아키텍처 전환은 없다. 전체 구문 진단은 sidecar 오류 응답에 최대 100개가
포함되며, 현재 job/UI에는 **첫 위치·진단 번호와 전체 개수**만 전달한다. 모든 진단 목록의
지속 저장·소스 이동 UI가 구현됐다고 주장하지 않는다.

구문 오류가 있으면 전체 추출 실패를 유지한다. 소스가 고정된 같은 snapshot을 반복하는
단순 재시도는 차단하고, 소스를 수정한 뒤 프로젝트에서 새 분석을 시작하도록 안내한다.
기존 로컬 승인 재확인과 일반 서비스 오류의 재시도 동작은 유지한다.

| 심각도 / 우선순위 | 발견·근거 | 수정 / 사용자 영향 | 검증 수준 |
|---|---|---|---|
| Medium / P2 — module 수집 누락 | `LanguageDetector.java:14`, `TsParsingStep.java:137` | `.mts/.cts`를 TypeScript로 분류하고, 옛 inventory의 null language에도 확장자 fallback 적용. 대문자와 `.d.cts` 회귀 소스 추가 | **Java 정적 검토만**, 컴파일/JUnit 미실행 |
| Medium / P2 — 구문 오류가 일반 내부 오류로 처리됨 | `analyze.service.ts:29` | `ParserSyntaxError`를 status 400, code `TS_SYNTAX_ERROR`, `retryable:false`, 위치 진단과 전체 개수를 가진 `BadRequestException`으로 변환. 성공 응답은 유지 | 서비스 직접 호출과 공유 JSON fixture 일치 **PASS**. 실제 HTTP 서버 미실행 |
| Medium / P2 — 오류 분류·위치가 job에서 소실 | `TsAnalyzerClient.java:52`, `TsSyntaxInputException.java:34`, 기존 `JobWorker.java:142` | 400 본문을 최대 64 KiB까지 해석. 안정된 오류 코드·false retryable·양의 진단 개수를 확인하고, 안전한 첫 상대 경로/위치만 메시지로 구성. `JobInputFailure`를 통해 기존 failureCode 경로로 전달 | **Java 정적 검토만**. 실제 REST client→job 저장→API/SSE 미실행 |
| Medium / P2 — 같은 깨진 snapshot 재시도 | `JobService.java:86`, `ProgressStep.tsx:144,255` | 서버 재시도는 코드가 있는 409로 거부, 화면은 진단·소스 수정 안내·프로젝트 링크를 표시. 조회/SSE/재시도 응답 모두 코드로 판단 | UI 모의 시험 **PASS**. 서버 retry guard는 소스/JUnit 회귀 작성만 |

새 Java decoder는 response의 임의 `message`를 사용하지 않는다. 절대/상위 경로,
Windows 경로, control/bidi 문자, 240자를 넘는 경로는 위치를 표시하지 않고
`Location unavailable`로 처리한다. JSON 중복 key·깊이·토큰/문자열/숫자·문서 크기 제한을
설정했다. 인식할 수 없거나 너무 큰 응답은 일반 service failure로 남고 raw body는
새 오류 메시지에 포함하지 않는다. 이 Java 동작들은 아직 실행으로 입증하지 않았다.

## 실행 경계

- 현재 Mac 저장소와 기존 dirty tree에서 필요한 파일만 수정했다. commit/reset/push/PR/배포 없음.
- 선택한 테스트·설정·setup/import를 먼저 읽었다. 새 fixture는
  `backend/src/test/resources/fixtures/ts-syntax-error.json`의 합성 코드 한 줄이다.
- `vitest.syntax-api.config.mjs`: 기존 3개 parser 파일 + `analyze.service.test.ts`만 실행.
  Nest 앱/HTTP listener 없이 `AnalyzeService`를 직접 생성한다.
- `vitest.progress.config.mjs`: 3개 progress 테스트 파일만 실행. dotenv, proxy,
  watch, browser, API listener, dependency optimizer를 사용하지 않는다.
  격리된 jsdom의 inline script 실행은 끄고(`outside-only`), API/SSE는 모의 처리하며
  추가 setup에서 실제 fetch/XHR 요청을 차단한다. 사용자 브라우저를 사용하지 않는다.
- 두 runner 모두 Node worker thread 1개와 native config loader를 사용한다. 설치된
  변환 라이브러리는 Node 내부에서 로드한다. 분석 대상 코드를 실행하지 않는다.
- Java/DB/guardian/native helper/process query/signal/AX/전체 build와 runtime 시험은
  사용자 지시대로 보류했다. 새로운 권한 거부나 우회 시도는 없었다.
- `desktop/test/managed-process.test.cjs`의 위험 PID 시험 격리와 이전 parser 보고서/검증
  JSON은 baseline SHA와 동일하다. 동결 기획·실행 문서는 수정하지 않았다.
- `vercel:react-best-practices`의 effect 정리·상태 범위·접근성·문자열 렌더링 지침을
  검토했다. 기존 jobId key와 SSE unsubscribe를 유지하며 별도 effect를 추가하지 않았다.

## 실행 결과와 실패 보존

| 단계 | 결과 | 근거 (`/tmp/ci-parser-flow-ZQdw8J/`) |
|---|---|---|
| sidecar 수정 전 | 155 PASS / 1 FAIL, 총 156, exit 1 | `sidecar-red.json` — 일반 ParserSyntaxError가 BadRequestException으로 변환되지 않음을 재현 |
| UI 최초 harness | 기존 4 tests PASS, 새 suite 수집 실패 | `ui-red.json` — jsdom/Vite가 fixture 파일 URL을 변환. 정적 JSON import로 수정 |
| UI 수정 전 정상 회귀 | 5 PASS / 3 FAIL, 총 8, exit 1 | `ui-red-regression.json` — 안내 누락/잘못된 retry 재현 |
| 최종 sidecar | **156 PASS / 0 FAIL / 0 SKIP**, 4 files, exit 0 | `sidecar-final.json`, 17.03초 |
| 첫 UI 구현 검증 | 9 PASS / 0 FAIL / 0 SKIP, exit 0 | `ui-final.json` |
| 최종 UI(진단의 markup 해석 방지 포함) | **10 PASS / 0 FAIL / 0 SKIP**, 3 files, exit 0 | `ui-final-escaped.json`, 1.72초 |
| sidecar 제한 타입 검사 | **PASS**, exit 0, noEmit | `sidecar-typecheck.log` |
| 최초 UI 제한 타입 검사 | FAIL, exit 2 | `ui-typecheck.log` — 기존 setup의 jest-dom matcher 선언을 검사 범위에서 누락 |
| UI 제한 타입 검사 수정/최종 | **PASS**, exit 0, noEmit | `ui-typecheck-final.log`, `ui-typecheck-final-escaped.log` — 실제 setup 포함 |
| tracked 변경 whitespace 검사 | **PASS**, exit 0 | 범위를 지정한 `git diff --check` |
| Java compile/JUnit/formatter, DB·HTTP 통합, 실제 SSE, 설치 앱·전체 build | **미실행** | 실행 보류 유지. Java 테스트 작성은 통과 결과가 아님 |

Node 26.5.0의 로컬 결과다. Node 24 RC baseline, 대표 제품 정확도, 대규모 성능 SLO 또는
운영 설치 검증을 대체하지 않는다. 이전 parser 152개는 이번 sidecar 156개에 포함되므로
두 수를 더하지 않는다. 테스트 실패/수집 실패/타입 검사 실패는 삭제하거나 성공으로
재분류하지 않았다.

실행 명령과 관련 소스·fixture·증거 SHA-256은
[검증 manifest](parser-flow-validation-2026-10-03.json)에 기록한다. 서비스와 UI 테스트는
공유 fixture를 사용하지만, 그 사이 Java 경로를 실행하지 않았으므로 end-to-end 시험이 아니다.

## 남은 작업·운영 결정·안전 실행 차단점

현 범위의 최소 연결 구현, 합성/모의 회귀와 제한 타입 검사는 마쳤다. 추가로 실행 위험 없이
가능한 작업은 Java contract/retry 테스트 소스 검토, 입력 크기·경로 경계의 합성 사례 확대,
전체 진단 목록 UI의 요구사항 정리다. 이러한 정적 작업을 늘려도 아래 미검증 경계가
해소되지는 않는다.

1. **실행 제한 변경 필요:** Java compile/순수 JUnit도 현재 보류 대상이다. 후속 허용 시
   `LanguageDetectorTest`, `TsParsingStepTest`, `TsSyntaxInputExceptionTest`,
   `JobServiceRetryTest`를 먼저 검증해야 한다. 그 후에 별도로 허용된 실제 400 응답→
   job failureCode 저장→GET/SSE→새 분석 흐름이 필요하다. 이번 결과는 그 동작 완료 증거가 아니다.
2. **위험 PID 시험:** 격리를 유지한다. 직접 소유한 child/control channel을 기반으로 종료·정리
   설계를 재검토하고 별도 검증 경계가 확정되기 전에는 guardian/native 강제 종료 시험을 재개하지 않는다.
3. **제품 운영 결정:** GitHub 앱 종류와 승인 flow/서버 exchange 방식, 지원 OS/architecture와
   독립 JRE·PG·Redis 배포 기준, Developer ID/notarization/update 서명 운영은 결정·준비가 필요하다.
   새 자격증명을 만들거나 운영 OAuth/게시/배포를 수행하지 않았다.
4. **제품 수용:** source consumer 이행, clean Mac 설치/업데이트, 대표 React→Nest→data corpus와
   실제 source 근거/변경 영향·마인드맵 UX·성능·취소/동시성 수용이 남았다.

**No-Go 유지.** 코드 연결과 제한된 모의 검증은 진행됐으나 Java 및 실제 사용자 흐름은 미검증이다.
