import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { Project } from '../../api/types'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input
  if (typeof input === 'string') return new URL(input, 'http://localhost')
  return new URL(input.url, 'http://localhost')
}

const readyProject: Project = {
  id: 7,
  name: 'Hello-World',
  repoOwner: 'octocat',
  repoName: 'Hello-World',
  defaultBranch: 'main',
  currentSnapshot: {
    id: 3,
    commitSha: 'abc1234deadbeef',
    status: 'READY',
    analyzedAt: '2026-04-01T12:00:00Z',
  },
  latestJob: {
    id: 9,
    type: 'IMPORT',
    status: 'DONE',
    error: null,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
  },
  selectedAreas: ['BACKEND', 'DATABASE'],
  topTechnologies: ['Java', 'Spring Boot', 'PostgreSQL'],
  latestCommit: { sha: 'abc1234deadbeef', message: 'wire auth filter\n\nmore' },
  latestPull: {
    number: 4,
    title: 'Harden sessions',
    state: 'closed',
    author: 'octocat',
    mergedAt: '2026-04-01T15:00:00Z',
  },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-04-01T12:00:00Z',
}

const analyzingProject: Project = {
  ...readyProject,
  id: 8,
  repoName: 'in-flight',
  currentSnapshot: {
    id: 4,
    commitSha: 'fff',
    status: 'ANALYZING',
    analyzedAt: null,
  },
  latestJob: {
    id: 10,
    type: 'IMPORT',
    status: 'RUNNING',
    error: null,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
  },
  selectedAreas: ['FRONTEND'],
  topTechnologies: ['React'],
  latestCommit: null,
  latestPull: null,
}

let projects: Project[] = []
const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const path = requestUrl(input).pathname
    if (path === '/api/projects') {
      return jsonResponse(projects)
    }
    return jsonResponse({ title: 'Not Found' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderHome() {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({
    aiPanelOpen: true,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
  })
  projects = []
  fetchMock.mockReset()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HomePage', () => {
  it('renders card fields for areas, technologies, snapshot, and latest commit', async () => {
    projects = [readyProject]
    renderHome()

    expect(await screen.findByRole('heading', { name: 'octocat/Hello-World' })).toBeInTheDocument()
    expect(screen.getByText('Backend, Database')).toBeInTheDocument()
    expect(screen.getByText('Java, Spring Boot, PostgreSQL')).toBeInTheDocument()
    expect(screen.getByText(/READY/)).toBeInTheDocument()
    expect(screen.getByText(/abc1234 wire auth filter/)).toBeInTheDocument()
    expect(screen.getByText(/#4 Harden sessions \(closed\)/)).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Import repository' }).length).toBeGreaterThan(0)
  })

  it('shows an analyzing badge for in-progress jobs', async () => {
    projects = [analyzingProject]
    renderHome()

    expect(await screen.findByRole('heading', { name: 'octocat/in-flight' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('분석 중')
    expect(screen.getByText(/ANALYZING/)).toBeInTheDocument()
  })
})
