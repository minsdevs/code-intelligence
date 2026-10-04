import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getMe } from '../../api/auth'
import {
  createLocalProject,
  getLocalPreviewOutcome,
  previewLocalProject,
  previewLocalRefresh,
  reanalyzeLocalProject,
} from '../../api/projects'
import { getJob, subscribeJobEvents } from '../../api/jobs'
import type { CreateProjectResponse, LocalSourcePreview } from '../../api/types'
import ImportWizardPage from './ImportWizardPage'

vi.mock('../../api/auth', () => ({ getMe: vi.fn() }))
vi.mock('../../api/projects', () => ({
  createLocalProject: vi.fn(),
  getLocalPreviewOutcome: vi.fn(),
  previewLocalProject: vi.fn(),
  previewLocalRefresh: vi.fn(),
  reanalyzeLocalProject: vi.fn(),
}))
vi.mock('../../api/jobs', () => ({
  getJob: vi.fn(),
  retryJob: vi.fn(),
  cancelJob: vi.fn(),
  subscribeJobEvents: vi.fn(),
}))
// These steps are outside the local approval path under test.
vi.mock('./ConnectStep', () => ({ default: () => <div>Connect</div> }))
vi.mock('./RepoStep', () => ({ default: () => <div>Repository</div> }))

function preview(): LocalSourcePreview {
  return {
    previewToken: 'wizard-approval',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    operation: 'INITIAL',
    sourceName: 'fixture',
    snapshotId: null,
    changes: { added: 1, modified: 0, deleted: 0, total: 1 },
    changedPaths: ['safe.ts'],
    localImport: {
      schemaVersion: 1,
      policyVersion: 'local-ingest-v1',
      acceptedFiles: 1,
      bytesRead: 20,
      excludedEntriesByReason: {},
    },
  }
}

function renderWizard() {
  const router = createMemoryRouter(
    [
      { path: '/import', element: <ImportWizardPage /> },
      { path: '/projects/:id', element: <div>Existing project</div> },
      { path: '/projects/:id/overview', element: <div>Repository overview</div> },
    ],
    { initialEntries: ['/import?path=%2Ffixture%2Ffirst'] },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getMe).mockResolvedValue({
    authenticated: true,
    login: 'local',
    name: 'Local',
    avatarUrl: null,
    credentialKind: 'LOCAL',
    oauthAvailable: false,
  })
  vi.mocked(previewLocalProject).mockImplementation(async () => preview())
  vi.mocked(createLocalProject).mockResolvedValue({
    project: { id: 7 },
    jobId: 42,
  } as CreateProjectResponse)
  vi.mocked(getJob).mockResolvedValue({
    id: 42,
    projectId: 7,
    snapshotId: null,
    type: 'IMPORT',
    status: 'RUNNING',
    error: null,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    steps: [],
  })
  vi.mocked(subscribeJobEvents).mockReturnValue(vi.fn())
})

describe('local import wizard approval integration', () => {
  it('treats an external path as a selection, then starts progress only after the separate confirmation', async () => {
    renderWizard()
    const requestPreview = await screen.findByRole('button', { name: '가져올 파일 미리보기' })
    expect(screen.getByText('/fixture/first')).toBeInTheDocument()
    expect(previewLocalProject).not.toHaveBeenCalled()
    expect(createLocalProject).not.toHaveBeenCalled()
    fireEvent.click(requestPreview)
    const confirm = await screen.findByRole('button', { name: '확인한 파일 가져오기 및 분석' })
    expect(createLocalProject).not.toHaveBeenCalled()
    fireEvent.click(confirm)
    await waitFor(() => expect(getJob).toHaveBeenCalledWith(42))
    expect(createLocalProject).toHaveBeenCalledExactlyOnceWith('/fixture/first', 'wizard-approval')
  })

  it('opens overview immediately when the approved local analysis completes', async () => {
    vi.mocked(getJob).mockResolvedValue({
      id: 42, projectId: 7, snapshotId: 5, type: 'IMPORT', status: 'DONE',
      error: null, createdAt: null, startedAt: null, finishedAt: null, steps: [],
    })
    const router = renderWizard()
    fireEvent.click(await screen.findByRole('button', { name: '가져올 파일 미리보기' }))
    fireEvent.click(await screen.findByRole('button', { name: '확인한 파일 가져오기 및 분석' }))
    await screen.findByText('Repository overview')
    expect(router.state.location.pathname).toBe('/projects/7/overview')
  })

  it('clears approval when the supplied URL path changes without automatically previewing the next path', async () => {
    const router = renderWizard()
    fireEvent.click(await screen.findByRole('button', { name: '가져올 파일 미리보기' }))
    await screen.findByRole('button', { name: '확인한 파일 가져오기 및 분석' })
    await act(async () => router.navigate('/import?path=%2Ffixture%2Fsecond'))
    await screen.findByRole('button', { name: '가져올 파일 미리보기' })
    expect(screen.getByText('/fixture/second')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '확인한 파일 가져오기 및 분석' }),
    ).not.toBeInTheDocument()
    expect(previewLocalProject).toHaveBeenCalledTimes(1)
    expect(createLocalProject).not.toHaveBeenCalled()
  })

  it('routes a failed initial worker to its existing project for a new REFRESH approval', async () => {
    vi.mocked(getJob).mockResolvedValue({
      id: 42,
      projectId: 7,
      snapshotId: null,
      type: 'IMPORT',
      status: 'FAILED',
      failureCode: 'LOCAL_PREVIEW_REQUIRED',
      error: 'Changed input.',
      createdAt: null,
      startedAt: null,
      finishedAt: null,
      steps: [],
    })
    const router = renderWizard()
    fireEvent.click(await screen.findByRole('button', { name: '가져올 파일 미리보기' }))
    fireEvent.click(await screen.findByRole('button', { name: '확인한 파일 가져오기 및 분석' }))
    fireEvent.click(await screen.findByRole('button', { name: '기존 프로젝트에서 새 미리보기' }))
    await screen.findByText('Existing project')
    expect(router.state.location.pathname).toBe('/projects/7')
    expect(createLocalProject).toHaveBeenCalledTimes(1)
    expect(previewLocalRefresh).not.toHaveBeenCalled()
    expect(reanalyzeLocalProject).not.toHaveBeenCalled()
    expect(getLocalPreviewOutcome).not.toHaveBeenCalled()
  })
})
