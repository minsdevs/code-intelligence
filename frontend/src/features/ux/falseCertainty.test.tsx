import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { ReactNode } from 'react'
import RepositoryOverviewPage from '../projects/RepositoryOverviewPage'
import AnalysisPage from '../analysis/AnalysisPage'
import SymbolPanel from '../code/SymbolPanel'
import FlowsPage from '../flows/FlowsPage'
import { CoveragePanel } from '../analysis/CoveragePanel'
import { I18nProvider } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'

// G-UX false-certainty pins: inferred, candidate, unmeasured, partial and truncated
// states must stay distinguishable in text, and an empty result must never read
// as proof of no impact. React/JSDOM regressions, not packaged-app evidence.

vi.mock('@xyflow/react', () => ({
  ReactFlow: () => null,
  Background: () => null,
  Controls: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
}))

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const node = (id: number, name: string, nodeType = 'METHOD', filePath = 'api/OrderService.java') => ({
  id, name, nodeType, naturalKey: `key:${name}`, filePath, lineStart: 10, lineEnd: 12, areaType: 'BACKEND',
})
const service = node(10, 'OrderService', 'SERVICE')
const relation = (target: ReturnType<typeof node>, confidence: string, edgeType = 'CALLS') => ({
  sourceNodeId: target.id, targetNodeId: service.id, depth: 1, direction: 'in', edgeType, confidence, node: target,
})
const mixedRelations = [
  relation(node(11, 'OrderController.cancel'), 'CONFIRMED'),
  relation(node(12, 'OrderDetailPage', 'COMPONENT', 'web/OrderDetailPage.tsx'), 'LIKELY', 'CONSUMES'),
  relation(node(13, 'SmsOrderNotifier.orderCancelled'), 'POSSIBLE'),
]

type Routes = Record<string, (url: URL) => unknown>
function stubApi(routes: Routes) {
  const requests: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
    requests.push(url)
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.pathname.endsWith(suffix)) return json(handler(url))
    }
    return json({ title: 'Not Found' }, 404)
  }))
  return requests
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
  return router
}

const overviewRoutes = (relations: unknown[], truncated = false): Routes => ({
  '/api/projects/7': () => ({ id: 7, name: 'order-desk', currentSnapshot: { id: 2, commitSha: 'local', status: 'DONE', analyzedAt: '2026-10-07' } }),
  '/snapshots': () => [{ id: 2, commitSha: 'local', status: 'DONE', analyzedAt: '2026-10-07' }],
  '/files': () => [
    { path: 'api/OrderService.java', language: 'Java', analysisStatus: 'SUCCESS' },
    { path: 'web/OrderDetailPage.tsx', language: 'TypeScript', analysisStatus: 'PARTIAL', analysisReason: 'AMBIGUOUS_SYMBOL_IDENTITY' },
    { path: 'scripts/export_orders.py', language: 'Python', analysisStatus: 'UNSUPPORTED', analysisReason: 'SOURCE_LANGUAGE_UNSUPPORTED' },
    { path: 'legacy/Old.java', language: 'Java' },
  ],
  '/graph/overview': () => ({ resolvedSnapshotId: 2, nodeCounts: { SERVICE: 1, METHOD: 3 }, edgeCounts: { CALLS: 2, CONSUMES: 1 } }),
  '/graph/nodes': () => ({ resolvedSnapshotId: 2, items: [service], page: 1, size: 40, total: 1 }),
  '/graph/nodes/10': () => ({ ...service, resolvedSnapshotId: 2, metadata: {}, evidences: [] }),
  '/relations': () => ({ resolvedSnapshotId: 2, nodeId: 10, depth: 1, direction: 'in', truncated, relations }),
  '/coverage': () => ({ measurementStatus: 'LEGACY_UNMEASURED', supportStatus: 'UNVERIFIED', fileCoverage: { inventoriedFiles: 4 },
    languageCoverage: [], analyzerStatuses: [{ name: 'java', status: 'done' }] }),
})

