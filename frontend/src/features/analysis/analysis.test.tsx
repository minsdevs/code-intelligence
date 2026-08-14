import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { FindingView, GraphNodePage, ImpactView } from '../../api/types'

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

const findings: FindingView[] = [
  {
    id: 5,
    areaType: 'FRONTEND',
    category: 'UNMATCHED_API_CALL',
    severity: 'HIGH',
    title: 'Unmatched GET /api/missing',
    detail: 'No backend endpoint matched this call.',
    status: 'OPEN',
    nodeId: 21,
    evidences: [
      {
        filePath: 'src/pages/TodosPage.tsx',
        lineStart: 4,
        lineEnd: 4,
        excerpt: 'fetch("/api/missing")',
      },
    ],
  },
]

const impact: ImpactView = {
  nodeId: 21,
  depth: 5,
  riskScore: 9,
  riskLevel: 'MEDIUM',
  dependents: [
    {
      depth: 1,
      edgeType: 'CALLS',
      nodeType: 'METHOD',
      nodeId: 30,
      name: 'HomePage.load',
      filePath: 'src/pages/HomePage.tsx',
      line: 8,
    },
  ],
}

const nodes: GraphNodePage = {
  items: [
    {
      id: 21,
      nodeType: 'COMPONENT',
      naturalKey: 'component:TodosPage',
      name: 'TodosPage',
      filePath: 'src/pages/TodosPage.tsx',
      lineStart: 1,
      lineEnd: 20,
      areaType: 'FRONTEND',
    },
  ],
  page: 1,
  size: 20,
  total: 1,
}

const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/projects/7/findings') return jsonResponse(findings)
    if (path === '/api/projects/7/impact') return jsonResponse(impact)
    if (path === '/api/projects/7/graph/nodes') return jsonResponse(nodes)
    if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'mock' })
    if (path === '/api/csrf') return new Response(null, { status: 204 })
    if (path === '/api/projects/7/findings/5/task-draft') {
      return jsonResponse(
        {
          id: 4,
          type: 'LEARNING',
          title: 'Review unmatched API call',
          description: 'Confirm',
          status: 'DRAFT',
          origin: 'AI',
          sourceFindingId: 5,
          goals: ['Open evidence'],
        },
        201,
      )
    }
    if (path === '/api/projects/7/tasks') return jsonResponse([])
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderAnalysis() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/analysis'] })
  return { router, ...render(<RouterProvider router={router} />) }
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({
    aiPanelOpen: true,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
  })
  fetchMock.mockReset()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnalysisPage', () => {
  it('lists findings and loads impact when a finding with nodeId is selected', async () => {
    renderAnalysis()

    expect(await screen.findByText('Unmatched GET /api/missing')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'HIGH' })).toBeInTheDocument()
    expect(await screen.findByText('HomePage.load')).toBeInTheDocument()
    expect(screen.getByText(/score 9/)).toBeInTheDocument()
  })

  it('opens the AI panel with FINDING intent from a finding', async () => {
    useUiStore.setState({ aiPanelOpen: false, focusedFindingId: null, pendingIntent: null })
    renderAnalysis()
    await screen.findByText('Unmatched GET /api/missing')
    fireEvent.click(screen.getByRole('button', { name: 'AI에게 확인' }))
    expect(useUiStore.getState().aiPanelOpen).toBe(true)
    expect(useUiStore.getState().focusedFindingId).toBe(5)
    expect(useUiStore.getState().pendingIntent).toBe('FINDING')
  })

  it('searches graph nodes for impact', async () => {
    renderAnalysis()
    await screen.findByText('Unmatched GET /api/missing')

    fireEvent.change(screen.getByPlaceholderText('이름 또는 경로'), { target: { value: 'Todos' } })
    const results = await screen.findByRole('list', { name: 'Impact 노드 검색 결과' })
    expect(within(results).getByRole('button', { name: /TodosPage/ })).toBeInTheDocument()

    await waitFor(() => {
      const searched = fetchMock.mock.calls.some((call) => {
        const url = requestUrl(call[0] as RequestInfo | URL)
        return (
          url.pathname === '/api/projects/7/graph/nodes' && url.searchParams.get('q') === 'Todos'
        )
      })
      expect(searched).toBe(true)
    })
  })

  it('creates a learning-task draft from a finding', async () => {
    const { router } = renderAnalysis()
    await screen.findByText('Unmatched GET /api/missing')
    fireEvent.click(screen.getByRole('button', { name: '초안 생성' }))
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/7/tasks')
    })
  })
})
