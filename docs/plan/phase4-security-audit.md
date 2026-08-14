# Phase 4 security audit (task 4-10)

Date: 2026-08-14  
Branches: `feature/phase4-notes-tasks` (PR #26, merged) + `feature/phase4-ui`  
Mode: audit-first. **CRITICAL/HIGH = 0** — no `feature/phase4-security-fixes` PR.

## Controls verified (no finding)

| Control | Result |
|---|---|
| Notes/Tasks/Search/task-draft use `findByIdAndUserId` or `projects.user_id`; other user's project → 404 (notes/tasks/draft) or empty groups (search) | Pass (integration tests) |
| Note body stored after `SecretMask.redact`; never rendered as HTML (`textarea` + ref chips, no `dangerouslySetInnerHTML`) | Pass |
| Task title/description/goals/learning records SecretMask | Pass |
| AI task draft: blank key → 503; origin=AI status=DRAFT until `POST .../approve`; default list and search omit DRAFT | Pass |
| `TaskGenerationService` stays in `ai` package; ArchUnit: `AIProvider` not referenced outside `dev.codeintelligence.ai..`; no `task`↔`ai` package cycle | Pass |
| Search LIKE wildcards escaped; FTS `plainto_tsquery`; owner-scoped joins | Pass |
| Search does not inject `AIProvider` (uses `SummaryService.similar`, empty when AI disabled) | Pass |
| Settings UI still has no API-key fields; keys env-only | Pass |
| Clone tree never executed | Pass (unchanged) |
| Frontend: no markdown HTML renderer; note XSS payload stays in textarea | Pass (notes.test) |

## CRITICAL / HIGH

None.

GitHub Dependabot open alerts on default branch: 4 × `dompurify` (**medium/low** only). Application C/H = 0.

## LOW (report only — not fixed)

| ID | Finding | Why LOW | Disposition |
|---|---|---|---|
| L1 | `GET /api/search?projectId=` of another user's project returns empty groups instead of 404 | Does not confirm existence beyond "no hits"; avoids leaking note/task titles | Keep |
| L2 | Unresolved note refs store `subject_id` null (raw target kept) | Owner-scoped; SecretMask already applied to body | Keep |
| L3 | DOMPurify transitive (monaco/jsdom) medium/low GHSAs | Not used to sanitize attacker HTML; notes are not HTML | Dependabot weekly; same as Phase 3 L3 |
| L4 | Tasks UI fetches `includeDrafts=true` so authors see AI drafts | Drafts remain unlisted on default API and search | Keep |

## Public surface (Phase 4 additions)

- `GET/POST /api/projects/{id}/notes`, `GET/PUT/DELETE .../notes/{noteId}` — session + ownership; CSRF on writes.
- `GET/POST /api/projects/{id}/tasks`, get/update/approve/goals/records/delete — session + ownership; CSRF on writes.
- `POST /api/projects/{id}/findings/{findingId}/task-draft` — session + ownership + AI configured; CSRF.
- `GET /api/search?q=&projectId=` — session; results limited to the caller's projects.

## Out of scope

PR Review, Playground, Growth reports, What-if (Phase 5). GitHub secret scanning CI still waits for public-repo conversion.
