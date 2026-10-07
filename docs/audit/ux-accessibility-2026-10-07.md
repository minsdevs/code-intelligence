# G-UX accessibility, false-certainty review and scripted pilot — 2026-10-07

## Scope and result

This unit covers the part of release gate **G-UX** that does not need human
participants: accessibility measurements of the real packaged renderer, a
false-certainty review of the UI, a scripted (machine) pilot of outcomes U1–U6,
and the usability test kit for the eight-participant study. The gate itself is
**not** passed: its human-study rows are BLOCKED, and the packaged candidate
**1lvULq** shows open High false-certainty defects. Release verdict stays
**NO_GO**.

Branch `worktree-agent-a2ab4860a0424970f` from `bcd8081`. Evidence used the
unchanged candidate `.native-product-1lvULq` (buildSequence 1791292686000,
runtime-manifest SHA-256 `023a8c65…c85d`, app.asar SHA-256 `fe08c457…0acc`) with a
fresh synthetic automation profile, mock Keychain, no GitHub account and AI off.
Every launch ran under `with-native-lock.sh gate-ux`. Timing values in the evidence
are indicative only.

Matrix: **23 PASS, 21 FAIL, 4 NOT RUN, 6 BLOCKED** (54 rows).

## Product changes (invalidate candidate 1lvULq)

Each change has a test that fails against the `bcd8081` version of the file and
passes with the change (red check: the HEAD file was written back temporarily and
the ux tests run; logs `red-*.log`).

| Commit | Path | Defect (severity) |
|---|---|---|
| 38290e3 | `frontend/src/lib/relationConfidence.ts` (new) | Shared text verdict for CONFIRMED / LIKELY / POSSIBLE / unresolved. |
| 38290e3 | `frontend/src/features/projects/RepositoryNeighborhood.tsx` | Intro called LIKELY/POSSIBLE relations “확인된 정적 관계”; verdict column and edge labels showed raw enums (High: candidate stated as confirmed). |
| 38290e3 | `frontend/src/features/code/SymbolPanel.tsx` | Callers/callees labelled only POSSIBLE; LIKELY looked confirmed (High). |
| 38290e3 | `frontend/src/features/projects/RepositoryOverviewPage.tsx` | Link “확인된 흐름 따라가기” → “기록된 정적 흐름 따라가기” (High wording). |
| 38290e3 | `frontend/src/features/flows/FlowsPage.tsx` | Flow detail gave no hint that steps can be inferred; adds `flows.stepConfidenceNote` (High; partial mitigation of F5). |
| 38290e3, a41b4be | `frontend/src/lib/translations.ts` | `code.noRelations`, `analysis.noReverseDeps` read as absence/no impact (High); new `relation.confidence.*`, `flows.stepConfidenceNote`, `progress.announce*` keys (ko/en). |
| a41b4be | `frontend/src/features/import/ProgressStep.tsx` | No live region for a minutes-long analysis: a screen-reader user of U1 gets no progress (High for U1 with a screen reader, WCAG 4.1.3). Polite `role=status` exists only while the job runs; terminal states stay with the host/alert so nothing is announced twice. |

Tests: `frontend/src/features/ux/falseCertainty.test.tsx` (8 tests),
`frontend/src/features/ux/progressAnnouncements.test.tsx` (2 tests).
The first live-region version also announced completion and duplicated the
GitHub status region (`githubRecovery.test.tsx` failed: two `role=status`);
that was corrected before commit and the suite rerun (`targeted-vitest.log` keeps
the failing run, `targeted-vitest-final.log` the passing one).

## What ran

| Check | Command (cwd = worktree root) | Result |
|---|---|---|
| UX unit tests + touched components | `node frontend/node_modules/vitest/vitest.mjs run --config validation/pre-release/frontend-regression.config.mjs src/features/ux src/features/import src/features/flows src/features/projects src/features/code src/features/analysis src/lib` | 22 files, 188 tests passed |
| Red check per product file | same config, `src/features/ux`, with `git show bcd8081:<path>` written back | SymbolPanel 1, FlowsPage 1, ProgressStep 1, RepositoryNeighborhood 1, RepositoryOverviewPage 1, translations 6 failing tests; all restored |
| Frontend typecheck | `cd frontend && node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit` | exit 0 |
| Runner unit tests | `node --test validation/pre-release/test/ux-accessibility.test.cjs` | 7/7 pass |
| Packaged pilot + a11y (full) | `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C /Users/minseokchae/.herdr/worktrees/code-intelligence/worktree-calm-meadow-7229/validation/local/coordination/with-native-lock.sh gate-ux node validation/pre-release/ux-accessibility-pilot.cjs --app "$PWD/.native-product-1lvULq/Code Intelligence Validation.app"` | `ux-X7CBXO` COMPLETED, 0 step errors, 190 states, 3 launches |

