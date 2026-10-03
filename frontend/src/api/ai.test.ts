import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askAi, askAiStream } from './ai'
import { createAiRequestPlan } from './aiRequestPlan'
import type { AiAskBody, AiRequestPlanResponse } from './types'

const body: AiAskBody = {
  question: 'Synthetic question', conversationId: 4, intent: 'EXPLAIN', view: 'code',
  focusedFile: 'src/App.tsx', selectedAreas: ['web'], excludedContextIds: ['SOURCE:excluded'],
}
const result = { conversationId: 4, messageId: 5, explanation: 'Synthetic answer', claims: [], alternatives: [] }
const fetchMock = vi.fn()

function plan(): AiRequestPlanResponse {
  return {
    requestPlanToken: 'synthetic-plan', requestId: 'synthetic-request', expiresAt: '2099-01-01T00:00:00Z',
    snapshotId: 7, provider: 'mock', model: 'mock-model', intent: 'EXPLAIN',
    contextItems: [{ id: 'VIEW:code', type: 'VIEW', label: 'code', charCount: 12, masked: false, fileRefs: [] }],
    fileRefs: [], systemPrompt: 'Full system prompt', userPrompt: 'Full user prompt',
    payloadSha256: 'a'.repeat(64), costStatus: 'UNAVAILABLE',
  }
}

function path(input: RequestInfo | URL) {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname
}

function respond(response: () => Response) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => path(input) === '/api/csrf'
    ? new Response(null, { status: 204 }) : response())
}

