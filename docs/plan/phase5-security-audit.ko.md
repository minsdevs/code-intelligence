**언어:** [English](phase5-security-audit.md) | 한국어

# Phase 5 보안 감사 (작업 5-10)

> **역사 문서:** 이 감사 결과는 해당 Phase 시점의 코드와 의존성을 대상으로
> 한다. 현재 RC의 신규 local import/refresh, compare, judgment, export,
> IDE, AI preview 표면과 release blocker는
> [SECURITY](../../SECURITY.ko.md) 및
> [ADDITIONAL_FEATURES](../../ADDITIONAL_FEATURES.md)를 우선한다.

날짜: 2026-08-14
브랜치: `feature/phase5-backend` (PR #29, merge됨) + `feature/phase5-ui`
모드: 감사 우선. **CRITICAL/HIGH = 0** — `feature/phase5-security-fixes` PR 없음.

## 검증된 제어 항목 (finding 없음)

| 제어 항목 | 결과 |
|---|---|
| Review / Playground / Growth / What-if가 `findByIdAndUserId` 사용; 다른 사용자의 project → 404 | 통과 (Phase5ApiIntegrationTest) |
| 없는 PR / review / playground session / graph node → 404 | 통과 |
| LLM input에 SecretMask 적용(PR body, playground question/snippet/title, what-if context) | 통과 |
| 선택 경로에 Playground `SafeRelativePath.normalize`; `../` → 400 | 통과 |
| Playground snippet은 text로만 저장; clone에 쓰지 않음; UI에 execute control 없음 | 통과 |
| Playground conversation은 main assistant thread가 아닌 session-scoped | 통과 |
| What-if는 Impact reverse-graph + AI narrative; clone tree의 process 실행 없음 | 통과 |
| Growth가 `AIProvider`를 사용하지 않음 | 통과 |
| `CodeReviewService` / Playground / What-if가 `ai` package에 유지됨; ArchUnit: `AIProvider`는 `dev.codeintelligence.ai..` 안에서만 사용; package cycle 없음 | 통과 |
| AI 비활성 → `AiNotConfiguredException`을 통해 503 | 통과 (ask와 같은 exception) |
| Evidence ref 검증; 깨진 ref → UNKNOWN | 통과 (공유 EvidenceValidator) |
| Settings UI에 여전히 API-key field 없음; key는 env-only | 통과 |
| Frontend: `dangerouslySetInnerHTML` 없음; review/playground/growth는 plain text render | 통과 |
| Review / playground / what-if에 daily token budget 적용 | 통과 (`AiUsageService`) |

## CRITICAL / HIGH

없음.

GitHub Dependabot default branch open alert: `dompurify` 4개(**medium/low**만 해당).
애플리케이션 C/H = 0.

## LOW (보고만 함 — 수정하지 않음)

| ID | Finding | LOW인 이유 | 처리 |
|---|---|---|---|
| L1 | Playground가 마지막 question/snippet/claim을 session row에 저장 | Owner-scoped; SecretMask 적용; 공유하지 않음 | 유지 |
| L2 | Review GET이 PR 없음과 review 없음 모두에 404 반환 | 같은 404 body; 다른 사용자의 PR을 leak하지 않음 | 유지 |
| L3 | DOMPurify transitive(monaco/jsdom) medium/low GHSA | attacker HTML sanitize에 사용하지 않음 | Dependabot weekly; Phase 4 L3과 동일 |
| L4 | What-if 설명은 static dependent에 대한 AI 해석 | Prompt가 실행을 주장하지 못하게 함; fact는 계속 Impact SQL에서 가져옴 | 유지 |

## 공개 표면 (Phase 5 추가 사항)

- `POST/GET /api/projects/{id}/pulls/{number}/review` — session + ownership;
  POST에 CSRF; AI configured.
- `GET/POST /api/projects/{id}/playground/sessions`, get/update/delete,
  `POST .../ask` — session + ownership; write에 CSRF.
- `GET /api/projects/{id}/growth` — session + ownership.
- `POST /api/projects/{id}/what-if` — session + ownership; CSRF; AI configured.

## 범위 밖

Phase 6. GitHub secret scanning CI는 여전히 public-repo 전환을 기다립니다.
