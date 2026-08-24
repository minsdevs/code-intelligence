**언어:** [English](phase1-security-audit.md) | 한국어

# Phase 1 보안 감사 (작업 1-16)

> **역사 문서:** 이 감사 결과는 해당 Phase 시점의 코드와 의존성을 대상으로
> 한다. 현재 RC의 신규 local import/refresh, compare, judgment, export,
> IDE, AI preview 표면과 release blocker는
> [SECURITY](../../SECURITY.ko.md) 및
> [ADDITIONAL_FEATURES](../../ADDITIONAL_FEATURES.md)를 우선한다.

날짜: 2026-08-14
브랜치: `feature/phase1-security-fixes`
모드: 감사 우선. 이 PR에서 CRITICAL/HIGH 수정. LOW는 보고만 함.

## 검증된 제어 항목 (finding 없음)

| 제어 항목 | 결과 |
|---|---|
| TOKEN_ENC_KEY 32-byte fail-fast, 고유 GCM nonce, key_version | 통과 |
| Spring Session Redis, CSRF cookie+header, SameSite=Lax, prod Secure | 통과 |
| CORS allowlist만 허용; credentials=true일 때 wildcard 거부 | 통과 |
| `VITE_*` secret | 통과 (frontend source에서 `VITE_` 일치 항목 없음) |
| DTO / error body / SSE payload에 token 없음 | 통과 (PAT 400 test에서 이미 echo 없음 확인) |
| SSRF: `https://github.com/{owner}/{repo}`만 가져오기 | 통과 (`RepoRefTest`) |
| `file-content`의 path traversal (`..`, absolute, `%2e`) | 통과; symlink 이탈 test 추가 |
| Clone 경로를 `${DATA_DIR}/repos/{projectId}`로 제한 | 통과 (`GitCloneService.requireUnderReposRoot`) |
| `/api/**`는 기본적으로 401; project API는 `findByIdAndUserId` 사용 | 통과; PUT `/area-selections` IDOR test 추가 |
| Clone tree를 실행하지 않음(`ProcessBuilder`/`Runtime.exec` 없음) | 통과 |
| Loopback bind `server.address=127.0.0.1` | 통과 |

## CRITICAL / HIGH — 수정됨

| ID | 심각도 | Finding | 수정 |
|---|---|---|---|
| D1 | CRITICAL | GitHub Dependabot: fixture `package.json`이 `vitest ^1.3.0`(GHSA-5xrq-8626-4rwp)을 선언했습니다. Fixture는 설치/실행되지 않지만 dependency graph는 여전히 default-branch manifest를 표시했습니다. | `react-mini`와 `fullstack-mini/frontend` → `vitest ^3.2.6`, `vite ^6.4.3` |
| D2 | HIGH | 같은 fixture: `vite ^5.1.0`(Windows `server.fs.deny` 우회 GHSA-fx2h-pf6j-xcff 및 관련 항목). | 동일하게 상향 |
| H1 | HIGH | 인증되지 않은 `POST /api/auth/pat`가 throttle 없이 모든 token을 GitHub로 전달했습니다(credential stuffing / GitHub oracle). | CSRF 뒤에 `PatLoginRateLimitFilter`; 기본 20 / 60s (`app.auth.pat-login-*`) |
| H2 | HIGH | Evidence excerpt가 config file의 처음 약 80자를 저장하여 `password:` / PAT 형태 값이 포함되었습니다. | `EvidenceService.insertStatic`에서 `SecretMask` 적용 |
| H3 | HIGH | `@monaco-editor/react` 기본 loader가 jsDelivr에서 Monaco를 가져왔습니다. 손상된 CDN은 private source를 표시하는 view에서 코드를 실행할 수 있었습니다. | npm `monaco-editor` package를 사용한 `loader.config({ monaco })` |

이 PR 이후: 애플리케이션 CRITICAL/HIGH = 0. GitHub가 fixture manifest를 다시
scan하면 Dependabot default-branch C/H는 닫혀야 합니다.

`/frontend`에서 `npm audit`(P10 lockfile 이후): critical 0, high 0
(LOW/C/H 범위에 없는 DOMPurify / 유사 항목 low 1, moderate 1).

## LOW (보고만 함 — 수정하지 않음)

| ID | Finding | LOW인 이유 | 처리 |
|---|---|---|---|
| L1 | `GET /v3/api-docs`와 swagger-ui가 계속 `permitAll`임(`npm run gen:api`에서 사용) | 로컬 loopback bind; 문서에 token 없음; codegen에 필요 | 전용 codegen 인증 방안이 생길 때까지 공개 유지 |
| L2 | token이 log에 절대 나타나지 않음을 확인하는 log-capture test 없음 | 코드 검토: GithubApiClient는 rate-limit header만 log; credential `toString`은 masked | log-test harness가 생기면 추가 |
| L3 | Job retry: step reset과 mark-queued가 한 transaction을 공유하지만 concurrent retry vs enqueue는 여전히 partial unique index에 의존 | index가 실제 guard이며 순서는 이미 `transactionTemplate` 안에 있음 | 변경 없음 |
| L4 | Project delete: DB row를 제거한 뒤 clone dir를 삭제하므로 crash 시 repos root 아래 orphan directory가 남을 수 있음 | orphan도 path 검사를 거치며 다른 사용자에게 data leak 없음 | Phase 2: after-commit cleanup job |
| L5 | `RepoRef`가 단독 `.` segment를 허용하고 owner/name을 case-fold하지 않음 | GitHub는 `.`을 거부; 대소문자만 다른 중복 import 가능 | 나중에 선택적으로 hardening |
| L6 | SSE emitter: timeout에서 `complete()` 호출; `onCompletion`에서 제거. callback 전 complete가 throw하면 residual leak 가능 | `@PreDestroy`가 남은 emitter를 complete; 30m timeout | 모니터링 |
| L7 | DOMPurify transitive(monaco/jsdom stack) medium/low GHSA | 이 앱에서 attacker HTML을 sanitize하는 데 사용하지 않음 | Dependabot weekly |
| L8 | Vite launch-editor NTLM(dev-only, Windows) | Dev dependency이며 production bundle이 아님 | Phase 1 runtime에서는 무시 |

## 공개 표면 (위협 모델 참고)

- **OAuth callback** — Spring OAuth2 + state; 성공 시 설정된 FE origin으로만 redirect.
- **PAT register** — CSRF + rate limit; response에 token 없음.
- **SSE** — subscribe 전에 `getOwnedJob`; snapshot/update는 credential 없는 job DTO.
- **File serving** — owner 범위, inventory path 일치, `toRealPath` jail, size/binary guard.

## 범위 밖

GitHub secret scanning / gitleaks CI는 public-repo 전환을 기다립니다(기획서 §18 ⑤).
