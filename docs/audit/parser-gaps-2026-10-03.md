# 제한된 TypeScript 파서 정확도 후속 감사 — 2026-10-03

파서 수준의 5개 공백을 수정했다. **출시 판정은 No-Go**다. 제품 수집 단계의
`.mts/.cts` 누락과 구문 진단의 HTTP/UI 전달은 남아 있으며, 이전 감사의 운영 OAuth,
독립 native 번들, 서명·설치·업데이트와 제품 정확도 수용 차단점도 해소되지 않았다.

## 범위와 보존

- `/Users/minseokchae/Dev/code-intelligence`, branch `codex/e2e-docs-scripts`, HEAD
  `ebe3ab135ce6dbaa454b29db6e5ab5c678557070`에서 수행했다. 기존 미커밋 변경을 보존했다.
- 사용자 허용 범위는 순수 파서 수정과 선택한 Node/Vitest 검증이다. `AGENTS.md`와
  관련 `.agents` 지침은 앞선 저장소 확인에서 발견되지 않았다.
- 선택한 `ts-extractor.test.ts`, `semantic-extractor.test.ts`, `http-boundary.test.ts`와
  package/config/import를 읽었다. 테스트 입력은 합성 문자열 또는 고정 repo fixture다.
  분석 대상 저장소의 import, 코드, npm hook, tsconfig plugin은 실행하지 않는다.
- 전용 `vitest.parser.config.mjs`는 Node worker thread 하나, 3개 파일만 선택한다.
  dotenv·watch·브라우저·API listener·setup/globalSetup·dependency optimizer를 끈다.
  native config loader로 설정 번들링도 생략한다. 설치된 Vitest 4.1.10/Vite 8.2.1의
  실행 경로와 Mac arm64 Rolldown binding을 정적으로 확인했다. 변환용 native library는
  Node 내부에서 로드되며 외부 native helper 프로세스 실행을 요구하지 않는다.
- 새 패키지 설치·네트워크 요청·분석 대상 코드 실행·Java/DB/guardian 시작·PID 조회/신호·AX·
  사용자 브라우저·전체 빌드/스위트를 실행하지 않았다. 금지된 권한 경로를 재시도하지 않았다.
- 동결한 기획/실행 문서, 기존 검증 JSON, 실제 guardian skip, backend/frontend 소스를
  수정하지 않았다. 커밋·푸시·PR·게시·배포도 하지 않았다.

## 발견과 수정

라인은 이 후속 후보 기준이다. 코드 위치와 합성 회귀가 재현 근거다.

| 심각도 / 우선순위 | 근거 | 사용자 영향과 수정 |
|---|---|---|
| Low / P2 — 상수 Nest 경로 누락 | `semantic-extractor.ts:1143`, `semantic-extractor.test.ts:4` | `const segment = 'known-orders'; @Controller(segment)` 경로 누락. 같은 파일의 앞선 top-level const literal/alias만 64단계 이내에서 추적. mutable/imported/forward/cycle/dynamic 표현식은 unresolved 유지 |
| Medium / P2 — own method 누락·잘못된 this 연결 | `semantic-extractor.ts:764,860`, `semantic-extractor.test.ts:42` | `this.read()` 간선 누락, `this.this.read()` 오인 및 중첩 일반 함수의 DI receiver 오인 재현. 실제 단일 own instance method 선언과 lexical this를 확인. shadow/static 충돌·상속·동적 member는 unresolved 유지 |
| Medium / P2 — React Route 별칭 누락·동명 오인 | `ts-extractor.ts:125`, `ts-extractor.test.ts:11` | `Route as ScreenRoute` 누락, unrelated/type-only/shadowed Route 오인. react-router(-dom)의 실제 value import 선언으로 named alias와 namespace member 확인 |
| Low / P2 — TypeScript module 확장자 누락 | `paths.ts:51`, `semantic-extractor.ts:451`, `ts-extractor.test.ts:39` | `.mts/.cts`가 파서에서 제외됨. 입력 파싱과 명시적 `.mjs/.cjs` specifier의 TS source 우선 대응 추가. extensionless·framework file-route 확장자 정책은 확장하지 않음 |
| Medium / P2 — 구문 오류를 정상 분석처럼 반환 | `syntax-diagnostics.ts:11,22`, `ts-extractor.ts:54`, `ts-extractor.test.ts:65` | 깨진 bootstrap 때문에 다른 파일의 경로까지 잘못 확정할 수 있음. 어떤 TS/JS 입력이라도 syntactic diagnostic이 있으면 전체 추출을 `ParserSyntaxError`로 거부. 파일·코드·1-based 위치 최대 100개와 전체 개수만 제공. 원문·compiler message·AST 미포함 |

성공 응답 DTO는 바꾸지 않았다. 문법 오류는 실패이며 빈 정상 그래프가 아니다.
없는 타입/외부 import 같은 semantic diagnostic은 syntax 오류와 구분한다.
`CONFIRMED`는 정적 선언 근거이며 실행 시 dispatch, prototype/property 변조까지
증명한다는 의미가 아니다. 분석 대상 코드는 실행하지 않는다.