Earlier records kept next to it: `ux-JpYJjy` (full run, U1 keyboard exploration
failed because the runner tabbed before the lazy relation panel had rendered),
`ux-rKSIO6` and `ux-22Thfl` (`--stages u1` diagnostics), `ux-Ii3eNI` (`--stages u1`
after the runner fix 9ac44e6, COMPLETED). The runner change only waits for the
panel's first control and names unreached targets; it lowers no limit.

## Requirement matrix

| ID | Area | Requirement | Status | Evidence | Note |
|---|---|---|---|---|---|
| G1 | Gate | 8 participants (≥2 per level, mixed Java/web/Python); ≥7/8 complete U1–U4 unaided | **BLOCKED** | docs/release/usability-test-kit/ | Needs 8 recruited human participants and a moderator; kit delivered. |
| G2 | Gate | Zero participants with a serious 'inference taken as confirmed fact' error | **BLOCKED** | usability-test-kit/02 probes Q1–Q7 | Needs human sessions. |
| G3 | Gate | Zero serious data/permission errors | **BLOCKED** | usability-test-kit/03 | Needs human sessions. |
| G4 | Gate | ≤15 min per task (excl. first analysis); median screen→evidence ≤60 s | **BLOCKED** | usability-test-kit/03 timing fields | Needs human sessions; pilot timings are indicative only and not acceptance numbers. |
| G5 | Gate | On failure fix and retest with new tasks | **BLOCKED** | usability-test-kit/03 retest rule; library-loans fixture | Depends on G1. |
| G6 | Gate | Forbidden substitute (headless API mock) not used for UX evidence | **PASS** | ux-X7CBXO | Pilot and a11y measurements ran on the unchanged packaged candidate 1lvULq. |
| A1 | A11y | Every interactive control reachable by Tab (55 full traversals, 190 states, ko/en, 980×700/1280×800/1440×900, 200% zoom) | **PASS** | ux-X7CBXO screens[].keyboard | unreachedCount 0 on every traversed state. |
| A2 | A11y | No keyboard trap | **PASS** | ux-X7CBXO | trap null on all 55 traversals. |
| A3 | A11y | U1 import → overview → search → relation → snapshot source operable keyboard-only | **PASS** | ux-X7CBXO, ux-Ii3eNI pilot.U1 | OS folder picker result supplied by a controlled single-use stub of dialog.showOpenDialog; picker UI itself not driven. |
| A4 | A11y | Graph navigation: nodes/edges named and focus visible | **FAIL** | ux-X7CBXO focusableWithoutRole/noVisibleIndicator | React Flow nodes are focusable unnamed 'group's; edges are named 'Edge from 79 to 22' (database ids) and have no visible focus indicator (overview-neighborhood, neighborhood-*, architecture, ai-panel). Medium: a keyboard table alternative exists (A5). |
| A5 | A11y | Table/list alternative to the relation graph | **PASS** | ux-X7CBXO overview-neighborhood; falseCertainty.test.tsx | '선택 주변 관계 표' reachable and operable by keyboard. |
| A6 | A11y | Visible focus indicator with ≥3:1 ring contrast on all other controls | **PASS** | ux-X7CBXO lowContrastRing 0 | Only React Flow edges lack an indicator (counted in A4). |
| A7 | A11y | Dialog focus trap and focus return | **NOT RUN** | source review | The renderer has no modal dialogs (confirmations are inline); native macOS dialogs (recovery prompt, folder picker) are outside Chromium measurement. VoiceOver sheet V15. |
| A8 | A11y | Accessible names/roles/states of interactive controls (AX tree) | **PASS** | ux-X7CBXO ax.unnamedInteractive | 0 unnamed interactive controls; graph-node groups counted in A4. |
| A9 | A11y | Landmarks and headings | **FAIL** | ux-X7CBXO ax | Exactly one main everywhere (PASS); no h1 on 'projects'; skipped heading levels on analysis, analysis-impact-cancel, import-connect, import-preview. Low. |
| A10 | A11y | Text contrast WCAG 2.1 AA from computed colours | **FAIL** | ux-X7CBXO dom.contrast | 2,400 failing text elements across 190/190 states. Main pair --color-ink-faint #64646e on surfaces 2.40–3.09:1; also #6a7282 (3.73), #4a5565 (2.39), #e06c75 on #2b2b33 (4.39), Monaco #cc6666 (4.49). Medium, open. |
| A11 | A11y | Long-running analysis progress perceivable via live region | **FAIL** | ux-X7CBXO pilot.U1 progress-announcements=[]; progressAnnouncements.test.tsx | Candidate exposes no progress announcement. Fixed in source a41b4be (unit-tested red/green); not in any packaged candidate yet. |
| A12 | A11y | Focus placement after folder pick, preview and analysis completion | **FAIL** | ux-X7CBXO pilot.U1 focusAfter | Focus falls to <body> after folder selection, after the preview renders (no announcement) and on the overview after completion. Medium, open. |
| A13 | A11y | Cancellation announced as status | **PASS** | ux-X7CBXO pilot.U5 cases[0].cancelAnnouncedAsStatus | Packaged. |
| A14 | A11y | Errors announced as alerts | **NOT RUN** | existing unit tests syntaxFailure/progressResponses (role=alert) | No failing analysis was provoked on the packaged app in this unit. |
| A15 | A11y | Step and file states carried by text, not colour alone | **PASS** | progressAnnouncements.test.tsx; falseCertainty.test.tsx; ux-X7CBXO import-progress text | Pipeline states '완료/진행 중/대기/실패' and file outcomes in text. |
| A16 | A11y | 200% zoom without horizontal page scroll / clipping | **FAIL** | ux-X7CBXO 640×400@2 | No horizontal page scroll on 44 zoomed states (PASS part); clipped h2 'Impact' (analysis) and 'Files' (playground), clipped graph labels. Low. |
| A17 | A11y | prefers-reduced-motion respected | **PASS** | ux-X7CBXO pilot.motion | 0 moving elements under reduce on 4 screens. |
| A18 | A11y | Document language matches UI language | **FAIL** | ux-X7CBXO dom.lang | <html lang> stays 'ko' on 91/91 English states; English mode still contains Hangul text on 91/91 states (hard-coded Korean). Medium for English screen-reader users, open. |
| A19 | A11y | Light and dark themes | **NOT RUN** | ux-X7CBXO pilot.motion.lightSchemeRequest | Not applicable: one dark palette only; a light-scheme request keeps the dark palette. |
| A20 | A11y | Real VoiceOver speech | **BLOCKED** | usability-test-kit/04-voiceover-manual-check.md | Needs a human listener (30-minute sheet). |
| A21 | A11y | No pointer-only controls | **PASS** | ux-X7CBXO dom.pointerOnly | 0. |
| F1 | False certainty | Selected-code neighbourhood must not call inferred relations confirmed | **FAIL** | ux-X7CBXO pilot.U3/U4 neighborhood text; falseCertainty.test.tsx | Candidate says '확인된 정적 관계에 따른 검토 후보' while all FE hops are LIKELY and verdicts show raw enums. High. Fixed in source 38290e3 (text verdicts, wording); needs a new candidate. |
| F2 | False certainty | Code explorer callers/callees label inferred relations | **FAIL** | falseCertainty.test.tsx (red on HEAD) | HEAD labels only POSSIBLE ('· possible'); LIKELY looked confirmed. High. Fixed in source 38290e3. |
| F3 | False certainty | Empty relation/impact results never read as absence | **FAIL** | falseCertainty.test.tsx (red on HEAD) | 'No reverse dependencies.' / '역방향 의존이 없습니다.' / 'No {title}'. High. Fixed in source 38290e3. |
| F4 | False certainty | Overview link does not call static flows confirmed | **FAIL** | falseCertainty.test.tsx (red on HEAD) | '확인된 흐름 따라가기 →' → '기록된 정적 흐름 따라가기 →'. Fixed in source 38290e3. |
| F5 | False certainty | Flow path shows per-step verdict and an 'inferred included' badge | **FAIL** | ux-X7CBXO pilot.U3.ui.flow | Flow steps carry no confidence in the API; candidate shows none (showsInferredBadge false) although FE→API hops are LIKELY. Source 38290e3 adds a visible note only; per-step verdict needs a backend+UI change. High, open. |
| F6 | False certainty | Impact separates confirmed reverse dependency / candidate impact / outside analysis; no duplicates; no cumulative score | **FAIL** | ux-X7CBXO pilot.U4 | OrderService.cancel: 36 rows for 12 unique nodes (24 duplicate rows), riskScore 41 'HIGH' accumulated over duplicate paths, dependents carry no confidence, no out-of-analysis area. High, open (backend ImpactService + AnalysisPage). |
| F7 | False certainty | Truncated neighbourhood visibly incomplete | **PASS** | falseCertainty.test.tsx | Status '관계 조회 한도에 도달했습니다'. |
| F8 | False certainty | Legacy/unmeasured coverage never shown as a completeness percentage | **PASS** | falseCertainty.test.tsx; coverageHonesty.test.tsx |  |
| F9 | False certainty | File outcomes (success/partial/unsupported/legacy unmeasured) in text | **PASS** | falseCertainty.test.tsx |  |
| F10 | False certainty | README/run commands presented as documentary claims | **PASS** | falseCertainty.test.tsx |  |
| F11 | False certainty | Import preview does not read as analysis success | **PASS** | ux-X7CBXO pilot.U2 previewTextSample | '가져오기 선택 결과이며 분석 성공·완료를 뜻하지 않습니다'. |
| F12 | False certainty | Snapshot status 'Completed/분석 완료' on partial results | **FAIL** | translations projects.statusReady, analysis.status.DONE | Shown for a snapshot with PARTIAL/UNSUPPORTED files. Medium, open; proposed '분석 종료 · 범위 확인 필요' / 'Analysis finished · check coverage'. |
| F13 | False certainty | Area detection confidence not shown as a probability | **FAIL** | AreasStep.tsx progressbar aria-valuenow pct | Area confidence rendered as a 0–100% progressbar ('… confidence'). Medium, open (GitHub import path). |
| F14 | False certainty | AI claim confidence not colour-coded as confirmed | **FAIL** | PlaygroundPage.tsx text-ok for every claim | Every claim confidence in green regardless of value; text enum present. Low, open (AI off by default). |
| F15 | False certainty | Empty feature/flow link lists worded as not found | **FAIL** | translations features.noLinks/features.empty/flows.empty | '연결된 노드가 없습니다' etc. Low, open. |
| P1 | Pilot | U1 local import and exploration without network or login | **PASS** | ux-X7CBXO pilot.U1 | Keyboard-only; first analysis DONE. |
| P2 | Pilot | U1 egress: no outbound request during local import/explore | **PASS** | ux-X7CBXO egress | Renderer and Electron-session requests only to the app origin (451/452 in U1). Sockets of the owned tree: loopback only; 48+2 java TCP samples to '::127.0.0.1' (loopback in IPv4-compatible form, conservatively classified external by the runner, state CLOSED). Observed java UDP and one TCP listening on all interfaces (hand to G-SEC). Not observed: DNS, processes outside the owned tree, kernel-level egress. |
| P3 | Pilot | U2 preview shows included/excluded with reasons and bytes | **PASS** | ux-X7CBXO pilot.U2 | 19 files, 7,330 bytes, SECRET_PATH 1, GENERATED_DIRECTORY 1 shown in text. |
| P4 | Pilot | U2 per-language expected depth and scope reduction from the preview | **FAIL** | ux-X7CBXO pilot.U2 | Neither shown nor offered in the preview. Medium product gap, open. |
| P5 | Pilot | U3 screen → HTTP call → handler → service → entity/table with evidence | **FAIL** | ux-X7CBXO pilot.U3 | Endpoint, handler, service and repository reached in the flow with keyboard-openable sources; entity/table not reached by the relation walk; verdicts per step missing (F5). |
| P6 | Pilot | U4 confirmed vs candidate vs outside-analysis impact | **FAIL** | ux-X7CBXO pilot.U4 | See F6. |
| P7 | Pilot | U5 cancel during initial import (wizard, keyboard) | **PASS** | ux-X7CBXO pilot.U5 cases[0] | Job CANCELLED; announced as status. |
| P8 | Pilot | U5 cancel during re-analysis from the workspace | **FAIL** | ux-X7CBXO pilot.U5 cases[1] | Workspace offers no cancel control (cancelled via the job API instead); last snapshot, note and task retained. Medium, open. |
| P9 | Pilot | U5 graceful quit and Electron-owner SIGKILL during re-analysis keep last snapshot, notes, tasks | **PASS** | ux-X7CBXO pilot.U5 cases[2,3] | Job FAILED after relaunch, snapshot #1 current, note/task visible; 0 owned processes left after SIGKILL. |
| P10 | Pilot | U5 update failure recovery | **NOT RUN** | — | No update package/feed in this environment; out of this unit's reach. |
| P11 | Pilot | U6 without GitHub and without an AI key | **PASS** | ux-X7CBXO pilot.U6 | Settings show not connected and AI off; AI submit sent 0 app requests; U1 completed, U3/U4 recorded. |
| K1 | Kit | Usability test kit (Korean) with English summary and VoiceOver sheet | **PASS** | docs/release/usability-test-kit/ | Recruitment, screener, consent/data handling, fixtures, script, probes, observation sheet, severity, workbook, retest rule, VoiceOver sheet. |

