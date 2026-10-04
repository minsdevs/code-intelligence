import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { PullRequest, ReviewView } from '../../api/types'

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

const pulls: PullRequest[] = [
  {
    number: 12,
    title: 'Add login',
    body: 'changes App',
    state: 'open',
    author: 'octocat',
    mergedAt: null,
    headSha: 'abc',
    baseSha: 'def',
  },
]

const review: ReviewView = {
  id: 1,
  pullNumber: 12,
  summary: 'Look at the login path.',
  origin: 'AI',
  createdAt: '2026-08-14T00:00:00Z',
  comments: [
    {
      id: 9,
      seq: 1,
      filePath: 'src/App.java',
      line: 1,
      severity: 'WARNING',
      body: 'Check this change.',
      confidence: 'CONFIRMED',
      evidence: ['file:src/App.java:1'],
    },
  ],
}

const fetchMock = vi.fn()
let generateStatus = 201

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const path = url.pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'mock' })
    if (path === '/api/csrf') return new Response(null, { status: 204 })
    if (path === '/api/projects/7/pulls') return jsonResponse(pulls)
    if (path === '/api/projects/7/pulls/12/review' && method === 'GET') {
      return jsonResponse(review)
    }
    if (path === '/api/projects/7/pulls/12/review' && method === 'POST')
      return generateStatus === 201
        ? jsonResponse(review, 201)
        : jsonResponse({ title: 'Service Unavailable', detail: 'AI is not configured.' }, generateStatus)
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderReview() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/review'] })
  return { router, ...render(<RouterProvider router={router} />) }
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({
    aiPanelOpen: false,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
  })
  fetchMock.mockReset()
  generateStatus = 201
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ReviewPage', () => {
  it('keeps saved reviews readable and opens approval-based assistance without posting a generation request', async () => {
    const { router } = renderReview()
    expect(await screen.findByText('Look at the login path.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'AI 패널에서 근거 검토' }))
    await waitFor(() => expect(useUiStore.getState().aiPanelOpen).toBe(true))
    expect(useUiStore.getState().focusedFile).toBe('src/App.java')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'src/App.java:1' }))
    expect(router.state.location.pathname).toBe('/projects/7/code')
  })
})
