// Isolated DOM and mocked jobs API. No Vite dev proxy or application bootstrap.
export default {
  envDir: false,
  server: { middlewareMode: true, ws: false, watch: null },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['src/features/import/syntaxFailure.test.tsx', 'src/features/import/localPreviewRequired.test.tsx', 'src/features/import/progressCancellation.test.tsx',
      'src/features/import/progressResponses.test.tsx', 'src/features/import/progressReconciliation.test.tsx'],
    environment: 'jsdom',
    environmentOptions: { jsdom: { runScripts: 'outside-only' } },
    setupFiles: ['./src/test/setup.ts', './src/test/no-network.ts'],
    globalSetup: [],
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    watch: false,
    api: false,
    browser: { enabled: false },
    coverage: { enabled: false },
    deps: { optimizer: { client: { enabled: false }, ssr: { enabled: false } } },
  },
}