beforeEach(() => {
  window.localStorage.setItem('code-intelligence.lang', 'ko')
  useUiStore.setState({ focusedNode: null, aiPanelOpen: false })
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('overview and neighborhood keep inferred and unmeasured states in text', () => {
  it('labels every relation verdict in text and does not call inferred relations confirmed', async () => {
    stubApi(overviewRoutes(mixedRelations, true))
    renderRoute(<RepositoryOverviewPage />, '/projects/:projectId/overview', '/projects/7/overview?snapshotId=2&nodeId=10')
    const region = await screen.findByRole('region', { name: '선택한 코드 주변 관계' })
    const table = await within(region).findByRole('table', { name: '선택 주변 관계 표' })
    const verdicts = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[2].textContent)
    expect(verdicts).toEqual(['정적 대상 확인 (CONFIRMED)', '추정 (LIKELY)', '추정 · 약함 (POSSIBLE)'])
    expect(region).not.toHaveTextContent('확인된 정적 관계에 따른')
    expect(region).toHaveTextContent('추정')
    // A truncated neighbourhood stays visibly incomplete (T06: truncated 보임).
    expect(within(region).getByRole('status')).toHaveTextContent('관계 조회 한도에 도달했습니다')
  })

  it('states that an empty neighbourhood is not evidence of no impact', async () => {
    stubApi(overviewRoutes([]))
    renderRoute(<RepositoryOverviewPage />, '/projects/:projectId/overview', '/projects/7/overview?snapshotId=2&nodeId=10')
    expect(await screen.findByText(/영향 없음의 근거가 아닙니다/)).toBeInTheDocument()
  })

  it('names static flows as recorded, not confirmed, and keeps file outcome states in text', async () => {
    stubApi(overviewRoutes([]))
    renderRoute(<RepositoryOverviewPage />, '/projects/:projectId/overview', '/projects/7/overview')
    await screen.findByRole('table', { name: '분석 결과 표' })
    expect(screen.queryByText(/확인된 흐름/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /기록된 정적 흐름 따라가기/ })).toBeInTheDocument()
    expect(screen.getByText(/README의 선언 · 실행 명령도 문서에 적힌 정보/)).toBeInTheDocument()
    expect(screen.getByText(/실행 명령이나 런타임 도달 가능성을 확인한 목록은/)).toBeInTheDocument()
    expect(screen.getByText(/언어 감지는 심볼·호출·프레임워크/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '파일 · 분석 상태' }))
    const table = screen.getByRole('table', { name: '분석 결과 표' })
    for (const label of ['구문 분석 성공', '부분 성공', '미지원', '과거 미측정']) {
      expect(await within(table).findByText(label)).toBeInTheDocument()
    }
    expect(within(table).getByText(/동명 선언을 구분할 수 없어/)).toBeInTheDocument()
    expect(screen.queryByText(/100%/)).not.toBeInTheDocument()
  })
})

describe('impact never reads as a guarantee', () => {
  const impactRoutes = (dependents: unknown[]): Routes => ({
    '/findings': () => [],
    '/snapshots': () => [],
    '/coverage': () => ({ measurementStatus: 'LEGACY_UNMEASURED', supportStatus: 'UNVERIFIED', fileCoverage: { inventoriedFiles: 4 },
      languageCoverage: [], analyzerStatuses: [] }),
    '/graph/nodes': () => ({ resolvedSnapshotId: 2, items: [node(20, 'cancel')], page: 1, size: 20, total: 1 }),
    '/impact': () => ({ resolvedSnapshotId: 2, nodeId: 20, depth: 5, riskScore: 0, riskLevel: 'LOW', dependents }),
  })

  it.each([
    ['ko', /영향이 없다는 증거가 아닙니다/, /역방향 의존이 없습니다/, '관계 미발견은 영향 없음이 아닙니다'],
    ['en', /not proof of no impact/, /^No reverse dependencies\.$/, 'finding no relation does not mean no impact'],
  ])('describes an empty reverse-dependency result as not found, not as absence (%s)', async (lang, expected, forbidden, intro) => {
    window.localStorage.setItem('code-intelligence.lang', lang)
    stubApi(impactRoutes([]))
    renderRoute(<AnalysisPage />, '/projects/:projectId/analysis', '/projects/7/analysis')
    const search = await screen.findByRole('textbox', { name: lang === 'ko' ? /노드 검색/ : /Node search/ })
    fireEvent.change(search, { target: { value: 'cancel' } })
    fireEvent.click(await screen.findByRole('button', { name: /cancel/ }))
    const panel = screen.getByRole('complementary', { name: 'Impact' })
    await waitFor(() => expect(panel).toHaveTextContent(expected))
    expect(within(panel).queryByText(forbidden)).not.toBeInTheDocument()
    // The panel intro is in the UI language (G-UX A18); it was hard-coded Korean before.
    expect(panel).toHaveTextContent(intro)
  })
})

