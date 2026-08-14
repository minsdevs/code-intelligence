import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import { COMMIT_PAGE_SIZE } from '../../api/history'
import type { CommitDetail, CommitDiff, CommitSummary, ProjectArea, PullRequest } from '../../api/types'

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ original, modified }: { original?: string; modified?: string }) => (
    <div data-testid="monaco-diff-editor">
      <pre data-testid="diff-original">{original}</pre>
      <pre data-testid="diff-modified">{modified}</pre>
    </div>
  ),
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

function commitSummary(page: number, index: number): CommitSummary {
  return {
    sha: `${page}${String(index).padStart(39, '0')}`,
    author: 'Ada Lovelace',
    message: `commit-page-${page}-${index}\n\nbody`,
    committedAt: '2026-01-01T00:00:00Z',
    additions: 4,
    deletions: 1,
  }
}

const firstSha = commitSummary(1, 0).sha

const firstDetail: CommitDetail = {
  sha: firstSha,
  author: 'Ada Lovelace',
  message: 'commit-page-1-0\n\nbody',
  committedAt: '2026-01-01T00:00:00Z',
  additions: 4,
  deletions: 1,
  files: [
    { path: 'src/App.java', changeType: 'MODIFY' },
    { path: 'README.md', changeType: 'ADD' },
  ],
}

const sampleDiff: CommitDiff = {
  changeType: 'MODIFY',
  oldContent: 'class Old {}',
  newContent: 'class New {}',
}

const samplePulls: PullRequest[] = [
  {
    number: 12,
    title: 'Add login',
    body: '**not markdown** just text',
    state: 'open',
    author: 'octocat',
    mergedAt: null,
    headSha: 'abc',
    baseSha: 'def',
  },
]

const sampleAreas: ProjectArea[] = [
  {
    areaType: 'BACKEND',
    confidence: 0.9,
    technologies: ['Java'],
    evidences: [],
    selected: true,
  },
]

const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/projects/7/commits') {
      const page = Number(url.searchParams.get('page') ?? '1')
      if (page === 1) {
        return jsonResponse(Array.from({ length: COMMIT_PAGE_SIZE }, (_, i) => commitSummary(1, i)))
      }
      if (page === 2) {
        return jsonResponse([commitSummary(2, 0)])
      }
      return jsonResponse([])
    }
    if (path === `/api/projects/7/commits/${firstSha}`) {
      return jsonResponse(firstDetail)
    }
    if (path === `/api/projects/7/commits/${firstSha}/diff`) {
      return jsonResponse(sampleDiff)
    }
    if (path === '/api/projects/7/branches') {
      return jsonResponse([{ name: 'main', headSha: firstSha }])
    }
    if (path === '/api/projects/7/pulls') {
      return jsonResponse(samplePulls)
    }
    if (path === '/api/projects/7/areas') {
      return jsonResponse(sampleAreas)
    }
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderHistory() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/history'] })
  return render(<RouterProvider router={router} />)
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

describe('HistoryPage', () => {
  it('renders the commit timeline and fetches the next page', async () => {
    renderHistory()

    expect(await screen.findByText('commit-page-1-0')).toBeInTheDocument()
    expect(screen.getByText('commit-page-1-49')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '이전 커밋 더 보기' }))

    expect(await screen.findByText('commit-page-2-0')).toBeInTheDocument()
    await waitFor(() => {
      const paged = fetchMock.mock.calls.some((call) => {
        const url = requestUrl(call[0] as RequestInfo | URL)
        return url.pathname === '/api/projects/7/commits' && url.searchParams.get('page') === '2'
      })
      expect(paged).toBe(true)
    })
  })

  it('shows commit detail when a commit is selected', async () => {
    renderHistory()

    const detail = await screen.findByRole('article', { name: '커밋 상세' })
    expect(within(detail).getByText('Ada Lovelace')).toBeInTheDocument()
    expect(within(detail).getByRole('button', { name: /src\/App.java/ })).toBeInTheDocument()
    expect(within(detail).getByText('+4')).toBeInTheDocument()
  })

  it('renders Monaco DiffEditor from a mocked diff response', async () => {
    renderHistory()

    fireEvent.click(await screen.findByRole('button', { name: /src\/App.java/ }))

    expect(await screen.findByTestId('monaco-diff-editor')).toBeInTheDocument()
    expect(screen.getByTestId('diff-original')).toHaveTextContent('class Old {}')
    expect(screen.getByTestId('diff-modified')).toHaveTextContent('class New {}')
  })

  it('lists pull requests with plain-text body', async () => {
    renderHistory()

    fireEvent.click(await screen.findByRole('tab', { name: 'Pull requests' }))
    const list = await screen.findByRole('list', { name: 'Pull request 목록' })
    expect(within(list).getByText('Add login')).toBeInTheDocument()
    expect(within(list).getByText('octocat')).toBeInTheDocument()
    expect(await screen.findByRole('article', { name: 'Pull request 상세' })).toHaveTextContent(
      '**not markdown** just text',
    )
  })
})
