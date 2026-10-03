import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiSend } from './client'
import {
  createLocalProject,
  previewLocalProject,
  previewLocalRefresh,
  reanalyzeLocalProject,
  getLocalPreviewOutcome,
} from './projects'

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
      const path = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
        .pathname
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

    await expect(
      apiSend('/api/auth/pat', { method: 'POST', body: { token: 'test-token' } }),
    ).resolves.toBeUndefined()

    expect(csrfCalls).toBe(2)
    expect(patCalls).toBe(2)
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('X-XSRF-TOKEN')).toBe('csrf-1')
    expect(new Headers(fetchMock.mock.calls[3][1]?.headers).get('X-XSRF-TOKEN')).toBe('csrf-2')
  })

  it('does not retry a non-CSRF failure', async () => {
    let csrfCalls = 0
    let patCalls = 0
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
        .pathname
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

  it.each([
    [
      'initial',
      () => createLocalProject('/fixture/local', 'one-use-approval'),
      '/api/projects/local',
      { path: '/fixture/local', previewToken: 'one-use-approval' },
    ],
    [
      'refresh',
      () => reanalyzeLocalProject(7, 'one-use-approval'),
      '/api/projects/7/reanalyze',
      { previewToken: 'one-use-approval' },
    ],
  ] as const)('never resends a %s approval after HTTP 403', async (_, send, path, body) => {
    fetchMock.mockImplementation(async (input: string) =>
      input === '/api/csrf'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ code: 'FORBIDDEN', detail: 'Forbidden' }), { status: 403 }),
    )
    await expect(send()).rejects.toMatchObject({ status: 403 })
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(['/api/csrf', path])
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(body)
  })

  it('requests an explicit preview and reconciles by token without sending client counts', async () => {
    fetchMock.mockImplementation(async (input: string) =>
      input === '/api/csrf'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({}), { status: 200 }),
    )
    await previewLocalProject('/fixture/local')
    await previewLocalRefresh(7)
    await getLocalPreviewOutcome('opaque-approval')
    expect(
      fetchMock.mock.calls
        .filter(([path]) => path !== '/api/csrf')
        .map(([path, options]) => [path, JSON.parse(options.body)]),
    ).toEqual([
      ['/api/projects/local/preview', { path: '/fixture/local' }],
      ['/api/projects/7/local-preview', {}],
      ['/api/projects/local/preview-outcome', { previewToken: 'opaque-approval' }],
    ])
  })
})
