import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { ReactNode } from 'react'
import AnalysisPage from '../analysis/AnalysisPage'
import FlowsPage from '../flows/FlowsPage'
import { I18nProvider } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'

// G-UX F5/F6: flow steps show the verdict of the relation that produced them, and impact
// separates confirmed reverse dependencies, candidate impact and areas outside analysis.
// React/JSDOM regressions, not packaged-app evidence.

vi.mock('@xyflow/react', () => ({
  ReactFlow: () => null,
  Background: () => null,
  Controls: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
}))

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

type Routes = Record<string, (url: URL) => unknown>
function stubApi(routes: Routes) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.pathname.endsWith(suffix)) return json(handler(url))
    }
    return json({ title: 'Not Found' }, 404)
  }))
}

function renderRoute(element: ReactNode, path: string, entry: string) {
  const router = createMemoryRouter(
    [{ path, element }, { path: '/projects/:projectId/code', element: <p>Source</p> }],
    { initialEntries: [entry] },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <I18nProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({ selectedAreas: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const step = (seq: number, name: string, extra: Record<string, unknown>) => ({
  seq, nodeId: 100 + seq, nodeName: name, nodeType: 'METHOD', filePath: `src/${name}.java`, line: seq, description: null,
  entry: false, relationType: null, confidence: null, ...extra,
})

const feBeSteps = [
  step(1, 'OrderDetailPage', { nodeType: 'FE_ROUTE', entry: true }),
  step(2, 'POST /api/orders/{id}/cancel', { nodeType: 'API_ENDPOINT', relationType: 'CONSUMES', confidence: 'LIKELY' }),
  step(3, 'OrderController', { nodeType: 'CLASS', relationType: 'EXPOSES', confidence: 'CONFIRMED' }),
  step(4, 'OrderService.cancel', { relationType: 'CALLS', confidence: 'POSSIBLE' }),
  step(5, 'Audit.log', {}),
]

const flowRoutes = (steps: unknown[], inferredStepIncluded: boolean): Routes => ({
  '/api/projects/7': () => ({ id: 7, name: 'order-desk', currentSnapshot: { id: 2, status: 'DONE' } }),
  '/flows': () => [{ id: 4, name: '/orders/:orderId', kind: 'FE_BE', entryNodeId: 101 }],
  '/flows/4': () => ({ resolvedSnapshotId: 2, id: 4, name: '/orders/:orderId', kind: 'FE_BE', entryNodeId: 101,
    evidences: [], inferredStepIncluded, steps }),
})

describe('flow steps carry the verdict of the relation that produced them (F5)', () => {
  it.each([
    ['ko', '시작점', '추정 (LIKELY)', '정적 대상 확인 (CONFIRMED)', '추정 · 약함 (POSSIBLE)', '연결 관계 기록 없음', '추정 단계 포함'],
    ['en', 'Entry point', 'Inferred (LIKELY)', 'Static target confirmed (CONFIRMED)', 'Inferred, weak (POSSIBLE)',
      'No recorded relation', 'Inferred step included'],
  ])('shows a per-step verdict and the inferred badge (%s)', async (lang, entry, likely, confirmed, possible, none, badge) => {
    window.localStorage.setItem('code-intelligence.lang', lang)
    stubApi(flowRoutes(feBeSteps, true))
    renderRoute(<FlowsPage />, '/projects/:projectId/flows', '/projects/7/flows')
    const article = await screen.findByRole('article', { name: 'Flow detail' })
    const items = within(await within(article).findByRole('list', { name: /Flow steps/ })).getAllByRole('listitem')
    expect(items).toHaveLength(5)
    expect(items[0]).toHaveTextContent(entry)
    expect(items[1]).toHaveTextContent('CONSUMES')
    expect(items[1]).toHaveTextContent(likely)
    expect(items[2]).toHaveTextContent('EXPOSES')
    expect(items[2]).toHaveTextContent(confirmed)
    expect(items[3]).toHaveTextContent(possible)
    expect(items[4]).toHaveTextContent(none)
    expect(items[4]).not.toHaveTextContent(confirmed)
    expect(within(article).getByText(badge)).toBeInTheDocument()
    // The earlier note said per-step confirmation is not shown; that is no longer true.
    expect(article).not.toHaveTextContent(/표시되지 않습니다|is not shown here/)
  })

  it('shows no inferred badge when every produced step is confirmed', async () => {
    stubApi(flowRoutes([feBeSteps[0], step(2, 'OrderController', { relationType: 'EXPOSES', confidence: 'CONFIRMED' })], false))
    renderRoute(<FlowsPage />, '/projects/:projectId/flows', '/projects/7/flows')
    const article = await screen.findByRole('article', { name: 'Flow detail' })
    await within(article).findByText(/정적 대상 확인 \(CONFIRMED\)/)
    expect(within(article).queryByText('추정 단계 포함')).not.toBeInTheDocument()
  })

  it('treats an old response without verdict fields as not confirmed', async () => {
    const legacy = feBeSteps.map(({ seq, nodeId, nodeName, nodeType, filePath, line, description }) =>
      ({ seq, nodeId, nodeName, nodeType, filePath, line, description }))
    stubApi({ ...flowRoutes(legacy, false), '/flows/4': () => ({ resolvedSnapshotId: 2, id: 4, name: '/orders/:orderId',
      kind: 'FE_BE', entryNodeId: 101, evidences: [], steps: legacy }) })
    renderRoute(<FlowsPage />, '/projects/:projectId/flows', '/projects/7/flows')
    const article = await screen.findByRole('article', { name: 'Flow detail' })
    await within(article).findByText('추정 단계 포함')
    expect(article).not.toHaveTextContent('정적 대상 확인 (CONFIRMED)')
  })
})

const dependent = (nodeId: number, name: string, confidence: string, extra: Record<string, unknown> = {}) => ({
  depth: 1, edgeType: 'CALLS', nodeType: 'METHOD', nodeId, name, filePath: `api/${name}.java`, line: 3,
  confidence, pathCount: 1, group: confidence === 'CONFIRMED' ? 'CONFIRMED_DEPENDENCY' : 'CANDIDATE_IMPACT', ...extra,
})

const measuredOutside = {
  measurementStatus: 'PER_FILE_RECORDED', excludedFiles: 3, excludedSubmodules: 0, unsupportedFiles: 2, failedFiles: 1,
  partialFiles: 0, pendingFiles: 0, unmeasuredFiles: 4,
  areas: [
    { status: 'UNSUPPORTED', language: 'Kotlin', files: 2, samplePath: 'jobs/A.kt' },
    { status: 'FAILED', language: 'TypeScript', files: 1, samplePath: 'web/broken.ts' },
  ],
}

const impactRoutes = (impact: Record<string, unknown>): Routes => ({
  '/findings': () => [],
  '/snapshots': () => [],
  '/coverage': () => ({ measurementStatus: 'LEGACY_UNMEASURED', supportStatus: 'UNVERIFIED', fileCoverage: { inventoriedFiles: 4 },
    languageCoverage: [], analyzerStatuses: [] }),
  '/graph/nodes': () => ({ resolvedSnapshotId: 2, page: 1, size: 20, total: 1, items: [
    { id: 20, name: 'cancel', nodeType: 'METHOD', naturalKey: 'key:cancel', filePath: 'api/OrderService.java', lineStart: 10,
      lineEnd: 12, areaType: 'BACKEND' }] }),
  '/impact': () => ({ resolvedSnapshotId: 2, nodeId: 20, depth: 5, riskScore: 4, riskLevel: 'LOW',
    scoreVersion: 'unique-node-weight-v2', ...impact }),
})

async function openImpact(lang: string) {
  renderRoute(<AnalysisPage />, '/projects/:projectId/analysis', '/projects/7/analysis')
  const search = await screen.findByRole('textbox', { name: lang === 'ko' ? /노드 검색/ : /Node search/ })
  fireEvent.change(search, { target: { value: 'cancel' } })
  fireEvent.click(await screen.findByRole('button', { name: /cancel/ }))
  return screen.getByRole('complementary', { name: 'Impact' })
}

describe('impact separates confirmed, candidate and outside-analysis areas (F6)', () => {
  const dependents = [
    dependent(30, 'OrderController.cancel', 'CONFIRMED'),
    dependent(31, 'RetryJob.run', 'LIKELY'),
    dependent(32, 'OrderPage', 'POSSIBLE', { depth: 2, nodeType: 'COMPONENT', pathCount: 2 }),
  ]

  it.each([
    ['ko', '확인된 역방향 의존', '후보 영향', '분석 밖 영역', '정적 대상 확인 (CONFIRMED)', '추정 (LIKELY)',
      '추정 · 약함 (POSSIBLE)', '경로 2개', '미지원', '고유 노드마다 유형 가중치를 한 번만'],
    ['en', 'Confirmed reverse dependencies', 'Candidate impact', 'Outside analysis', 'Static target confirmed (CONFIRMED)',
      'Inferred (LIKELY)', 'Inferred, weak (POSSIBLE)', '2 paths', 'Unsupported', 'once per unique node'],
  ])('groups dependents by verdict and lists recorded outside areas (%s)', async (lang, confirmedName, candidateName,
    outsideName, confirmed, likely, possible, paths, unsupported, scoreRule) => {
    window.localStorage.setItem('code-intelligence.lang', lang)
    stubApi(impactRoutes({ dependents, outsideAnalysis: measuredOutside }))
    const panel = await openImpact(lang)

    const confirmedList = await within(panel).findByRole('list', { name: new RegExp(confirmedName) })
    const confirmedRows = within(confirmedList).getAllByRole('listitem')
    expect(confirmedRows).toHaveLength(1)
    expect(confirmedRows[0]).toHaveTextContent('OrderController.cancel')
    expect(confirmedRows[0]).toHaveTextContent(confirmed)

    const candidateRows = within(within(panel).getByRole('list', { name: new RegExp(candidateName) })).getAllByRole('listitem')
    expect(candidateRows).toHaveLength(2)
    expect(candidateRows[0]).toHaveTextContent('RetryJob.run')
    expect(candidateRows[0]).toHaveTextContent(likely)
    expect(candidateRows[1]).toHaveTextContent(possible)
    expect(candidateRows[1]).toHaveTextContent(paths)

    const outside = within(panel).getByRole('region', { name: new RegExp(outsideName) })
    expect(outside).toHaveTextContent(unsupported)
    expect(outside).toHaveTextContent('Kotlin')
    expect(outside).toHaveTextContent('jobs/A.kt')
    expect(outside).toHaveTextContent('web/broken.ts')
    expect(panel).toHaveTextContent(scoreRule)
  })

  it('says outside-analysis areas are unknown for an unmeasured snapshot or an old response', async () => {
    stubApi(impactRoutes({ dependents, outsideAnalysis: { measurementStatus: 'LEGACY_UNMEASURED', areas: [] } }))
    const panel = await openImpact('ko')
    const outside = await within(panel).findByRole('region', { name: /분석 밖 영역/ })
    expect(outside).toHaveTextContent('파일별 분석 결과를 기록하지 않았습니다')
  })

  it('keeps an old response without verdicts out of the confirmed group', async () => {
    const legacy = dependents.map(({ depth, edgeType, nodeType, nodeId, name, filePath, line }) =>
      ({ depth, edgeType, nodeType, nodeId, name, filePath, line }))
    stubApi(impactRoutes({ dependents: legacy }))
    const panel = await openImpact('ko')
    const candidateList = await within(panel).findByRole('list', { name: /후보 영향/ })
    expect(within(candidateList).getAllByRole('listitem')).toHaveLength(3)
    expect(within(panel).queryByRole('list', { name: /확인된 역방향 의존/ })).not.toBeInTheDocument()
    await waitFor(() => expect(within(panel).getByRole('region', { name: /분석 밖 영역/ }))
      .toHaveTextContent('파일별 분석 결과를 기록하지 않았습니다'))
  })
})
