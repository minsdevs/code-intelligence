# G-COST D4 redaction and PK-08 validation variant (w2-cost) — 2026-10-07

Scope: the two G-COST product decisions of 2026-10-07 recorded against
[cost-egress-matrix-2026-10-07.md](cost-egress-matrix-2026-10-07.md): **D4 / P-07** (user decision
"기본 마스킹": mask personal data by default) and **PK-08** (user decision "검증 빌드 전용 변형": a
validation-build-only fake-provider variant). Base `0e7e9a4`, branch `gate/w2-cost`. No paid call, real
provider key, real account, real Keychain or real profile was used. Release verdict stays **NO_GO**; this
report records facts, not a gate verdict. Evidence logs are under `validation/local/cost-redaction-pk08/`
(not committed).

## D4 — default personal-data masking

**Behaviour.** Every outgoing AI user prompt is now `PersonalDataMask.mask(SecretMask.redact(prompt))`.
The request plan builds its payload that way and its SHA-256 digest binds the binding that contains those
masked bytes, so the plan the user approves (`userPrompt`, shown verbatim in `AiPanel`) is exactly the
user message main sends; the read-only preview's `copyablePrompt` uses the same composition and is equal
to the plan's `userPrompt` (asserted). Context items whose content contains personal data report
`masked=true`. The same composition is applied at the What-if, Playground and PR-review prompt sites
(unreachable for sending today, `requireRequestPlan()` always throws), so no prompt site is left without it.
`SecretMask` is unchanged (no edit, not even additive); secret masking runs first and stays intact.

**Mask format.** `[EMAIL_n]`, `[PHONE_n]`, `[RRN_n]`, `[CARD_n]`, `[SSN_n]`. Numbering is per kind and per
call, in detection order (rule order, then left to right); the same value (normalised: lower-case e-mail,
digits only for numbers) gets the same placeholder within one request, so `010-2345-6789` and
`01023456789` are one person. Nothing of the value is kept (no hash, no suffix, no reversible token);
placeholders are never re-matched (idempotent). Matches never cross a line, so `file:path:line` evidence
references stay valid.

**Patterns** (`backend/src/main/java/dev/codeintelligence/ai/PersonalDataMask.java`):

| Kind | Detected | Extra check |
| --- | --- | --- |
| EMAIL | `local@domain.tld` (alphabetic TLD) | not after `scheme://` (URI userinfo); `git@host` SSH remotes excluded |
| RRN | `YYMMDD-Gxxxxxx` (G = 1–8) | valid birth date (century from G); unhyphenated 13 digits only if the pre-2020 check digit also holds |
| CARD | 13–19 digits, issuer prefix 2–6, contiguous or `4-4-4-x` / Amex `4-6-5` with one consistent space/hyphen | Luhn |
| SSN | `AAA-GG-SSSS` | area not 000/666/9xx, group not 00, serial not 0000 |
| PHONE | `+CC …` (E.164-style, 8–15 digits); Korean `01x`/area-code numbers with a consistent `-`/`.`/space separator, or an 11-digit `01x` run; North American `(NXX) NXX-XXXX` / `NXX-NXX-XXXX` / `NXX.NXX.XXXX` | digit count for `+` numbers |

All number rules require that the value is not glued to a letter, digit, `_`, `.`, `-`, `+` or `@`, so
identifiers (`user_01023456789`, `A010-…`), versions (`2.345.678.9012`), hashes, UUID tails, IPs, dates,
Java long literals (`4111111111111111L`) and npm specs (`lodash@4.17.21`) stay as they are.

