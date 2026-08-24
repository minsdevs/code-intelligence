# Phase 1 security audit (task 1-16)

> **역사 문서:** 이 감사 결과는 해당 Phase 시점의 코드와 의존성을 대상으로
> 한다. 현재 RC의 신규 local import/refresh, compare, judgment, export,
> IDE, AI preview 표면과 release blocker는
> [SECURITY](../../SECURITY.md) 및
> [ADDITIONAL_FEATURES](../../ADDITIONAL_FEATURES.md)를 우선한다.

Date: 2026-08-14
Branch: `feature/phase1-security-fixes`
Mode: audit-first. CRITICAL/HIGH fixed in this PR. LOW reported only.

## Controls verified (no finding)

| Control | Result |
|---|---|
| TOKEN_ENC_KEY 32-byte fail-fast, unique GCM nonce, key_version | Pass |
| Spring Session Redis, CSRF cookie+header, SameSite=Lax, prod Secure | Pass |
| CORS allowlist only; wildcard rejected when credentials=true | Pass |
| `VITE_*` secrets | Pass (no `VITE_` matches in frontend source) |
| Token not in DTO / error bodies / SSE payloads | Pass (PAT 400 test already asserts no echo) |
| SSRF: import only `https://github.com/{owner}/{repo}` | Pass (`RepoRefTest`) |
| Path traversal on `file-content` (`..`, absolute, `%2e`) | Pass; symlink escape test added |
| Clone path confined to `${DATA_DIR}/repos/{projectId}` | Pass (`GitCloneService.requireUnderReposRoot`) |
| `/api/**` 401 by default; project APIs `findByIdAndUserId` | Pass; PUT `/area-selections` IDOR test added |
| Clone tree never executed (`ProcessBuilder`/`Runtime.exec` absent) | Pass |
| Loopback bind `server.address=127.0.0.1` | Pass |

## CRITICAL / HIGH — fixed

| ID | Sev | Finding | Fix |
|---|---|---|---|
| D1 | CRITICAL | GitHub Dependabot: fixture `package.json` declared `vitest ^1.3.0` (GHSA-5xrq-8626-4rwp). Fixtures are never installed/executed, but the dependency graph still flagged default-branch manifests. | `react-mini` and `fullstack-mini/frontend` → `vitest ^3.2.6`, `vite ^6.4.3` |
| D2 | HIGH | Same fixtures: `vite ^5.1.0` (Windows `server.fs.deny` bypass GHSA-fx2h-pf6j-xcff and related). | Same bump |
| H1 | HIGH | Unauthenticated `POST /api/auth/pat` forwarded every token to GitHub with no throttle (credential stuffing / GitHub-oracle). | `PatLoginRateLimitFilter` after CSRF; default 20 / 60s (`app.auth.pat-login-*`) |
| H2 | HIGH | Evidence excerpts stored the first ~80 characters of config files, including `password:` / PAT-shaped values. | `SecretMask` at `EvidenceService.insertStatic` |
| H3 | HIGH | `@monaco-editor/react` default loader pulls Monaco from jsDelivr; a compromised CDN could run in a view that displays private source. | `loader.config({ monaco })` with the npm `monaco-editor` package |

After this PR: application CRITICAL/HIGH = 0. Dependabot default-branch C/H should close once GitHub re-scans the fixture manifests.

`npm audit` on `/frontend` (post-P10 lockfile): 0 critical, 0 high (1 low, 1 moderate — DOMPurify / similar, not in C/H scope).

## LOW (report only — not fixed)

| ID | Finding | Why LOW | Disposition |
|---|---|---|---|
| L1 | `GET /v3/api-docs` and swagger-ui remain `permitAll` (used by `npm run gen:api`) | Local loopback bind; docs have no tokens; codegen needs it | Keep public until a dedicated codegen auth story |
| L2 | No log-capture test that tokens never appear in logs | Code review: GithubApiClient logs only rate-limit headers; credential `toString` masked | Add when a log-test harness exists |
| L3 | Job retry: step reset and mark-queued share one transaction, but concurrent retry vs enqueue still relies on the partial unique index | Index is the real guard; order is already inside `transactionTemplate` | No change |
| L4 | Project delete: DB row removed then clone dir deleted; a crash can leave an orphan directory under repos root | Orphan is still path-checked; no data leak to other users | Phase 2: after-commit cleanup job |
| L5 | `RepoRef` allows a lone `.` segment and does not case-fold owner/name | GitHub rejects `.`; duplicate imports differ only by case | Optional harden later |
| L6 | SSE emitters: timeout calls `complete()`; `onCompletion` removes. Residual leak if complete throws before callback | `@PreDestroy` completes remaining emitters; 30m timeout | Monitor |
| L7 | DOMPurify transitive (monaco/jsdom stack) medium/low GHSA | Not used to sanitize attacker HTML in this app | Dependabot weekly |
| L8 | Vite launch-editor NTLM (dev-only, Windows) | Dev dependency, not production bundle | Ignore for Phase 1 runtime |

## Public surface (threat model notes)

- **OAuth callback** — Spring OAuth2 + state; success redirects to configured FE origin only.
- **PAT register** — CSRF + rate limit; token never in response.
- **SSE** — `getOwnedJob` before subscribe; snapshot/update are job DTOs without credentials.
- **File serving** — owner scope, inventory path match, `toRealPath` jail, size/binary guards.

## Out of scope

GitHub secret scanning / gitleaks CI waits for public-repo conversion (기획서 §18 ⑤).
