import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalProject,
  getLocalSourceStatus,
  previewLocalRefresh,
  reanalyzeLocalProject,
  relinkLocalProject,
} from '../../api/projects'
import { getJob } from '../../api/jobs'
import type {
  LocalSourcePreview,
  LocalSourceStatus as LocalSourceStatusView,
} from '../../api/types'
import LocalSourceStatus from './LocalSourceStatus'

vi.mock('../../api/projects', () => ({
  getLocalSourceStatus: vi.fn(),
  reanalyzeLocalProject: vi.fn(),
  relinkLocalProject: vi.fn(),
  previewLocalProject: vi.fn(),
  previewLocalRefresh: vi.fn(),
  createLocalProject: vi.fn(),
  getLocalPreviewOutcome: vi.fn(),
}))
vi.mock('../../api/jobs', () => ({ getJob: vi.fn() }))

const inspectionFailed: LocalSourceStatusView = {
  state: 'INSPECTION_FAILED',
  snapshotId: 4,
  // Contradictory stale preview fields must not enable reanalysis or appear as a valid preview.
  changes: { added: 1, modified: 0, deleted: 0, total: 1 },
  changedPaths: ['/private/fixture/source.ts'],
  fullAnalysisRequired: true,
  message: 'Inspection exception at /private/fixture/source.ts',
}

