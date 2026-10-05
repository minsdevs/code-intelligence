import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { renderWithRouter } from '../../test/renderWithRouter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDetail, JobStatus, Project } from '../../api/types'
import { subscribeJobEvents } from '../../api/jobs'
import GithubAnalysisStatus from './GithubAnalysisStatus'
import ProjectsPage from './ProjectsPage'
import { isProjectAnalyzing, projectAnalysisStatus } from './analysisStatus'

vi.mock('../../api/jobs', async (original) => ({
  ...(await original<typeof import('../../api/jobs')>()),
  subscribeJobEvents: vi.fn(),
}))

const failedJob: JobDetail = {
  id: 1,
  projectId: 1,
  snapshotId: 10,
  type: 'IMPORT',
  status: 'FAILED',
  error: "step 'GIT_METADATA' failed: GitHub pulls request failed",
  failureCode: null,
  createdAt: null,
  startedAt: null,
  finishedAt: null,
  steps: [
    {
      stepKey: 'GIT_METADATA',
      seq: 5,
      status: 'FAILED',
      progressPct: 70,
      attempt: 1,
      error: 'Optional pull permission missing',
      startedAt: null,
      finishedAt: null,
    },
  ],
}
const failedProject: Project = {
  id: 1,
  name: 'code-intelligence',
  repoOwner: 'minsdevs',
  repoName: 'code-intelligence',
  defaultBranch: 'main',
  sourceAddress: 'minsdevs/code-intelligence',
  sourceType: 'GITHUB',
  currentSnapshot: null,
  latestJob: failedJob,
  selectedAreas: [],
  topTechnologies: [],
  latestCommit: null,
  latestPull: null,
  createdAt: '',
  updatedAt: '',
}

let serverProject: Project
let jobs: Map<number, JobDetail>
let listeners: Map<number, (job: JobDetail) => void>
let mode: 'accepted' | 'lost' | 'unknown' | 'forbidden' | 'unauthorized' | 'csrf-failed'
let requests: { path: string; method: string; body: unknown }[]
let clients: QueryClient[]

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function acceptJob(status: JobStatus = 'RUNNING') {
  const job: JobDetail = {
    ...failedJob,
    id: 2,
    snapshotId: 11,
    type: 'REANALYZE',
    status,
    error: null,
    steps: [{ ...failedJob.steps[0], status: 'RUNNING', error: null }],
  }
  jobs.set(2, job)
  serverProject = { ...serverProject, latestJob: job }
  return job
}

function show(project = failedProject) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  client.setQueryData(['project', project.id], project)
  client.setQueryData(['snapshots', project.id], ['previous-result'])
  const view = renderWithRouter(
    <QueryClientProvider client={client}>
      <GithubAnalysisStatus project={project} />
    </QueryClientProvider>,
  )
  return { client, ...view }
}

function analysisPosts() {
  return requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith('/reanalyze'),
  )
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  delete window.codeIntelligenceDesktop
  serverProject = { ...failedProject }
  jobs = new Map([[1, { ...failedJob }]])
  listeners = new Map()
  requests = []
  clients = []
  mode = 'accepted'
  vi.mocked(subscribeJobEvents).mockImplementation((id, listener) => {
    listeners.set(id, listener)
    return () => {
      listeners.delete(id)
    }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input, 'http://localhost').pathname
      const method = init?.method ?? 'GET'
      requests.push({ path, method, body: init?.body })
      if (path === '/api/csrf') {
        if (mode === 'csrf-failed') throw new TypeError('CSRF preparation connection failed')
        return new Response(null, { status: 204 })
      }
      if (path === '/api/projects' && method === 'GET') return json([serverProject])
      if (path === '/api/projects/1' && method === 'GET') return json(serverProject)
      if (path === '/api/jobs/1/retry')
        return json({ detail: 'Checkpoint source changed.', code: 'RETRY_SOURCE_UNVERIFIED' }, 409)
      if (path === '/api/projects/1/reanalyze' && method === 'POST') {
        if (mode === 'forbidden') return json({ detail: 'Permission denied.' }, 403)
        if (mode === 'unauthorized') return json({ detail: 'Expired.' }, 401)
        if (mode === 'unknown') throw new TypeError('Response lost before outcome is known')
        acceptJob()
        if (mode === 'lost') throw new TypeError('Response lost after commit')
        return json({ jobId: 2 }, 202)
      }
      const jobMatch = /^\/api\/jobs\/(\d+)$/.exec(path)
      if (jobMatch && method === 'GET') return json(jobs.get(Number(jobMatch[1])))
      return json({ detail: `Unexpected ${method} ${path}` }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  clients.forEach((client) => client.clear())
  vi.unstubAllGlobals()
})

