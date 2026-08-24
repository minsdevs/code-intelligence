**Languages:** English | [한국어](phase3-security-audit.ko.md)

# Phase 3 security audit (task 3-10)

> **역사 문서:** 이 감사 결과는 해당 Phase 시점의 코드와 의존성을 대상으로
> 한다. 현재 RC의 신규 local import/refresh, compare, judgment, export,
> IDE, AI preview 표면과 release blocker는
> [SECURITY](../../SECURITY.md) 및
> [ADDITIONAL_FEATURES](../../ADDITIONAL_FEATURES.md)를 우선한다.

Date: 2026-08-14
Branches: `feature/phase3-ai-backend` (PR #24, merged) + `feature/phase3-ai-panel`
Mode: audit-first. **CRITICAL/HIGH = 0** — no `feature/phase3-security-fixes` PR.

## Controls verified (no finding)

| Control | Result |
|---|---|
| API keys env-only (`OPENAI_API_KEY` / `GEMINI_API_KEY`); Settings UI has no key fields | Pass |
| `GET /api/ai/status` returns `{ configured, provider }` only — never keys | Pass (integration tests) |
| Blank key → `NoOpAIProvider`, ask `503` `"AI provider is not configured"` | Pass |
| Tests inject `@Primary MockAIProvider`; Mock is not a production fallback | Pass |
| LLM input `SecretMask` (question + source window); extra `sk-` / `AIza` patterns | Pass |
| Provider `base-url` host allowlist: `api.openai.com`, `generativelanguage.googleapis.com`, loopback | Pass |
| RestClient: 10s connect, 60s read, **no redirects** | Pass |
| Gemini key sent as `x-goog-api-key` header (not query string) | Pass |
| Ask APIs use `findByIdAndUserId`; other user's project → 404 | Pass |
| Daily token cap `app.ai.daily-token-limit` (default 500000) | Pass |
| Evidence refs validated against owned snapshot; broken refs → UNKNOWN | Pass |
| CONTEXT treated as untrusted data in system prompt | Pass |
| ArchUnit: `AIProvider` not referenced outside `dev.codeintelligence.ai..` | Pass |
| CI never calls a real LLM | Pass |
| Frontend: no `dangerouslySetInnerHTML`; no `VITE_*` secrets; no key inputs | Pass |
| Clone tree never executed | Pass (unchanged) |

## CRITICAL / HIGH

None.

GitHub Dependabot open alerts on default branch: 4 × `dompurify` (**medium/low** only). Application C/H = 0.

## LOW (report only — not fixed)

| ID | Finding | Why LOW | Disposition |
|---|---|---|---|
| L1 | `GET /api/ai/status` discloses whether a key is configured | Session-authenticated; no secret material | Keep |
| L2 | Stream fallback retries JSON ask after stream failure (double token use) | Same user, same budget counter | Keep |
| L3 | DOMPurify transitive (monaco/jsdom) medium/low GHSAs | Not used to sanitize attacker HTML | Dependabot weekly; same as Phase 2 L3 |
| L4 | `InetAddress.getByName` on a non-allowlisted host that currently resolves to loopback would pass | base-url is operator config, not user input | Keep allowlist of names |

## Public surface (Phase 3 additions)

- `GET /api/ai/status` — session required.
- `POST /api/projects/{id}/ai/ask` and `/ai/ask/stream` — session + project ownership; CSRF.

## Out of scope

Notes / Tasks / LearningRecommendation / TaskGeneration / CodeReview / Search hybrid (Phase 4–5). GitHub secret scanning CI still waits for public-repo conversion.