## False-certainty findings with proposed wording (open)

| Screen | Key / location | Current | Proposed |
|---|---|---|---|
| Analysis → Impact | `ImpactService.impact`, `AnalysisPage` dependents list | Flat list without verdict, duplicates per path, risk score summed over paths | Deduplicate by node (shortest path), carry min-confidence of the path, three groups “정적 의존 확인 / 추정 영향 / 분석 밖”, score per unique node; label “정적 관계 기반 참고 점수 (위험 확률 아님)”. |
| Flows → detail | flow step API + `FlowsPage` | No per-step verdict | Add step `confidence`; badge “추정 포함” on the path when any step is not CONFIRMED. |
| Projects list / job status | `projects.statusReady`, `analysis.status.DONE` | “분석 완료 / Completed” | “분석 종료 · 범위 확인 필요 / Analysis finished · check coverage” when coverage is partial or unmeasured. |
| Import → areas | `AreasStep` progressbar | “{area} confidence” 0–100 % | Text tier (“근거 많음 / 일부 / 약함”) without percent. |
| Playground / AI | `PlaygroundPage` claim confidence | Always green | Use `relationConfidenceLabel` text and neutral colour for non-CONFIRMED. |
| Features / Flows | `features.noLinks`, `features.empty`, `flows.empty` | “연결된 노드가 없습니다” etc. | “기록된 연결 없음 · 연결이 없다는 증거는 아닙니다”. |
| Review | `ReviewPage` comment confidence | Raw enum | Same text verdicts as relations. |