describe('code explorer callers keep candidate relations distinguishable', () => {
  it('labels inferred callers in text and words an empty list as not found', async () => {
    const symbol = node(30, 'cancel')
    stubApi({
      '/graph/nodes': () => ({ resolvedSnapshotId: 2, items: [symbol], page: 1, size: 200, total: 1 }),
      '/relations': (url) => url.searchParams.get('direction') === 'in'
        ? { resolvedSnapshotId: 2, nodeId: 30, depth: 1, direction: 'in', truncated: false, relations: mixedRelations }
        : { resolvedSnapshotId: 2, nodeId: 30, depth: 1, direction: 'out', truncated: false, relations: [] },
    })
    useUiStore.setState({ focusedNode: { id: 30, name: 'cancel', nodeType: 'METHOD', filePath: 'api/OrderService.java', lineStart: 10 } })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <I18nProvider>
        <QueryClientProvider client={client}>
          <SymbolPanel projectId={7} snapshotId={2} path="api/OrderService.java" onOpenLocation={() => {}} />
        </QueryClientProvider>
      </I18nProvider>,
    )
    const callers = await screen.findByRole('list', { name: 'Callers' })
    await waitFor(() => expect(within(callers).getAllByRole('listitem')).toHaveLength(3))
    const [confirmed, likely, possible] = within(callers).getAllByRole('listitem')
    expect(confirmed).not.toHaveTextContent('추정')
    expect(likely).toHaveTextContent('추정 (LIKELY)')
    expect(possible).toHaveTextContent('추정 · 약함 (POSSIBLE)')
    const empty = await screen.findByText(/Callees/, { selector: 'p' })
    expect(empty).toHaveTextContent('관계가 없다는 증거는 아닙니다')
    expect(screen.queryByText('Callees 없음')).not.toBeInTheDocument()
  })
})

describe('flows and coverage say what was not established', () => {
  it('tells the reader that steps can be inferred and marks a path without per-step verdicts as inferred', async () => {
    stubApi({
      '/api/projects/7': () => ({ id: 7, name: 'order-desk', currentSnapshot: { id: 2, status: 'DONE' } }),
      '/flows': () => [{ id: 4, name: '/orders/:orderId', kind: 'FE_BE', entryNodeId: 12 }],
      '/flows/4': () => ({ resolvedSnapshotId: 2, id: 4, name: '/orders/:orderId', kind: 'FE_BE', entryNodeId: 12, evidences: [],
        steps: [{ seq: 1, nodeId: 12, nodeName: 'OrderDetailPage', nodeType: 'COMPONENT', filePath: 'web/OrderDetailPage.tsx', line: 1, description: null },
          { seq: 2, nodeId: 40, nodeName: 'POST /api/orders/{orderId}/cancel', nodeType: 'API_ENDPOINT', filePath: null, line: null, description: 'CONSUMES' }] }),
    })
    renderRoute(<FlowsPage />, '/projects/:projectId/flows', '/projects/7/flows')
    const article = await screen.findByRole('article', { name: 'Flow detail' })
    expect(article).toHaveTextContent('기록된 정적 경로입니다')
    expect(article).toHaveTextContent('단계를 만든 기록된 관계의 판정')
    expect(article).toHaveTextContent('추정 단계 포함')
  })

  it('never turns legacy or unmeasured coverage into a completeness percentage', async () => {
    stubApi({ '/coverage': () => ({ measurementStatus: 'LEGACY_UNMEASURED', supportStatus: 'UNVERIFIED', fileCoverage: { inventoriedFiles: 4, analyzedFiles: 4 },
      languageCoverage: [{ language: 'Java', inventoriedFiles: 2, analyzed: 2, failed: 0 }], analyzerStatuses: [{ name: 'java', status: 'done' }] }) })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><CoveragePanel projectId={7} snapshotId={2} /></QueryClientProvider>)
    const report = await screen.findByRole('region', { name: '분석 범위 보고서' })
    expect(report).toHaveTextContent('분석 범위 측정 불가')
    expect(report).toHaveTextContent('단계 종료 · 파일별 결과 미측정')
    expect(within(report).getAllByText('알 수 없음').length).toBeGreaterThanOrEqual(2)
    expect(report).not.toHaveTextContent('%')
  })
})
