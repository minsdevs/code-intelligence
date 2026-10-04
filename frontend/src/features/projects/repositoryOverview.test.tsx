import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import RepositoryOverviewPage from './RepositoryOverviewPage'

vi.mock('@xyflow/react', () => ({
  ReactFlow: () => null,
  Background: () => null,
  Controls: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
}))
const node = {
  id: 10,
  name: 'GET /orders',
  nodeType: 'API_ENDPOINT',
  naturalKey: 'module-a:orders',
  filePath: 'a/Orders.ts',
  lineStart: 12,
  lineEnd: 14,
  areaType: 'BACKEND',
}
const snapshots = [
  { id: 1, commitSha: 'old-source', status: 'DONE', analyzedAt: '2026-10-01' },
  { id: 2, commitSha: 'new-source', status: 'DONE', analyzedAt: '2026-10-05' },
]
function setup(entry = '/projects/7/overview?snapshotId=1', total = 1) {
  const requests: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost')
      requests.push(url)
      let data: unknown
      if (url.pathname === '/api/projects/7')
        data = { id: 7, name: 'Orders', currentSnapshot: snapshots[1] }
      else if (url.pathname.endsWith('/snapshots')) data = snapshots
      else if (url.pathname.endsWith('/files'))
        data = [
          {
            path: 'a/Orders.ts',
            language: 'TypeScript',
            size: 80,
            lineCount: 14,
          },
        ]
      else if (url.pathname.endsWith('/graph/overview'))
        data = {
          resolvedSnapshotId: 1,
          nodeCounts: { CONTROLLER: 1, METHOD: 4 },
          edgeCounts: { CALLS: 3 },
        }
      else if (url.pathname.endsWith('/graph/nodes'))
        data = { resolvedSnapshotId: 1, items: [node], page: 0, size: 40, total }
      else if (url.pathname.endsWith('/graph/nodes/10'))
        data = { ...node, resolvedSnapshotId: 1, metadata: {}, evidences: [] }
      else if (url.pathname.endsWith('/relations'))
        data = {
          resolvedSnapshotId: 1,
          nodeId: 10,
          relations: [],
          depth: 1,
          direction: 'in',
          truncated: false,
        }
      else
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }),
  )
  const router = createMemoryRouter(
    [
      { path: '/projects/:projectId/overview', element: <RepositoryOverviewPage /> },
      { path: '/projects/:projectId/code', element: <p>Source</p> },
    ],
    { initialEntries: [entry] },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, requests }
}
afterEach(() => vi.unstubAllGlobals())
describe('repository investigation', () => {
  it('keeps old snapshot across overview, search, graph and source despite newer current', async () => {
    const { requests, router } = setup()
    const table = await screen.findByRole('table', { name: '분석 결과 표' })
    expect(within(table).getByText('GET /orders')).toBeInTheDocument()
    fireEvent.click(within(table).getByRole('button', { name: '관계 · 함께 확인할 곳' }))
    expect(await screen.findByText(/영향 없음의 근거가 아닙니다/)).toBeInTheDocument()
    const graphRequests = requests.filter((url) => url.pathname.includes('/graph/'))
    expect(graphRequests.length).toBeGreaterThan(2)
    expect(graphRequests.every((url) => url.searchParams.get('snapshotId') === '1')).toBe(true)
    fireEvent.click(within(table).getByRole('link', { name: /보관된 소스/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/7/code'))
    expect(new URLSearchParams(router.state.location.search).get('snapshotId')).toBe('1')
    expect(new URLSearchParams(router.state.location.search).get('sourceContext')).toBe('evidence')
  })
  it('shows legacy measurement honestly and sends category/search/sort filters', async () => {
    const { requests } = setup()
    await screen.findByRole('table', { name: '분석 결과 표' })
    fireEvent.click(screen.getByRole('button', { name: '파일 · 분석 상태' }))
    expect(
      await within(screen.getByRole('table', { name: '분석 결과 표' })).findByText('과거 미측정'),
    ).toBeInTheDocument()
    expect(screen.queryByText('100%')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '선언된 외부 패키지' }))
    fireEvent.change(screen.getByRole('searchbox', { name: '분석 결과 검색' }), {
      target: { value: 'orders' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: '분석 결과 정렬' }), {
      target: { value: 'name' },
    })
    await waitFor(() =>
      expect(
        requests.some(
          (url) =>
            url.searchParams.get('category') === 'dependencies' &&
            url.searchParams.get('q') === 'orders' &&
            url.searchParams.get('sort') === 'name',
        ),
      ).toBe(true),
    )
    expect(screen.getByText(/실제 실행 중 사용 여부/)).toBeInTheDocument()
  })
  it('uses one-based server pages and resets pagination when searching', async () => {
    const { requests } = setup(undefined, 81)
    await screen.findByRole('table', { name: '분석 결과 표' })
    fireEvent.click(screen.getByRole('button', { name: '다음' }))
    await waitFor(() =>
      expect(
        requests.some(
          (url) => url.pathname.endsWith('/graph/nodes') && url.searchParams.get('page') === '2',
        ),
      ).toBe(true),
    )
    fireEvent.change(screen.getByRole('searchbox', { name: '분석 결과 검색' }), {
      target: { value: 'Orders' },
    })
    await waitFor(() =>
      expect(
        requests.some(
          (url) => url.searchParams.get('q') === 'Orders' && url.searchParams.get('page') === '1',
        ),
      ).toBe(true),
    )
  })

  it('does not substitute current snapshot for a malformed requested snapshot', async () => {
    const { requests } = setup('/projects/7/overview?snapshotId=bogus')
    expect(await screen.findByRole('alert')).toHaveTextContent('분석 시점')
    expect(
      requests.some((url) => url.pathname.includes('/graph/') || url.pathname.endsWith('/files')),
    ).toBe(false)
  })
})
