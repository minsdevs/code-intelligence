# Phase 5 security audit (task 5-10)

> **역사 문서:** 이 감사 결과는 해당 Phase 시점의 코드와 의존성을 대상으로
> 한다. 현재 RC의 신규 local import/refresh, compare, judgment, export,
> IDE, AI preview 표면과 release blocker는
> [SECURITY](../../SECURITY.md) 및
> [ADDITIONAL_FEATURES](../../ADDITIONAL_FEATURES.md)를 우선한다.

Date: 2026-08-14
Branches: `feature/phase5-backend` (PR #29, merged) + `feature/phase5-ui`
Mode: audit-first. **CRITICAL/HIGH = 0** — no `feature/phase5-security-fixes` PR.

## Controls verified (no finding)

| Control | Result |
|---|---|
| Review / Playground / Growth / What-if use `findByIdAndUserId`; other user's project → 404 | Pass (Phase5ApiIntegrationTest) |
| Missing PR / review / playground session / graph node → 404 | Pass |
| LLM inputs SecretMask (PR body, playground question/snippet/title, what-if context) | Pass |
| Playground `SafeRelativePath.normalize` on selected paths; `../` → 400 | Pass |
| Playground snippet stored as text only; never written into the clone; UI has no execute control | Pass |
| Playground conversations are session-scoped, not the main assistant thread | Pass |
| What-if is Impact reverse-graph + AI narrative; no process execution of clone trees | Pass |
| Growth does not use `AIProvider` | Pass |
| `CodeReviewService` / Playground / What-if stay in `ai` package; ArchUnit: `AIProvider` only inside `dev.codeintelligence.ai..`; packages cycle-free | Pass |
| AI disabled → 503 via `AiNotConfiguredException` | Pass (same exception as ask) |
| Evidence refs validated; broken refs → UNKNOWN | Pass (shared EvidenceValidator) |
| Settings UI still has no API-key fields; keys env-only | Pass |
| Frontend: no `dangerouslySetInnerHTML`; review/playground/growth render plain text | Pass |
| Daily token budget applied to review / playground / what-if | Pass (`AiUsageService`) |

## CRITICAL / HIGH

None.

GitHub Dependabot open alerts on default branch: 4 × `dompurify` (**medium/low** only). Application C/H = 0.

## LOW (report only — not fixed)

| ID | Finding | Why LOW | Disposition |
|---|---|---|---|
| L1 | Playground stores last question/snippet/claims on the session row | Owner-scoped; SecretMask applied; not shared | Keep |
| L2 | Review GET 404 both for missing PR and missing review | Same 404 body; does not leak other users' PRs | Keep |
| L3 | DOMPurify transitive (monaco/jsdom) medium/low GHSAs | Not used to sanitize attacker HTML | Dependabot weekly; same as Phase 4 L3 |
| L4 | What-if explanation is AI interpretation of static dependents | Prompt forbids claiming execution; facts still come from Impact SQL | Keep |

## Public surface (Phase 5 additions)

- `POST/GET /api/projects/{id}/pulls/{number}/review` — session + ownership; CSRF on POST; AI configured.
- `GET/POST /api/projects/{id}/playground/sessions`, get/update/delete, `POST .../ask` — session + ownership; CSRF on writes.
- `GET /api/projects/{id}/growth` — session + ownership.
- `POST /api/projects/{id}/what-if` — session + ownership; CSRF; AI configured.

## Out of scope

Phase 6. GitHub secret scanning CI still waits for public-repo conversion.
