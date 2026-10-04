import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { FileListItem, PlaygroundSessionView } from '../../api/types'

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

const files: FileListItem[] = [{ path: 'src/App.java', language: 'java', size: 12, lineCount: 1 }]

const asked: PlaygroundSessionView = {
  id: 3,
  title: 'src/App.java',
  selectedPaths: ['src/App.java'],
  proposedSnippet: 'class App {}',
  lastQuestion: 'what does this do?',
  lastExplanation: 'App is a placeholder class.',
  lastClaims: [
    {
      text: 'The focused file exists in the snapshot.',
      confidence: 'CONFIRMED',
      evidence: ['file:src/App.java:1'],
    },
  ],
  updatedAt: '2026-08-14T00:00:00Z',
}

const fetchMock = vi.fn()
let askStatus = 200

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const path = url.pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'mock' })
    if (path === '/api/csrf') return new Response(null, { status: 204 })
    if (path === '/api/projects/7/files') return jsonResponse(files)
    if (path === '/api/projects/7/playground/sessions' && method === 'GET') return jsonResponse([asked])
    if (path === '/api/projects/7/playground/sessions/3' && method === 'GET') return jsonResponse(asked)
    if (path === '/api/projects/7/playground/sessions/3' && method === 'PUT') return jsonResponse(asked)
    if (path === '/api/projects/7/playground/sessions' && method === 'POST') {
      return jsonResponse(
        { ...asked, lastQuestion: null, lastExplanation: null, lastClaims: [] },
        201,
      )
    }
    if (path === '/api/projects/7/playground/sessions/3/ask') {
      return askStatus === 200
        ? jsonResponse(asked)
        : jsonResponse({ title: 'Service Unavailable', detail: 'AI is not configured.' }, askStatus)
    }
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderPlayground() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/playground'] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({
    aiPanelOpen: false,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
  })
  fetchMock.mockReset()
  askStatus = 200
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PlaygroundPage', () => {
  it('loads saved sessions and saves local snippets without an AI request', async () => {
    renderPlayground()
    fireEvent.click(await screen.findByRole('button', { name: 'src/App.java' }))
    expect(await screen.findByText('App is a placeholder class.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '가설 스니펫' })).toHaveValue('class App {}')
    fireEvent.click(screen.getByRole('button', { name: '세션 저장' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true))
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).pathname.endsWith('/ask'))).toBe(false)
    expect(screen.queryByRole('button', { name: /실행/ })).not.toBeInTheDocument()
  })

  it('opens the approval panel with the first selected file without transmitting snippets', async () => {
    renderPlayground()
    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'AI 패널에서 질문 준비' }))
    await waitFor(() => expect(useUiStore.getState().aiPanelOpen).toBe(true))
    expect(useUiStore.getState().focusedFile).toBe('src/App.java')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })
})
