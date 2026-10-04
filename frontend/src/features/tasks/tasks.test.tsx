import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { TaskView } from '../../api/types'

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

const draft: TaskView = {
  id: 4,
  type: 'REVIEW',
  title: 'Review unmatched API call',
  description: 'Confirm the finding in code.',
  status: 'DRAFT',
  origin: 'AI',
  sourceFindingId: 5,
  updatedAt: '2026-08-14T00:00:00Z',
  goals: [{ id: 1, seq: 1, content: 'Open the evidence file', done: false }],
}

let tasks: TaskView[] = [draft]

const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'mock' })
    if (path === '/api/csrf') return new Response(null, { status: 204 })
    if (path.startsWith('/api/projects/7/tasks/4/approve')) {
      tasks = [{ ...draft, status: 'OPEN' }]
      return jsonResponse(tasks[0])
    }
    if (path.startsWith('/api/projects/7/tasks/4/goals/1')) {
      tasks = [
        {
          ...tasks[0],
          goals: [{ id: 1, seq: 1, content: 'Open the evidence file', done: true }],
        },
      ]
      return jsonResponse(tasks[0].goals[0])
    }
    if (path === '/api/projects/7/tasks') return jsonResponse(tasks)
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderTasks() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/tasks'] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  window.localStorage.clear()
  tasks = [draft]
  useUiStore.setState({
    aiPanelOpen: false,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
    focusedTaskId: null,
  })
  fetchMock.mockReset()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TasksPage', () => {
  it('shows an AI draft and approves it to OPEN', async () => {
    renderTasks()
    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: '초안 승인' }))
    expect(await screen.findByText(/OPEN · REVIEW · AI/)).toBeInTheDocument()
  })

  it('offers analysis tasks without learning type or record inputs', async () => {
    renderTasks()
    await screen.findByRole('heading', { name: 'Tasks' })
    expect(screen.queryByRole('option', { name: 'LEARNING' })).not.toBeInTheDocument()
    expect(screen.queryByText('학습 기록')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '학습 기록' })).not.toBeInTheDocument()
  })

  it('toggles a checklist item', async () => {
    renderTasks()
    const checkbox = await screen.findByRole('checkbox')
    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox).toBeChecked())
  })
})
