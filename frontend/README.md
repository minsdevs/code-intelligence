# Code Intelligence frontend

React 19 + TypeScript strict-mode + Vite SPA for the browser-based local
workspace. It contains the import flow and the Features, Architecture, Flows,
Code, History, Analysis, Notes, Tasks, Review, Playground, Growth, Search,
Settings, and context-aware AI surfaces. It is not a native desktop runtime.

## Requirements and backend

Use Node.js 24 for the RC/CI baseline. The Vite dev server runs on
`http://localhost:5173` and proxies local API/auth routes to the backend. For a
backend on another port, set `VITE_BACKEND_URL` to a loopback URL; never put a
secret in a `VITE_*` variable because Vite exposes it to the browser bundle.

```bash
cd frontend
npm ci
npm run dev
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the Vite development server |
| `npm run build` | Typecheck with `tsc -b`, then build production assets |
| `npm run lint` | Run ESLint over the package |
| `npm run typecheck` | Run `tsc -b` without Vite build |
| `npm test -- --run` | Run Vitest once (CI form) |
| `npm test` | Run Vitest in its default interactive/watch behavior |
| `npm run format` | Write Prettier formatting |
| `npm run format:check` | Check Prettier formatting |
| `npm run preview` | Preview a completed production build |
| `npm run gen:api` | Generate `src/api/generated.ts` from a backend running at `127.0.0.1:8080` |

The full frontend gate is:

```bash
npm ci
npm run lint
npm run typecheck
npm test -- --run
npm run build
```

## Source layout

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

The current RC record is in [../ADDITIONAL_FEATURES.md](../ADDITIONAL_FEATURES.md);
real browser E2E remains a release blocker and must not be inferred from Vitest
or build success.
