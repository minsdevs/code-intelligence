# Phase 4 — Learning / Productivity 구현 계획

- 근거: `기획서.md` v1.2 (§6.2 Notes/Tasks, §14.1 TaskGeneration, §15.2–15.3, §16 Search, §17, §21 Phase 4)
- 불변 원칙: 사실은 정적 분석만 · AI 초안은 `origin=AI` + 승인 전 DRAFT · clone 코드 실행 금지 · 키는 env only
- **Phase 5 시작 금지** (PR Review / Playground / Growth 리포트 / What-if)

---

## 1. 목표 / 범위 / 비범위

**목표:** 프로젝트 Notes(마크다운 참조·역링크), Tasks(5타입+체크리스트+AI 초안 승인), 통합 Search(FTS+trgm+요약 벡터 hybrid), Notes/Tasks가 AI 컨텍스트에 포함되는 상태.

**범위:**

- `notes` / `note_references` — `@file` `@class#method` `@commit` `@task` `[[note]]`
- `tasks` / `task_goals` / `learning_records`
- Finding → LEARNING/REFACTORING Task 초안 (`origin=AI`, 승인 전 목록 미확정)
- `GET /api/search` 타입별 그룹, 소유 프로젝트만
- ContextRetrieval에 note/task 첨부
- Notes / Tasks / Search UI. Settings에 키 필드 추가 금지

**비범위:** Growth 리포트, PR Review, Playground, What-if (Phase 5)

---

## 2. PR 묶음

| PR | 브랜치 | task | 산출물 |
|----|--------|------|--------|
| P1 | `feature/phase4-notes-tasks` | 4-1~4-6 | V13, Notes/Tasks/Search API, AI draft, context |
| P2 | `feature/phase4-ui` | 4-7~4-9 | Notes/Tasks/Search UI, AI 칩/빠른질문 |
| 게이트 | 필요 시 | 4-10 → 4-11 | sc → verify |

---

## 3. Task 체크리스트

### 4-1 V13 스키마 — be

- [x] `pg_trgm`
- [x] `notes`, `note_references`, `tasks`, `task_goals`, `learning_records`
- [x] FTS/trgm 인덱스

### 4-2 Notes API — be

- [x] CRUD, 소유 프로젝트만, 본문 SecretMask
- [x] 저장 시 참조 파싱 → `note_references`
- [x] IDOR 404

### 4-3 Tasks API — be

- [x] 5타입, checklist, status, origin
- [x] USER 생성은 OPEN, AI 생성은 DRAFT
- [x] 승인 `POST .../approve` → OPEN
- [x] `learning_records` 추가

### 4-4 AI Task 초안 — be

- [x] `TaskGenerationService` (ai 패키지, AIProvider만 여기)
- [x] 키 없음 → 503. Mock 테스트. 승인 전 일반 목록에서 제외

### 4-5 Search — be

- [x] symbol/file/feature/flow/commit/PR/finding/note/task/evidence (+ summary hybrid)
- [x] 타입별 그룹, 소유 스코프

### 4-6 AI context — be

- [x] focused note/task + 파일에 걸린 note를 retrieval에 포함

### 4-7 Notes UI — fe

- [x] 목록+에디터, 참조 클릭 이동, placeholder 제거

### 4-8 Tasks UI — fe

- [x] 보드/목록, 체크리스트, Finding에서 초안 생성+승인

### 4-9 Search UI + AI 칩 — fe

- [x] `/search` 입력·그룹 결과. Task 빠른 질문 「현재 코드 기준으로 설명해줘」

### 4-10 sc — sc

- [x] IDOR, XSS(노트 HTML 미렌더), SecretMask, 검색 스코프
- [x] Dependabot C/H=0
- [x] `docs/plan/phase4-security-audit.md`

### 4-11 verify — verify

- [x] gradle / frontend / sidecar CI green
- [x] **Phase 5 시작 금지**
