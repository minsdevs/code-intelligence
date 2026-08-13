# Code Intelligence — Frontend

React 19 + TypeScript(strict) + Vite SPA. 기획서 §15의 3-pane 워크스페이스 셸(Phase 0 스캐폴딩).

## Stack

- React 19, React Router 7, TanStack Query 5, Zustand 5
- Tailwind CSS 4 (`@tailwindcss/vite`)
- Vitest + Testing Library, ESLint(flat) + Prettier

## Scripts

| 명령                   | 설명                          |
| ---------------------- | ----------------------------- |
| `npm run dev`          | 개발 서버                     |
| `npm run build`        | 타입체크 + 프로덕션 빌드      |
| `npm run lint`         | ESLint                        |
| `npm run typecheck`    | `tsc -b`                      |
| `npm test`             | Vitest (`-- --run` 단발 실행) |
| `npm run format`       | Prettier 쓰기                 |
| `npm run format:check` | Prettier 검사                 |

## 구조 (기획서 §5.2)

```text
src/
├── app/          # 라우팅, 3-pane 레이아웃 (AppLayout, Sidebar, AiPanel)
├── features/     # 화면 단위 (home, projects, search, settings)
├── components/   # 공용 UI
├── stores/       # Zustand (AI 패널 상태 등)
└── api/          # Phase 1에서 openapi-typescript 클라이언트 추가 예정
```
