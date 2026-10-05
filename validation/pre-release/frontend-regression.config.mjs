import { fileURLToPath } from 'node:url';
import focused from '../../frontend/vitest.progress.config.mjs';

// Run all frontend source unit tests without loading the application's Vite
// configuration, .env files, dev proxy or entry point. Tests supply API doubles;
// the shared setup rejects any unstubbed fetch or XMLHttpRequest operation.
export default {
  ...focused,
  root: fileURLToPath(new URL('../../frontend/', import.meta.url)),
  test: {
    ...focused.test,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
};
