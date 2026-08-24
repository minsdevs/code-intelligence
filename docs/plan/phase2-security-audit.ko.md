**언어:** [English](phase2-security-audit.md) | 한국어

# Phase 2 보안 감사 (작업 2-12)

> **역사 문서:** 이 감사 결과는 해당 Phase 시점의 코드와 의존성을 대상으로
> 한다. 현재 RC의 신규 local import/refresh, compare, judgment, export,
> IDE, AI preview 표면과 release blocker는
> [SECURITY](../../SECURITY.ko.md) 및
> [ADDITIONAL_FEATURES](../../ADDITIONAL_FEATURES.md)를 우선한다.

날짜: 2026-08-14
브랜치: `feature/phase2-ui` (P1 sidecar + P2 API + 이 UI 감사)
모드: 감사 우선. **CRITICAL/HIGH = 0** — `feature/phase2-security-fixes` PR 없음.

## 검증된 제어 항목 (finding 없음)

| 제어 항목 | 결과 |
|---|---|
| Sidecar bind `127.0.0.1:3040` (compose: service name) | 통과 (`TS_ANALYZER_HOST` default) |
| `POST /analyze` JSON body 제한 10MB | 통과 (`json({ limit: '10mb' })`) |
| Analyze path: relative만 허용, `..`, NUL, absolute, Windows drive 거부 | 통과 (`assertSafeRelativePath` + vitest) |
| 파일별 content 제한 1 MiB | 통과 (`assertContentSize`) |
| Sidecar가 clone code를 실행하지 않음(ts-morph in-memory / heuristic) | 통과 |
| `app.ts-analyzer.base-url` SSRF allowlist: loopback 또는 hostname `ts-analyzer`; userinfo 없음; http(s)만 허용 | 통과 (`TsAnalyzerProperties` + unit test) |
| RestClient: connect timeout, read timeout, **redirect 없음** | 통과 |
| 빈 base-url → TS_PARSING empty DONE(outbound call 없음) | 통과 |
| 신규 GET(`/flows`, `/findings`, `/impact`, `/eras`, `/features`)이 `findByIdAndUserId` 사용 | 통과 |
| Impact `nodeId`가 소유한 snapshot에 속해야 함; depth는 1–8로 clamp | 통과 |
| Frontend: `dangerouslySetInnerHTML` 없음; evidence/finding text는 React text node | 통과 |
| `VITE_*` secret 없음 | 통과 |
| Clone tree를 실행하지 않음 | 통과 (변경 없음) |

## CRITICAL / HIGH

없음.

GitHub Dependabot default branch open alert: `dompurify` 4개(**medium/low**만 해당).
애플리케이션 C/H = 0.

## LOW (보고만 함 — 수정하지 않음)

| ID | Finding | LOW인 이유 | 처리 |
|---|---|---|---|
| L1 | Sidecar `POST /analyze`에 인증 없음 | Loopback bind; backend RestClient만 호출; compose network는 내부망 | 유지; port를 공개하지 않음 |
| L2 | 현재 loopback으로 resolve되는 non-allowlisted host가 `InetAddress.getByName`을 통과할 수 있음 | base-url은 operator config이며 user input이 아님 | name allowlist 유지; 변경 없음 |
| L3 | DOMPurify transitive(monaco/jsdom) medium/low GHSA | attacker HTML sanitize에 사용하지 않음 | Dependabot weekly; Phase 1 L7과 동일 |
| L4 | Sidecar의 `GET /health`가 인증되지 않음 | liveness 전용; data 없음 | 유지 |

## 공개 표면 (Phase 2 추가 사항)

- **ts-analyzer** — 공개 SPA origin에 있지 않음. Backend 전용.
- **Flows / Findings / Impact / Eras** — session cookie + project ownership;
  project 없음 → 404(Phase 1과 같은 IDOR posture).
- **Architecture `area=FRONTEND`** — BACKEND/SYSTEM과 같은 controller.

## 범위 밖

AI / embedding(Phase 3). Notes / Tasks(Phase 4). GitHub secret scanning CI는
여전히 public-repo 전환을 기다립니다.
