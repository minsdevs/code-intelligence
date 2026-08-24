**언어:** [English](README.md) | 한국어

# Code Intelligence frontend

브라우저 기반 로컬 워크스페이스를 위한 React 19 + TypeScript strict-mode +
Vite SPA입니다. 가져오기 흐름과 Features, Architecture, Flows, Code, History,
Analysis, Notes, Tasks, Review, Playground, Growth, Search, Settings 및 컨텍스트
인식 AI 화면을 포함합니다. 네이티브 데스크톱 런타임은 아닙니다.

## 요구 사항과 backend

RC/CI baseline에는 Node.js 24를 사용하십시오. Vite dev server는
`http://localhost:5173`에서 실행되며 로컬 API/auth route를 backend로 proxy합니다.
다른 port의 backend에는 `VITE_BACKEND_URL`을 loopback URL로 설정하십시오.
Vite는 변수를 브라우저 bundle에 노출하므로 `VITE_*` 변수에 secret을 넣지
마십시오.

```bash
cd frontend
npm ci
npm run dev
```

## 스크립트

| 명령 | 목적 |
|---|---|
| `npm run dev` | Vite development server 시작 |
| `npm run build` | `tsc -b`로 typecheck한 다음 production asset build |
| `npm run lint` | package에 ESLint 실행 |
| `npm run typecheck` | Vite build 없이 `tsc -b` 실행 |
| `npm test -- --run` | Vitest를 한 번 실행(CI 형식) |
| `npm test` | 기본 interactive/watch 동작으로 Vitest 실행 |
| `npm run format` | Prettier formatting 쓰기 |
| `npm run format:check` | Prettier formatting 검사 |
| `npm run preview` | 완료된 production build 미리보기 |
| `npm run gen:api` | `127.0.0.1:8080`에서 실행 중인 backend로부터 `src/api/generated.ts` 생성 |

전체 frontend 게이트는 다음과 같습니다.

```bash
npm ci
npm run lint
npm run typecheck
npm test -- --run
npm run build
```

## 소스 구성

```text
src/
├── app/          # routing, shell, sidebar, AI panel
├── features/     # product screens and workflows
├── components/   # shared UI
├── stores/       # Zustand UI/context state
├── api/          # API wrappers and shared response types
├── lib/          # i18n and shared helpers
└── test/         # test setup/support
```

현재 RC 기록은 [../ADDITIONAL_FEATURES.md](../ADDITIONAL_FEATURES.md)에 있습니다.
실제 브라우저 E2E는 여전히 릴리스 blocker이며 Vitest 또는 build 성공으로부터
완료되었다고 추론해서는 안 됩니다.
