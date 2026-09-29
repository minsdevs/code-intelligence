import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiSend } from './client'

describe('apiSend', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    document.cookie = 'XSRF-TOKEN=; Max-Age=0; path=/'
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refreshes the CSRF cookie once after a 403', async () => {
    let csrfCalls = 0
    let patCalls = 0
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost').pathname
      if (path === '/api/csrf') {
        csrfCalls += 1
        document.cookie = `XSRF-TOKEN=csrf-${csrfCalls}; path=/`
        return new Response(null, { status: 204 })
      }
      if (path === '/api/auth/pat') {
        patCalls += 1
        return new Response(null, { status: patCalls === 1 ? 403 : 204 })
      }
      throw new Error(`unexpected request: ${path}`)
    })

    await expect(apiSend('/api/auth/pat', { method: 'POST', body: { token: 'test-token' } })).resolves.toBeUndefined()

    expect(csrfCalls).toBe(2)
    expect(patCalls).toBe(2)
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('X-XSRF-TOKEN')).toBe('csrf-1')
    expect(new Headers(fetchMock.mock.calls[3][1]?.headers).get('X-XSRF-TOKEN')).toBe('csrf-2')
  })

  it('does not retry a non-CSRF failure', async () => {
    let csrfCalls = 0
    let patCalls = 0
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost').pathname
      if (path === '/api/csrf') {
        csrfCalls += 1
        document.cookie = 'XSRF-TOKEN=csrf-1; path=/'
        return new Response(null, { status: 204 })
      }
      if (path === '/api/auth/pat') {
        patCalls += 1
        return new Response(JSON.stringify({ detail: 'GitHub rejected the provided token.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/problem+json' },
        })
      }
      throw new Error(`unexpected request: ${path}`)
    })

    const result = apiSend('/api/auth/pat', { method: 'POST', body: { token: 'test-token' } })
    await expect(result).rejects.toMatchObject({ status: 400 })
    expect(csrfCalls).toBe(1)
    expect(patCalls).toBe(1)
  })
})
