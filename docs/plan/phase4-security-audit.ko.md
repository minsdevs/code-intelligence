**언어:** [English](phase4-security-audit.md) | 한국어

# Phase 4 보안 감사 (작업 4-10)

> **역사 문서:** 이 감사 결과는 해당 Phase 시점의 코드와 의존성을 대상으로
> 한다. 현재 RC의 신규 local import/refresh, compare, judgment, export,
> IDE, AI preview 표면과 release blocker는
> [SECURITY](../../SECURITY.ko.md) 및
> [ADDITIONAL_FEATURES](../../ADDITIONAL_FEATURES.md)를 우선한다.

날짜: 2026-08-14
브랜치: `feature/phase4-notes-tasks` (PR #26, merge됨) + `feature/phase4-ui`
모드: 감사 우선. **CRITICAL/HIGH = 0** — `feature/phase4-security-fixes` PR 없음.

## 검증된 제어 항목 (finding 없음)

| 제어 항목 | 결과 |
|---|---|
| Notes/Tasks/Search/task-draft가 `findByIdAndUserId` 또는 `projects.user_id` 사용; 다른 사용자의 project → 404(notes/tasks/draft) 또는 empty group(search) | 통과 (integration test) |
| Note body는 `SecretMask.redact` 후 저장; HTML로 render하지 않음(`textarea` + ref chip, `dangerouslySetInnerHTML` 없음) | 통과 |
| Task title/description/goal/learning record에 SecretMask 적용 | 통과 |
| AI task draft: 빈 key → 503; `POST .../approve` 전까지 origin=AI status=DRAFT; default list와 search는 DRAFT 생략 | 통과 |
| `TaskGenerationService`가 `ai` package에 유지됨; ArchUnit: `AIProvider`는 `dev.codeintelligence.ai..` 밖에서 참조되지 않음; `task`↔`ai` package cycle 없음 | 통과 |
| Search LIKE wildcard escape; FTS `plainto_tsquery`; owner-scoped join | 통과 |
| Search가 `AIProvider`를 주입하지 않음(`SummaryService.similar` 사용, AI 비활성 시 empty) | 통과 |
| Settings UI에 여전히 API-key field 없음; key는 env-only | 통과 |
| Clone tree를 실행하지 않음 | 통과 (변경 없음) |
| Frontend: markdown HTML renderer 없음; note XSS payload가 textarea에 유지됨 | 통과 (notes.test) |

## CRITICAL / HIGH

없음.

GitHub Dependabot default branch open alert: `dompurify` 4개(**medium/low**만 해당).
애플리케이션 C/H = 0.

## LOW (보고만 함 — 수정하지 않음)

| ID | Finding | LOW인 이유 | 처리 |
|---|---|---|---|
| L1 | 다른 사용자의 project에 대한 `GET /api/search?projectId=`가 404 대신 empty group 반환 | "hit 없음" 외에는 존재를 확인하지 않음; note/task title leak 방지 | 유지 |
| L2 | 해결되지 않은 note ref가 `subject_id` null(raw target 유지)을 저장 | Owner-scoped; body에 이미 SecretMask 적용 | 유지 |
| L3 | DOMPurify transitive(monaco/jsdom) medium/low GHSA | attacker HTML sanitize에 사용하지 않음; note는 HTML이 아님 | Dependabot weekly; Phase 3 L3과 동일 |
| L4 | Tasks UI가 `includeDrafts=true`로 fetch하여 작성자가 AI draft를 봄 | Draft는 default API와 search에는 계속 표시되지 않음 | 유지 |

## 공개 표면 (Phase 4 추가 사항)

- `GET/POST /api/projects/{id}/notes`, `GET/PUT/DELETE .../notes/{noteId}` —
  session + ownership; write에 CSRF.
- `GET/POST /api/projects/{id}/tasks`, get/update/approve/goals/records/delete —
  session + ownership; write에 CSRF.
- `POST /api/projects/{id}/findings/{findingId}/task-draft` — session + ownership +
  AI configured; CSRF.
- `GET /api/search?q=&projectId=` — session; caller의 project로 result 제한.

## 범위 밖

PR Review, Playground, Growth report, What-if(Phase 5). GitHub secret scanning CI는
여전히 public-repo 전환을 기다립니다.
