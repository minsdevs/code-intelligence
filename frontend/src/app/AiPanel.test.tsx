import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { routes } from './router'
import AiPanel from './AiPanel'
import { AI_BUDGET_QUERY_KEY, type AiBudgetView } from '../api/aiBudget'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../stores/uiStore'
import type { AiAskBody, AiRequestPlanResponse } from '../api/types'

vi.mock('@monaco-editor/react', () => ({
  default: () => null,
  DiffEditor: () => null,
}))

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input
  if (typeof input === 'string') return new URL(input, 'http://localhost')
  return new URL(input.url, 'http://localhost')
}

const askResponse = {
  conversationId: 9,
  messageId: 3,
  explanation: 'App stores the counter in memory.',
  claims: [
    {
      text: 'Counter lives in App.tsx',
      confidence: 'CONFIRMED',
      evidence: ['file:src/App.tsx:1'],
    },
  ],
  alternatives: [],
}

const fetchMock = vi.fn()
const webBudget: AiBudgetView = {
  available: false, state: 'OFF', policyRevision: '0', activationToken: null,
  dailyLimitMicroUsd: '0', monthlyLimitMicroUsd: '0', allDatesHeldMicroUsd: '0',
  dailySettledMicroUsd: '0', monthlySettledMicroUsd: '0', supportedModels: [],
}
let aiConfigured = true
let blockedReason: string | null = null
let streamFails = false
let previewPayload: unknown = null
let planCount = 0