**False-positive and coverage limits.** Pattern based only: names, postal addresses, birth dates, account
numbers and personal data written in other formats are **not** detected (the fixture name "Jane
Sentinel-Doe" is still sent). A Luhn-valid 13–19 digit number with prefix 2–6 written as a standalone token,
any `local@domain.tld` string (e.g. a service mailbox in config), any 11-digit `01x` number and any
`NXX-NXX-XXXX` number are masked even when they are not personal data. Phone numbers without a country
code outside Korea/North America are not detected. Prompt-injection text inside the approved span is still
sent as data (P-06, unchanged).

**What stays local and unmasked (existing design, unchanged).** Source files in the local source vault and
the retained file content; context blocks used to build the prompt in memory; the user's question stored in
`ai_messages.content` (with `SecretMask` only); AI evidence rows, which store only `file:path:line`
references. None of these leaves the app; the provider and the persisted assistant answer only ever see
the masked prompt. The privacy test still asserts that the personal-data sentinels are in no persisted
column and in no backend/main log.

## PK-08 — validation-build-only fake-provider variant

**Build-time selection.** The validation candidate is produced by
`validation/pre-release/build-candidate.cjs` with app id `dev.codeintelligence.desktop.validation` and
`extraMetadata.name = code-intelligence-validation` (the same identity `pack:mac:validation` uses).
The candidate config now also sets `extraMetadata.validationAiProviderOrigin = "http://127.0.0.1:47613"`,
which electron-builder writes into the packaged `package.json` inside `app.asar` (embedded asar integrity
fuse on). The build reads it back from the asar after packaging and records it in the build report.

**Runtime rule** (`desktop/src/ai-https-transport.cjs`, `validationProviderTarget`/`createProviderTransport`):
main passes its static `require('../package.json')` to the gateway (`buildMetadata`), and the gateway
composes `createProviderTransport(buildMetadata)` as its default transport. Without the key the transport
is the unchanged fixed `https://api.openai.com` HTTPS transport with public-DNS pinning. With the key it is
accepted only when the package name is `code-intelligence-validation` and the value is exactly
`http://127.0.0.1:<1024-65535>` or `http://[::1]:<port>`; anything else throws
(`AI provider build variant refused`) and the gateway does not open. The loopback transport keeps every
request check of the HTTPS transport (fixed origin/path in the core request, POST, no redirect/retry,
fixed headers, size and deadline limits, JSON 2xx only) and only changes delivery to `node:http` on the
literal loopback address with DNS lookup refused. The transport module reads no environment, argv, file
or Electron state; renderer, config files and user settings have no path to it.

**Release refusal.** `desktop/package.json` (release configuration) has no such key (boundary test). A
release-named package carrying the key is refused by the transport, by `openDesktopAiGateway` and by
`beforePack` (`requireValidationOnlyProviderVariant`: only app id `…desktop.validation` and only `dir`
targets may carry it; tested with synthetic contexts, not with a real electron-builder run).

**Runners.**
- Full stack (`AiCostEgressValidationProviderIntegrationTest`): Spring HTTP/CSRF → RequestPlan → Java ledger
  on Testcontainers PostgreSQL → real Node main whose gateway composes the transport from validation build
  metadata (no injected transport) → real loopback HTTP fake provider.
- Packaged (`validation/pre-release/cost-egress-packaged-ask.cjs`, new): verifies bundle/codesign/manifest,
  requires the packaged transport to equal the source and the packaged `package.json` to carry an accepted
  variant (else **BLOCKED**, exit 2, no launch); starts the fake provider on the build-time origin; launches
  the candidate with a fresh isolated profile and mock Keychain; imports a synthetic source with the D4
  personal-data fixtures through the UI; saves a synthetic key, configures and activates a budget, previews,
  approves one plan and asks once through the renderer's API authority; checks one provider request,
  sent prompt equal to the approved prompt, no personal data in preview/plan/wire, placeholders present,
  exact settlement 42 µUSD (daily/monthly, held 0), replay 409, and no non-loopback socket (4 `lsof`
  samples). Non-provider requests to the port (stray local probes) are answered 404 and recorded
  separately; one carrying a credential fails the run.

**Accepted validation-build variant limit.** PK-08 exercises the packaged ask flow, ledger and journal
path through the validation build's loopback transport. The release binary's endpoint path
(`https://api.openai.com`, TLS, public-DNS pinning) is not exercised by any packaged run; it remains
covered only by `ai-https-transport.test.cjs` (injected HTTPS/DNS doubles) and the boundary guard.

## Red / green

| Defect | Test | Red (before fix) | Green (after fix) |
| --- | --- | --- | --- |
| D4 / P-07 | `AiCostEgressPrivacyIntegrationTest` (C13 harness; fixture list extended with KR/intl phone, RRN, card; WYSIWYS and look-alike checks) | FAIL: `[personal data in the provider body] Expecting empty but was: [jane.sentinel@example.invalid, 078-05-1120, 010-2345-6789, +44 20 7946 0958, 900101-1234567, 4111 1111 1111 1111]` (`red-d4.log`) | PASS 1/1; observed `piiInProviderBody=[] piiInPreview=[] piiPersisted=[] piiLogged=[]` |
| D4 | `PersonalDataMaskTest` (6) | 4 FAIL / 2 pass with an identity stub (the two negative cases pass trivially) | 6/6 PASS |
| PK-08 | `ai-provider-variant.test.cjs` (5), `ai-egress-boundary.test.cjs` (8, two changed + one new rule) | 8 FAIL / 13 against the unchanged desktop sources (`red-pk08.log`) | 13/13 PASS |
| PK-08 | `AiCostEgressValidationProviderIntegrationTest` | new case (run 1 FAIL: a stray local `GET /` reached the ephemeral port before the ask; the fixture now answers non-provider requests 404 and records them separately) | PASS 1/1 (final run: 0 strays) |
| PK-08 | `main-runtime-gateway.test.cjs` new case, `build-candidate.test.cjs` new case, `cost-egress-packaged-ask.test.cjs` (3) | new | PASS |

Final reruns on `de75839` (Gradle `--offline cleanTest`; quiet-machine waits passed):

| Run | Result |
| --- | --- |
| Backend `dev.codeintelligence.ai.*` + `SecretMaskTest` + `ArchitectureTest` + `spotlessCheck` | **415/415 PASS**, 36 suites, 0 skip (`final-backend.log`, `final-backend-xml/`) |
| Desktop `ai-*.test.cjs`, `safety-journal`, `safety-lifecycle`, `main-runtime-gateway`, `update-service`, `electron-fuses`, pre-release `build-candidate` and `cost-egress-packaged-ask` tests | **858 PASS / 0 FAIL / 1 SKIP** (859; the skip is the opt-in real-PostgreSQL case) (`final-desktop.log`) |
| `cost-egress-packaged-ask.cjs` on retained candidate LA8ZS9 (native lock) | **BLOCKED** `PACKAGED_TRANSPORT_NOT_CURRENT_SOURCE` (candidate predates this change; not launched) — `validation/local/cost-egress-packaged-ask/ask-WBQNbr/result.json` |

## Changed product paths

- `backend/src/main/java/dev/codeintelligence/ai/PersonalDataMask.java` (new)
- `backend/src/main/java/dev/codeintelligence/ai/AiRequestPlanService.java`, `AiPreviewService.java`,
  `WhatIfService.java`, `PlaygroundService.java`, `CodeReviewService.java`
- `desktop/src/ai-https-transport.cjs`, `desktop/src/ai-desktop-gateway.cjs`, `desktop/src/main.cjs` (one argument)
- `desktop/scripts/desktop-build-gate.cjs`
- Validation: `validation/pre-release/build-candidate.cjs`, `validation/pre-release/cost-egress-packaged-ask.cjs` (new),
  `validation/pre-release/cost-egress-packaged-probe.cjs` (comment/reason text only)

## Limits

- D4 detection is pattern based (see limits above); it is a default safety net, not a guarantee that no
  personal data leaves the app.
- PK-08 has **not** run on a packaged app: LA8ZS9 predates the variant and this unit cannot build a
  candidate. Packaged acceptance is pending the next coordinator candidate built by `build-candidate.cjs`.
- The `beforePack` refusal is tested with synthetic electron-builder contexts; the `info.metadata` /
  `config.extraMetadata` field names were not observed in a real packaging run.
- Plain HTTP on loopback in the validation variant carries the synthetic key in clear text to the local
  fake provider; only validation builds can do this.
- The validation candidate can no longer reach the real provider at all (by design of the variant).

## Remaining

Build the next candidate with `build-candidate.cjs`, then run
`COORD/with-native-lock.sh <name> env -i … node validation/pre-release/cost-egress-packaged-ask.cjs --app <repo>/.native-product-<id>/Code\ Intelligence\ Validation.app`
(PK-08), rerun `cost-egress-packaged-probe.cjs` (PK-01…07; its PK-01 byte comparison already includes the
changed transport, gateway and main; only its header comment and `fakeProviderReason` text changed here) and P-02/P-07 evidence on that candidate. D2/D3, C16 and the independent
G-SEC review are unchanged.
