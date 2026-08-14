# Phase 5 — Advanced 구현 계획

- 근거: `기획서.md` v1.2 (§14.1 CodeReviewService, §18 clone 비실행, §21 Phase 5)
- 불변 원칙: 사실은 정적 분석만 · AI 해석은 `origin=AI` · evidence 깨지면 UNKNOWN · clone 코드 실행 금지 · 키는 env only · IDOR는 `findByIdAndUserId` · SecretMask · ArchUnit(`AIProvider`는 `ai` 패키지)
- **Phase 6 시작 금지**

---

## 1. 목표 / 범위 / 비범위

**목표:** PR Review(정적 findings + AI), Playground(실행 없는 격리 탐색), Growth(학습 기록 리포트), Production What-if(Impact 역그래프 + AI 설명).

**범위:**

- `CodeReviewService` — 변경 파일 + findings를 컨텍스트로 리뷰 생성·조회. `origin=AI`
- Playground — 파일 선택 + 가설 스니펫(텍스트만) + 격리 ask. **clone/스니펫 실행 없음**
- Growth — `learning_records` / LEARNING·REFACTORING tasks / notes / findings 집계. AI 불필요
- What-if — 기존 Impact API + AI 서술. 런타임 시뮬 없음
- Review / Playground / Growth UI. Analysis에 What-if. Settings에 키 필드 추가 금지

**비범위:** clone 빌드/실행 샌드박스, 튜터 코스웨어, 런타임 부하 시뮬, Phase 6

---

## 2. PR 묶음

| PR | 브랜치 | task | 산출물 |
|----|--------|------|--------|
| P1 | `feature/phase5-backend` | 5-1~5-5 | 본 문서, V14, Review/Playground/Growth/What-if API |
| P2 | `feature/phase5-ui` | 5-6~5-9 | Review / Playground / Growth UI, Analysis What-if, AI 칩 |
| 게이트 | 필요 시 `feature/phase5-docs` | 5-10 → 5-11 | sc → verify |

---

## 3. Task 체크리스트

### 5-1 V14 스키마 — be

- [x] `pr_reviews`, `pr_review_comments`
- [x] `playground_sessions` (selected_paths, proposed_snippet, last Q&A). 스니펫은 텍스트만

### 5-2 PR Review — be

- [x] `CodeReviewService` (`ai` 패키지, JDBC — history 패키지 사이클 금지)
- [x] `POST/GET /api/projects/{id}/pulls/{number}/review`
- [x] 변경 파일(`commit_files` @ head_sha) + findings + PR 본문. SecretMask. 키 없음 → 503
- [x] evidence 검증. IDOR 404. Mock 테스트

### 5-3 Playground — be

- [x] 세션 CRUD + `POST .../ask`
- [x] 가설 스니펫은 CONTEXT로만 전달, 디스크에 쓰지 않음, 실행하지 않음
- [x] 메인 Assistant 대화와 분리. SecretMask. 경로 traversal 400

### 5-4 Growth — be

- [x] `GET /api/projects/{id}/growth` — 타입별 task, learning_records, notes, findings, 주간 집계
- [x] `AIProvider` 미사용. 소유 프로젝트만

### 5-5 What-if — be

- [x] `POST /api/projects/{id}/what-if` `{ nodeId, depth? }`
- [x] ImpactService 재사용 + AI 설명(claims). 코드 실행 없음

### 5-6 Review UI — fe

- [x] 워크스페이스 Review 탭: PR 목록, 리뷰 생성, claim/evidence → 코드 이동

### 5-7 Playground UI — fe

- [x] 파일 다중 선택, 스니펫 textarea, ask, claims. 실행 버튼 없음

### 5-8 Growth UI — fe

- [x] 카운트·주간·최근 학습 기록. 차트 라이브러리 추가 금지

### 5-9 What-if UI + AI 칩 — fe

- [x] Analysis Impact 패널에서 What-if. Review/Playground/Growth 빠른 질문

### 5-10 sc — sc

- [ ] IDOR, SecretMask, playground 비실행, 키 env-only
- [ ] Dependabot C/H=0
- [ ] `docs/plan/phase5-security-audit.md`

### 5-11 verify — verify

- [ ] gradle / frontend / sidecar CI green
- [ ] **Phase 6 시작 금지**
