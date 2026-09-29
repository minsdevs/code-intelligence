import { expect, test, type Page, type Route } from '@playwright/test'

type FlowMode = 'success' | 'retry'

type MockState = {
  authenticated: boolean
  jobStatus: 'RUNNING' | 'FAILED' | 'DONE'
  retryCalls: number
  sseConnections: number
  patCsrfHeader: string | null
  areaSelections: unknown
}

const anonymousMe = {
  authenticated: false,
  login: null,
  name: null,
  avatarUrl: null,
  credentialKind: null,
  oauthAvailable: false,
}

const signedInMe = {
  authenticated: true,
  login: 'e2e-user',
  name: 'E2E User',
  avatarUrl: null,
  credentialKind: 'PAT',
  oauthAvailable: false,
}

const sampleRepo = {
  owner: 'octocat',
  name: 'Hello-World',
  fullName: 'octocat/Hello-World',
  private: false,
  defaultBranch: 'main',
  description: 'Browser E2E fixture repository',
  updatedAt: '2026-01-01T00:00:00Z',
}

const sampleProject = {
  id: 7,
  name: 'Hello-World',
  repoOwner: 'octocat',
  repoName: 'Hello-World',
  defaultBranch: 'main',
  sourceType: 'GITHUB',
  currentSnapshot: {
    id: 1,
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    status: 'READY',
    analyzedAt: '2026-01-01T00:00:00Z',
  },
  latestJob: null,
  selectedAreas: ['DATABASE'],
  topTechnologies: ['Java', 'Spring Boot'],
  latestCommit: null,
  latestPull: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const sampleAreas = [
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

function pipelineSteps(status: MockState['jobStatus']) {
  if (status === 'DONE') {
    return ['IMPORT', 'FILE_INVENTORY', 'LANGUAGE_FRAMEWORK', 'AREA_DETECTION', 'FINALIZE'].map(
      (stepKey, index) => ({
        stepKey,
        seq: index + 1,
        status: 'DONE',
        progressPct: 100,
        attempt: 1,
        error: null,
        startedAt: null,
        finishedAt: null,
      }),
    )
  }

  if (status === 'FAILED') {
    return [
      { stepKey: 'IMPORT', seq: 1, status: 'DONE', progressPct: 100, attempt: 1, error: null },
      {
        stepKey: 'FILE_INVENTORY',
        seq: 2,
        status: 'FAILED',
        progressPct: null,
        attempt: 1,
        error: 'fixture failure',
      },
      {
        stepKey: 'LANGUAGE_FRAMEWORK',
        seq: 3,
        status: 'PENDING',
        progressPct: null,
        attempt: 0,
        error: null,
      },
      {
        stepKey: 'AREA_DETECTION',
        seq: 4,
        status: 'PENDING',
        progressPct: null,
        attempt: 0,
        error: null,
      },
      {
        stepKey: 'FINALIZE',
        seq: 5,
        status: 'PENDING',
        progressPct: null,
        attempt: 0,
        error: null,
      },
    ]
  }

  return [
    { stepKey: 'IMPORT', seq: 1, status: 'DONE', progressPct: 100, attempt: 1, error: null },
    {
      stepKey: 'FILE_INVENTORY',
      seq: 2,
      status: 'RUNNING',
      progressPct: 40,
      attempt: 1,
      error: null,
    },
    {
      stepKey: 'LANGUAGE_FRAMEWORK',
      seq: 3,
      status: 'PENDING',
      progressPct: null,
      attempt: 0,
      error: null,
    },
    {
      stepKey: 'AREA_DETECTION',
      seq: 4,
      status: 'PENDING',
      progressPct: null,
      attempt: 0,
      error: null,
    },
    { stepKey: 'FINALIZE', seq: 5, status: 'PENDING', progressPct: null, attempt: 0, error: null },
  ]
}

function job(state: MockState) {
  return {
    id: 42,
    projectId: 7,
    snapshotId: 1,
    type: 'IMPORT',
    status: state.jobStatus,
    error: state.jobStatus === 'FAILED' ? 'FILE_INVENTORY failed' : null,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    steps: pipelineSteps(state.jobStatus),
  }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function noContent(route: Route, status = 204) {
  await route.fulfill({ status, body: '' })
}

async function installMockBackend(page: Page, mode: FlowMode): Promise<MockState> {
  const state: MockState = {
    authenticated: false,
    jobStatus: mode === 'retry' ? 'FAILED' : 'RUNNING',
    retryCalls: 0,
    sseConnections: 0,
    patCsrfHeader: null,
    areaSelections: null,
  }

  await page.context().addCookies([
    {
      name: 'XSRF-TOKEN',
      value: 'test-csrf',
      url: 'http://127.0.0.1:4173',
    },
  ])
  await page.addInitScript(() => {
    window.localStorage.setItem('code-intelligence.lang', 'ko')
  })

  await page.route(/^https?:\/\/127\.0\.0\.1:4173\/api(?:\/|$)/, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const path = url.pathname

    if (method === 'GET' && path === '/api/auth/me') {
      await json(route, state.authenticated ? signedInMe : anonymousMe)
      return
    }
    if (method === 'GET' && path === '/api/ai/status') {
      await json(route, { configured: false, provider: null, model: null })
      return
    }
    if (method === 'GET' && path === '/api/projects') {
      await json(route, [])
      return
    }
    if (method === 'GET' && path === '/api/csrf') {
      await noContent(route)
      return
    }
    if (method === 'POST' && path === '/api/auth/pat') {
      state.patCsrfHeader = request.headers()['x-xsrf-token'] ?? null
      state.authenticated = true
      await noContent(route)
      return
    }
    if (method === 'GET' && path === '/api/github/repos') {
      await json(route, { items: [sampleRepo], page: 1, hasNext: false })
      return
    }
    if (method === 'GET' && path === '/api/github/repos/octocat/Hello-World/branches') {
      await json(route, {
        items: [{ name: 'main', commitSha: '0123456789abcdef0123456789abcdef01234567', protected: true }],
        page: 1,
        hasNext: false,
      })
      return
    }
    if (method === 'POST' && path === '/api/projects') {
      await json(route, { project: sampleProject, jobId: 42 }, 201)
      return
    }
    if (method === 'GET' && path === '/api/jobs/42') {
      await json(route, job(state))
      return
    }
    if (method === 'GET' && path === '/api/jobs/42/events') {
      state.sseConnections += 1
      state.jobStatus = 'DONE'
      await new Promise((resolve) => setTimeout(resolve, 150))
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache' },
        body: `event: update\ndata: ${JSON.stringify(job(state))}\n\n`,
      })
      return
    }
    if (method === 'POST' && path === '/api/jobs/42/retry') {
      state.retryCalls += 1
      state.jobStatus = 'RUNNING'
      await noContent(route, 202)
      return
    }
    if (method === 'GET' && path === '/api/projects/7/areas') {
      await json(route, sampleAreas)
      return
    }
    if (method === 'PUT' && path === '/api/projects/7/area-selections') {
      state.areaSelections = JSON.parse(request.postData() ?? '{}')
      await noContent(route)
      return
    }
    if (method === 'GET' && path === '/api/projects/7') {
      await json(route, sampleProject)
      return
    }
    if (method === 'GET' && path === '/api/projects/7/features') {
      await json(route, [])
      return
    }

    await route.fulfill({ status: 500, body: `Unhandled E2E API route: ${method} ${path}` })
  })

  return state
}