function requestPlan(body: AiAskBody, token = 'synthetic-plan-token'): AiRequestPlanResponse {
  return {
    requestPlanToken: token, requestId: `request-${token}`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    snapshotId: 70, provider: 'mock-provider', model: 'mock-model', intent: body.intent ?? 'ASK',
    contextItems: [{ id: 'SOURCE:planned', type: 'SOURCE', label: 'Reviewed src/App.tsx', charCount: 100, masked: true, fileRefs: ['file:src/App.tsx:1'] }],
    fileRefs: ['file:src/App.tsx:1'], systemPrompt: 'Full synthetic system prompt.\nSecond system line.',
    userPrompt: `Full synthetic user prompt.\n${body.question}\nOriginal source with [REDACTED].`,
    payloadSha256: 'a'.repeat(64), costStatus: 'UNAVAILABLE',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function endpointCalls(suffix: string) {
  return fetchMock.mock.calls.filter(call => requestUrl(call[0]).pathname.endsWith(suffix))
}

async function confirmRequest() {
  const confirm = await screen.findByRole('button', { name: '확인 후 전송' })
  await waitFor(() => expect(confirm).toBeEnabled())
  fireEvent.click(confirm)
}

async function reviewQuestion(question = 'Explain the selected source') {
  const input = await screen.findByLabelText('AI 질문 입력')
  fireEvent.change(input, { target: { value: question } })
  const review = screen.getByRole('button', { name: '요청 확인' })
  await waitFor(() => expect(review).toBeEnabled())
  fireEvent.click(review)
  await screen.findByRole('region', { name: 'AI 요청 전송 확인' })
  return input
}

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/projects/7') return jsonResponse({ id: 7, name: 'fixture', currentSnapshot: { id: 70 } })
    if (path === '/api/projects/8') return jsonResponse({ id: 8, name: 'other fixture', currentSnapshot: { id: 80 } })
    if (path === '/api/projects/8/snapshots' || path === '/api/projects/8/files') return jsonResponse([])
    if (path === '/api/projects/7/snapshots') return jsonResponse([])
    if (path === '/api/ai/status') {
      return jsonResponse({ configured: aiConfigured, provider: aiConfigured ? 'mock' : null, blockedReason })
    }
    if (path === '/api/ai/budget') return jsonResponse(webBudget)
    if (path === '/api/csrf') return new Response(null, { status: 204 })
    if (path === '/api/projects/7/files') return jsonResponse([])
    if (path === '/api/projects/7/graph/nodes') return jsonResponse({ items: [], page: 0, totalPages: 0 })
    if (path === '/api/projects/7/file-content') return jsonResponse({
      path: 'src/App.tsx', content: 'export const App = 1', language: 'typescript',
      resolvedSnapshotId: 70, currentSnapshot: true, contentOid: 'a'.repeat(40),
      sourceState: 'AVAILABLE',
    })
    if (path === '/api/projects/7/ai/preview' && previewPayload) return jsonResponse(previewPayload)
    if (path.endsWith('/ai/request-plan')) {
      planCount += 1
      return jsonResponse(requestPlan(JSON.parse(init?.body as string), `synthetic-plan-${planCount}`))
    }
    if (path === '/api/projects/7/ai/ask/stream') {
      if (streamFails) {
        return jsonResponse({ title: 'Bad Gateway', detail: 'stream failed' }, 502)
      }
      const payload = [
        'event: token',
        'data: App stores',
        '',
        'event: result',
        `data: ${JSON.stringify(askResponse)}`,
        '',
      ].join('\n')
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (path === '/api/projects/7/ai/ask') return jsonResponse(askResponse)
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderCode() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/code?path=src/App.tsx'] })
  return { router, ...render(<RouterProvider router={router} />) }
}

function selectionPreview(sourceId = 'SOURCE:before', copyablePrompt = 'source content must stay excluded') {
  return {
    contextItems: [
      { id: 'VIEW:stable', type: 'VIEW', label: 'code', charCount: 10, masked: false },
      { id: sourceId, type: 'SOURCE', label: 'src/App.tsx', charCount: 100, masked: false },
    ],
    fileRefs: ['file:src/App.tsx:1'], totalChars: 110, estimatedInputTokens: 28,
    estimatedOutputTokens: 8, estimatedCostUsd: 0, provider: 'mock', model: 'mock',
    maskedSecrets: 0, localOnly: true, copyablePrompt,
  }
}

async function previewAndExcludeSource() {
  renderCode()
  const input = await screen.findByLabelText('AI 질문 입력')
  fireEvent.change(input, { target: { value: 'explain this code' } })
  fireEvent.click(screen.getByTitle('Preview what will be sent'))
  fireEvent.click(await screen.findByLabelText('Include SOURCE: src/App.tsx'))
  return input
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({
    aiPanelOpen: true,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
    focusedFile: 'src/App.tsx',
    focusedNode: null,
    focusedCommitSha: null,
    focusedFindingId: null,
    focusedNoteId: null,
    focusedTaskId: null,
    pendingIntent: null,
  })
  aiConfigured = true
  blockedReason = null
  streamFails = false
  previewPayload = null
  planCount = 0
  fetchMock.mockReset()
  installFetch()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AiPanel', () => {
  it('replaces stale exclusions with a conservative new selection on preview refresh', async () => {
    previewPayload = selectionPreview()
    await previewAndExcludeSource()
    previewPayload = selectionPreview('SOURCE:after')

    fireEvent.click(screen.getByTitle('Preview what will be sent'))

    expect(await screen.findByText('Context changed. All items were excluded; select the items to include.')).toBeInTheDocument()
    expect(screen.getByLabelText('Include SOURCE: src/App.tsx')).not.toBeChecked()
    expect(screen.getByLabelText('Include VIEW: code')).not.toBeChecked()
    fireEvent.click(screen.getByLabelText('Include VIEW: code'))
    fireEvent.click(screen.getByRole('button', { name: '요청 확인' }))
    await confirmRequest()
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(call => requestUrl(call[0]).pathname.endsWith('/ai/ask/stream'))
      expect(calls).toHaveLength(1)
      expect(JSON.parse(calls[0][1]?.body as string).excludedContextIds).toEqual(['SOURCE:after'])
    })
  })

  it('copies only the locally filtered prompt after excluding source', async () => {
    previewPayload = selectionPreview()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await previewAndExcludeSource()
    const originalFetch = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).pathname.endsWith('/ai/preview')) {
        expect(JSON.parse(init?.body as string).excludedContextIds).toEqual(['SOURCE:before'])
        return Promise.resolve(jsonResponse(selectionPreview('SOURCE:before', 'filtered local prompt')))
      }
      return originalFetch(input, init)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Prompt 복사' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('filtered local prompt'))
    expect(fetchMock.mock.calls.some(call => requestUrl(call[0]).pathname.includes('/ai/ask'))).toBe(false)
  })

  it('leaves the clipboard unchanged when excluded context cannot be revalidated', async () => {
    previewPayload = selectionPreview()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await previewAndExcludeSource()
    const originalFetch = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).pathname.endsWith('/ai/preview')) {
        return Promise.resolve(jsonResponse({ code: 'AI_CONTEXT_CHANGED', detail: 'Create a new preview.' }, 409))
      }
      return originalFetch(input, init)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Prompt 복사' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Create a new preview.')
    expect(writeText).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(call => requestUrl(call[0]).pathname.includes('/ai/ask'))).toBe(false)
  })

  it('prepares a quick question for explicit confirmation before sending and renders evidence', async () => {
    const { router } = renderCode()
    await waitFor(() => expect(useUiStore.getState().focusedFile).toBe('src/App.tsx'))
    const quick = await screen.findByRole('button', { name: '쉽게 설명' })
    await waitFor(() => expect(quick).toBeEnabled())
    fireEvent.click(quick)
    const plan = await screen.findByRole('region', { name: 'AI 요청 전송 확인' })
    expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
    expect(within(plan).getByText('Full synthetic system prompt. Second system line.')).toBeInTheDocument()
    expect(within(plan).getByText(/Original source with \[REDACTED\]/)).toBeInTheDocument()
    expect(within(plan).getByText('mock-provider')).toBeInTheDocument()
    expect(within(plan).getByText('mock-model')).toBeInTheDocument()
    expect(within(plan).getByText(/마스킹 적용/)).toBeInTheDocument()
    expect(within(plan).getByText(/비용 계산과 예약 금액은 아직 제공되지 않습니다/)).toBeInTheDocument()
    expect(plan).not.toHaveTextContent('synthetic-plan-1')
    await confirmRequest()
    expect(await screen.findByText('App stores the counter in memory.')).toBeInTheDocument()
    expect(JSON.parse(endpointCalls('/ai/ask/stream')[0][1]?.body as string).requestPlanToken).toBe('synthetic-plan-1')
    expect(screen.queryByRole('button', { name: '확인 후 전송' })).not.toBeInTheDocument()
    expect(screen.getByText('Counter lives in App.tsx')).toBeInTheDocument()
    expect(screen.getByText('CONFIRMED')).toBeInTheDocument()
    const evidence = screen.getByRole('button', { name: 'src/App.tsx:1' })
    fireEvent.click(evidence)
    await waitFor(() => {
      expect(router.state.location.search).toContain('path=src%2FApp.tsx')
    })
  })

  it('opens Settings when AI is not configured', async () => {
    aiConfigured = false
    const { router } = renderCode()

    fireEvent.click(await screen.findByRole('link', { name: '설정 열기' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })

  for (const configured of [false, true]) {
    it(`blocks desktop AI sending even through direct form submission (configured=${configured})`, async () => {
      aiConfigured = configured
      blockedReason = 'DESKTOP_AI_SAFETY_UNAVAILABLE'
      renderCode()
      expect(await screen.findByText('이 데스크톱 빌드에서는 AI 연결을 사용할 수 없습니다. 로컬 분석은 계속 사용할 수 있습니다.')).toBeInTheDocument()
      expect(screen.queryByText(/설정에서 provider 키를 추가하세요/)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '쉽게 설명' })).toBeDisabled()
      const input = screen.getByLabelText('AI 질문 입력')
      expect(input).toBeEnabled()
      fireEvent.change(input, { target: { value: 'Local preview remains available' } })
      expect(screen.getByRole('button', { name: '요청 확인' })).toBeDisabled()
      fireEvent.submit(input.closest('form')!)
      fireEvent.click(screen.getByLabelText('Local data only (no external AI)'))
      expect(screen.getByRole('button', { name: '요청 확인' })).toBeDisabled()
      fireEvent.submit(input.closest('form')!)
      expect(fetchMock.mock.calls.some(call => requestUrl(call[0]).pathname.includes('/ai/ask'))).toBe(false)
      expect(endpointCalls('/ai/request-plan')).toHaveLength(0)
    })
  }

  it('keeps local source preview and prompt copy available while desktop AI is blocked', async () => {
    aiConfigured = false
    blockedReason = 'DESKTOP_AI_SAFETY_UNAVAILABLE'
    previewPayload = selectionPreview('SOURCE:local', 'Synthetic local desktop prompt')
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderCode()
    await screen.findByText('이 데스크톱 빌드에서는 AI 연결을 사용할 수 없습니다. 로컬 분석은 계속 사용할 수 있습니다.')
    const input = screen.getByLabelText('AI 질문 입력')
    expect(input).toBeEnabled()
    fireEvent.change(input, { target: { value: 'Preview local source' } })
    fireEvent.click(screen.getByTitle('Preview what will be sent'))
    expect(await screen.findByLabelText('Include SOURCE: src/App.tsx')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Prompt 복사' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('Synthetic local desktop prompt'))
    expect(screen.getByRole('button', { name: '요청 확인' })).toBeDisabled()
    const paths = fetchMock.mock.calls.map(call => requestUrl(call[0]).pathname)
    expect(paths.filter(path => path.endsWith('/ai/preview'))).toHaveLength(1)
    expect(paths.filter(path => path.includes('/ai/ask'))).toHaveLength(0)
  })

  it('does not resend a failed streaming request through the non-streaming endpoint', async () => {
    streamFails = true
    renderCode()
    const quick = await screen.findByRole('button', { name: '쉽게 설명' })
    await waitFor(() => expect(quick).toBeEnabled())

    fireEvent.click(quick)
    await confirmRequest()

    expect(await screen.findByRole('alert')).toHaveTextContent('stream failed')
    const aiRequests = fetchMock.mock.calls.map((call) => requestUrl(call[0]).pathname)
    expect(aiRequests.filter((path) => path === '/api/projects/7/ai/ask/stream')).toHaveLength(1)
    expect(aiRequests.filter((path) => path === '/api/projects/7/ai/ask')).toHaveLength(0)
  })

  it('blocks external AI call when local data only mode is active', async () => {
    renderCode()
    // Wait for the AI panel to render (it has 'AI Assistant' header)
    await screen.findByText('AI Assistant')
    // Enable local data only mode
    const localOnlyCheckbox = await screen.findByLabelText('Local data only (no external AI)')
    fireEvent.click(localOnlyCheckbox)
    expect(localOnlyCheckbox).toBeChecked()

    // Type a question and submit
    const input = screen.getByLabelText('AI 질문 입력')
    expect(input).toBeEnabled()
    fireEvent.change(input, { target: { value: 'explain this code' } })
    const sendButton = screen.getByRole('button', { name: '요청 확인' })
    fireEvent.click(sendButton)

    // Verify error message is shown
    expect(await screen.findByText(/Local data only mode is active/)).toBeInTheDocument()

    // Verify no AI stream or ask request was made
    const aiRequests = fetchMock.mock.calls.map((call) => requestUrl(call[0]).pathname)
    expect(aiRequests.filter((path) => path.includes('/ai/ask'))).toHaveLength(0)
    expect(endpointCalls('/ai/request-plan')).toHaveLength(0)
  })

  it('previews and copies a prompt without an AI key', async () => {
    aiConfigured = false
    previewPayload = {
      contextItems: [{ id: 'VIEW:abc123def456', type: 'VIEW', label: 'code', charCount: 10, masked: false }],
      fileRefs: ['file:src/App.tsx:1'],
      totalChars: 10,
      estimatedInputTokens: 3,
      estimatedOutputTokens: 1,
      estimatedCostUsd: 0,
      provider: '',
      model: '',
      maskedSecrets: 0,
      localOnly: true,
      copyablePrompt: 'QUESTION:\nExplain this code\n\n---BEGIN CONTEXT---\nVIEW: code\n---END CONTEXT---',
    }
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    renderCode()
    const input = await screen.findByLabelText('AI 질문 입력')
    fireEvent.change(input, { target: { value: 'Explain this code' } })
    fireEvent.click(screen.getByTitle('Preview what will be sent'))
    await screen.findByText('Context Preview')
    fireEvent.click(screen.getByRole('button', { name: 'Prompt 복사' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('QUESTION:')))
  })

  it('passes excludedContextIds from preview selection to ask request', async () => {
    // Mock the preview endpoint to return context items with deterministic IDs
    const previewResponse = {
      contextItems: [
        { id: 'VIEW:abc123def456', type: 'VIEW', label: 'code', charCount: 10, masked: false },
        { id: 'FILE:def789abc012', type: 'FILE', label: 'src/App.tsx', charCount: 25, masked: false },
        { id: 'SOURCE:111222333444', type: 'SOURCE', label: 'src/App.tsx', charCount: 100, masked: false },
      ],
      fileRefs: ['file:src/App.tsx:1'],
      totalChars: 135,
      estimatedInputTokens: 34,
      estimatedOutputTokens: 10,
      estimatedCostUsd: 0.00001,
      provider: 'openai',
      model: 'gpt-4o-mini',
      maskedSecrets: 0,
      localOnly: true,
      copyablePrompt: 'QUESTION:\nexplain this code\n\n---BEGIN CONTEXT---\nVIEW: code\n---END CONTEXT---',
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      const path = url.pathname
      if (path === '/api/projects/7') return jsonResponse({ id: 7, name: 'fixture', currentSnapshot: { id: 70 } })
    if (path === '/api/projects/7/snapshots') return jsonResponse([])
    if (path === '/api/ai/status') {
        return jsonResponse({ configured: true, provider: 'mock' })
      }
      if (path === '/api/ai/budget') return jsonResponse(webBudget)
      if (path === '/api/csrf') return new Response(null, { status: 204 })
      if (path === '/api/projects/7/files') return jsonResponse([])
      if (path === '/api/projects/7/ai/preview') {
        return jsonResponse(previewResponse)
      }
      if (path === '/api/projects/7/ai/request-plan') return jsonResponse(requestPlan(JSON.parse(init?.body as string)))
      if (path === '/api/projects/7/ai/ask/stream') {
        const payload = [
          'event: token',
          'data: result text',
          '',
          'event: result',
          `data: ${JSON.stringify(askResponse)}`,
          '',
        ].join('\n')
        return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return jsonResponse({ title: 'Not Found', detail: path }, 404)
    })

    renderCode()
    await screen.findByText('AI Assistant')

    // Type a question
    const input = screen.getByLabelText('AI 질문 입력')
    fireEvent.change(input, { target: { value: 'explain this code' } })

    // Click preview button
    const previewBtn = screen.getByTitle('Preview what will be sent')
    fireEvent.click(previewBtn)

    // Wait for preview to appear
    await screen.findByText('Context Preview')

    // Expand the context items details
    const details = screen.getByText(/Context items/)
    fireEvent.click(details)

    // Uncheck the SOURCE item (third checkbox - exclude it)
    const sourceCheckbox = await screen.findByLabelText('Include SOURCE: src/App.tsx')
    fireEvent.click(sourceCheckbox)

    // Now submit the question
    const sendButton = screen.getByRole('button', { name: '요청 확인' })
    fireEvent.click(sendButton)
    await confirmRequest()

    // Verify the ask/stream request was made with excludedContextIds
    await waitFor(() => {
      const streamCalls = fetchMock.mock.calls.filter(
        (call) => requestUrl(call[0]).pathname === '/api/projects/7/ai/ask/stream'
      )
      expect(streamCalls).toHaveLength(1)
      const body = JSON.parse(streamCalls[0][1]?.body as string)
      expect(body.excludedContextIds).toEqual(['SOURCE:111222333444'])
      const plannedBody = JSON.parse(endpointCalls('/ai/request-plan')[0][1]?.body as string)
      expect(body).toEqual({ ...plannedBody, requestPlanToken: 'synthetic-plan-token' })
    })
  })
})

describe('AiPanel request plan approval lifecycle', () => {
  it('allows one plan and one transmission for duplicate same-tick submit and confirmation', async () => {
    const stream = deferred<Response>()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => requestUrl(input).pathname.endsWith('/ai/ask/stream')
      ? stream.promise : original(input, init))
    renderCode()
    const input = await screen.findByLabelText('AI 질문 입력')
    fireEvent.change(input, { target: { value: 'Only one request' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '요청 확인' })).toBeEnabled())
    act(() => { fireEvent.submit(input.closest('form')!); fireEvent.submit(input.closest('form')!) })
    const confirm = await screen.findByRole('button', { name: '확인 후 전송' })
    expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm) })
    await waitFor(() => expect(endpointCalls('/ai/ask/stream')).toHaveLength(1))
    expect(screen.queryByRole('button', { name: '확인 후 전송' })).not.toBeInTheDocument()
    expect(input).toBeDisabled()
    await act(async () => { stream.resolve(new Response(`event: result\ndata: ${JSON.stringify(askResponse)}\n\n`)) })
    expect(await screen.findByText('App stores the counter in memory.')).toBeInTheDocument()
    expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(1)
    expect(endpointCalls('/ai/ask')).toHaveLength(0)
  })

  it('does not revive an approved draft after editing the question and changing it back', async () => {
    renderCode()
    const input = await reviewQuestion('Original question')
    fireEvent.change(input, { target: { value: 'Different question' } })
    fireEvent.change(input, { target: { value: 'Original question' } })
    expect(screen.queryByRole('button', { name: '확인 후 전송' })).not.toBeInTheDocument()
    expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '요청 확인' }))
    await confirmRequest()
    await waitFor(() => expect(endpointCalls('/ai/ask/stream')).toHaveLength(1))
    expect(JSON.parse(endpointCalls('/ai/ask/stream')[0][1]?.body as string).requestPlanToken).toBe('synthetic-plan-2')
  })

  const changes: Array<Partial<ReturnType<typeof useUiStore.getState>>> = [
    { focusedFile: 'src/Other.tsx' },
    { focusedNode: { id: 123, name: 'Changed node', nodeType: 'METHOD', filePath: null, lineStart: null } },
    { focusedCommitSha: 'b'.repeat(40) }, { focusedFindingId: 12 }, { focusedNoteId: 13 },
    { focusedTaskId: 14 }, { pendingIntent: 'REVIEW' },
    { selectedAreas: ['BACKEND'] },
  ]
  for (const change of changes) {
    it(`invalidates a plan when ${Object.keys(change)[0]} changes`, async () => {
      renderCode()
      await reviewQuestion()
      act(() => useUiStore.setState(change))
      await waitFor(() => expect(screen.queryByRole('button', { name: '확인 후 전송' })).not.toBeInTheDocument())
      expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
      expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
    })
  }

  it('invalidates a plan when preview exclusions change and preserves them in the new plan', async () => {
    previewPayload = selectionPreview()
    await previewAndExcludeSource()
    fireEvent.click(screen.getByRole('button', { name: '요청 확인' }))
    await screen.findByRole('button', { name: '확인 후 전송' })
    fireEvent.click(screen.getByLabelText('Include VIEW: code'))
    expect(screen.queryByRole('button', { name: '확인 후 전송' })).not.toBeInTheDocument()
    expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '요청 확인' }))
    await screen.findByRole('button', { name: '확인 후 전송' })
    expect(JSON.parse(endpointCalls('/ai/request-plan')[1][1]?.body as string).excludedContextIds).toEqual(['SOURCE:before', 'VIEW:stable'])
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
  })

  it('checks live context before confirmation even when its React render is still batched', async () => {
    renderCode()
    await reviewQuestion()
    const confirm = screen.getByRole('button', { name: '확인 후 전송' })
    act(() => {
      useUiStore.setState({ focusedTaskId: 777 })
      fireEvent.click(confirm)
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: '확인 후 전송' })).not.toBeInTheDocument())
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
    expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
  })

  it('drops an old slow plan response after a newer question has a plan', async () => {
    const old = deferred<Response>()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).pathname.endsWith('/ai/request-plan')) {
        const body = JSON.parse(init?.body as string)
        return body.question === 'Older question' ? old.promise : Promise.resolve(jsonResponse(requestPlan(body, 'newer-plan')))
      }
      return original(input, init)
    })
    renderCode()
    const input = await screen.findByLabelText('AI 질문 입력')
    fireEvent.change(input, { target: { value: 'Older question' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '요청 확인' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '요청 확인' }))
    await waitFor(() => expect(endpointCalls('/ai/request-plan')).toHaveLength(1))
    fireEvent.change(input, { target: { value: 'Newer question' } })
    fireEvent.click(screen.getByRole('button', { name: '요청 확인' }))
    await screen.findByRole('button', { name: '확인 후 전송' })
    await act(async () => { old.resolve(jsonResponse(requestPlan({ question: 'Older question' }, 'older-plan'))) })
    const plan = screen.getByRole('region', { name: 'AI 요청 전송 확인' })
    expect(plan).toHaveTextContent('Newer question')
    expect(plan).not.toHaveTextContent('Older question')
    await confirmRequest()
    await waitFor(() => expect(endpointCalls('/ai/ask/stream')).toHaveLength(1))
    expect(JSON.parse(endpointCalls('/ai/ask/stream')[0][1]?.body as string).requestPlanToken).toBe('newer-plan')
  })

  it('ignores a pending plan response after unmount without sending it', async () => {
    const pending = deferred<Response>()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => requestUrl(input).pathname.endsWith('/ai/request-plan')
      ? pending.promise : original(input, init))
    const { unmount } = renderCode()
    const quick = await screen.findByRole('button', { name: '쉽게 설명' })
    await waitFor(() => expect(quick).toBeEnabled())
    fireEvent.click(quick)
    await waitFor(() => expect(endpointCalls('/ai/request-plan')).toHaveLength(1))
    unmount()
    await act(async () => { pending.resolve(jsonResponse(requestPlan({ question: 'Unmounted' }))) })
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
  })

  it('requires a new confirmation after local-only mode is toggled on and off', async () => {
    renderCode()
    await reviewQuestion()
    const local = screen.getByLabelText('Local data only (no external AI)')
    fireEvent.click(local)
    fireEvent.click(local)
    expect(screen.queryByRole('button', { name: '확인 후 전송' })).not.toBeInTheDocument()
    expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
  })

  it('rejects expiry at confirmation time without obtaining or transmitting a replacement plan', async () => {
    renderCode()
    await reviewQuestion()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    fireEvent.click(screen.getByRole('button', { name: '확인 후 전송' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('요청 계획이 만료되었습니다')
    expect(screen.getByRole('button', { name: '확인 후 전송' })).toBeDisabled()
    expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
  })

  for (const status of [403, 503]) {
    it(`does not retry or execute a failed ${status} plan`, async () => {
      const original = fetchMock.getMockImplementation()!
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => requestUrl(input).pathname.endsWith('/ai/request-plan')
        ? Promise.resolve(jsonResponse({ detail: 'Synthetic private error detail' }, status)) : original(input, init))
      renderCode()
      const quick = await screen.findByRole('button', { name: '쉽게 설명' })
      await waitFor(() => expect(quick).toBeEnabled())
      fireEvent.click(quick)
      expect(await screen.findByRole('alert')).toHaveTextContent('자동으로 다시 요청하지 않았습니다')
      expect(document.body).not.toHaveTextContent('Synthetic private error detail')
      expect(screen.queryByRole('button', { name: '확인 후 전송' })).not.toBeInTheDocument()
      expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
      expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
    })
  }

  for (const missingBody of [true, false]) {
    it(`consumes approval and reports an uncertain stream outcome without replay (missingBody=${missingBody})`, async () => {
      const original = fetchMock.getMockImplementation()!
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => requestUrl(input).pathname.endsWith('/ai/ask/stream')
        ? Promise.resolve(new Response(missingBody ? null : 'event: token\ndata: partial answer\n\n')) : original(input, init))
      renderCode()
      await reviewQuestion()
      await confirmRequest()
      expect(await screen.findByRole('alert')).toHaveTextContent('요청 결과를 확인할 수 없습니다')
      expect(screen.queryByRole('button', { name: '확인 후 전송' })).not.toBeInTheDocument()
      expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
      expect(endpointCalls('/ai/ask/stream')).toHaveLength(1)
      expect(endpointCalls('/ai/ask')).toHaveLength(0)
    })
  }

  it('binds follow-up conversation IDs to their project and invalidates plans on navigation', async () => {
    const { router } = renderCode()
    await reviewQuestion()
    await confirmRequest()
    await screen.findByText('App stores the counter in memory.')
    await reviewQuestion('Follow up')
    expect(JSON.parse(endpointCalls('/ai/request-plan')[1][1]?.body as string).conversationId).toBe(9)
    await act(async () => { await router.navigate('/projects/8/code') })
    await waitFor(() => expect(screen.queryByRole('button', { name: '확인 후 전송' })).not.toBeInTheDocument())
    expect(screen.queryByText('App stores the counter in memory.')).not.toBeInTheDocument()
    await reviewQuestion('Other project')
    const calls = endpointCalls('/ai/request-plan')
    expect(requestUrl(calls[2][0]).pathname).toBe('/api/projects/8/ai/request-plan')
    expect(JSON.parse(calls[2][1]?.body as string).conversationId).toBeNull()
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(1)
  })
})

