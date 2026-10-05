import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthorizedError } from '../../api/client'
import { cancelJob, getJob, retryJob, subscribeJobEvents } from '../../api/jobs'
import type { JobDetail } from '../../api/types'
import { renderWithRouter as render } from '../../test/renderWithRouter'
import ProgressStep from './ProgressStep'

vi.mock('../../api/jobs', () => ({
  getJob: vi.fn(),
  retryJob: vi.fn(),
  cancelJob: vi.fn(),
  subscribeJobEvents: vi.fn(),
}))

const running: JobDetail = {
  id: 42, projectId: 7, snapshotId: 9, type: 'IMPORT', status: 'RUNNING',
  error: null, failureCode: null, createdAt: null, startedAt: '2026-10-05T08:00:00Z',
  finishedAt: null, steps: [],
}
const cancelled: JobDetail = { ...running, status: 'CANCELLED', finishedAt: '2026-10-05T08:01:00Z' }
const failed: JobDetail = { ...running, status: 'FAILED', error: 'Temporary service failure.' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(cancelJob).mockResolvedValue(undefined)
  vi.mocked(retryJob).mockResolvedValue(undefined)
  vi.mocked(subscribeJobEvents).mockReturnValue(vi.fn())
})

describe('progress responses that arrive after newer state', () => {
  it('requires reconnecting from account settings instead of replaying an authentication-failed job', async () => {
    vi.mocked(getJob).mockResolvedValue({ ...failed, failureCode: 'GITHUB_REAUTHENTICATION_REQUIRED' })
    render(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={vi.fn()} />)
    const account = await screen.findByRole('link', { name: /GitHub/ })
    expect(account).toHaveAttribute('href', '/settings#github-account')
    expect(screen.queryByRole('button', { name: /^(Retry|재시도)$/ })).not.toBeInTheDocument()
    expect(retryJob).not.toHaveBeenCalled()
  })
  it('continues stream recovery when a cancellation is rejected during the recovery GET', async () => {
    const recovery = deferred<JobDetail>()
    vi.mocked(getJob)
      .mockResolvedValue(running)
      .mockResolvedValueOnce(running)
      .mockReturnValueOnce(recovery.promise)
    vi.mocked(cancelJob).mockRejectedValue(new ApiError(403, 'Cancel permission denied.'))
    const changed = vi.fn()
    const done = vi.fn()
    render(<ProgressStep jobId={42} onDone={done} onUnauthorized={vi.fn()} onJobChange={changed} />)
    await waitFor(() => expect(subscribeJobEvents).toHaveBeenCalledOnce())
    act(() => vi.mocked(subscribeJobEvents).mock.calls[0][2]())
    await waitFor(() => expect(getJob).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel analysis' }))
    await screen.findByText('Cancel permission denied.')
    await act(async () => { recovery.resolve(running) })
    await waitFor(() => expect(subscribeJobEvents).toHaveBeenCalledTimes(2))
    const completed: JobDetail = { ...running, status: 'DONE' }
    act(() => vi.mocked(subscribeJobEvents).mock.calls[1][1](completed))

    expect(changed).toHaveBeenLastCalledWith(completed)
    expect(done).toHaveBeenCalledOnce()
  })

  it('keeps cancellation complete when the cancel GET returns an older CANCELLING state', async () => {
    const late = deferred<JobDetail>()
    vi.mocked(getJob).mockResolvedValueOnce(running).mockReturnValueOnce(late.promise)
    const changed = vi.fn()
    const done = vi.fn()
    render(<ProgressStep jobId={42} onDone={done} onUnauthorized={vi.fn()} onJobChange={changed} />)
    await waitFor(() => expect(subscribeJobEvents).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel analysis' }))
    await waitFor(() => expect(getJob).toHaveBeenCalledTimes(2))

    act(() => vi.mocked(subscribeJobEvents).mock.calls[0][1](cancelled))
    expect(changed).toHaveBeenLastCalledWith(cancelled)
    await act(async () => { late.resolve({ ...running, status: 'CANCELLING' }) })

    expect(screen.queryByRole('button', { name: 'Cancelling…' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('분석 취소됨')
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith(cancelled)
    expect(done).not.toHaveBeenCalled()
  })

  it('does not notify the parent from an old cancel GET after the same job is remounted', async () => {
    const late = deferred<JobDetail>()
    vi.mocked(getJob)
      .mockResolvedValueOnce(running)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(cancelled)
    const changed = vi.fn()
    const done = vi.fn()
    const unauthorized = vi.fn()
    const view = render(<ProgressStep key="running" jobId={42} onDone={done} onUnauthorized={unauthorized} onJobChange={changed} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel analysis' }))
    await waitFor(() => expect(getJob).toHaveBeenCalledTimes(2))

    view.rerender(<ProgressStep key="cancelled" jobId={42} onDone={done} onUnauthorized={unauthorized} onJobChange={changed} />)
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(cancelled))
    await act(async () => { late.resolve({ ...running, status: 'CANCELLING' }) })

    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith(cancelled)
    expect(screen.queryByRole('button', { name: 'Cancelling…' })).not.toBeInTheDocument()
    expect(unauthorized).not.toHaveBeenCalled()
  })

  it.each(['RUNNING', 'DONE'] as const)('ignores a late retry %s response after the parent observes the finished attempt', async (status) => {
    const late = deferred<JobDetail>()
    const completed: JobDetail = { ...running, status: 'DONE', finishedAt: '2026-10-05T08:02:00Z' }
    vi.mocked(getJob)
      .mockResolvedValueOnce(failed)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(completed)
    const changed = vi.fn()
    const done = vi.fn()
    const unauthorized = vi.fn()
    const view = render(<ProgressStep key="failed" jobId={42} onDone={done} onUnauthorized={unauthorized} onJobChange={changed} />)
    fireEvent.click(await screen.findByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(getJob).toHaveBeenCalledTimes(2))

    view.rerender(<ProgressStep key="finished" jobId={42} onDone={done} onUnauthorized={unauthorized} onJobChange={changed} />)
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(completed))
    await act(async () => { late.resolve({ ...running, status }) })

    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith(completed)
    expect(done).toHaveBeenCalledOnce()
    expect(subscribeJobEvents).not.toHaveBeenCalled()
  })

  it('does not send an expired response from an old retry to the new job authentication flow', async () => {
    const late = deferred<JobDetail>()
    const nextJob = { ...running, id: 43 }
    vi.mocked(getJob)
      .mockResolvedValueOnce(failed)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(nextJob)
    const changed = vi.fn()
    const done = vi.fn()
    const unauthorized = vi.fn()
    const view = render(<ProgressStep jobId={42} onDone={done} onUnauthorized={unauthorized} onJobChange={changed} />)
    fireEvent.click(await screen.findByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(getJob).toHaveBeenCalledTimes(2))

    view.rerender(<ProgressStep jobId={43} onDone={done} onUnauthorized={unauthorized} onJobChange={changed} />)
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(nextJob))
    await act(async () => { late.reject(new UnauthorizedError()) })

    expect(unauthorized).not.toHaveBeenCalled()
    expect(changed).toHaveBeenLastCalledWith(nextJob)
    expect(done).not.toHaveBeenCalled()
  })
})
