import { act, screen, waitFor } from '@testing-library/react'
import { renderWithRouter as render } from '../../test/renderWithRouter'
import { expect, it, vi } from 'vitest'
import type { JobDetail } from '../../api/types'
import { getJob, subscribeJobEvents } from '../../api/jobs'
import ProgressStep from './ProgressStep'

vi.mock('../../api/jobs', () => ({ getJob: vi.fn(), subscribeJobEvents: vi.fn(), cancelJob: vi.fn(), retryJob: vi.fn() }))

it('keeps progress subscribed while cancelling and stops only after the worker acknowledges cancellation', async () => {
  const cancelling: JobDetail = {
    id: 1, projectId: 1, snapshotId: null, type: 'IMPORT', status: 'CANCELLING', error: null,
    createdAt: '', startedAt: '', finishedAt: null, steps: [],
  }
  vi.mocked(getJob).mockResolvedValue(cancelling)
  const unsubscribe = vi.fn()
  vi.mocked(subscribeJobEvents).mockReturnValue(unsubscribe)
  const done = vi.fn()
  render(<ProgressStep jobId={1} onDone={done} onUnauthorized={vi.fn()} />)
  expect(await screen.findByRole('button', { name: 'Cancelling…' })).toBeDisabled()
  await waitFor(() => expect(subscribeJobEvents).toHaveBeenCalledOnce())
  expect(unsubscribe).not.toHaveBeenCalled()
  const update = vi.mocked(subscribeJobEvents).mock.calls[0][1]
  act(() => update({ ...cancelling, status: 'CANCELLED', finishedAt: '2026-10-02T00:00:00Z' }))
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Cancelling…' })).not.toBeInTheDocument()
  expect(done).not.toHaveBeenCalled()
})
