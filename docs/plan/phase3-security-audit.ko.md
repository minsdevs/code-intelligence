**언어:** [English](phase3-security-audit.md) | 한국어

# Phase 3 보안 감사 (작업 3-10)

> **역사 문서:** 이 감사 결과는 해당 Phase 시점의 코드와 의존성을 대상으로
> 한다. 현재 RC의 신규 local import/refresh, compare, judgment, export,
> IDE, AI preview 표면과 release blocker는
> [SECURITY](../../SECURITY.ko.md) 및
> [ADDITIONAL_FEATURES](../../ADDITIONAL_FEATURES.md)를 우선한다.

날짜: 2026-08-14
브랜치: `feature/phase3-ai-backend` (PR #24, merge됨) + `feature/phase3-ai-panel`
모드: 감사 우선. **CRITICAL/HIGH = 0** — `feature/phase3-security-fixes` PR 없음.

## 검증된 제어 항목 (finding 없음)

| 제어 항목 | 결과 |
|---|---|
| API key는 env-only(`OPENAI_API_KEY` / `GEMINI_API_KEY`); Settings UI에 key field 없음 | 통과 |
| `GET /api/ai/status`는 `{ configured, provider }`만 반환 — key는 절대 반환하지 않음 | 통과 (integration test) |
| 빈 key → `NoOpAIProvider`, ask는 `503` `"AI provider is not configured"` | 통과 |
| Test는 `@Primary MockAIProvider` 주입; Mock은 production fallback이 아님 | 통과 |
| LLM input `SecretMask`(question + source window); 추가 `sk-` / `AIza` pattern | 통과 |
| Provider `base-url` host allowlist: `api.openai.com`, `generativelanguage.googleapis.com`, loopback | 통과 |
| RestClient: 10s connect, 60s read, **redirect 없음** | 통과 |
| Gemini key를 query string이 아닌 `x-goog-api-key` header로 전송 | 통과 |
| Ask API가 `findByIdAndUserId` 사용; 다른 사용자의 project → 404 | 통과 |
| Daily token 제한 `app.ai.daily-token-limit`(default 500000) | 통과 |
| Evidence ref를 소유한 snapshot에 대해 검증; 깨진 ref → UNKNOWN | 통과 |
| System prompt에서 CONTEXT를 신뢰할 수 없는 data로 취급 | 통과 |
| ArchUnit: `AIProvider`는 `dev.codeintelligence.ai..` 밖에서 참조되지 않음 | 통과 |
| CI가 실제 LLM을 절대 호출하지 않음 | 통과 |
| Frontend: `dangerouslySetInnerHTML` 없음; `VITE_*` secret 없음; key input 없음 | 통과 |
| Clone tree를 실행하지 않음 | 통과 (변경 없음) |

## CRITICAL / HIGH

없음.

GitHub Dependabot default branch open alert: `dompurify` 4개(**medium/low**만 해당).
애플리케이션 C/H = 0.

## LOW (보고만 함 — 수정하지 않음)

| ID | Finding | LOW인 이유 | 처리 |
|---|---|---|---|
| L1 | `GET /api/ai/status`가 key 설정 여부를 공개 | Session 인증 필요; secret material 없음 | 유지 |
| L2 | Stream fallback이 stream 실패 후 JSON ask를 재시도(double token 사용) | 같은 사용자, 같은 budget counter | 유지 |
| L3 | DOMPurify transitive(monaco/jsdom) medium/low GHSA | attacker HTML sanitize에 사용하지 않음 | Dependabot weekly; Phase 2 L3과 동일 |
| L4 | 현재 loopback으로 resolve되는 non-allowlisted host가 `InetAddress.getByName`을 통과할 수 있음 | base-url은 operator config이며 user input이 아님 | name allowlist 유지 |

## 공개 표면 (Phase 3 추가 사항)

- `GET /api/ai/status` — session 필요.
- `POST /api/projects/{id}/ai/ask`와 `/ai/ask/stream` — session + project ownership; CSRF.

## 범위 밖

Notes / Tasks / LearningRecommendation / TaskGeneration / CodeReview / Search hybrid
(Phase 4–5). GitHub secret scanning CI는 여전히 public-repo 전환을 기다립니다.