function renderStatus(details = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <LocalSourceStatus projectId={7} details={details} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('codeIntelligenceDesktop', { pickFolder: vi.fn() })
  vi.mocked(getLocalSourceStatus).mockResolvedValue(inspectionFailed)
  vi.mocked(previewLocalRefresh).mockResolvedValue({
    previewToken: 'one-use-refresh',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    operation: 'REFRESH',
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
  } satisfies LocalSourcePreview)
  vi.mocked(reanalyzeLocalProject).mockResolvedValue({ jobId: 42 })
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
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local source inspection failures', () => {
  it('shows safe inspection guidance with status retry and no reanalysis or folder reauthorization', async () => {
    renderStatus()
    const panel = await screen.findByRole('region', { name: 'Local source status' })
    expect(within(panel).getByText('검사 실패')).toBeInTheDocument()
    expect(
      within(panel).getByText(
        '원본 폴더의 파일 수·용량과 파일 상태를 확인한 뒤 상태를 새로고침하세요.',
      ),
    ).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: '상태 새로고침' })).toBeEnabled()
    expect(
      within(panel).queryByRole('button', { name: '변경 확인 후 전체 재분석' }),
    ).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: '폴더 다시 연결' })).not.toBeInTheDocument()
    expect(within(panel).queryByText('변경 파일 보기')).not.toBeInTheDocument()
    expect(panel).not.toHaveTextContent(/권한 재확인|private|fixture|Inspection exception/)
    expect(reanalyzeLocalProject).not.toHaveBeenCalled()
    expect(relinkLocalProject).not.toHaveBeenCalled()
  })

  it('allows another inspection and offers a preview after a changed status is confirmed', async () => {
    vi.mocked(getLocalSourceStatus)
      .mockResolvedValueOnce(inspectionFailed)
      .mockResolvedValue({
        state: 'CHANGED',
        snapshotId: 4,
        changes: { added: 1, modified: 0, deleted: 0, total: 1 },
        changedPaths: ['A safe.ts'],
        fullAnalysisRequired: true,
        message: 'Review the confirmed changes.',
      })
    renderStatus()
    fireEvent.click(await screen.findByRole('button', { name: '상태 새로고침' }))
    expect(await screen.findByRole('button', { name: '변경 사항 미리보기' })).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: '변경 확인 후 전체 재분석' }),
    ).not.toBeInTheDocument()
    await waitFor(() => expect(getLocalSourceStatus).toHaveBeenCalledTimes(2))
    expect(screen.getByText('변경됨')).toBeInTheDocument()
    expect(screen.getByText('변경 파일 보기')).toBeInTheDocument()
    expect(reanalyzeLocalProject).not.toHaveBeenCalled()
  })

  it('labels the compact badge as an inspection failure', async () => {
    renderStatus(false)
    expect(await screen.findByRole('status')).toHaveTextContent('검사 실패')
    expect(screen.queryByText('권한 재확인 필요')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('retains the folder reconnection action for a genuine authorization failure', async () => {
    vi.mocked(getLocalSourceStatus).mockResolvedValue({
      ...inspectionFailed,
      state: 'REAUTHORIZATION_REQUIRED',
      changes: { added: 0, modified: 0, deleted: 0, total: 0 },
      changedPaths: [],
      fullAnalysisRequired: false,
      message: 'Path access needs authorization.',
    })
    renderStatus()
    expect(await screen.findByText('권한 재확인 필요')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '폴더 다시 연결' })).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: '변경 확인 후 전체 재분석' }),
    ).not.toBeInTheDocument()
  })

  it('recovers a project without a snapshot through an explicit REFRESH approval without creating a duplicate project', async () => {
    vi.mocked(getLocalSourceStatus).mockResolvedValue({
      ...inspectionFailed,
      state: 'NO_SNAPSHOT',
      snapshotId: null,
      changedPaths: [],
      message: 'No snapshot.',
    })
    renderStatus()
    fireEvent.click(await screen.findByRole('button', { name: '변경 사항 미리보기' }))
    const confirm = await screen.findByRole('button', { name: '변경 확인 후 전체 재분석' })
    expect(screen.getByText('기준 스냅샷: 없음 (처음 분석)')).toBeInTheDocument()
    expect(reanalyzeLocalProject).not.toHaveBeenCalled()
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(reanalyzeLocalProject).toHaveBeenCalledExactlyOnceWith(7, 'one-use-refresh'),
    )
    expect(createLocalProject).not.toHaveBeenCalled()
    await waitFor(() => expect(getJob).toHaveBeenCalledWith(42))
  })

  it('invalidates a ready approval when the user refreshes informational status', async () => {
    vi.mocked(getLocalSourceStatus).mockResolvedValue({
      ...inspectionFailed,
      state: 'CHANGED',
      message: 'Changed.',
    })
    renderStatus()
    fireEvent.click(await screen.findByRole('button', { name: '변경 사항 미리보기' }))
    await screen.findByRole('button', { name: '변경 확인 후 전체 재분석' })
    fireEvent.click(screen.getByRole('button', { name: '상태 새로고침' }))
    expect(
      screen.queryByRole('button', { name: '변경 확인 후 전체 재분석' }),
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '변경 사항 미리보기' })).toBeEnabled(),
    )
    expect(previewLocalRefresh).toHaveBeenCalledTimes(1)
    expect(reanalyzeLocalProject).not.toHaveBeenCalled()
  })

  it('offers a new approval after the worker rejects the selected source', async () => {
    vi.mocked(getLocalSourceStatus).mockResolvedValue({
      ...inspectionFailed,
      state: 'CHANGED',
      message: 'Changed.',
    })
    vi.mocked(getJob).mockResolvedValue({
      id: 42,
      projectId: 7,
      snapshotId: null,
      type: 'IMPORT',
      status: 'FAILED',
      failureCode: 'LOCAL_PREVIEW_REQUIRED',
      error: 'Source changed.',
      createdAt: null,
      startedAt: null,
      finishedAt: null,
      steps: [],
    })
    renderStatus()
    fireEvent.click(await screen.findByRole('button', { name: '변경 사항 미리보기' }))
    fireEvent.click(await screen.findByRole('button', { name: '변경 확인 후 전체 재분석' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '새 미리보기를 확인한 뒤 다시 승인하세요',
    )
    expect(screen.getByRole('button', { name: '변경 사항 미리보기' })).toBeEnabled()
    expect(previewLocalRefresh).toHaveBeenCalledTimes(1)
    expect(reanalyzeLocalProject).toHaveBeenCalledTimes(1)
  })
})

describe('local source relink', () => {
  it('relinks only with the folder grant of the native picker', async () => {
    const selection = { path: '/fixture/moved', grant: 'g'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' }
    vi.stubGlobal('codeIntelligenceDesktop', { pickFolder: vi.fn(async () => selection) })
    vi.mocked(getLocalSourceStatus).mockResolvedValue({
      ...inspectionFailed,
      state: 'PATH_MISSING',
      changes: { added: 0, modified: 0, deleted: 0, total: 0 },
      changedPaths: [],
      message: null,
    })
    vi.mocked(relinkLocalProject).mockResolvedValue({ id: 7 } as Awaited<ReturnType<typeof relinkLocalProject>>)
    renderStatus()
    fireEvent.click(await screen.findByRole('button', { name: '폴더 다시 연결' }))
    await waitFor(() =>
      expect(relinkLocalProject).toHaveBeenCalledExactlyOnceWith(7, '/fixture/moved', selection.grant),
    )
  })
})
