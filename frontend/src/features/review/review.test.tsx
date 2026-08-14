import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const path = url.pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'mock' })
    if (path === '/api/csrf') return new Response(null, { status: 204 })
    if (path === '/api/projects/7/pulls') return jsonResponse(pulls)
    if (path === '/api/projects/7/pulls/12/review' && method === 'GET') {
      return jsonResponse({ title: 'Not Found', detail: 'Review not found.' }, 404)
    }
    if (path === '/api/projects/7/pulls/12/review' && method === 'POST')
      return jsonResponse(review, 201)
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
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ReviewPage', () => {
  it('lists pull requests and generates an AI review with evidence', async () => {
    const { router } = renderReview()
    expect(await screen.findByRole('heading', { name: 'Add login' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '리뷰 생성' }))
    expect(await screen.findByText('Look at the login path.')).toBeInTheDocument()
    expect(screen.getByText('Check this change.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'src/App.java:1' }))
    expect(router.state.location.pathname).toBe('/projects/7/code')
  })
})
