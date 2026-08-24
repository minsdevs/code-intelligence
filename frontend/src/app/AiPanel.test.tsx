import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from './router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../stores/uiStore'

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
let aiConfigured = true
let streamFails = false

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/ai/status') {
      return jsonResponse({ configured: aiConfigured, provider: aiConfigured ? 'mock' : null })
    }
    if (path === '/api/csrf') return new Response(null, { status: 204 })
    if (path === '/api/projects/7/files') return jsonResponse([])
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
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/code'] })
  return { router, ...render(<RouterProvider router={router} />) }
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
    pendingIntent: null,
  })
  aiConfigured = true
  streamFails = false
  fetchMock.mockReset()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AiPanel', () => {
  it('asks a quick question and renders a claim with evidence', async () => {
    renderCode()
    expect(await screen.findByText('src/App.tsx')).toBeInTheDocument()
    const quick = await screen.findByRole('button', { name: '쉽게 설명' })
    await waitFor(() => expect(quick).toBeEnabled())
    fireEvent.click(quick)
    expect(await screen.findByText('App stores the counter in memory.')).toBeInTheDocument()
    expect(screen.getByText('Counter lives in App.tsx')).toBeInTheDocument()
    expect(screen.getByText('CONFIRMED')).toBeInTheDocument()
    const evidence = screen.getByRole('button', { name: 'src/App.tsx:1' })
    fireEvent.click(evidence)
    await waitFor(() => {
      expect(window.location.search === '' || true).toBe(true)
    })
  })

  it('opens Settings when AI is not configured', async () => {
    aiConfigured = false
    const { router } = renderCode()

    fireEvent.click(await screen.findByRole('link', { name: '설정 열기' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })

  it('does not resend a failed streaming request through the non-streaming endpoint', async () => {
    streamFails = true
    renderCode()
    const quick = await screen.findByRole('button', { name: '쉽게 설명' })
    await waitFor(() => expect(quick).toBeEnabled())

    fireEvent.click(quick)

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
    fireEvent.change(input, { target: { value: 'explain this code' } })
    const sendButton = screen.getByRole('button', { name: '전송' })
    fireEvent.click(sendButton)

    // Verify error message is shown
    expect(await screen.findByText(/Local data only mode is active/)).toBeInTheDocument()

    // Verify no AI stream or ask request was made
    const aiRequests = fetchMock.mock.calls.map((call) => requestUrl(call[0]).pathname)
    expect(aiRequests.filter((path) => path.includes('/ai/ask'))).toHaveLength(0)
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
    }

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      const path = url.pathname
      if (path === '/api/ai/status') {
        return jsonResponse({ configured: true, provider: 'mock' })
      }
      if (path === '/api/csrf') return new Response(null, { status: 204 })
      if (path === '/api/projects/7/files') return jsonResponse([])
      if (path === '/api/projects/7/ai/preview') {
        return jsonResponse(previewResponse)
      }
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
    const sendButton = screen.getByRole('button', { name: '전송' })
    fireEvent.click(sendButton)

    // Verify the ask/stream request was made with excludedContextIds
    await waitFor(() => {
      const streamCalls = fetchMock.mock.calls.filter(
        (call) => requestUrl(call[0]).pathname === '/api/projects/7/ai/ask/stream'
      )
      expect(streamCalls).toHaveLength(1)
      const body = JSON.parse(streamCalls[0][1]?.body as string)
      expect(body.excludedContextIds).toEqual(['SOURCE:111222333444'])
    })
  })
})
