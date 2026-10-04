import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type {
  GithubRepo,
  JobDetail,
  JobStep,
  MeResponse,
  ProjectArea,
  StepStatus,
} from '../../api/types'

let jobStreamController: ReadableStreamDefaultController<Uint8Array> | null = null
const jobStreamEncoder = new TextEncoder()

function emitJobUpdate(job: JobDetail) {
  if (!jobStreamController) throw new Error('Job stream is not connected')
  jobStreamController.enqueue(jobStreamEncoder.encode(`data: ${JSON.stringify(job)}\n\n`))
}

const anonymousMe: MeResponse = {
  authenticated: false,
  login: null,
  name: null,
  avatarUrl: null,
  credentialKind: null,
  oauthAvailable: true,
}

const signedInMe: MeResponse = {
  authenticated: true,
  login: 'octocat',
  name: 'The Octocat',
  avatarUrl: null,
  credentialKind: 'PAT',
  oauthAvailable: true,
}

const sampleRepo: GithubRepo = {
  owner: 'octocat',
  name: 'Hello-World',
  fullName: 'octocat/Hello-World',
  private: false,
  defaultBranch: 'master',
  description: 'My first repository on GitHub.',
  updatedAt: '2026-01-01T00:00:00Z',
}

const createdProject = {
  project: {
    id: 7,
    name: 'Hello-World',
    repoOwner: 'octocat',
    repoName: 'Hello-World',
    defaultBranch: 'master',
    currentSnapshot: null,
    latestJob: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  jobId: 42,
}

const sampleAreas: ProjectArea[] = [
  {
    areaType: 'BACKEND',
    confidence: 0.92,
    technologies: ['Java', 'Spring Boot'],
    evidences: [{ filePath: 'src/main/java/TodoController.java', line: 12, excerpt: null }],
    selected: true,
  },
  {
    areaType: 'DATABASE',
    confidence: 0.61,
    technologies: ['PostgreSQL'],
    evidences: [
      {
        filePath: 'src/main/resources/db/migration/V1__create_todos.sql',
        line: null,
        excerpt: null,
      },
    ],
    selected: true,
  },
]

function jobStep(
  stepKey: string,
  seq: number,
  status: StepStatus,
  error: string | null = null,
): JobStep {
  return {
    stepKey,
    seq,
    status,
    progressPct: status === 'RUNNING' ? 40 : status === 'DONE' ? 100 : null,
    attempt: 1,
    error,
    startedAt: null,
    finishedAt: null,
  }
}

function jobDetail(
  status: JobDetail['status'],
  steps: JobStep[],
  error: string | null = null,
): JobDetail {
  return {
    id: 42,
    projectId: 7,
    snapshotId: 1,
    type: 'IMPORT',
    status,
    error,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    steps,
  }
}

const runningJob = jobDetail('RUNNING', [
  jobStep('IMPORT', 1, 'RUNNING'),
  jobStep('FILE_INVENTORY', 2, 'PENDING'),
  jobStep('LANGUAGE_FRAMEWORK', 3, 'PENDING'),
  jobStep('AREA_DETECTION', 4, 'PENDING'),
  jobStep('FINALIZE', 5, 'PENDING'),
])

const doneJob = jobDetail('DONE', [
  jobStep('IMPORT', 1, 'DONE'),
  jobStep('FILE_INVENTORY', 2, 'DONE'),
  jobStep('LANGUAGE_FRAMEWORK', 3, 'DONE'),
  jobStep('AREA_DETECTION', 4, 'DONE'),
  jobStep('FINALIZE', 5, 'DONE'),
])

type FetchHandler = (url: URL, init?: RequestInit) => Response | Promise<Response>

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function emptyResponse(status: number): Response {
  return new Response(null, { status })
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input
  if (typeof input === 'string') return new URL(input, 'http://localhost')
  return new URL(input.url, 'http://localhost')
}

function renderImport() {
  const router = createMemoryRouter(routes, { initialEntries: ['/import'] })
  return { router, ...render(<RouterProvider router={router} />) }
}

let meState: MeResponse = anonymousMe
let jobState: JobDetail = runningJob
let reposStatus = 200
const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname
    const key = `${method} ${path}`
    const extra = extraHandlers[key]
    if (extra) {
      return extra(url, init)
    }
    if (key === 'GET /api/auth/me') {
      return jsonResponse(meState)
    }
    if (key === 'GET /api/csrf') {
      return emptyResponse(204)
    }
    if (key === 'POST /api/auth/pat') {
      meState = signedInMe
      return emptyResponse(204)
    }
    if (key === 'GET /api/github/repos') {
      if (reposStatus === 401) {
        return jsonResponse({ title: 'Unauthorized' }, 401)
      }
      return jsonResponse({
        items: [sampleRepo],
        page: Number(url.searchParams.get('page') ?? '1'),
        hasNext: false,
      })
    }
    if (key === 'GET /api/github/repos/octocat/Hello-World/branches') {
      return jsonResponse({
        items: [{ name: 'master', protected: false }],
        defaultBranch: 'master',
      })
    }
    if (key === 'POST /api/projects') {
      return jsonResponse(createdProject, 201)
    }
    if (key === 'GET /api/jobs/42/events') {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          jobStreamController = controller
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (key === 'GET /api/jobs/42') {
      return jsonResponse(jobState)
    }
    if (key === 'POST /api/jobs/42/retry') {
      jobState = runningJob
      return emptyResponse(202)
    }
    if (key === 'GET /api/projects/7/areas') {
      return jsonResponse(sampleAreas)
    }
    if (key === 'PUT /api/projects/7/area-selections') {
      return emptyResponse(204)
    }
    return jsonResponse({ title: 'Not Found', detail: key }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

const extraHandlers: Record<string, FetchHandler> = {}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({ aiPanelOpen: true, aiPanelWidth: AI_PANEL_DEFAULT_WIDTH })
  document.cookie = 'XSRF-TOKEN=test-csrf'
  meState = anonymousMe
  jobState = runningJob
  reposStatus = 200
  for (const key of Object.keys(extraHandlers)) {
    delete extraHandlers[key]
  }
  jobStreamController = null
  fetchMock.mockReset()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ImportWizardPage', () => {
  it('shows Connect when unauthenticated and advances to Repository after PAT submit', async () => {
    renderImport()

    expect(await screen.findByLabelText('Personal access token')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'GitHub로 계속' })).toHaveAttribute(
      'href',
      '/oauth2/authorization/github',
    )

    fireEvent.change(screen.getByLabelText('Personal access token'), {
      target: { value: 'ghp_test_token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'PAT로 연결' }))

    expect(await screen.findByRole('heading', { name: '저장소 선택' })).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: /octocat\/Hello-World/ })).toBeInTheDocument()

    const patCall = fetchMock.mock.calls.find(([input, init]) => {
      return (
        requestUrl(input).pathname === '/api/auth/pat' &&
        (init?.method ?? 'GET').toUpperCase() === 'POST'
      )
    })
    expect(patCall).toBeTruthy()
    const headers = new Headers(patCall?.[1]?.headers)
    expect(headers.get('X-XSRF-TOKEN')).toBe('test-csrf')
    expect(patCall?.[1]?.body).toBe(JSON.stringify({ token: 'ghp_test_token' }))
  })

  it('updates pipeline steps from the authenticated event stream and shows Retry when the job fails', async () => {
    meState = signedInMe
    renderImport()

    expect(await screen.findByRole('heading', { name: '저장소 선택' })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('option', { name: /octocat\/Hello-World/ }))
    const importButton = screen.getByRole('button', { name: '저장소 가져오기' })
    await waitFor(() => expect(importButton).toBeEnabled())
    fireEvent.click(importButton)

    const pipeline = await screen.findByRole('list', { name: '분석 파이프라인' })
    await waitFor(() => expect(jobStreamController).not.toBeNull())

    expect(within(pipeline).getByText(/^IMPORT/)).toBeInTheDocument()

    emitJobUpdate(
      jobDetail('RUNNING', [
        jobStep('IMPORT', 1, 'DONE'),
        jobStep('FILE_INVENTORY', 2, 'RUNNING'),
        jobStep('LANGUAGE_FRAMEWORK', 3, 'PENDING'),
        jobStep('AREA_DETECTION', 4, 'PENDING'),
        jobStep('FINALIZE', 5, 'PENDING'),
      ]),
    )

    await waitFor(() => {
      const inventory = within(pipeline)
        .getByText(/^FILE_INVENTORY/)
        .closest('li')
      expect(inventory).toHaveTextContent('진행 중')
    })

    emitJobUpdate(
      jobDetail(
        'FAILED',
        [
          jobStep('IMPORT', 1, 'DONE'),
          jobStep('FILE_INVENTORY', 2, 'FAILED', 'clone failed'),
          jobStep('LANGUAGE_FRAMEWORK', 3, 'PENDING'),
          jobStep('AREA_DETECTION', 4, 'PENDING'),
          jobStep('FINALIZE', 5, 'PENDING'),
        ],
        'FILE_INVENTORY failed',
      ),
    )

    expect(await screen.findByRole('button', { name: '다시 시도' })).toBeInTheDocument()
    expect(screen.getByText('FILE_INVENTORY failed').closest('[role="alert"]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    await waitFor(() => {
      const retried = fetchMock.mock.calls.some(([input, init]) => {
        return (
          requestUrl(input).pathname === '/api/jobs/42/retry' &&
          (init?.method ?? 'GET').toUpperCase() === 'POST'
        )
      })
      expect(retried).toBe(true)
    })
  })

  it('opens the overview after analysis without requiring area selection', async () => {
    meState = signedInMe
    jobState = doneJob
    const { router } = renderImport()
    fireEvent.click(await screen.findByRole('option', { name: /octocat\/Hello-World/ }))
    const importButton = screen.getByRole('button', { name: '저장소 가져오기' })
    await waitFor(() => expect(importButton).toBeEnabled())
    fireEvent.click(importButton)
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/7/overview'))
    expect(fetchMock.mock.calls.some(([input, init]) =>
      requestUrl(input).pathname.endsWith('/area-selections') && init?.method === 'PUT',
    )).toBe(false)
  })

  it('returns to Connect when an API call responds 401', async () => {
    meState = signedInMe
    reposStatus = 401
    extraHandlers['GET /api/auth/me'] = () => {
      const calls = fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input).pathname === '/api/auth/me',
      )
      if (calls.length <= 1) {
        return jsonResponse(signedInMe)
      }
      return jsonResponse(anonymousMe)
    }

    renderImport()

    expect(await screen.findByRole('link', { name: 'GitHub로 계속' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '저장소 선택' })).not.toBeInTheDocument()
  })

  it('hides the OAuth button when oauthAvailable is false', async () => {
    meState = { ...anonymousMe, oauthAvailable: false }
    renderImport()

    expect(await screen.findByRole('button', { name: 'PAT로 연결' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'GitHub로 계속' })).not.toBeInTheDocument()
  })
})
