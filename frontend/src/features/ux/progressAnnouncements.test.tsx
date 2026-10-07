import { act, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getJob, subscribeJobEvents } from '../../api/jobs'
import type { JobDetail } from '../../api/types'
import { renderWithRouter as render } from '../../test/renderWithRouter'
import ProgressStep from '../import/ProgressStep'

// G-UX: a long-running analysis must be perceivable without sight. Step progress is exposed
// through a polite live region while the job runs; terminal states are left to the host and
// to this view's own alert/status so that no state is announced twice.

vi.mock('../../api/jobs', () => ({
  getJob: vi.fn(),
  retryJob: vi.fn(),
  cancelJob: vi.fn(),
  subscribeJobEvents: vi.fn(),
}))

const step = (stepKey: string, seq: number, status: JobDetail['steps'][number]['status']) => ({
  stepKey, seq, status, progressPct: null, attempt: 1, error: null, startedAt: null, finishedAt: null,
})
const running: JobDetail = {
  id: 42, projectId: 7, snapshotId: 9, type: 'IMPORT', status: 'RUNNING', error: null, failureCode: null,
  createdAt: null, startedAt: '2026-10-07T00:00:00Z', finishedAt: null,
  steps: [step('IMPORT', 1, 'DONE'), step('FILE_INVENTORY', 2, 'RUNNING'), step('FINALIZE', 3, 'PENDING')],
}

beforeEach(() => {
  vi.resetAllMocks()
  window.localStorage.setItem('code-intelligence.lang', 'ko')
  vi.mocked(subscribeJobEvents).mockReturnValue(vi.fn())
})

describe('analysis progress announcements', () => {
  it('announces the running step through one polite status region and leaves completion to the host', async () => {
    vi.mocked(getJob).mockResolvedValue(running)
    const done = vi.fn()
    render(<ProgressStep jobId={42} onDone={done} onUnauthorized={vi.fn()} />)
    const live = await screen.findByTestId('analysis-progress-announcement')
    expect(live).toHaveAttribute('role', 'status')
    expect(live).toHaveAttribute('aria-live', 'polite')
    await waitFor(() => expect(live).toHaveTextContent('File inventory'))
    expect(live).toHaveTextContent('진행 중')
    expect(live).toHaveTextContent('2/3')
    const onJob = vi.mocked(subscribeJobEvents).mock.calls[0][1]
    act(() => onJob({ ...running, steps: [step('IMPORT', 1, 'DONE'), step('FILE_INVENTORY', 2, 'DONE'), step('FINALIZE', 3, 'RUNNING')] }))
    await waitFor(() => expect(live).toHaveTextContent('Finalize'))
    act(() => onJob({ ...running, status: 'DONE', steps: running.steps.map((entry) => ({ ...entry, status: 'DONE' as const })) }))
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(screen.queryByTestId('analysis-progress-announcement')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('status')).toHaveLength(0)
  })

  it('keeps each step status as text next to its colour mark', async () => {
    vi.mocked(getJob).mockResolvedValue(running)
    render(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={vi.fn()} />)
    const pipeline = await screen.findByRole('list', { name: /파이프라인|pipeline/i })
    await waitFor(() => expect(pipeline).toHaveTextContent('완료'))
    expect(pipeline).toHaveTextContent('진행 중')
    expect(pipeline).toHaveTextContent('대기')
  })
})