## 검증

모든 테스트는 같은 3개 파일을 선택했다. 마지막에 진단 개수 상한 회귀 1개를 추가했다.
새 테스트 총 46개와 기존 기대값 1개 변경(상수 경로의 의도적 지원)이 포함된다.

| 단계 | 결과 | 근거 |
|---|---|---|
| 수정 전 기존 파서 baseline | 106 PASS / 0 FAIL / 0 SKIP, exit 0 | `baseline-tests.json` |
| 회귀 추가, 구현 수정 전 RED | 128 PASS / 23 FAIL / 0 SKIP, 총 151, exit 1 | `red-tests.json` — 실패 증거 보존 |
| 첫 구현 검증 | 151 PASS / 0 FAIL / 0 SKIP, exit 0 | `green-attempt-1.json` |
| 최종 진단 상한 포함 검증 | **152 PASS / 0 FAIL / 0 SKIP**, 3 files, exit 0 | `final-tests.json`, runner 15.57초 |
| 범위 제한 strict TypeScript 검사 | **PASS**, exit 0, noEmit | 아래 명령, `final-typecheck.log` 비어 있음 |
| 변경 whitespace 검사 | **PASS**, exit 0 | `git diff --check -- analyzers/ts-analyzer` |
| Lint | 미실행 | analyzer package에 lint script 없음 |
| Java/DB/HTTP integration, 전체 suite/build, native, UI, 서명/배포 | **미실행** | 이번 사용자 허용 범위 밖 |

Node 26.5.0 / macOS arm64의 로컬 결과다. README의 Node 24 RC baseline 재검증은 아니다.
15.57초는 이 테스트 묶음의 시간이며 대형 저장소 SLO가 아니다. 옛 holdout **34/39**는
그대로 이력으로 보존한다. 해당 harness를 다시 실행하지 않았으므로 **39/39라고 주장하지 않는다**.

실행 명령(작업 디렉터리 `analyzers/ts-analyzer`):

```bash
env -u NODE_OPTIONS -u NAPI_RS_NATIVE_LIBRARY_PATH -u NAPI_RS_FORCE_WASI -u NAPI_RS_WASI_FLAVOR \
  node node_modules/vitest/vitest.mjs run --config vitest.parser.config.mjs --configLoader native \
  --reporter=default --reporter=json --outputFile.json=/tmp/ci-parser-gaps-EudHOF/final-tests.json

env -u NODE_OPTIONS node node_modules/typescript/bin/tsc --noEmit --target ES2022 --lib ES2022 \
  --module ESNext --moduleResolution Bundler --strict --esModuleInterop --skipLibCheck \
  src/ts-extractor.ts src/semantic-extractor.ts src/syntax-diagnostics.ts src/paths.ts src/types.ts \
  src/generic-extractor.ts src/ts-extractor.test.ts src/semantic-extractor.test.ts src/http-boundary.test.ts
```

개별 JSON과 baseline source hashes는 충돌 없는 신규 `/tmp/ci-parser-gaps-EudHOF/`에
보존했다. repo에 남긴 [검증 manifest](parser-gaps-validation-2026-10-03.json)는 각 결과의
개수·SHA-256, 현재 관련 소스 SHA-256과 명령/종료 코드를 기록한다. 기존 감사의 검증
JSON을 덮어쓰거나 이전 통합 결과를 이번 후보의 결과로 바꾸지 않았다.

## 남은 경계와 출시 판정

| 심각도 / 우선순위 | 정적 근거 / 한계 | 필요한 후속 작업 |
|---|---|---|
| Medium / P2 — 제품 `.mts/.cts` 수집 누락 | `LanguageDetector.java:8`의 확장자 표와 `TsParsingStep.java:125`의 입력 필터 모두 미포함 | backend 수집 수정과 Java→sidecar 통합을 별도 허용 범위에서 검증. 파서 지원만으로 제품 지원 완료 아님 |
| Medium / P2 — 구문 진단 전달 | `analyze.service.ts:28`는 직접 `extractTs` 호출, typed parser error의 HTTP/UI 매핑 없음 | 명시적 비재시도 입력 오류/부분 분석 정책과 안전한 진단 UI 계약 결정·구현. 현재 결과를 HTTP 400 또는 사용자 화면 표시 성공으로 주장하지 않음 |
| High / P1 — 제품 출시 | 이전 [감사](restart-recovery-audit-2026-10-03.md)의 운영 OAuth, self-contained native bundle, 서명·설치·업데이트, source consumer 이행, 권한 격리·대표 corpus 수용 | 실제 출시 환경에서 별도 검증 필요. 현재 제한된 파서 통과로 해소되지 않음 |

**No-Go 유지.** 이번 작업은 파서 정확도와 실패 표시의 범위가 명확한 개선이다.
실제 guardian 시험의 정적 skip 및 프로세스 검증 보류는 계속 유효하다.
