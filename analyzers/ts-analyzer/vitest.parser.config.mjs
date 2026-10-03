// Focused, in-process parser verification. No app bootstrap or integration hooks.
export default {
  envDir: false,
  server: { middlewareMode: true, ws: false, watch: null },
  test: {
    include: ['src/ts-extractor.test.ts', 'src/semantic-extractor.test.ts', 'src/http-boundary.test.ts'],
    environment: 'node',
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    watch: false,
    api: false,
    browser: { enabled: false },
    coverage: { enabled: false },
    setupFiles: [],
    globalSetup: [],
    deps: { optimizer: { client: { enabled: false }, ssr: { enabled: false } } },
  },
}
