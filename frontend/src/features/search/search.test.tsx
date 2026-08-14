import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { SearchResponse } from '../../api/types'

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
  ],
}

const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/ai/status') return jsonResponse({ configured: false, provider: null })
    if (path === '/api/search') return jsonResponse(results)
    if (path === '/api/projects/7/notes') return jsonResponse([])
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderSearch() {
  const router = createMemoryRouter(routes, { initialEntries: ['/search'] })
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
})
