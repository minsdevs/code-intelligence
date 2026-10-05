import fixture from '../../../../backend/src/test/resources/fixtures/ts-syntax-error.json'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithRouter as render } from '../../test/renderWithRouter'
import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { getJob, retryJob, subscribeJobEvents } from '../../api/jobs'
import type { JobDetail } from '../../api/types'
import ProgressStep from './ProgressStep'

vi.mock('../../api/jobs', () => ({ getJob: vi.fn(), retryJob: vi.fn(), cancelJob: vi.fn(), subscribeJobEvents: vi.fn() }))

const failed: JobDetail = {
  id: 42, projectId: 7, snapshotId: 9, type: 'IMPORT', status: 'FAILED',
  error: `step 'TS_PARSING' failed: ${fixture.jobError}`, failureCode: fixture.response.code,
  createdAt: null, startedAt: null, finishedAt: null, steps: [],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getJob).mockResolvedValue(failed)
})

it('shows the diagnostic and source-fix guidance without offering the same snapshot retry', async () => {
  render(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('src/broken.mts:1:22 (TS1109)')
  expect(screen.getByText(/소스의 구문 오류를 수정한 뒤 새 분석/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '프로젝트로 돌아가기' })).toHaveAttribute('href', '/projects/7')
  expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument()
  expect(retryJob).not.toHaveBeenCalled()
})

it('applies the same recovery guidance to a failure delivered through SSE', async () => {
  vi.mocked(getJob).mockResolvedValue({ ...failed, status: 'RUNNING', failureCode: null, error: null })
  const unsubscribe = vi.fn()
  vi.mocked(subscribeJobEvents).mockReturnValue(unsubscribe)
  const done = vi.fn()
  render(<ProgressStep jobId={42} onDone={done} onUnauthorized={vi.fn()} />)
  await waitFor(() => expect(subscribeJobEvents).toHaveBeenCalledOnce())
  act(() => vi.mocked(subscribeJobEvents).mock.calls[0][1](failed))
  expect(screen.getByRole('link', { name: '프로젝트로 돌아가기' })).toHaveAttribute('href', '/projects/7')
  expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(done).not.toHaveBeenCalled()
})

it('stops retrying when the retry endpoint reports the input error code', async () => {
  vi.mocked(getJob).mockResolvedValue({ ...failed, failureCode: null })
  vi.mocked(retryJob).mockRejectedValue(new ApiError(409, fixture.jobError, 'TS_SYNTAX_ERROR'))
  render(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '다시 시도' }))
  await screen.findByRole('link', { name: '프로젝트로 돌아가기' })
  expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument()
  expect(retryJob).toHaveBeenCalledOnce()
})

it('keeps ordinary service failures retryable and does not infer the code from arbitrary error text', async () => {
  vi.mocked(getJob).mockResolvedValue({ ...failed, failureCode: null, error: 'service unavailable: TS_SYNTAX_ERROR' })
  render(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={vi.fn()} />)
  expect(await screen.findByRole('button', { name: '다시 시도' })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: '프로젝트로 돌아가기' })).not.toBeInTheDocument()
})

it('does not retain the syntax recovery state when viewing a different job', async () => {
  const done = vi.fn()
  const unauthorized = vi.fn()
  const view = render(<ProgressStep jobId={42} onDone={done} onUnauthorized={unauthorized} />)
  await screen.findByRole('link', { name: '프로젝트로 돌아가기' })
  vi.mocked(getJob).mockResolvedValue({ ...failed, id: 43, failureCode: null, error: 'Service unavailable.' })
  view.rerender(<ProgressStep jobId={43} onDone={done} onUnauthorized={unauthorized} />)
  expect(await screen.findByRole('button', { name: '다시 시도' })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: '프로젝트로 돌아가기' })).not.toBeInTheDocument()
})

it('renders diagnostic text as text without interpreting source names as markup', async () => {
  const message = 'First diagnostic: src/<img src=x onerror=alert(1)>.mts:1:22 (TS1109)'
  vi.mocked(getJob).mockResolvedValue({ ...failed, error: message })
  render(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(document.querySelector('img')).toBeNull()
})
