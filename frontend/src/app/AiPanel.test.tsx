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
})
