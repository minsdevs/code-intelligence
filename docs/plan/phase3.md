# Phase 3 — AI 구현 계획

- 근거: `기획서.md` v1.2 (§4.4, §8 Indexing, §14, §15.1–15.3, §19, §21 Phase 3)
- 불변 원칙: 사실은 정적 분석만 · AI는 해석만 · evidence 없는 단정 금지 · **clone 코드 실행 금지** · 모델명은 설정에만
- 스택: Spring RestClient (SDK 없음). WebFlux 미도입 — `AIProvider.stream`은 `Consumer<String>` + MVC `SseEmitter`.

---

## 1. 목표 / 범위 / 비범위

**목표:** OpenAI/Gemini 추상화 위에서 summary+pgvector 컨텍스트를 모으고, AI 패널이 Claim/Evidence JSON을 스트리밍·렌더하며 Why/Alternative/전역 질문을 답하는 상태.

**범위:**

- `AIProvider` (`chat` JSON mode / `stream` / `embed`) — OpenAI, Gemini, 키 없음=disabled
- `summaries` + pgvector, 파일 해시 불변 시 재사용. **import 파이프라인에 넣지 않음**(§8: on-demand)
- `ContextRetrievalService` 1–2 hop + hybrid 랭킹 + 토큰 예산
- AI 패널: 컨텍스트 칩, 빠른 질문, 스트리밍, Claim/Evidence
- Why / Alternative / Code explanation / Architecture / 프로젝트 전역 / Finding 확인
- LLM 입력 `SecretMask` + 사용량 한도 + ArchUnit
- Settings: provider 상태만 (키는 env, UI 입력 금지)

**비범위:** Notes / Tasks / LearningRecommendation / TaskGeneration / CodeReview / 통합 Search hybrid (Phase 4–5)

---

## 2. PR 묶음

| PR | 브랜치 | task | 산출물 |
|----|--------|------|--------|
| P1 | `feature/phase3-ai-backend` | 3-1~3-6 | V12, provider, retrieval, ask API, Mock 테스트 |
| P2 | `feature/phase3-ai-panel` | 3-7~3-9 | 패널 UI, 빠른 질문, Settings 상태, Finding 버튼 |
| 게이트 | `feature/phase3-security-fixes` (필요 시) | 3-10 → 3-11 | sc → verify |

---

## 3. Task 체크리스트

### 3-1 Provider + 설정 — be

- [ ] `AIProvider`, `OpenAIProvider`, `GeminiProvider`, `NoOpAIProvider`
- [ ] `app.ai.*` yml / `.env.example`. 모델명 하드코딩 금지(기본값은 Properties)
- [ ] base-url 호스트 allowlist (api.openai.com, generativelanguage.googleapis.com, loopback 테스트)
- [ ] ArchUnit: `AIProvider`는 `ai` 패키지 밖 직접 참조 금지

### 3-2 V12 스키마 — be

- [ ] `summaries` (embedding `vector(1536)`, `content_hash`)
- [ ] `ai_conversations` / `ai_messages` (context jsonb, claims jsonb)
- [ ] `ai_usage_logs`

### 3-3 Summaries on-demand + pgvector — be

- [ ] 포커스 파일/노드 summary 없으면 생성, 해시 같으면 재사용
- [ ] 키 없으면 생성 스킵 (컨텍스트는 그래프+truncated source)
- [ ] cosine `<=>` 검색

### 3-4 Context retrieval + prompt — be

- [ ] UI context → 그래프 1 hop CALLS, 경로별 최근 commit, summary
- [ ] 토큰 예산, SecretMask 후 LLM
- [ ] 시스템 규칙: evidence 없는 단정 금지

### 3-5 Ask API + Why/Alternative — be

- [ ] `POST /api/projects/{id}/ai/ask` JSON
- [ ] `POST .../ai/ask/stream` SSE (`token` + `result`)
- [ ] intent: EXPLAIN / WHY / ALTERNATIVE / ARCHITECTURE / PROJECT / FINDING
- [ ] evidence 참조 검증, 깨진 참조는 UNKNOWN
- [ ] 일일 토큰 한도. IDOR 404. MockAIProvider 통합 테스트

### 3-6 Disabled / Mock — be

- [ ] 키 없음 → 503 `AI provider is not configured`
- [ ] 테스트는 `@Primary MockAIProvider`

### 3-7 AI 패널 — fe

- [ ] 칩, 빠른 질문, 입력, Claim/Evidence, Code 이동
- [ ] 스트림 또는 JSON. `AppLayout` Phase 3 placeholder 제거

### 3-8 Settings + Finding — fe

- [ ] `GET /api/ai/status` (provider/configured, 키 없음)
- [ ] Analysis `AI에게 확인`

### 3-9 Why 순서 / Alternative 비교 — be+fe

- [ ] Why 6단, Alternative 장단점 프롬프트

### 3-10 sc — sc

- [ ] 키 UI 저장 금지, 프롬프트 secret 필터, SSRF allowlist, IDOR, 사용량 한도
- [ ] Dependabot C/H=0
- [ ] `docs/plan/phase3-security-audit.md`

### 3-11 verify — verify

- [ ] gradle / frontend / sidecar CI green
- [ ] **Phase 4 시작 금지**
