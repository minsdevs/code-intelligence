import { screen } from '@testing-library/react'
import { renderWithRouter as render } from '../../test/renderWithRouter'
import { beforeEach, expect, it, vi } from 'vitest'
import { getJob } from '../../api/jobs'
import type { JobDetail } from '../../api/types'
import ProgressStep from './ProgressStep'

vi.mock('../../api/jobs', () => ({ getJob: vi.fn(), retryJob: vi.fn(), cancelJob: vi.fn(), subscribeJobEvents: vi.fn() }))

// ADR-01: the desktop refused to run the analyzer outside its sandbox. The job carries the code.
const failed: JobDetail = {
  id: 42, projectId: 7, snapshotId: 9, type: 'IMPORT', status: 'FAILED',
  error: "step 'TS_PARSING' failed: TypeScript/JavaScript analysis isolation is unavailable (SUPERVISOR_HASH_MISMATCH); "
    + 'the analysis did not run. Reinstall or update the app.',
  failureCode: 'ADAPTER_ISOLATION_UNAVAILABLE',
  createdAt: null, startedAt: null, finishedAt: null, steps: [],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getJob).mockResolvedValue(failed)
})

it('explains that the isolated analyzer could not start and that nothing ran outside it', async () => {
  render(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('SUPERVISOR_HASH_MISMATCH')
  expect(screen.getByText(/격리된 분석 환경을 확인할 수 없어/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument()
})

it('does not show the isolation guidance for other failures', async () => {
  vi.mocked(getJob).mockResolvedValue({ ...failed, failureCode: null, error: 'ADAPTER_ISOLATION_UNAVAILABLE in some text' })
  render(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={vi.fn()} />)
  await screen.findByRole('alert')
  expect(screen.queryByText(/격리된 분석 환경을 확인할 수 없어/)).not.toBeInTheDocument()
})
