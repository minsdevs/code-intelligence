/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backend = env.VITE_BACKEND_URL || 'http://127.0.0.1:8080'

  const backendProxy: ProxyOptions = {
    target: backend,
    changeOrigin: true,
  }

  /** SSE job events must not be buffered or cut by the default 120s proxy timeout. */
  const apiProxy: ProxyOptions = {
    ...backendProxy,
    timeout: 0,
    proxyTimeout: 0,
    configure: (proxy) => {
      proxy.on('proxyRes', (proxyRes) => {
        const contentType = proxyRes.headers['content-type']
        if (typeof contentType === 'string' && contentType.includes('text/event-stream')) {
          proxyRes.headers['cache-control'] = 'no-cache, no-transform'
          proxyRes.headers['x-accel-buffering'] = 'no'
        }
      })
    },
  }

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/api': apiProxy,
        '/oauth2': backendProxy,
        '/login': backendProxy,
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
    },
  }
})