function postedPaths() {
  return fetchMock.mock.calls.filter(call => call[1]?.method === 'POST').map(call => path(call[0]))
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('AI request plans and one-use stream transport', () => {
  it('creates a plan with the original body and does not call an AI execution endpoint', async () => {
    respond(() => Response.json(plan()))
    await expect(createAiRequestPlan(7, body)).resolves.toEqual(plan())
    expect(postedPaths()).toEqual(['/api/projects/7/ai/request-plan'])
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(body)
  })

  for (const [label, call] of [
    ['plan', () => createAiRequestPlan(7, body)],
    ['ask', () => askAi(7, { ...body, requestPlanToken: 'synthetic-plan' })],
    ['stream', () => askAiStream(7, { ...body, requestPlanToken: 'synthetic-plan' }, vi.fn())],
  ] as const) {
    it(`does not automatically retry a ${label} POST after a 403`, async () => {
      respond(() => Response.json({ detail: 'Synthetic forbidden' }, { status: 403 }))
      await expect(call()).rejects.toMatchObject({ status: 403 })
      expect(postedPaths()).toHaveLength(1)
      expect(fetchMock.mock.calls.filter(call => path(call[0]) === '/api/csrf')).toHaveLength(1)
    })
  }

  for (const invalid of [
    { ...plan(), systemPrompt: undefined },
    { ...plan(), costStatus: 'RESERVED' },
    { ...plan(), contextItems: [{ id: 'SOURCE:x', type: 'SOURCE', label: 'x', charCount: 5, masked: false }] },
  ]) {
    it('rejects incomplete or unsupported confirmation content', async () => {
      respond(() => Response.json(invalid))
      await expect(createAiRequestPlan(7, body)).rejects.toMatchObject({ status: 502 })
      expect(postedPaths()).toEqual(['/api/projects/7/ai/request-plan'])
    })
  }

  for (const [label, response] of [
    ['missing response body', () => new Response(null, { status: 200 })],
    ['EOF without result', () => new Response('event: token\ndata: partial\n\n')],
    ['malformed result', () => new Response('event: result\ndata: broken-json\n\n')],
    ['incomplete result object', () => new Response('event: result\ndata: {}\n\n')],
    ['reader failure', () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('Synthetic disconnect')) } }))],
  ] as const) {
    it(`reports an unknown outcome for ${label} without a fallback POST`, async () => {
      respond(response)
      await expect(askAiStream(7, { ...body, requestPlanToken: 'synthetic-plan' }, vi.fn()))
        .rejects.toMatchObject({ status: 502, code: 'AI_REQUEST_OUTCOME_UNKNOWN' })
      expect(postedPaths()).toEqual(['/api/projects/7/ai/ask/stream'])
    })
  }

  it('reads a complete CRLF stream split inside UTF-8 bytes and preserves the single tokenized request', async () => {
    const bytes = new TextEncoder().encode(`event: token\r\ndata: 코드\r\n\r\nevent: result\r\ndata: ${JSON.stringify(result)}\r\n\r\n`)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    respond(() => new Response(stream))
    const onToken = vi.fn()
    const tokenized = { ...body, requestPlanToken: 'synthetic-plan' }
    await expect(askAiStream(7, tokenized, onToken)).resolves.toEqual(result)
    expect(onToken).toHaveBeenCalledExactlyOnceWith('코드')
    expect(stream.locked).toBe(false)
    expect(postedPaths()).toEqual(['/api/projects/7/ai/ask/stream'])
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(tokenized)
  })

  it('uses the existing desktop origin and authentication header for the single stream POST', async () => {
    const previous = window.codeIntelligenceDesktop
    window.codeIntelligenceDesktop = {
      appVersion: '0.1.0',
      platform: 'darwin', apiBaseUrl: 'http://127.0.0.1:54321', apiToken: 'synthetic-desktop-token',
      pickFolder: vi.fn(), authorizeDroppedFolder: vi.fn(), openExternal: vi.fn(),
      backup: vi.fn(), restore: vi.fn(), runtimeStatus: vi.fn(), restartRuntime: vi.fn(),
    }
    try {
      vi.resetModules()
      const desktopApi = await import('./ai')
      respond(() => new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`))
      await expect(desktopApi.askAiStream(7, { ...body, requestPlanToken: 'synthetic-plan' }, vi.fn())).resolves.toEqual(result)
      expect(postedPaths()).toEqual(['/api/projects/7/ai/ask/stream'])
      const request = fetchMock.mock.calls.find(call => call[1]?.method === 'POST')!
      expect(request[0]).toBe('http://127.0.0.1:54321/api/projects/7/ai/ask/stream')
      expect(new Headers(request[1]?.headers).get('X-Code-Intelligence-Token')).toBe('synthetic-desktop-token')
    } finally {
      if (previous) window.codeIntelligenceDesktop = previous
      else delete window.codeIntelligenceDesktop
      vi.resetModules()
    }
  })
})

describe('strict cost confirmation data', () => {
  const cost = {
    reservedMicroUsd: '9007199254740993', inputTokenUpperBound: '128000', outputTokenMax: '2048',
    priceVersion: 'synthetic-price-v1', validUntil: '2099-01-01T00:00:00Z', policyRevision: '7',
  }

  it('preserves the maximum reservation and token bounds as exact strings', async () => {
    const priced = { ...plan(), costStatus: 'AVAILABLE', cost }
    respond(() => Response.json(priced))
    await expect(createAiRequestPlan(7, body)).resolves.toEqual(priced)
    expect(postedPaths()).toEqual(['/api/projects/7/ai/request-plan'])
  })

  for (const invalid of [
    null, { ...cost, reservedMicroUsd: 9007199254740992 }, { ...cost, reservedMicroUsd: '01' },
    { ...cost, inputTokenUpperBound: '128000.0' }, { ...cost, outputTokenMax: '-1' },
    { ...cost, priceVersion: '' }, { ...cost, validUntil: 'not-a-date' }, { ...cost, policyRevision: undefined },
    { ...cost, validUntil: '2099-01-01' }, { ...cost, validUntil: '2099-02-31T00:00:00Z' },
  ]) {
    it('rejects missing, lossy or incomplete AVAILABLE cost fields', async () => {
      respond(() => Response.json({ ...plan(), costStatus: 'AVAILABLE', cost: invalid }))
      await expect(createAiRequestPlan(7, body)).rejects.toMatchObject({ status: 502 })
      expect(postedPaths()).toEqual(['/api/projects/7/ai/request-plan'])
    })
  }

  it('rejects a contradictory UNAVAILABLE plan carrying a cost', async () => {
    respond(() => Response.json({ ...plan(), cost }))
    await expect(createAiRequestPlan(7, body)).rejects.toMatchObject({ status: 502 })
  })
})