async function openImportWizard(page: Page, mode: FlowMode) {
  const state = await installMockBackend(page, mode)
  await page.goto('/import')
  await expect(page.getByRole('heading', { name: 'Choose a project source' })).toBeVisible()
  await page.getByText('Use a personal access token instead').click()
  await page.getByLabel('Personal access token').fill('fixture-token-not-a-secret')
  await page.getByRole('button', { name: 'PAT로 연결' }).click()
  await expect(page.getByRole('heading', { name: '저장소 선택' })).toBeVisible()
  await expect(page.getByRole('option', { name: /octocat\/Hello-World/ })).toBeVisible()
  await page.getByRole('option', { name: /octocat\/Hello-World/ }).click()
  await page.getByRole('button', { name: '저장소 가져오기' }).click()
  return state
}

test('completes repository import in a real browser and persists area selection', async ({
  page,
}) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`)
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  const state = await openImportWizard(page, 'success')

  await expect(page.getByRole('heading', { name: '분석 진행' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '영역 선택' })).toBeVisible()
  await expect(page.getByText('src/main/java/TodoController.java:12')).toBeVisible()
  await expect.poll(() => state.sseConnections).toBe(1)
  await expect(page.getByRole('checkbox', { name: 'Backend' })).toBeChecked()

  await page.getByRole('checkbox', { name: 'Backend' }).uncheck()
  await page.getByRole('button', { name: '워크스페이스로 이동' }).click()

  await expect(page).toHaveURL(/\/projects\/7\/features$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Hello-World' })).toBeVisible()
  expect(state.patCsrfHeader).toBe('test-csrf')
  expect(state.areaSelections).toEqual({
    selections: [
      { areaType: 'BACKEND', selected: false },
      { areaType: 'DATABASE', selected: true },
    ],
  })
  expect(consoleErrors).toEqual([])
})

test('recovers from a failed job through Retry and reaches area selection', async ({ page }) => {
  const state = await openImportWizard(page, 'retry')

  await expect(page.getByRole('heading', { name: '분석 진행' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('FILE_INVENTORY failed')
  await expect(page.getByRole('button', { name: '다시 시도' })).toBeVisible()

  await page.getByRole('button', { name: '다시 시도' }).click()

  await expect(page.getByRole('heading', { name: '영역 선택' })).toBeVisible()
  await expect.poll(() => state.retryCalls).toBe(1)
  await expect.poll(() => state.sseConnections).toBe(1)
})
