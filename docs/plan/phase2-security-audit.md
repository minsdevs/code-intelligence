**Languages:** English | [한국어](phase2-security-audit.ko.md)

# Phase 2 security audit (task 2-12)

> **역사 문서:** 이 감사 결과는 해당 Phase 시점의 코드와 의존성을 대상으로
> 한다. 현재 RC의 신규 local import/refresh, compare, judgment, export,
> IDE, AI preview 표면과 release blocker는
> [SECURITY](../../SECURITY.md) 및
> [ADDITIONAL_FEATURES](../../ADDITIONAL_FEATURES.md)를 우선한다.

Date: 2026-08-14
Branch: `feature/phase2-ui` (audit of P1 sidecar + P2 APIs + this UI)
Mode: audit-first. **CRITICAL/HIGH = 0** — no `feature/phase2-security-fixes` PR.

## Controls verified (no finding)

| Control | Result |
|---|---|
| Sidecar bind `127.0.0.1:3040` (compose: service name) | Pass (`TS_ANALYZER_HOST` default) |
| `POST /analyze` JSON body cap 10MB | Pass (`json({ limit: '10mb' })`) |
| Analyze path: relative only, reject `..`, NUL, absolute, Windows drive | Pass (`assertSafeRelativePath` + vitest) |
| Per-file content cap 1 MiB | Pass (`assertContentSize`) |
| Sidecar does not execute clone code (ts-morph in-memory / heuristics) | Pass |
| `app.ts-analyzer.base-url` SSRF allowlist: loopback or hostname `ts-analyzer`; no userinfo; http(s) only | Pass (`TsAnalyzerProperties` + unit tests) |
| RestClient: connect timeout, read timeout, **no redirects** | Pass |
| Blank base-url → TS_PARSING empty DONE (no outbound call) | Pass |
| New GETs (`/flows`, `/findings`, `/impact`, `/eras`, `/features`) use `findByIdAndUserId` | Pass |
| Impact `nodeId` must belong to the owned snapshot; depth clamped 1–8 | Pass |
| Frontend: no `dangerouslySetInnerHTML`; evidence/finding text is React text nodes | Pass |
| No `VITE_*` secrets | Pass |
| Clone tree never executed | Pass (unchanged) |

## CRITICAL / HIGH

None.

GitHub Dependabot open alerts on default branch: 4 × `dompurify` (**medium/low** only). Application C/H = 0.

## LOW (report only — not fixed)

| ID | Finding | Why LOW | Disposition |
|---|---|---|---|
| L1 | Sidecar `POST /analyze` has no auth | Loopback bind; only the backend RestClient is the caller; compose network is internal | Keep; do not publish the port |
| L2 | `InetAddress.getByName` on a non-allowlisted host that currently resolves to loopback would pass | base-url is operator config, not user input | Keep allowlist of names; no change |
| L3 | DOMPurify transitive (monaco/jsdom) medium/low GHSAs | Not used to sanitize attacker HTML | Dependabot weekly; same as Phase 1 L7 |
| L4 | `GET /health` on the sidecar is unauthenticated | Liveness only; no data | Keep |

## Public surface (Phase 2 additions)

- **ts-analyzer** — not on the public SPA origin. Backend-only.
- **Flows / Findings / Impact / Eras** — session cookie + project ownership; missing project → 404 (same IDOR posture as Phase 1).
- **Architecture `area=FRONTEND`** — same controller as BACKEND/SYSTEM.

## Out of scope

AI / embeddings (Phase 3). Notes / Tasks (Phase 4). GitHub secret scanning CI still waits for public-repo conversion.
