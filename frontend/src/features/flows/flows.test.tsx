import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { FlowDetail, FlowSummary } from '../../api/types'

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

const summaries: FlowSummary[] = [
  { id: 3, name: 'GET /todos', kind: 'BACKEND', entryNodeId: 9 },
  { id: 4, name: '/todos', kind: 'FE_BE', entryNodeId: 12 },
]

const backendDetail: FlowDetail = {
  id: 3,
  name: 'GET /todos',
  kind: 'BACKEND',
  entryNodeId: 9,
  steps: [
    {
      seq: 1,
      nodeId: 9,
      nodeName: 'TodoController.list',
      nodeType: 'METHOD',
      filePath: 'src/api/TodoController.java',
      line: 14,
      description: null,
    },
  ],
  evidences: [],
}

const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/projects/7') return jsonResponse({ id: 7, name: 'test', currentSnapshot: { id: 100, status: 'DONE' } })
    if (path === '/api/projects/7/flows') {
      const kind = url.searchParams.get('kind')
      return jsonResponse(kind ? summaries.filter((flow) => flow.kind === kind) : summaries)
    }
    if (path === '/api/projects/7/flows/3') return jsonResponse(backendDetail)
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderFlows() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/flows'] })
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

describe('FlowsPage', () => {
  it('filters by kind and opens a step in the code tab', async () => {
    const { router } = renderFlows()

    expect(await screen.findByRole('button', { name: /GET \/todos/ })).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Flow 목록' })
    expect(within(list).getByText('FE_BE')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: /Kind/ }), { target: { value: 'BACKEND' } })
    await waitFor(() => {
      const filtered = screen.getByRole('list', { name: 'Flow 목록' })
      expect(within(filtered).queryByText('FE_BE')).not.toBeInTheDocument()
      expect(within(filtered).getByRole('button', { name: /GET \/todos/ })).toBeInTheDocument()
    })

    fireEvent.click(await screen.findByRole('button', { name: /TodoController.list/ }))
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/7/code')
      expect(router.state.location.search).toBe('?path=src%2Fapi%2FTodoController.java&line=14&sourceContext=unknown')
    })
  })
})