## Accessibility findings (open, with patch plan)

- **Contrast (Medium)**: raise `--color-ink-faint` from `#64646e` to at least
  `#8e8e98` (4.82:1 on surface-2, 5.57:1 on surface-0) and stop using it on
  surface-3, or reserve it for disabled text; replace Tailwind `gray-500/600`
  text (#6a7282, #4a5565) with `ink-muted`.
- **Graph (Medium)**: give React Flow nodes `aria-label` = name + file, edges
  `aria-label` = “source → target · edge type · verdict”, and a visible focus
  style for `.react-flow__edge:focus-visible`; or make the graph
  `aria-hidden` + non-focusable and keep the table as the keyboard path.
- **Focus management (Medium)**: move focus to the preview heading after the
  folder is chosen and the preview loads; focus the overview `h1` after analysis
  completes; announce the relation panel when it opens.
- **Language (Medium)**: set `document.documentElement.lang` from the i18n
  provider; move hard-coded Korean strings in overview/neighborhood/settings into
  `translations.ts`.
- **Headings/zoom (Low)**: add an `h1` on Projects, remove level skips, let the
  `h2` headers of Analysis/Playground wrap at 200 %.
- **Workspace re-analysis cancel (Medium)**: expose the existing job-cancel
  action next to “Analyzing…” in the workspace header.
- **U2 preview (Medium)**: show per-language file counts/expected depth and a
  scope-narrowing action in the preview.

## Limits

- Chromium accessibility tree and keyboard events, not VoiceOver output; native
  macOS dialogs and the OS folder picker UI were not driven (a single-use stub of
  `dialog.showOpenDialog` returned the fixture path).
- Egress observation covers the renderer, the Electron default session and
  periodic `lsof` of the owned process tree; it does not see DNS, other processes
  or kernel-level traffic. The runner classifies `::127.0.0.1` conservatively as
  external; every such sample was that loopback form.
- Source fixes are unit/JSDOM evidence only; no packaged candidate contains them.
- One theme exists; light/dark comparison not applicable.
- Timing numbers in `result.json` are indicative (machine shared with other units).

## Remaining conditions for G-UX

1. Build a new candidate containing 38290e3 and a41b4be; rerun the pilot
   (`ux-accessibility-pilot.cjs`) on it.
2. Fix F5/F6 (flow step verdicts; impact dedupe, verdicts, three groups) — backend
   and UI; G-ACCURACY owns duplicate-impact semantics.
3. Fix the open Medium accessibility findings above or accept them explicitly.
4. Run the 8-participant study with the kit, plus the 30-minute VoiceOver sheet;
   score with `scoring-workbook.csv`; retest with `library-loans` on failure.

## Evidence

`validation/local/pre-release-ux/` — `ux-X7CBXO` (primary), `ux-Ii3eNI`,
`ux-JpYJjy`, `ux-rKSIO6`, `ux-22Thfl`, and `frontend-ux-20261007` (vitest, red-check,
tsc, node-test and runner logs). SHA-256 values are in the JSON ledger.
