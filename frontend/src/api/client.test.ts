import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, MutationNotSentError, UnauthorizedError, apiGet, apiSend } from './client'
import {
  createLocalProject,
  previewLocalProject,
  previewLocalRefresh,
  reanalyzeLocalProject,
  getLocalPreviewOutcome,
} from './projects'

function problemResponse(status: number, problem: unknown): Response {
  return new Response(JSON.stringify(problem), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })
}

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

  it('refreshes the CSRF cookie once after an explicit CSRF_INVALID rejection', async () => {
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
        return patCalls === 1
          ? problemResponse(403, {
              code: 'CSRF_INVALID',
              detail: 'CSRF token is missing or invalid.',
            })
          : new Response(null, { status: 204 })
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

  it.each([
    ['bad request', 400, { detail: 'GitHub rejected the provided token.' }],
    ['permission denial', 403, { code: 'GITHUB_FORBIDDEN', detail: 'Permission denied.' }],
    ['SSO denial', 403, { code: 'GITHUB_SSO_REQUIRED', detail: 'Organization approval required.' }],
    ['general denial', 403, { code: 'FORBIDDEN', detail: 'Forbidden' }],
    ['unknown denial', 403, {}],
    ['upstream wording', 403, { detail: 'CSRF_INVALID: upstream reported a CSRF token error.' }],
    ['unrelated code', 403, { code: 'GITHUB_FORBIDDEN', detail: 'CSRF_INVALID' }],
    ['nested code', 403, { error: { code: 'CSRF_INVALID' } }],
    ['non-string code', 403, { code: ['CSRF_INVALID'] }],
    ['lowercase code', 403, { code: 'csrf_invalid' }],
    ['padded code', 403, { code: 'CSRF_INVALID ' }],
    ['unauthorized', 401, { code: 'GITHUB_REAUTH_REQUIRED', detail: 'Reconnect GitHub.' }],
    ['rate limit', 429, { detail: 'Retry later.' }],
    ['server failure', 500, { detail: 'Server unavailable.' }],
    ['upstream failure', 502, { detail: 'Upstream unavailable.' }],
    ['service failure', 503, { detail: 'Service unavailable.' }],
    ['401 with a CSRF code', 401, { code: 'CSRF_INVALID' }],
    ['429 with a CSRF code', 429, { code: 'CSRF_INVALID' }],
    ['500 with a CSRF code', 500, { code: 'CSRF_INVALID' }],
  ] as const)('does not resend a mutation after %s', async (_, status, problem) => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(problemResponse(status, problem))

    await expect(apiSend('/api/projects', { method: 'POST', body: {} })).rejects.toMatchObject({
      status,
    })
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(['/api/csrf', '/api/projects'])
  })

  it.each([
    ['empty body', null],
    ['non-JSON wording', 'CSRF_INVALID: CSRF token is missing or invalid.'],
    ['malformed JSON', '{"code":"CSRF_INVALID",'],
    ['HTML error', '<h1>CSRF_INVALID</h1>'],
  ] as const)('does not infer CSRF from an unknown 403 with %s', async (_, body) => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(body, { status: 403 }))

    await expect(apiSend('/api/projects', { method: 'DELETE' })).rejects.toMatchObject({
      status: 403,
      code: undefined,
    })
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(['/api/csrf', '/api/projects'])
  })

  it('does not resend a mutation after a network failure', async () => {
    const failure = new TypeError('Synthetic connection lost after sending')
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(failure)

    await expect(apiSend('/api/projects', { method: 'POST' })).rejects.toBe(failure)
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(['/api/csrf', '/api/projects'])
  })

  it('stops after one CSRF retry even when the second mutation is rejected by CSRF', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(problemResponse(403, { code: 'CSRF_INVALID' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(problemResponse(403, { code: 'CSRF_INVALID' }))

    await expect(apiSend('/api/projects', { method: 'PATCH', body: {} })).rejects.toMatchObject({
      status: 403,
      code: 'CSRF_INVALID',
    })
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      '/api/csrf',
      '/api/projects',
      '/api/csrf',
      '/api/projects',
    ])
  })

  it('does not retry a GET rejected with CSRF_INVALID', async () => {
    fetchMock.mockResolvedValueOnce(problemResponse(403, { code: 'CSRF_INVALID' }))

    await expect(apiGet('/api/projects')).rejects.toMatchObject({
      status: 403,
      code: 'CSRF_INVALID',
    })
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(['/api/projects'])
  })

  it.each([
    [
      { code: 'GITHUB_REAUTH_REQUIRED', detail: 'Reconnect GitHub.', title: 'Unauthorized' },
      'Reconnect GitHub.',
      'GITHUB_REAUTH_REQUIRED',
    ],
    [
      { code: 'TOKEN_EXPIRED', title: 'GitHub authorization expired.' },
      'GitHub authorization expired.',
      'TOKEN_EXPIRED',
    ],
    [{ code: 'TOKEN_EXPIRED' }, 'Request failed (401)', 'TOKEN_EXPIRED'],
    [{ code: 401, detail: { message: 'untrusted' } }, 'Request failed (401)', undefined],
  ] as const)('preserves typed 401 problem information: %j', async (problem, message, code) => {
    fetchMock.mockResolvedValueOnce(problemResponse(401, problem))

    const result = apiGet('/api/github/repos')
    await expect(result).rejects.toBeInstanceOf(UnauthorizedError)
    await expect(result).rejects.toMatchObject({ status: 401, message, code })
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(['/api/github/repos'])
  })

  it('preserves a mutation 401 reason without refreshing or resending it', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        problemResponse(401, { code: 'GITHUB_REAUTH_REQUIRED', detail: 'Reconnect GitHub.' }),
      )

    const result = apiSend('/api/projects', { method: 'POST' })
    await expect(result).rejects.toBeInstanceOf(UnauthorizedError)
    await expect(result).rejects.toMatchObject({
      status: 401,
      code: 'GITHUB_REAUTH_REQUIRED',
      message: 'Reconnect GitHub.',
    })
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(['/api/csrf', '/api/projects'])
  })

  it('keeps a non-JSON 401 typed without exposing the response text', async () => {
    fetchMock.mockResolvedValueOnce(new Response('untrusted upstream diagnostic', { status: 401 }))

    const result = apiGet('/api/github/repos')
    await expect(result).rejects.toBeInstanceOf(UnauthorizedError)
    await expect(result).rejects.toMatchObject({
      status: 401,
      code: undefined,
      message: 'Request failed (401)',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retains the default UnauthorizedError constructor contract', () => {
    const error = new UnauthorizedError()
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 401, message: 'Unauthorized', code: undefined })
  })

  it.each([401, 403, 429, 500, 503])(
    'sends no mutation when initial CSRF priming returns HTTP %s',
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        problemResponse(status, { code: 'PRIMING_REFUSED', detail: 'Preparation refused.' }),
      )

      const result = apiSend('/api/projects', { method: 'POST', body: {} })
      await expect(result).rejects.toBeInstanceOf(MutationNotSentError)
      await expect(result).rejects.toMatchObject({
        cause: {
          name: status === 401 ? 'UnauthorizedError' : 'ApiError',
          status,
          code: 'PRIMING_REFUSED',
          message: 'Preparation refused.',
        },
      })
      expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(['/api/csrf'])
    },
  )

  it('sends no mutation when initial CSRF priming fails on the network', async () => {
    const cause = new TypeError('Synthetic priming failure')
    fetchMock.mockRejectedValueOnce(cause)

    const result = apiSend('/api/projects', { method: 'POST', retryOnCsrfFailure: false })
    await expect(result).rejects.toBeInstanceOf(MutationNotSentError)
    await expect(result).rejects.toMatchObject({ cause })
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(['/api/csrf'])
  })

  it('does not resend or claim an unsent mutation if CSRF refresh fails after the first send', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(problemResponse(403, { code: 'CSRF_INVALID' }))
      .mockResolvedValueOnce(problemResponse(503, { detail: 'CSRF refresh unavailable.' }))

    await expect(apiSend('/api/projects', { method: 'POST' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      message: 'CSRF refresh unavailable.',
    })
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      '/api/csrf',
      '/api/projects',
      '/api/csrf',
    ])
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
  ] as const)(
    'never resends a %s approval even after explicit CSRF_INVALID',
    async (_, send, path, body) => {
      fetchMock.mockImplementation(async (input: string) =>
        input === '/api/csrf'
          ? new Response(null, { status: 204 })
          : problemResponse(403, {
              code: 'CSRF_INVALID',
              detail: 'CSRF token is missing or invalid.',
            }),
      )
      await expect(send()).rejects.toMatchObject({ status: 403, code: 'CSRF_INVALID' })
      expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(['/api/csrf', path])
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(body)
    },
  )

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
