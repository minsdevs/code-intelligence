# G-UX 사용성 시험 키트 (2026-10-07)

이 키트는 릴리스 게이트 **G-UX**의 사람 참가자 부분을 진행하기 위한 자료입니다.
게이트 기준(`docs/multilanguage-plan-2026-10-02/01-prd.md` 4절, `07-delivery-release-gates.md`):

- 참가자 8명: 초급·중급·시니어 각 2명 이상, Java/웹/Python 배경 혼합.
- 8명 중 **7명 이상이 U1–U4를 도움 없이 완료**.
- “추정을 확정으로 이해”한 **중대 오류 0명**, 심각한 데이터/권한 오류 **0건**.
- 과제당 제한 시간 15분(첫 분석 시간 제외), **화면→근거 찾기 시간 중앙값 60초 이하**.
- 실패하면 원인과 UI를 고친 뒤 **새 과제**로 재시험.
- 대체 증거 금지: headless API mock. 실제 패키지 앱으로만 진행합니다.

자동화된 스크립트 파일럿(`validation/pre-release/ux-accessibility-pilot.cjs`)은 이 시험을
대신하지 않습니다. 파일럿은 과제가 기계적으로 수행 가능한지, 어디서 막힐 수 있는지만 보여줍니다.

## 구성

| 파일 | 내용 |
|---|---|
| `01-recruitment-consent.md` | 모집 매트릭스, 스크리너, 동의서·데이터 취급 안내 |
| `02-fixtures-and-script.md` | 사용할 합성 프로젝트, 생성·설치 방법, U1–U4 진행 대본, 이해도 확인 질문 |
| `03-observation-and-scoring.md` | 관찰지, 심각도 정의, 채점 워크북 구조, 재시험 규칙 |
| `scoring-workbook.csv` | 채점 워크북 빈 서식(참가자×과제 1행) |
| `04-voiceover-manual-check.md` | 30분 VoiceOver 수동 점검표 |

## 진행 순서 요약

1. 스크리너로 8명을 모집하고 매트릭스 칸을 채운다(`01`).
2. 세션 Mac에 시험 대상 후보 빌드를 설치하고 새 macOS 사용자 계정(새 프로필)으로 로그인한다.
   GitHub 로그인 없음, AI 키 없음(AI OFF), Wi-Fi는 꺼도 된다(U1은 네트워크 없이 완료 가능해야 함).
3. 합성 프로젝트 `order-desk`를 생성한다(`02`). 참가자 본인의 소스 코드는 사용하지 않는다.
4. 동의서 낭독·서명 → 연습 없이 U1–U4 진행 → 과제마다 이해도 확인 질문.
5. 관찰지에 시간·도움 여부·오류를 기록하고 워크북에 옮긴다(`03`).
6. 게이트 판정은 워크북 집계로만 한다. 진행자 인상으로 판정하지 않는다.

## English summary

This kit runs the human part of release gate G-UX: eight participants (at least two
each of beginner/intermediate/senior, mixed Java/web/Python background) attempt
outcomes U1–U4 on the real packaged app with a fresh profile, no GitHub account and
AI off, using the synthetic fixture project `order-desk` generated from
`validation/pre-release/ux-fixtures.cjs` (version 1, SHA-256
`8a11841371cc3642dd8089b8bb7d7dfbc1d35bc8d5c81b9e31cf256ddd6f9044`). Pass criteria:
at least 7 of 8 complete U1–U4 unaided; zero participants with a serious
"inference taken as confirmed fact" error; zero serious data/permission errors;
each task within 15 minutes excluding the first analysis; median screen-to-evidence
time ≤ 60 s. On failure, fix the cause and retest with new tasks on the
`library-loans` fixture (SHA-256
`047f6ba3c5bd2d3fb55c9c4429e908796aaed02698f18785643e257a55d47b96`).
Files: recruitment matrix, screener and consent (`01`), fixtures, neutral moderator
script and comprehension probes (`02`), observation sheet, severity definitions,
workbook layout and retest rule (`03`, `scoring-workbook.csv`), and a 30-minute
VoiceOver manual check (`04`). The scripted machine pilot is not a substitute for
this study; the study status stays BLOCKED until real participants have run it.
