import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
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
const completed: JobDetail = { ...running, status: 'DONE', finishedAt: '2026-10-05T08:01:00Z' }
const cancelled: JobDetail = { ...running, status: 'CANCELLED', finishedAt: completed.finishedAt }
const failed: JobDetail = { ...running, status: 'FAILED', error: 'Temporary service failure.' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}

let unsubscribe: Mock<() => void>

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  unsubscribe = vi.fn()
  vi.mocked(subscribeJobEvents).mockReturnValue(unsubscribe)
  vi.mocked(getJob).mockResolvedValue(running)
  vi.mocked(cancelJob).mockResolvedValue(undefined)
  vi.mocked(retryJob).mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('progress reconciliation while the event stream stays open', () => {
  it('observes database completion without a terminal event or disconnect and stops all monitoring', async () => {
    vi.mocked(getJob).mockResolvedValue(completed).mockResolvedValueOnce(running)
    const done = vi.fn()
    const changed = vi.fn()
    await act(async () => {
      render(<ProgressStep jobId={42} onDone={done} onUnauthorized={vi.fn()} onJobChange={changed} />)
    })
    expect(subscribeJobEvents).toHaveBeenCalledOnce()

    await advance(1000)
    expect(getJob).toHaveBeenCalledOnce()
    await advance(5000)

    expect(done).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenLastCalledWith(completed)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(subscribeJobEvents).toHaveBeenCalledOnce()
    expect(getJob).toHaveBeenCalledTimes(2)
    await advance(60000)
    expect(getJob).toHaveBeenCalledTimes(2)
    expect(done).toHaveBeenCalledOnce()
    expect(retryJob).not.toHaveBeenCalled()
    expect(cancelJob).not.toHaveBeenCalled()
  })

  it('does not overlap reconciliation reads when a slow read also receives repeated disconnect callbacks', async () => {
    const pending = deferred<JobDetail>()
    vi.mocked(getJob).mockResolvedValueOnce(running).mockReturnValueOnce(pending.promise)
    const done = vi.fn()
    await act(async () => {
      render(<ProgressStep jobId={42} onDone={done} onUnauthorized={vi.fn()} />)
    })
    await advance(6000)
    expect(getJob).toHaveBeenCalledTimes(2)

    const disconnected = vi.mocked(subscribeJobEvents).mock.calls[0][2]
    act(() => { disconnected(); disconnected() })
    await advance(30000)
    expect(getJob).toHaveBeenCalledTimes(2)
    await act(async () => { pending.resolve(completed) })

    expect(done).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    await advance(60000)
    expect(getJob).toHaveBeenCalledTimes(2)
    expect(subscribeJobEvents).toHaveBeenCalledOnce()
  })

  it.each(['RUNNING', 'UNAUTHORIZED'] as const)('ignores a late %s poll after a newer stream observation and keeps reconciling', async (response) => {
    const pending = deferred<JobDetail>()
    const newer: JobDetail = { ...running, status: 'CANCELLING' }
    vi.mocked(getJob).mockResolvedValue(completed).mockResolvedValueOnce(running).mockReturnValueOnce(pending.promise)
    const done = vi.fn()
    const changed = vi.fn()
    const unauthorized = vi.fn()
    await act(async () => {
      render(<ProgressStep jobId={42} onDone={done} onUnauthorized={unauthorized} onJobChange={changed} />)
    })
    await advance(6000)
    expect(getJob).toHaveBeenCalledTimes(2)
    act(() => vi.mocked(subscribeJobEvents).mock.calls[0][1](newer))
    await act(async () => {
      if (response === 'UNAUTHORIZED') pending.reject(new UnauthorizedError())
      else pending.resolve(running)
    })

    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith(newer)
    expect(unauthorized).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
    await advance(6000)
    expect(changed).toHaveBeenLastCalledWith(completed)
    expect(done).toHaveBeenCalledOnce()
  })

  it('does not complete a retried attempt from a poll started before its failure', async () => {
    const pending = deferred<JobDetail>()
    vi.mocked(getJob).mockResolvedValueOnce(running).mockReturnValueOnce(pending.promise)
    const done = vi.fn()
    const changed = vi.fn()
    await act(async () => {
      render(<ProgressStep jobId={42} onDone={done} onUnauthorized={vi.fn()} onJobChange={changed} />)
    })
    await advance(6000)
    expect(getJob).toHaveBeenCalledTimes(2)
    act(() => vi.mocked(subscribeJobEvents).mock.calls[0][1](failed))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '다시 시도' })) })
    expect(retryJob).toHaveBeenCalledOnce()
    expect(subscribeJobEvents).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith(running)
    await act(async () => { pending.resolve(completed) })

    expect(done).not.toHaveBeenCalled()
    expect(changed).toHaveBeenLastCalledWith(running)
    act(() => vi.mocked(subscribeJobEvents).mock.calls[1][1](completed))
    expect(done).toHaveBeenCalledOnce()
  })

  it('keeps acknowledged cancellation terminal when an older poll later reports DONE', async () => {
    const pending = deferred<JobDetail>()
    vi.mocked(getJob).mockResolvedValue(cancelled).mockResolvedValueOnce(running).mockReturnValueOnce(pending.promise)
    const done = vi.fn()
    const changed = vi.fn()
    await act(async () => {
      render(<ProgressStep jobId={42} onDone={done} onUnauthorized={vi.fn()} onJobChange={changed} />)
    })
    await advance(6000)
    expect(getJob).toHaveBeenCalledTimes(2)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel analysis' })) })
    expect(changed).toHaveBeenLastCalledWith(cancelled)
    await act(async () => { pending.resolve(completed) })

    expect(changed).toHaveBeenLastCalledWith(cancelled)
    expect(done).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
    const reads = vi.mocked(getJob).mock.calls.length
    await advance(60000)
    expect(getJob).toHaveBeenCalledTimes(reads)
  })

  it.each(['DONE', 'UNAUTHORIZED'] as const)('ignores a late %s poll after a job switch and cleans up on unmount', async (response) => {
    const pending = deferred<JobDetail>()
    const nextJob: JobDetail = { ...running, id: 43 }
    vi.mocked(getJob).mockResolvedValue(nextJob).mockResolvedValueOnce(running).mockReturnValueOnce(pending.promise)
    const done = vi.fn()
    const changed = vi.fn()
    const unauthorized = vi.fn()
    const view = render(<ProgressStep jobId={42} onDone={done} onUnauthorized={unauthorized} onJobChange={changed} />)
    await act(async () => {})
    await advance(6000)
    expect(getJob).toHaveBeenCalledTimes(2)
    await act(async () => {
      view.rerender(<ProgressStep jobId={43} onDone={done} onUnauthorized={unauthorized} onJobChange={changed} />)
    })
    expect(getJob).toHaveBeenLastCalledWith(43)
    expect(changed).toHaveBeenLastCalledWith(nextJob)
    await act(async () => {
      if (response === 'UNAUTHORIZED') pending.reject(new UnauthorizedError())
      else pending.resolve(completed)
    })

    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith(nextJob)
    expect(done).not.toHaveBeenCalled()
    expect(unauthorized).not.toHaveBeenCalled()
    view.unmount()
    const reads = vi.mocked(getJob).mock.calls.length
    await advance(60000)
    expect(getJob).toHaveBeenCalledTimes(reads)
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('stops polling and closes the stream after the current reconciliation request becomes unauthorized', async () => {
    vi.mocked(getJob).mockRejectedValue(new UnauthorizedError()).mockResolvedValueOnce(running)
    const unauthorized = vi.fn()
    await act(async () => {
      render(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={unauthorized} />)
    })
    await advance(6000)

    expect(unauthorized).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(getJob).toHaveBeenCalledTimes(2)
    await advance(60000)
    expect(getJob).toHaveBeenCalledTimes(2)
    expect(unauthorized).toHaveBeenCalledOnce()
  })

  it('recovers an initial read failure without a remount and later observes quiet-stream completion', async () => {
    vi.mocked(getJob)
      .mockResolvedValue(completed)
      .mockRejectedValueOnce(new ApiError(503, 'Progress is temporarily unavailable.'))
      .mockResolvedValueOnce(running)
    const done = vi.fn()
    await act(async () => {
      render(<ProgressStep jobId={42} onDone={done} onUnauthorized={vi.fn()} />)
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Progress is temporarily unavailable.')
    await advance(1000)
    expect(getJob).toHaveBeenCalledOnce()
    await advance(14000)

    expect(subscribeJobEvents).toHaveBeenCalledOnce()
    expect(done).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('closes a synchronously completed subscription once even when unsubscribe calls disconnect', async () => {
    vi.mocked(subscribeJobEvents).mockImplementation((_jobId, onJob, onDisconnect) => {
      unsubscribe.mockImplementation(onDisconnect)
      onJob(completed)
      return unsubscribe
    })
    const done = vi.fn()
    await act(async () => {
      render(<ProgressStep jobId={42} onDone={done} onUnauthorized={vi.fn()} />)
    })

    expect(done).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    await advance(60000)
    expect(done).toHaveBeenCalledOnce()
    expect(getJob).toHaveBeenCalledOnce()
    expect(subscribeJobEvents).toHaveBeenCalledOnce()
  })
})
