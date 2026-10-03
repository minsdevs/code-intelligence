import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { getJob, retryJob, subscribeJobEvents } from '../../api/jobs'
import type { JobDetail } from '../../api/types'
import ProgressStep from './ProgressStep'

vi.mock('../../api/jobs', () => ({
  getJob: vi.fn(),
  retryJob: vi.fn(),
  cancelJob: vi.fn(),
  subscribeJobEvents: vi.fn(),
}))

const failed: JobDetail = {
  id: 42,
  projectId: 7,
  snapshotId: null,
  type: 'IMPORT',
  status: 'FAILED',
  error: 'Input changed.',
  failureCode: 'LOCAL_PREVIEW_REQUIRED',
  createdAt: null,
  startedAt: null,
  finishedAt: null,
  steps: [],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getJob).mockResolvedValue(failed)
})

describe('local worker approval failures', () => {
  it('opens the existing project instead of retrying a failed initial import', async () => {
    const openPreview = vi.fn()
    render(
      <ProgressStep
        jobId={42}
        onDone={vi.fn()}
        onUnauthorized={vi.fn()}
        onSourcePreviewRequired={openPreview}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '기존 프로젝트에서 새 미리보기' }))
    expect(openPreview).toHaveBeenCalledExactlyOnceWith(7)
    expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument()
    expect(retryJob).not.toHaveBeenCalled()
  })

  it('switches to preview guidance when a running job reports the structured failure through SSE', async () => {
    vi.mocked(getJob).mockResolvedValue({
      ...failed,
      status: 'RUNNING',
      failureCode: null,
      error: null,
    })
    vi.mocked(subscribeJobEvents).mockReturnValue(vi.fn())
    render(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={vi.fn()} />)
    await waitFor(() => expect(subscribeJobEvents).toHaveBeenCalledTimes(1))
    act(() => vi.mocked(subscribeJobEvents).mock.calls[0][1](failed))
    expect(screen.getByRole('link', { name: '기존 프로젝트에서 새 미리보기' })).toHaveAttribute(
      'href',
      '/projects/7',
    )
    expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument()
  })

  it('stops offering a generic retry when an old job requires a new approval at retry time', async () => {
    vi.mocked(getJob).mockResolvedValue({ ...failed, failureCode: null })
    vi.mocked(retryJob).mockRejectedValue(
      new ApiError(409, 'New approval required.', 'LOCAL_PREVIEW_REQUIRED'),
    )
    render(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '다시 시도' }))
    await screen.findByRole('link', { name: '기존 프로젝트에서 새 미리보기' })
    expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument()
    expect(retryJob).toHaveBeenCalledTimes(1)
  })
})
