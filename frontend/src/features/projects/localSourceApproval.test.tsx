import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import {
  createLocalProject,
  getLocalPreviewOutcome,
  previewLocalProject,
  previewLocalRefresh,
  reanalyzeLocalProject,
} from '../../api/projects'
import type { CreateProjectResponse, LocalSourcePreview } from '../../api/types'
import LocalSourceApproval from './LocalSourceApproval'

vi.mock('../../api/projects', () => ({
  createLocalProject: vi.fn(),
  getLocalPreviewOutcome: vi.fn(),
  previewLocalProject: vi.fn(),
  previewLocalRefresh: vi.fn(),
  reanalyzeLocalProject: vi.fn(),
}))

function preview(operation: 'INITIAL' | 'REFRESH' = 'INITIAL'): LocalSourcePreview {
  return {
    previewToken: 'opaque-token-never-display',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    operation,
    sourceName: 'fixture-source',
    snapshotId: operation === 'INITIAL' ? null : 4,
    changes: { added: 1, modified: 1, deleted: 0, total: 2 },
    changedPaths: ['src/fixture.ts'],
    localImport: {
      schemaVersion: 1,
      policyVersion: 'local-ingest-v1',
      acceptedFiles: 3,
      bytesRead: 128,
      excludedEntriesByReason: { GENERATED_DIRECTORY: 1, SECRET_CONTENT: 2 },
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const created = { project: { id: 7 }, jobId: 42 } as CreateProjectResponse

async function initialReview() {
  fireEvent.click(screen.getByRole('button', { name: '가져올 파일 미리보기' }))
  return screen.findByRole('button', { name: '확인한 파일 가져오기 및 분석' })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(previewLocalProject).mockImplementation(async () => preview())
  vi.mocked(previewLocalRefresh).mockImplementation(async () => preview('REFRESH'))
  vi.mocked(createLocalProject).mockResolvedValue(created)
  vi.mocked(reanalyzeLocalProject).mockResolvedValue({ jobId: 42 })
  vi.mocked(getLocalPreviewOutcome).mockResolvedValue({
    state: 'ABANDONED',
    projectId: null,
    jobId: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('local source approval', () => {
  it('requires two explicit actions and labels preview inventory without exposing its approval token', async () => {
    const onStarted = vi.fn()
    render(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/source' }}
        onStarted={onStarted}
      />,
    )
    expect(previewLocalProject).not.toHaveBeenCalled()
    expect(createLocalProject).not.toHaveBeenCalled()
    const confirm = await initialReview()
    expect(previewLocalProject).toHaveBeenCalledWith('/fixture/source')
    expect(createLocalProject).not.toHaveBeenCalled()
    expect(screen.getByText('미리보기에서 선택한 파일: 3개')).toBeInTheDocument()
    expect(screen.getByText('검사 중 읽은 바이트: 128')).toBeInTheDocument()
    expect(screen.getByText('생성·의존성 폴더')).toBeInTheDocument()
    expect(screen.getByText('민감 내용')).toBeInTheDocument()
    expect(
      screen.getByText('폴더 단위 제외는 1개 항목으로 셉니다. 하위 항목 수는 측정하지 않았습니다.'),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('opaque-token-never-display')
    expect(document.body).not.toHaveTextContent('SECRET_CONTENT')
    fireEvent.click(confirm)
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(7, 42))
    expect(createLocalProject).toHaveBeenCalledExactlyOnceWith(
      '/fixture/source',
      'opaque-token-never-display',
    )
    expect(getLocalPreviewOutcome).not.toHaveBeenCalled()
  })

  it('sends a confirmation only once even before its response arrives', async () => {
    const pending = deferred<CreateProjectResponse>()
    vi.mocked(createLocalProject).mockReturnValue(pending.promise)
    const onStarted = vi.fn()
    render(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/source' }}
        onStarted={onStarted}
      />,
    )
    const confirm = await initialReview()
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(createLocalProject).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '가져올 파일 미리보기' })).not.toBeInTheDocument()
    await act(async () => pending.resolve(created))
    expect(onStarted).toHaveBeenCalledTimes(1)
  })

  it('expires a visible approval and requires a new explicit preview', async () => {
    vi.useFakeTimers()
    render(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/source' }}
        onStarted={vi.fn()}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '가져올 파일 미리보기' }))
    })
    expect(screen.getByRole('button', { name: '확인한 파일 가져오기 및 분석' })).toBeEnabled()
    await act(async () => vi.advanceTimersByTime(600_001))
    expect(screen.getByRole('alert')).toHaveTextContent('미리보기가 만료되었습니다')
    expect(
      screen.queryByRole('button', { name: '확인한 파일 가져오기 및 분석' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '가져올 파일 미리보기' })).toBeEnabled()
    expect(previewLocalProject).toHaveBeenCalledTimes(1)
    expect(createLocalProject).not.toHaveBeenCalled()
  })

  it('reconciles a stalled confirmation once and ignores its late successful response', async () => {
    vi.useFakeTimers()
    const stalled = deferred<CreateProjectResponse>()
    vi.mocked(createLocalProject).mockReturnValue(stalled.promise)
    vi.mocked(getLocalPreviewOutcome).mockResolvedValue({
      state: 'CONSUMED',
      projectId: 7,
      jobId: 42,
    })
    const onStarted = vi.fn()
    render(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/source' }}
        onStarted={onStarted}
      />,
    )
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: '가져올 파일 미리보기' })),
    )
    fireEvent.click(screen.getByRole('button', { name: '확인한 파일 가져오기 및 분석' }))
    await act(async () => vi.advanceTimersByTimeAsync(30_001))
    expect(getLocalPreviewOutcome).toHaveBeenCalledExactlyOnceWith('opaque-token-never-display')
    expect(createLocalProject).toHaveBeenCalledTimes(1)
    expect(onStarted).toHaveBeenCalledExactlyOnceWith(7, 42)
    await act(async () => stalled.resolve(created))
    expect(onStarted).toHaveBeenCalledTimes(1)
  })

  it('offers lookup-only recovery after the outcome response also stalls', async () => {
    vi.useFakeTimers()
    const stalled = deferred<CreateProjectResponse>()
    const lookup = deferred<Awaited<ReturnType<typeof getLocalPreviewOutcome>>>()
    vi.mocked(createLocalProject).mockReturnValue(stalled.promise)
    vi.mocked(getLocalPreviewOutcome).mockReturnValueOnce(lookup.promise)
    const onStarted = vi.fn()
    render(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/source' }}
        onStarted={onStarted}
      />,
    )
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: '가져올 파일 미리보기' })),
    )
    fireEvent.click(screen.getByRole('button', { name: '확인한 파일 가져오기 및 분석' }))
    await act(async () => vi.advanceTimersByTimeAsync(60_001))
    expect(screen.getByRole('button', { name: '작업 상태 다시 확인' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '가져올 파일 미리보기' })).not.toBeInTheDocument()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: '작업 상태 다시 확인' })),
    )
    expect(screen.getByRole('button', { name: '가져올 파일 미리보기' })).toBeEnabled()
    await act(async () => lookup.resolve({ state: 'CONSUMED', projectId: 7, jobId: 42 }))
    await act(async () => stalled.resolve(created))
    expect(onStarted).not.toHaveBeenCalled()
    expect(createLocalProject).toHaveBeenCalledTimes(1)
    expect(getLocalPreviewOutcome).toHaveBeenCalledTimes(2)
  })

  it('checks the deadline again on confirmation even when a browser timer has not fired', async () => {
    vi.useFakeTimers()
    render(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/source' }}
        onStarted={vi.fn()}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '가져올 파일 미리보기' }))
    })
    vi.setSystemTime(Date.now() + 600_001)
    fireEvent.click(screen.getByRole('button', { name: '확인한 파일 가져오기 및 분석' }))
    expect(createLocalProject).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('미리보기가 만료되었습니다')
  })

  it('reconciles a rejected approval, then requires a new review without automatic confirmation', async () => {
    vi.mocked(createLocalProject).mockRejectedValueOnce(
      new ApiError(409, 'safe error', 'LOCAL_SOURCE_CHANGED'),
    )
    const onStarted = vi.fn()
    render(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/source' }}
        onStarted={onStarted}
      />,
    )
    fireEvent.click(await initialReview())
    expect(await screen.findByRole('alert')).toHaveTextContent('이 승인으로 시작된 작업이 없습니다')
    expect(getLocalPreviewOutcome).toHaveBeenCalledExactlyOnceWith('opaque-token-never-display')
    expect(previewLocalProject).toHaveBeenCalledTimes(1)
    expect(createLocalProject).toHaveBeenCalledTimes(1)
    expect(onStarted).not.toHaveBeenCalled()
    await initialReview()
    expect(createLocalProject).toHaveBeenCalledTimes(1)
  })

  it('follows the exact existing job after a lost confirmation response', async () => {
    vi.mocked(createLocalProject).mockRejectedValue(new TypeError('Lost response'))
    vi.mocked(getLocalPreviewOutcome).mockResolvedValue({
      state: 'CONSUMED',
      projectId: 17,
      jobId: 52,
    })
    const onStarted = vi.fn()
    render(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/source' }}
        onStarted={onStarted}
      />,
    )
    fireEvent.click(await initialReview())
    await waitFor(() => expect(onStarted).toHaveBeenCalledExactlyOnceWith(17, 52))
    expect(createLocalProject).toHaveBeenCalledTimes(1)
    expect(previewLocalProject).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('blocks new mutations while the outcome is unknown and only retries the outcome lookup', async () => {
    vi.mocked(createLocalProject).mockRejectedValue(new TypeError('Lost response'))
    vi.mocked(getLocalPreviewOutcome)
      .mockRejectedValueOnce(new TypeError('Offline'))
      .mockResolvedValueOnce({ state: 'ABANDONED', projectId: null, jobId: null })
    const busy = vi.fn()
    render(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/source' }}
        onStarted={vi.fn()}
        onBusyChange={busy}
      />,
    )
    fireEvent.click(await initialReview())
    const retry = await screen.findByRole('button', { name: '작업 상태 다시 확인' })
    expect(screen.getByRole('alert')).toHaveTextContent('중복 실행을 막기 위해')
    expect(screen.queryByRole('button', { name: '가져올 파일 미리보기' })).not.toBeInTheDocument()
    expect(busy).toHaveBeenLastCalledWith(true)
    fireEvent.click(retry)
    await screen.findByRole('button', { name: '가져올 파일 미리보기' })
    expect(getLocalPreviewOutcome).toHaveBeenCalledTimes(2)
    expect(createLocalProject).toHaveBeenCalledTimes(1)
    expect(previewLocalProject).toHaveBeenCalledTimes(1)
    expect(busy).toHaveBeenLastCalledWith(false)
  })

  it('discards a late initial preview after the selected path changes', async () => {
    const old = deferred<LocalSourcePreview>()
    vi.mocked(previewLocalProject).mockReturnValueOnce(old.promise)
    const onStarted = vi.fn()
    const { rerender } = render(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/old' }}
        onStarted={onStarted}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '가져올 파일 미리보기' }))
    rerender(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/new' }}
        onStarted={onStarted}
      />,
    )
    await act(async () => old.resolve(preview()))
    expect(
      screen.queryByRole('button', { name: '확인한 파일 가져오기 및 분석' }),
    ).not.toBeInTheDocument()
    fireEvent.click(await initialReview())
    await waitFor(() =>
      expect(createLocalProject).toHaveBeenCalledExactlyOnceWith(
        '/fixture/new',
        'opaque-token-never-display',
      ),
    )
  })

  it('discards a late refresh preview after switching projects', async () => {
    const old = deferred<LocalSourcePreview>()
    vi.mocked(previewLocalRefresh).mockReturnValueOnce(old.promise)
    const onStarted = vi.fn()
    const { rerender } = render(
      <LocalSourceApproval source={{ operation: 'REFRESH', projectId: 7 }} onStarted={onStarted} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '변경 사항 미리보기' }))
    rerender(
      <LocalSourceApproval source={{ operation: 'REFRESH', projectId: 8 }} onStarted={onStarted} />,
    )
    await act(async () => old.resolve(preview('REFRESH')))
    expect(
      screen.queryByRole('button', { name: '변경 확인 후 전체 재분석' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '변경 사항 미리보기' }))
    fireEvent.click(await screen.findByRole('button', { name: '변경 확인 후 전체 재분석' }))
    await waitFor(() => expect(onStarted).toHaveBeenCalledExactlyOnceWith(8, 42))
    expect(reanalyzeLocalProject).toHaveBeenCalledExactlyOnceWith(8, 'opaque-token-never-display')
  })

  it('does not deliver an old submission result into another project', async () => {
    const old = deferred<{ jobId: number }>()
    vi.mocked(reanalyzeLocalProject).mockReturnValueOnce(old.promise)
    const onStarted = vi.fn()
    const { rerender } = render(
      <LocalSourceApproval source={{ operation: 'REFRESH', projectId: 7 }} onStarted={onStarted} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '변경 사항 미리보기' }))
    fireEvent.click(await screen.findByRole('button', { name: '변경 확인 후 전체 재분석' }))
    rerender(
      <LocalSourceApproval source={{ operation: 'REFRESH', projectId: 8 }} onStarted={onStarted} />,
    )
    await act(async () => old.resolve({ jobId: 42 }))
    expect(onStarted).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '변경 사항 미리보기' })).toBeEnabled()
  })

  it.each([
    { previewToken: '' },
    { operation: 'REFRESH' },
    { localImport: null },
    {
      localImport: { ...preview().localImport, excludedEntriesByReason: { UNVERIFIED_REASON: 1 } },
    },
  ])('does not approve malformed or incompatible previews: %j', async (patch) => {
    vi.mocked(previewLocalProject).mockResolvedValue({
      ...preview(),
      ...patch,
    } as LocalSourcePreview)
    render(
      <LocalSourceApproval
        source={{ operation: 'INITIAL', path: '/fixture/source' }}
        onStarted={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '가져올 파일 미리보기' }))
    await screen.findByRole('alert')
    expect(
      screen.queryByRole('button', { name: '확인한 파일 가져오기 및 분석' }),
    ).not.toBeInTheDocument()
    expect(createLocalProject).not.toHaveBeenCalled()
  })

  it('keeps refresh reconciliation blocked if a response claims a different project', async () => {
    vi.mocked(reanalyzeLocalProject).mockRejectedValue(new TypeError('Lost response'))
    vi.mocked(getLocalPreviewOutcome).mockResolvedValue({
      state: 'CONSUMED',
      projectId: 8,
      jobId: 42,
    })
    const onStarted = vi.fn()
    render(
      <LocalSourceApproval source={{ operation: 'REFRESH', projectId: 7 }} onStarted={onStarted} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '변경 사항 미리보기' }))
    fireEvent.click(await screen.findByRole('button', { name: '변경 확인 후 전체 재분석' }))
    await screen.findByRole('button', { name: '작업 상태 다시 확인' })
    expect(onStarted).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '변경 사항 미리보기' })).not.toBeInTheDocument()
  })
})