describe('GitHub failed-project recovery through the existing UI and API', () => {
  it('opens failed project 1 without starting or deleting anything', async () => {
    show()
    expect(await screen.findByText(failedJob.error!)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('분석 실패')
    expect(screen.getByRole('button', { name: '새 분석 시작' })).toBeEnabled()
    expect(analysisPosts()).toHaveLength(0)
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
  })

  it('starts one fresh job, passes GIT_METADATA, completes and invalidates snapshot results', async () => {
    const { client } = show()
    await screen.findByText(failedJob.error!)
    const button = screen.getByRole('button', { name: '새 분석 시작' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(listeners.has(2)).toBe(true))
    expect(analysisPosts()).toEqual([
      { path: '/api/projects/1/reanalyze', method: 'POST', body: undefined },
    ])
    expect(jobs.get(1)).toEqual(failedJob)
    expect(serverProject.id).toBe(1)
    expect(screen.getByRole('button', { name: '새 분석 시작' })).toBeDisabled()
    expect(screen.getByText('GIT_METADATA · 70%')).toBeInTheDocument()
    const completed: JobDetail = {
      ...jobs.get(2)!,
      status: 'DONE',
      steps: [
        { ...failedJob.steps[0], status: 'DONE', progressPct: 100, error: null },
        {
          ...failedJob.steps[0],
          stepKey: 'FINALIZE',
          seq: 6,
          status: 'DONE',
          progressPct: 100,
          error: null,
        },
      ],
    }
    jobs.set(2, completed)
    serverProject = {
      ...serverProject,
      latestJob: completed,
      currentSnapshot: {
        id: 11,
        commitSha: 'new-commit',
        status: 'READY',
        analyzedAt: '2026-10-05',
      },
    }
    act(() => listeners.get(2)!(completed))
    expect(screen.getByRole('status')).toHaveTextContent('분석 완료')
    expect(screen.getByRole('button', { name: '새 분석 시작' })).toBeEnabled()
    expect(client.getQueryState(['snapshots', 1])?.isInvalidated).toBe(true)
    expect(jobs.get(1)?.status).toBe('FAILED')
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false)
    expect(
      requests.some((request) => request.method === 'POST' && request.path === '/api/projects'),
    ).toBe(false)
  })

  it('turns an unverified checkpoint retry into a fresh-analysis route', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: '다시 시도' }))
    expect(await screen.findByText(/이전 분석의 원본을 검증할 수 없습니다/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '기존 프로젝트에서 새 분석' })).toHaveAttribute(
      'href',
      '/projects/1',
    )
    fireEvent.click(screen.getByRole('button', { name: '새 분석 시작' }))
    await waitFor(() => expect(listeners.has(2)).toBe(true))
    expect(requests.filter((request) => request.path.endsWith('/retry'))).toHaveLength(1)
    expect(analysisPosts()).toHaveLength(1)
    expect(jobs.get(1)?.status).toBe('FAILED')
  })

  it.each(['QUEUED', 'RUNNING', 'CANCELLING'] as const)(
    'blocks a new analysis while %s',
    async (status) => {
      const job = { ...failedJob, status, error: null }
      jobs.set(1, job)
      serverProject = { ...failedProject, latestJob: job }
      show(serverProject)
      await waitFor(() => expect(listeners.has(1)).toBe(true))
      expect(screen.getByRole('button', { name: '새 분석 시작' })).toBeDisabled()
      expect(analysisPosts()).toHaveLength(0)
    },
  )

  it('joins a job started in another window during the preflight without sending POST', async () => {
    show()
    await screen.findByText(failedJob.error!)
    acceptJob()
    fireEvent.click(screen.getByRole('button', { name: '새 분석 시작' }))
    await waitFor(() => expect(listeners.has(2)).toBe(true))
    expect(analysisPosts()).toHaveLength(0)
  })

  it('recovers an accepted job after a lost start response without replay', async () => {
    mode = 'lost'
    show()
    fireEvent.click(screen.getByRole('button', { name: '새 분석 시작' }))
    await waitFor(() => expect(listeners.has(2)).toBe(true))
    expect(analysisPosts()).toHaveLength(1)
    expect(screen.getByRole('button', { name: '새 분석 시작' })).toBeDisabled()
    expect(screen.queryByText(/시작 응답을 받지 못했습니다/)).not.toBeInTheDocument()
  })

  it('permits another attempt when CSRF preparation fails before any mutation is sent', async () => {
    mode = 'csrf-failed'
    show()
    await screen.findByText(failedJob.error!)
    fireEvent.click(screen.getByRole('button', { name: '새 분석 시작' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '새 분석 시작' })).toBeEnabled())
    expect(analysisPosts()).toHaveLength(0)
    expect(screen.queryByText(/시작 응답을 받지 못했습니다/)).not.toBeInTheDocument()
    mode = 'accepted'
    fireEvent.click(screen.getByRole('button', { name: '새 분석 시작' }))
    await waitFor(() => expect(listeners.has(2)).toBe(true))
    expect(analysisPosts()).toHaveLength(1)
  })

  it('resubscribes when another window retries the same failed job during preflight', async () => {
    show()
    await screen.findByText(failedJob.error!)
    const retried = { ...failedJob, status: 'RUNNING' as const, error: null, startedAt: '2026-10-05T08:00:00Z' }
    jobs.set(1, retried)
    serverProject = { ...serverProject, latestJob: retried }
    fireEvent.click(screen.getByRole('button', { name: '새 분석 시작' }))
    await waitFor(() => expect(listeners.has(1)).toBe(true))
    expect(analysisPosts()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '새 분석 시작' })).toBeDisabled()
    act(() => listeners.get(1)!({ ...retried, status: 'DONE' }))
    expect(screen.getByRole('button', { name: '새 분석 시작' })).toBeEnabled()
  })

  it('observes a same-ID retry when the parent refreshes server state', async () => {
    const { client, rerender } = show()
    await screen.findByText(failedJob.error!)
    const retried = { ...failedJob, status: 'RUNNING' as const, error: null, startedAt: '2026-10-05T08:00:00Z' }
    jobs.set(1, retried)
    serverProject = { ...serverProject, latestJob: retried }
    rerender(<QueryClientProvider client={client}><GithubAnalysisStatus project={serverProject} /></QueryClientProvider>)
    await waitFor(() => expect(listeners.has(1)).toBe(true))
    expect(screen.getByRole('button', { name: '새 분석 시작' })).toBeDisabled()
    expect(analysisPosts()).toHaveLength(0)
  })

  it('keeps an unknown outcome blocked until a read finds the new job', async () => {
    mode = 'unknown'
    show()
    fireEvent.click(screen.getByRole('button', { name: '새 분석 시작' }))
    await screen.findByText(/시작 응답을 받지 못했습니다/)
    await waitFor(() => expect(screen.getByRole('button', { name: '상태 확인' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '새 분석 시작' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '상태 확인' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '상태 확인' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '새 분석 시작' })).toBeDisabled()
    acceptJob()
    fireEvent.click(screen.getByRole('button', { name: '상태 확인' }))
    await waitFor(() => expect(listeners.has(2)).toBe(true))
    expect(analysisPosts()).toHaveLength(1)
  })

  it('does not resend a rejected 403 start and keeps the existing failure', async () => {
    mode = 'forbidden'
    show()
    fireEvent.click(screen.getByRole('button', { name: '새 분석 시작' }))
    expect(await screen.findByText('Permission denied.')).toBeInTheDocument()
    expect(analysisPosts()).toHaveLength(1)
    expect(jobs.get(1)).toEqual(failedJob)
  })

  it('offers account settings on authentication failure without creating a replacement project', async () => {
    mode = 'unauthorized'
    show()
    fireEvent.click(screen.getByRole('button', { name: '새 분석 시작' }))
    expect(await screen.findByRole('link', { name: '계정 설정' })).toHaveAttribute(
      'href',
      '/settings',
    )
    expect(analysisPosts()).toHaveLength(1)
    expect(jobs.size).toBe(1)
  })

  it('never provides an unapproved local-source path through the GitHub control', () => {
    const { container } = show({ ...failedProject, sourceType: 'LOCAL' })
    expect(container).toBeEmptyDOMElement()
    expect(requests).toHaveLength(0)
  })

  it('shows failed status in the project list even when no completed snapshot exists', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const list = await screen.findByRole('list', { name: '프로젝트 목록' })
    expect(within(list).getByText('분석 실패')).toBeInTheDocument()
    expect(within(list).queryByText('분석 중')).not.toBeInTheDocument()
  })
})

describe('job and retained-snapshot status precedence', () => {
  it.each(['FAILED', 'CANCELLED', 'DONE'] as const)(
    'does not treat a %s job as active from a retained snapshot',
    (status) => {
      const project = {
        ...failedProject,
        latestJob: { ...failedJob, status },
        currentSnapshot: { id: 10, commitSha: 'old', status: 'ANALYZING', analyzedAt: null },
      }
      expect(isProjectAnalyzing(project)).toBe(false)
      expect(projectAnalysisStatus(project)).toBe(status)
    },
  )
  it('labels a project with no job and no snapshot as not analyzed', () => {
    expect(projectAnalysisStatus({ ...failedProject, latestJob: null })).toBe('NOT_ANALYZED')
  })
})
