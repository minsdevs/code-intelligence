import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { FeatureChildView, FeatureDetailView } from '../../api/types'

vi.mock('@monaco-editor/react', () => ({
  default: () => null,
  DiffEditor: () => null,
}))

vi.mock('@xyflow/react', () => ({
  ReactFlow: () => null,
  Background: () => null,
  Controls: () => null,
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

const tree: FeatureChildView[] = [
  {
    id: 1,
    name: 'Todos',
    detection: 'ROUTE_PREFIX',
    confidence: 0.8,
    children: [
      {
        id: 2,
        name: 'Todo list',
        detection: 'ENDPOINT',
        confidence: 0.9,
        children: [],
      },
    ],
  },
]

const detail: FeatureDetailView = {
  id: 1,
  name: 'Todos',
  detection: 'ROUTE_PREFIX',
  confidence: 0.8,
  links: [{ role: 'UI', nodeId: 11, name: 'TodosPage', filePath: 'src/pages/TodosPage.tsx' }],
  evidences: [
    {
      filePath: 'src/pages/TodosPage.tsx',
      lineStart: 4,
      lineEnd: 8,
      excerpt: 'fetch("/api/todos")',
    },
  ],
}

const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/projects/7/areas') {
      return jsonResponse([])
    }
    if (path === '/api/projects/7/features') return jsonResponse(tree)
    if (path === '/api/projects/7/features/1') return jsonResponse(detail)
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderFeatures() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/features'] })
  return { router, ...render(<RouterProvider router={router} />) }
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({ aiPanelOpen: true, aiPanelWidth: AI_PANEL_DEFAULT_WIDTH, selectedAreas: [] })
  fetchMock.mockReset()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FeaturesPage', () => {
  it('renders the feature tree and detail, then navigates to code', async () => {
    const { router } = renderFeatures()

    expect(await screen.findByRole('heading', { level: 2, name: 'Features' })).toBeInTheDocument()
    expect(await screen.findByText('Todos')).toBeInTheDocument()
    expect(screen.getByText('Todo list')).toBeInTheDocument()
    expect(await screen.findByRole('article', { name: 'Feature detail' })).toHaveTextContent('TodosPage')
    fireEvent.click(within(screen.getByRole('article', { name: 'Feature detail' })).getByRole('button', { name: /UI ·/ }))
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/7/code')
      expect(router.state.location.search).toBe('?path=src%2Fpages%2FTodosPage.tsx')
    })
  })
})
