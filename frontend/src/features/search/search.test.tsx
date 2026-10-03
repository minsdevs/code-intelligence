import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { SearchResponse } from '../../api/types'

vi.mock('@monaco-editor/react', () => ({
  default: ({ value }: { value?: string }) => value ?? null,
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

const results: SearchResponse = {
  query: 'Auth',
  groups: [
    {
      type: 'NOTE',
      hits: [
        {
          type: 'NOTE',
          projectId: 7,
          id: 3,
          title: 'Auth notes',
          snippet: 'login flow',
          path: null,
        },
      ],
    },
    {
      type: 'FILE',
      hits: [
        {
          type: 'FILE',
          projectId: 7,
          id: 1,
          title: 'src/App.java',
          snippet: 'java',
          path: 'src/App.java',
        },
      ],
    },
    {
      type: 'SYMBOL',
      hits: [{ type: 'SYMBOL', projectId: 7, id: 2, title: 'Auth symbol', snippet: 'class from analysis', path: 'src/App.java' }],
    },
    {
      type: 'EVIDENCE',
      hits: [{ type: 'EVIDENCE', projectId: 7, id: 9, title: 'Historical Auth evidence', snippet: 'excerpt from snapshot A', path: 'src/App.java' }],
    },
  ],
}

const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/ai/status') return jsonResponse({ configured: false, provider: null })
    if (path === '/api/search') return jsonResponse(results)
    if (path === '/api/projects/7') return jsonResponse({ id: 7, name: 'fixture', currentSnapshot: { id: 70 } })
    if (path === '/api/projects/7/snapshots') return jsonResponse([{ id: 70, status: 'READY', analyzedAt: '2026-10-02T00:00:00Z' }])
    if (path === '/api/projects/7/files') return jsonResponse([{ path: 'src/App.java', language: 'java', size: 40, lineCount: 1, resolvedSnapshotId: 70 }])
    if (path === '/api/projects/7/graph/nodes') return jsonResponse({ items: [], page: 1, size: 100, total: 0 })
    if (path === '/api/projects/7/file-content') return jsonResponse({
      path: 'src/App.java', language: 'java', content: 'class Current_B {}', resolvedSnapshotId: 70,
      contentOid: 'b'.repeat(40), sourceState: 'AVAILABLE', snapshotTime: '2026-10-02T00:00:00Z',
      currentSnapshot: true, evidenceState: null,
    })
    if (path === '/api/projects/7/notes') return jsonResponse([])
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderSearch(entry = '/search') {
  const router = createMemoryRouter(routes, { initialEntries: [entry] })
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

describe('SearchPage', () => {
  it('searches and navigates a note hit into the workspace', async () => {
    const { router } = renderSearch()
    const input = screen.getByRole('searchbox', { name: '통합 검색' })
    expect(input).not.toBeDisabled()
    fireEvent.change(input, { target: { value: 'Auth' } })
    fireEvent.click(screen.getByRole('button', { name: '검색' }))
    expect(await screen.findByRole('heading', { name: /NOTE/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Auth notes/ }))
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/7/notes')
    })
  })

  it('opens a plain file result explicitly as current source', async () => {
    const { router } = renderSearch('/search?q=Auth')
    fireEvent.click(await screen.findByRole('button', { name: /^src\/App.java/ }))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/7/code')
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('path')).toBe('src/App.java')
      expect(params.get('sourceContext')).toBe('current')
    })
    expect(await screen.findByTestId('code-viewer')).toHaveTextContent('Current_B')
    expect(screen.getByTestId('source-context')).toHaveTextContent('현재 소스')
  })

  it.each(['Auth symbol', 'Historical Auth evidence'])(
    'does not substitute current source for a versioned search result: %s',
    async (title) => {
      const { router } = renderSearch('/search?q=Auth')
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${title}`) }))

      expect(await screen.findByTestId('source-unavailable')).toHaveTextContent('SOURCE_CONTEXT_UNKNOWN')
      await screen.findByRole('heading', { name: 'fixture' })
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('path')).toBe('src/App.java')
      expect(params.get('sourceContext')).toBe('unknown')
      expect(params.get('snapshotId')).toBeNull()
      expect(screen.queryByTestId('code-viewer')).not.toBeInTheDocument()
      const sourceRequests = fetchMock.mock.calls
        .map((call) => requestUrl(call[0] as RequestInfo | URL))
        .filter((url) => url.pathname.endsWith('/file-content'))
      expect(sourceRequests).toHaveLength(0)
      expect(screen.getByRole('button', { name: /Open current source/ })).toBeInTheDocument()
    },
  )
})
