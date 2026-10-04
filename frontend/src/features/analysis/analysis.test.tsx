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
    stableKey: 'UNMATCHED_API_CALL|component:TodosPage',
    ruleId: 'UNMATCHED_API_CALL',
    ruleVersion: '1',
    judgment: {
      status: 'NEEDS_REVIEW',
      reason: '',
      judgedBy: null,
      judgedAt: null,
      needsReview: true,
      hidden: false,
    },
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
let draftStatus = 201

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/projects/7/findings/5/judgment') {
      return jsonResponse({
        status: 'FALSE_POSITIVE', reason: 'expected external route', judgedBy: 1,
        judgedAt: '2026-08-24T00:00:00Z', needsReview: false, hidden: true,
      })
    }
    if (path === '/api/projects/7/findings') return jsonResponse(findings)
    if (path === '/api/projects/7/snapshots') {
      return jsonResponse([
        { id: 2, commitSha: 'bbbbbbbb', status: 'READY', analyzedAt: null },
        { id: 1, commitSha: 'aaaaaaaa', status: 'READY', analyzedAt: null },
      ])
    }
    if (path === '/api/projects/7/snapshots/compare') {
      const empty = { added: [], removed: [], changed: [] }
      const coverage = {
        fileCoverage: { discoveredFiles: 10, analyzedFiles: 10, skippedForCount: 0, skippedForSize: 0, skippedBinary: 0 },
        languageCoverage: [], excludedFolders: [], analyzerStatuses: [],
        partialResults: { featuresPartial: false, flowsPartial: false, graphPartial: false, reason: null },
        retryableIssues: [], unsupportedItems: [],
      }
      return jsonResponse({
        baseSnapshotId: 1, targetSnapshotId: 2,
        features: { added: [{ type: 'ADDED', key: 'checkout', beforeName: null, afterName: 'checkout' }], removed: [], changed: [] },
        flows: empty, findings: empty, structure: { nodes: empty, relationships: empty },
        coverage: { before: coverage, after: coverage }, renameCandidates: [],
        regressionWarnings: ['flows decreased by more than 30%'],
      })
    }
    if (path === '/api/projects/7/impact') return jsonResponse(impact)
    if (path === '/api/projects/7/graph/nodes') return jsonResponse(nodes)
    if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'mock' })
    if (path === '/api/csrf') return new Response(null, { status: 204 })
    if (path === '/api/projects/7/findings/5/task-draft') {
      if (draftStatus !== 201) {
        return jsonResponse({ title: 'Service Unavailable', detail: 'AI is not configured.' }, draftStatus)
      }
      return jsonResponse(
        {
          id: 4,
          type: 'REVIEW',
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
    if (path === '/api/projects/7/what-if') {
      return jsonResponse({
        impact,
        explanation: 'Changing TodosPage would break HomePage.load.',
        claims: [
          {
            text: 'HomePage.load calls TodosPage.',
            confidence: 'CONFIRMED',
            evidence: ['file:src/pages/HomePage.tsx:8'],
          },
        ],
      })
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
  draftStatus = 201
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnalysisPage', () => {
  it('compares retained snapshots across analysis categories and coverage', async () => {
    renderAnalysis()
    const panel = await screen.findByRole('region', { name: 'Snapshot comparison' })
    expect(within(panel).getByText('Features')).toBeInTheDocument()
    expect(within(panel).getByText('+1 ~0 -0')).toBeInTheDocument()
    expect(within(panel).getByText(/Inventory: unknown → unknown files\. Analysis coverage unmeasured\./)).toBeInTheDocument()
    expect(within(panel).getByRole('alert')).toHaveTextContent('flows decreased')
  })

  it('lists findings and loads impact when a finding with nodeId is selected', async () => {
    renderAnalysis()

    expect(await screen.findByText('Unmatched GET /api/missing')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'HIGH' })).toBeInTheDocument()
    expect(await screen.findByText('HomePage.load')).toBeInTheDocument()
    expect(screen.getByText(/정적 관계 기반 참고 점수 9/)).toBeInTheDocument()
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

  it('saves a false-positive judgment and can request hidden findings', async () => {
    renderAnalysis()
    await screen.findByText('Unmatched GET /api/missing')
    fireEvent.change(screen.getByLabelText('Finding judgment'), { target: { value: 'FALSE_POSITIVE' } })
    fireEvent.change(screen.getByLabelText('Judgment reason'), { target: { value: 'expected external route' } })
    fireEvent.click(screen.getByRole('button', { name: '판정 저장' }))

    await waitFor(() => {
      const request = fetchMock.mock.calls.find((call) => requestUrl(call[0] as RequestInfo | URL).pathname.endsWith('/judgment'))
      expect(request?.[1]).toMatchObject({ method: 'PUT' })
    })

    fireEvent.click(screen.getByRole('checkbox', { name: '숨긴 오탐 표시' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => requestUrl(call[0] as RequestInfo | URL).searchParams.get('includeHidden') === 'true')).toBe(true)
    })
  })

  it('offers approved explanations without automatic task generation or what-if provider calls', async () => {
    renderAnalysis()
    await screen.findByText('정적 관계 기반 참고 점수 9')
    expect(screen.queryByRole('button', { name: 'Task 초안 만들기' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'AI 패널에서 영향 근거 확인' }))
    expect(useUiStore.getState().aiPanelOpen).toBe(true)
    expect(useUiStore.getState().pendingIntent).toBe('EXPLAIN')
    expect(useUiStore.getState().focusedNode?.id).toBe(21)
    expect(fetchMock.mock.calls.some(([input]) => /task-draft|what-if/.test(requestUrl(input).pathname))).toBe(false)
  })
})
