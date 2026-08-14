import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { GrowthView } from '../../api/types'

vi.mock('@monaco-editor/react', () => ({
  default: () => null,
  DiffEditor: () => null,
}))

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

const growth: GrowthView = {
  notesCount: 2,
  learningRecords: 1,
  findingsOpen: 3,
  findingsDismissed: 1,
  tasksByType: [
    { type: 'LEARNING', open: 0, done: 1, draft: 0, cancelled: 0 },
    { type: 'DEVELOPMENT', open: 0, done: 0, draft: 0, cancelled: 0 },
    { type: 'REVIEW', open: 0, done: 0, draft: 0, cancelled: 0 },
    { type: 'RESEARCH', open: 0, done: 0, draft: 0, cancelled: 0 },
    { type: 'REFACTORING', open: 0, done: 0, draft: 0, cancelled: 0 },
  ],
  weekly: [{ weekStart: '2026-08-10', learningRecords: 1, tasksDone: 1 }],
  recentRecords: [
    {
      taskId: 4,
      taskTitle: 'Read App',
      note: 'understood constructors',
      createdAt: '2026-08-14T00:00:00Z',
    },
  ],
}

const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'mock' })
    if (path === '/api/csrf') return new Response(null, { status: 204 })
    if (path === '/api/projects/7/growth') return jsonResponse(growth)
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderGrowth() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/growth'] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({
    aiPanelOpen: false,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
  })
  fetchMock.mockReset()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GrowthPage', () => {
  it('renders learning counts and recent records', async () => {
    renderGrowth()
    expect(await screen.findByText('understood constructors')).toBeInTheDocument()
    expect(screen.getByText('LEARNING')).toBeInTheDocument()
    expect(screen.getByText('records 1')).toBeInTheDocument()
  })
})
