import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMe } from '../../api/auth'
import { getJob, subscribeJobEvents } from '../../api/jobs'
import { createLocalProject, previewLocalProject } from '../../api/projects'
import type { CreateProjectResponse, LocalSourcePreview } from '../../api/types'
import ImportWizardPage from '../import/ImportWizardPage'
import LocalSourceApproval from '../projects/LocalSourceApproval'
import ProjectWorkspacePage from '../projects/ProjectWorkspacePage'

// G-UX A12: when the content a keyboard user acts on is replaced, focus must not fall to <body>.
// Folder chosen -> the local import heading; preview loaded -> the preview heading plus a polite
// announcement; analysis finished -> the workspace h1 of the opened overview plus a status.

vi.mock('../../api/auth', () => ({ getMe: vi.fn() }))
vi.mock('../../api/jobs', () => ({
  getJob: vi.fn(),
  retryJob: vi.fn(),
  cancelJob: vi.fn(),
  subscribeJobEvents: vi.fn(),
}))
vi.mock('../../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/projects')>()),
  createLocalProject: vi.fn(),
  previewLocalProject: vi.fn(),
}))
vi.mock('../projects/LocalSourceStatus', () => ({ default: () => null }))
vi.mock('../projects/GithubAnalysisStatus', () => ({ default: () => null }))

function preview(): LocalSourcePreview {
  return {
    previewToken: 'focus-approval',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    operation: 'INITIAL',
    sourceName: 'fixture',
    snapshotId: null,
    changes: { added: 3, modified: 0, deleted: 0, total: 3 },
    changedPaths: ['a.ts'],
    localImport: {
      schemaVersion: 1,
      policyVersion: 'local-ingest-v1',
      acceptedFiles: 3,
      bytesRead: 20,
      excludedEntriesByReason: {},
    },
  }
}

const previousBridge = window.codeIntelligenceDesktop

beforeEach(() => {
  vi.resetAllMocks()
  window.localStorage.setItem('code-intelligence.lang', 'ko')
  vi.mocked(getMe).mockResolvedValue({
    authenticated: true,
    login: 'local',
    name: 'Local',
    avatarUrl: null,
    credentialKind: 'LOCAL',
    oauthAvailable: false,
  })
  vi.mocked(previewLocalProject).mockImplementation(async () => preview())
  vi.mocked(subscribeJobEvents).mockReturnValue(vi.fn())
})
afterEach(() => {
  window.codeIntelligenceDesktop = previousBridge
  vi.unstubAllGlobals()
})

function renderWizard() {
  const router = createMemoryRouter(
    [
      { path: '/import', element: <ImportWizardPage /> },
      { path: '/projects/:projectId/overview', element: <div>Repository overview</div> },
    ],
    { initialEntries: ['/import'] },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

describe('focus placement', () => {
  it('moves focus to the local import heading after a folder is chosen', async () => {
    window.codeIntelligenceDesktop = {
      pickFolder: vi.fn(async () => ({
        path: '/fixture/orders',
        grant: 'g'.repeat(64),
        expiresAt: '2099-01-01T00:00:00Z',
      })),
      authorizeDroppedFolder: vi.fn(),
    } as unknown as typeof window.codeIntelligenceDesktop
    renderWizard()
    const choose = await screen.findByRole('button', { name: 'Choose folder' })
    choose.focus()
    await act(async () => {
      fireEvent.click(choose)
    })
    const heading = await screen.findByRole('heading', { name: '로컬 가져오기 확인' })
    await waitFor(() => expect(heading).toHaveFocus())
  })

  it('moves focus to the preview heading and announces the preview when it loads', async () => {
    render(<LocalSourceApproval source={{ operation: 'INITIAL', path: '/fixture' }} onStarted={vi.fn()} />)
    const request = screen.getByRole('button', { name: '가져올 파일 미리보기' })
    request.focus()
    await act(async () => {
      fireEvent.click(request)
    })
    const heading = await screen.findByRole('heading', { name: 'fixture · 가져오기 미리보기' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByRole('status')).toHaveTextContent('미리보기가 준비되었습니다. 가져올 파일 3개')
  })

  it('opens the overview with an analysis-finished marker when the job completes', async () => {
    window.codeIntelligenceDesktop = undefined
    vi.mocked(createLocalProject).mockResolvedValue({ project: { id: 7 }, jobId: 42 } as CreateProjectResponse)
    vi.mocked(getJob).mockResolvedValue({
      id: 42, projectId: 7, snapshotId: 9, type: 'IMPORT', status: 'DONE', error: null, failureCode: null,
      createdAt: null, startedAt: null, finishedAt: null, steps: [],
    })
    const router = createMemoryRouter(
      [
        { path: '/import', element: <ImportWizardPage /> },
        { path: '/projects/:projectId/overview', element: <div>Repository overview</div> },
      ],
      { initialEntries: ['/import?path=%2Ffixture'] },
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: '가져올 파일 미리보기' }))
    fireEvent.click(await screen.findByRole('button', { name: '확인한 파일 가져오기 및 분석' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/7/overview'))
    expect(router.state.location.state).toEqual({ analysisFinished: true })
  })

  it('focuses the workspace h1 and announces completion when the overview opens after analysis', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: 7, name: 'Orders', sourceType: 'LOCAL', currentSnapshot: null }),
      { headers: { 'Content-Type': 'application/json' } },
    )))
    const router = createMemoryRouter(
      [{ path: '/projects/:projectId', element: <ProjectWorkspacePage />, children: [{ path: 'overview', element: <p>Overview</p> }] }],
      { initialEntries: [{ pathname: '/projects/7/overview', state: { analysisFinished: true } }] },
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
    const heading = await screen.findByRole('heading', { level: 1, name: 'Orders' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByRole('status')).toHaveTextContent('분석이 끝났습니다')
  })

  it('leaves focus alone when the overview is opened normally', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: 7, name: 'Orders', sourceType: 'LOCAL', currentSnapshot: null }),
      { headers: { 'Content-Type': 'application/json' } },
    )))
    const router = createMemoryRouter(
      [{ path: '/projects/:projectId', element: <ProjectWorkspacePage />, children: [{ path: 'overview', element: <p>Overview</p> }] }],
      { initialEntries: ['/projects/7/overview'] },
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
    const heading = await screen.findByRole('heading', { level: 1, name: 'Orders' })
    expect(heading).not.toHaveFocus()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