describe('AiPanel local preview scope', () => {
  async function preparePreview() {
    previewPayload = selectionPreview()
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const rendered = renderCode()
    const input = await screen.findByLabelText('AI 질문 입력')
    fireEvent.change(input, { target: { value: 'Original preview question' } })
    fireEvent.click(screen.getByTitle('Preview what will be sent'))
    await screen.findByRole('button', { name: 'Prompt 복사' })
    return { ...rendered, input, writeText }
  }

  for (const excludeSource of [false, true]) {
    it(`does not copy or refetch an old project preview after navigation (excluded=${excludeSource})`, async () => {
      previewPayload = selectionPreview('SOURCE:before', 'Synthetic project seven source')
      const writeText = vi.fn(() => Promise.resolve())
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      const { router } = renderCode()
      const input = await screen.findByLabelText('AI 질문 입력')
      fireEvent.change(input, { target: { value: 'Preview project seven' } })
      fireEvent.click(screen.getByTitle('Preview what will be sent'))
      await screen.findByRole('button', { name: 'Prompt 복사' })
      if (excludeSource) fireEvent.click(screen.getByLabelText('Include SOURCE: src/App.tsx'))
      await act(async () => { await router.navigate('/projects/8/code') })
      await act(async () => {
        const staleCopy = screen.queryByRole('button', { name: 'Prompt 복사' })
        if (staleCopy) fireEvent.click(staleCopy)
      })
      expect(writeText).not.toHaveBeenCalled()
      expect(endpointCalls('/ai/preview')).toHaveLength(1)
      expect(screen.queryByText('Context Preview')).not.toBeInTheDocument()
    })
  }

  it('discards a filtered copy response when the project changes before it reaches the clipboard', async () => {
    previewPayload = selectionPreview()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { router } = renderCode()
    const input = await screen.findByLabelText('AI 질문 입력')
    fireEvent.change(input, { target: { value: 'Filter project seven' } })
    fireEvent.click(screen.getByTitle('Preview what will be sent'))
    fireEvent.click(await screen.findByLabelText('Include SOURCE: src/App.tsx'))
    const pending = deferred<Response>()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((request: RequestInfo | URL, init?: RequestInit) => requestUrl(request).pathname.endsWith('/ai/preview')
      ? pending.promise : original(request, init))
    fireEvent.click(screen.getByRole('button', { name: 'Prompt 복사' }))
    await waitFor(() => expect(endpointCalls('/ai/preview')).toHaveLength(2))
    await act(async () => { await router.navigate('/projects/8/code') })
    await act(async () => { pending.resolve(jsonResponse(selectionPreview('SOURCE:before', 'Late synthetic project seven source'))) })
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByText('Context Preview')).not.toBeInTheDocument()
  })

  it('does not revive preview/copy when a changed question is changed back', async () => {
    const { input, writeText } = await preparePreview()
    fireEvent.change(input, { target: { value: 'Different question' } })
    fireEvent.change(input, { target: { value: 'Original preview question' } })
    expect(screen.queryByText('Context Preview')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Prompt 복사' })).not.toBeInTheDocument()
    expect(writeText).not.toHaveBeenCalled()
    expect(endpointCalls('/ai/preview')).toHaveLength(1)
    fireEvent.click(screen.getByTitle('Preview what will be sent'))
    await screen.findByRole('button', { name: 'Prompt 복사' })
    expect(endpointCalls('/ai/preview')).toHaveLength(2)
  })

  const changes: Array<Partial<ReturnType<typeof useUiStore.getState>>> = [
    { focusedFile: 'src/Other.tsx' }, { focusedNoteId: 55 }, { focusedTaskId: 56 },
    { selectedAreas: ['BACKEND'] }, { pendingIntent: 'REVIEW' },
  ]
  for (const change of changes) {
    it(`blocks same-tick copy and removes old preview when ${Object.keys(change)[0]} changes`, async () => {
      const { writeText } = await preparePreview()
      const copy = screen.getByRole('button', { name: 'Prompt 복사' })
      act(() => { useUiStore.setState(change); fireEvent.click(copy) })
      expect(writeText).not.toHaveBeenCalled()
      await waitFor(() => expect(screen.queryByText('Context Preview')).not.toBeInTheDocument())
      expect(endpointCalls('/ai/preview')).toHaveLength(1)
    })
  }

  it('keeps exclusion editing and never copies the previous selection during a batched update', async () => {
    const { writeText } = await preparePreview()
    const copy = screen.getByRole('button', { name: 'Prompt 복사' })
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).pathname.endsWith('/ai/preview')) {
        expect(JSON.parse(init?.body as string).excludedContextIds).toEqual(['SOURCE:before'])
        return Promise.resolve(jsonResponse(selectionPreview('SOURCE:before', 'Filtered selection only')))
      }
      return original(input, init)
    })
    act(() => { fireEvent.click(screen.getByLabelText('Include SOURCE: src/App.tsx')); fireEvent.click(copy) })
    await act(async () => {})
    expect(writeText.mock.calls.every(call => String(call[0]) === 'Filtered selection only')).toBe(true)
    expect(screen.getByLabelText('Include SOURCE: src/App.tsx')).not.toBeChecked()
    if (writeText.mock.calls.length === 0) fireEvent.click(screen.getByRole('button', { name: 'Prompt 복사' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('Filtered selection only'))
  })

  it('drops a late preview after project navigation', async () => {
    const pending = deferred<Response>()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => requestUrl(input).pathname.endsWith('/ai/preview')
      ? pending.promise : original(input, init))
    const { router } = renderCode()
    const input = await screen.findByLabelText('AI 질문 입력')
    fireEvent.change(input, { target: { value: 'Previous project' } })
    fireEvent.click(screen.getByTitle('Preview what will be sent'))
    await waitFor(() => expect(endpointCalls('/ai/preview')).toHaveLength(1))
    await act(async () => { await router.navigate('/projects/8/code') })
    await act(async () => { pending.resolve(jsonResponse(selectionPreview('SOURCE:late', 'Late previous project'))) })
    expect(screen.queryByText('Context Preview')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Prompt 복사' })).not.toBeInTheDocument()
    expect(input).toBeEnabled()
  })

  it('keeps a newer question preview when an older preview response arrives last', async () => {
    const pending = deferred<Response>()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).pathname.endsWith('/ai/preview')) {
        const body = JSON.parse(init?.body as string)
        return body.question === 'Old question' ? pending.promise
          : Promise.resolve(jsonResponse(selectionPreview('SOURCE:new', 'New question preview')))
      }
      return original(input, init)
    })
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderCode()
    const input = await screen.findByLabelText('AI 질문 입력')
    fireEvent.change(input, { target: { value: 'Old question' } })
    fireEvent.click(screen.getByTitle('Preview what will be sent'))
    await waitFor(() => expect(endpointCalls('/ai/preview')).toHaveLength(1))
    fireEvent.change(input, { target: { value: 'New question' } })
    fireEvent.click(screen.getByTitle('Preview what will be sent'))
    await screen.findByRole('button', { name: 'Prompt 복사' })
    await act(async () => { pending.resolve(jsonResponse(selectionPreview('SOURCE:old', 'Old question preview'))) })
    fireEvent.click(screen.getByRole('button', { name: 'Prompt 복사' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('New question preview'))
  })

  it('does not let an old filtered copy overwrite a newer scope copy', async () => {
    const { input, writeText } = await preparePreview()
    fireEvent.click(screen.getByLabelText('Include SOURCE: src/App.tsx'))
    const pending = deferred<Response>()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((request: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(request).pathname.endsWith('/ai/preview')) {
        const body = JSON.parse(init?.body as string)
        return body.question === 'Original preview question' ? pending.promise
          : Promise.resolve(jsonResponse(selectionPreview('SOURCE:before', 'New scope filtered content')))
      }
      return original(request, init)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Prompt 복사' }))
    await waitFor(() => expect(endpointCalls('/ai/preview')).toHaveLength(2))
    // A controlled input can also change during an in-flight operation; do not trust only disabled UI.
    fireEvent.change(input, { target: { value: 'New scope question' } })
    fireEvent.click(screen.getByTitle('Preview what will be sent'))
    fireEvent.click(await screen.findByRole('button', { name: 'Prompt 복사' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('New scope filtered content'))
    await act(async () => { pending.resolve(jsonResponse(selectionPreview('SOURCE:before', 'Old filtered content'))) })
    expect(writeText).toHaveBeenCalledExactlyOnceWith('New scope filtered content')
  })

  it('ignores a filtered copy response after unmount', async () => {
    const { unmount, writeText } = await preparePreview()
    fireEvent.click(screen.getByLabelText('Include SOURCE: src/App.tsx'))
    const pending = deferred<Response>()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((request: RequestInfo | URL, init?: RequestInit) => requestUrl(request).pathname.endsWith('/ai/preview')
      ? pending.promise : original(request, init))
    fireEvent.click(screen.getByRole('button', { name: 'Prompt 복사' }))
    await waitFor(() => expect(endpointCalls('/ai/preview')).toHaveLength(2))
    unmount()
    await act(async () => { pending.resolve(jsonResponse(selectionPreview())) })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('does not report old copy success after an already-started native write completes in another scope', async () => {
    const { router, writeText } = await preparePreview()
    const nativeWrite = deferred<void>()
    writeText.mockImplementation(() => nativeWrite.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Prompt 복사' }))
    expect(writeText).toHaveBeenCalledTimes(1)
    await act(async () => { await router.navigate('/projects/8/code') })
    await act(async () => { nativeWrite.resolve(undefined) })
    expect(screen.queryByRole('button', { name: 'Prompt 복사됨' })).not.toBeInTheDocument()
    expect(screen.queryByText('Context Preview')).not.toBeInTheDocument()
    // The native call already started while its scope was valid; this test makes no cancellation claim.
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})

describe('AiPanel strict maximum reservation confirmation', () => {
  const model = 'gpt-4o-mini-2024-07-18'
  let client: QueryClient
  let budget: AiBudgetView
  let cost: AiRequestPlanResponse['cost']
  let costStatus: AiRequestPlanResponse['costStatus']
  let budgetFailure: boolean

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
    budget = { available: true, state: 'READY', policyRevision: '7', activationToken: null, dailyLimitMicroUsd: '9223372036854775807',
      monthlyLimitMicroUsd: '9223372036854775807', allDatesHeldMicroUsd: '0', dailySettledMicroUsd: '0',
      monthlySettledMicroUsd: '0', supportedModels: [model] }
    cost = { reservedMicroUsd: '9007199254740993', inputTokenUpperBound: '128000', outputTokenMax: '2048',
      priceVersion: 'synthetic-v1', validUntil: new Date(Date.now() + 60_000).toISOString(), policyRevision: '7' }
    costStatus = 'AVAILABLE'; budgetFailure = false
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname
      if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'openai', model, blockedReason: null })
      if (path === '/api/ai/budget') return budgetFailure ? jsonResponse({ detail: 'Synthetic unavailable' }, 503) : jsonResponse(budget)
      if (path.endsWith('/ai/request-plan')) {
        planCount += 1
        return jsonResponse({ ...requestPlan(JSON.parse(init?.body as string)), provider: 'openai', model,
          expiresAt: new Date(Date.now() + 300_000).toISOString(), costStatus, cost: costStatus === 'AVAILABLE' ? cost : null })
      }
      return fallback(input, init)
    })
  })
  afterEach(() => { client.clear() })

  async function renderPriced() {
    const router = createMemoryRouter([{ path: '*', element: <AiPanel /> }], { initialEntries: ['/projects/7/code'] })
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
    await waitFor(() => expect(client.getQueryState(AI_BUDGET_QUERY_KEY)?.fetchStatus).toBe('idle'))
  }

  it('shows an exact maximum, the whole-context input bound and price terms before one explicit send', async () => {
    await renderPriced(); await reviewQuestion()
    expect(screen.getByText('최대 예약액 (USD): $9007199254.740993')).toBeInTheDocument()
    expect(screen.getByText(/실제 청구액의 추정치가 아닙니다/)).toBeInTheDocument()
    expect(screen.getByText('128000')).toBeInTheDocument()
    expect(screen.getByText('2048')).toBeInTheDocument()
    expect(screen.getByText('synthetic-v1')).toBeInTheDocument()
    expect(screen.queryByText(/비용 계산과 예약 금액은 아직 제공되지 않습니다/)).not.toBeInTheDocument()
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
    const confirm = screen.getByRole('button', { name: '확인 후 전송' })
    await waitFor(() => expect(confirm).toBeEnabled())
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm) })
    await waitFor(() => expect(endpointCalls('/ai/ask/stream')).toHaveLength(1))
  })

  for (const state of ['OFF', 'RECOVERY_REQUIRED'] as const) {
    it(`blocks confirmation when the authoritative budget is ${state} despite cached configured status`, async () => {
      await renderPriced(); await reviewQuestion()
      await act(async () => { client.setQueryData(AI_BUDGET_QUERY_KEY, { ...budget, state }) })
      const confirm = screen.getByRole('button', { name: '확인 후 전송' })
      await waitFor(() => expect(confirm).toBeDisabled()); fireEvent.click(confirm)
      expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
      expect(screen.getByText(/현재 예산을 확인하지 못했습니다/)).toBeInTheDocument()
    })
  }

  for (const mismatch of ['revision', 'model'] as const) {
    it(`blocks a mismatched ${mismatch} without sending`, async () => {
      budget = mismatch === 'revision' ? { ...budget, policyRevision: '8' } : { ...budget, supportedModels: ['synthetic-other-model'] }
      await renderPriced(); await reviewQuestion()
      expect(screen.getByRole('button', { name: '확인 후 전송' })).toBeDisabled()
      expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
    })
  }

  it('does not confirm AVAILABLE costs when the budget read fails', async () => {
    await renderPriced(); await reviewQuestion()
    budgetFailure = true
    await act(async () => { await client.invalidateQueries({ queryKey: AI_BUDGET_QUERY_KEY }) })
    await waitFor(() => expect(screen.getByRole('button', { name: '확인 후 전송' })).toBeDisabled())
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
  })

  it('does not downgrade an available strict budget to the web UNAVAILABLE path', async () => {
    costStatus = 'UNAVAILABLE'
    await renderPriced(); await reviewQuestion()
    expect(screen.getByRole('button', { name: '확인 후 전송' })).toBeDisabled()
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
  })

  it('does not revive approval when a policy revision changes and changes back', async () => {
    await renderPriced(); await reviewQuestion()
    const confirm = screen.getByRole('button', { name: '확인 후 전송' })
    expect(confirm).toBeEnabled()
    await act(async () => { client.setQueryData(AI_BUDGET_QUERY_KEY, { ...budget, policyRevision: '8' }) })
    await waitFor(() => expect(confirm).toBeDisabled())
    await act(async () => { client.setQueryData(AI_BUDGET_QUERY_KEY, budget) })
    expect(confirm).toBeDisabled(); fireEvent.click(confirm)
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
  })

  it('checks the live cache when OFF arrives in the same tick as confirmation', async () => {
    await renderPriced(); await reviewQuestion()
    const confirm = screen.getByRole('button', { name: '확인 후 전송' })
    act(() => {
      client.setQueryData(AI_BUDGET_QUERY_KEY, { ...budget, state: 'OFF' })
      fireEvent.click(confirm)
    })
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
  })

  it('checks the earlier price expiry at confirmation even when the request token is still valid', async () => {
    await renderPriced(); await reviewQuestion()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    fireEvent.click(screen.getByRole('button', { name: '확인 후 전송' }))
    expect(await screen.findByText(/요청 계획이 만료되었습니다/)).toBeInTheDocument()
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
    expect(planCount).toBe(1)
  })

  for (const state of ['OFF', 'RECOVERY_REQUIRED'] as const) {
    it(`M1 blocks preparing remote requests with configured=true and budget ${state}, but preserves local copy`, async () => {
      budget.state = state
      previewPayload = selectionPreview()
      const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      await renderPriced()
      const input = await screen.findByLabelText('AI 질문 입력')
      fireEvent.change(input, { target: { value: 'Synthetic local question' } })
      const prepare = screen.getByRole('button', { name: '요청 확인' })
      expect(prepare).toBeDisabled()
      expect(screen.getByRole('link', { name: '설정 열기' })).toHaveAttribute('href', '/settings')
      fireEvent.submit(prepare.closest('form')!)
      expect(endpointCalls('/ai/request-plan')).toHaveLength(0)
      fireEvent.click(screen.getByTitle('Preview what will be sent'))
      fireEvent.click(await screen.findByRole('button', { name: 'Prompt 복사' }))
      await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(selectionPreview().copyablePrompt))
      expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
    })
  }

  it('M1 blocks preparation and links Settings when a configured desktop budget cannot be read', async () => {
    budgetFailure = true
    await renderPriced()
    fireEvent.change(await screen.findByLabelText('AI 질문 입력'), { target: { value: 'Synthetic question' } })
    expect(screen.getByRole('button', { name: '요청 확인' })).toBeDisabled()
    expect(screen.getByRole('link', { name: '설정 열기' })).toHaveAttribute('href', '/settings')
    expect(endpointCalls('/ai/request-plan')).toHaveLength(0)
  })

  it('M1 waits for a successful initial budget read before permitting any remote preparation', async () => {
    const pending = deferred<Response>()
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => requestUrl(input).pathname === '/api/ai/budget'
      ? pending.promise : fallback(input, init))
    const rendering = renderPriced()
    fireEvent.change(await screen.findByLabelText('AI 질문 입력'), { target: { value: 'Synthetic question' } })
    const prepare = screen.getByRole('button', { name: '요청 확인' })
    expect(prepare).toBeDisabled(); fireEvent.submit(prepare.closest('form')!)
    expect(screen.getByTitle('Preview what will be sent')).toBeEnabled()
    expect(endpointCalls('/ai/request-plan')).toHaveLength(0)
    await act(async () => { pending.resolve(jsonResponse(budget)) })
    await rendering
    await waitFor(() => expect(prepare).toBeEnabled())
    expect(endpointCalls('/ai/request-plan')).toHaveLength(0)
  })

  it('M2 refreshes authoritative budget/status/settings after an uncertain ask without resending', async () => {
    const pendingStream = deferred<Response>()
    const pendingBudget = deferred<Response>()
    const fallback = fetchMock.getMockImplementation()!
    let budgetReads = 0
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname
      if (path === '/api/ai/budget' && ++budgetReads > 1) return pendingBudget.promise
      if (path.endsWith('/ai/ask/stream')) return pendingStream.promise
      return fallback(input, init)
    })
    await renderPriced(); await reviewQuestion()
    client.setQueryData(['ai-settings'], { state: 'ENABLED', keySet: true })
    await confirmRequest()
    await waitFor(() => expect(endpointCalls('/ai/ask/stream')).toHaveLength(1))
    await act(async () => { pendingStream.resolve(new Response('event: token\ndata: partial\n\n')) })
    await screen.findByText(/요청 결과를 확인할 수 없습니다/)
    await waitFor(() => expect(budgetReads).toBe(2))
    fireEvent.change(screen.getByLabelText('AI 질문 입력'), { target: { value: 'Next synthetic question' } })
    expect(screen.getByRole('button', { name: '요청 확인' })).toBeDisabled()
    previewPayload = selectionPreview()
    const localPreview = screen.getByTitle('Preview what will be sent')
    expect(localPreview).toBeEnabled()
    fireEvent.click(localPreview)
    await screen.findByText('Context Preview')
    budget = { ...budget, state: 'OFF', allDatesHeldMicroUsd: '20429' }
    await act(async () => { pendingBudget.resolve(jsonResponse(budget)) })
    await waitFor(() => expect(client.getQueryData(AI_BUDGET_QUERY_KEY)).toMatchObject({ state: 'OFF', allDatesHeldMicroUsd: '20429' }))
    expect(endpointCalls('/api/ai/status').length).toBeGreaterThan(1)
    expect(client.getQueryState(['ai-settings'])?.isInvalidated).toBe(true)
    expect(screen.getByRole('button', { name: '요청 확인' })).toBeDisabled()
    expect(screen.getByRole('link', { name: '설정 열기' })).toBeInTheDocument()
    expect(planCount).toBe(1)
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(1)
  })

  it('M2 refreshes settled balances after ask success without additional execution', async () => {
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).pathname.endsWith('/ai/ask/stream')) budget = { ...budget, dailySettledMicroUsd: '20429' }
      return fallback(input, init)
    })
    await renderPriced(); await reviewQuestion(); await confirmRequest()
    await screen.findByText(askResponse.explanation)
    await waitFor(() => expect(client.getQueryData(AI_BUDGET_QUERY_KEY)).toMatchObject({ dailySettledMicroUsd: '20429' }))
    expect(endpointCalls('/api/ai/status').length).toBeGreaterThan(1)
    expect(planCount).toBe(1)
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(1)
  })

  it('M2 refreshes an OFF latch after plan failure and does not automatically prepare again', async () => {
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).pathname.endsWith('/ai/request-plan')) {
        budget = { ...budget, state: 'OFF' }
        return Promise.resolve(jsonResponse({ detail: 'Synthetic plan denied' }, 503))
      }
      return fallback(input, init)
    })
    await renderPriced()
    fireEvent.change(await screen.findByLabelText('AI 질문 입력'), { target: { value: 'Synthetic question' } })
    const prepare = screen.getByRole('button', { name: '요청 확인' })
    await waitFor(() => expect(prepare).toBeEnabled())
    fireEvent.click(prepare)
    await waitFor(() => expect(client.getQueryData(AI_BUDGET_QUERY_KEY)).toMatchObject({ state: 'OFF' }))
    expect(prepare).toBeDisabled()
    expect(screen.getByRole('link', { name: '설정 열기' })).toBeInTheDocument()
    expect(endpointCalls('/ai/request-plan')).toHaveLength(1)
    expect(endpointCalls('/ai/ask/stream')).toHaveLength(0)
  })
})
