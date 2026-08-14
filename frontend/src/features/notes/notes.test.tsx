import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { NoteSummary, NoteView } from '../../api/types'

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

const summary: NoteSummary = { id: 3, title: 'Auth', updatedAt: '2026-08-14T00:00:00Z' }
const detail: NoteView = {
  id: 3,
  title: 'Auth',
  contentMd: 'See @file:src/App.java',
  updatedAt: '2026-08-14T00:00:00Z',
  references: [
    {
      subjectType: 'FILE',
      subjectId: 1,
      rawTarget: 'src/App.java',
      label: 'src/App.java',
      hrefHint: 'FILE',
    },
  ],
}

const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const path = url.pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'mock' })
    if (path === '/api/csrf') return new Response(null, { status: 204 })
    if (path === '/api/projects/7/notes' && method === 'GET') return jsonResponse([summary])
    if (path === '/api/projects/7/notes' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { title: string; contentMd: string }
      return jsonResponse({ ...detail, id: 9, title: body.title, contentMd: body.contentMd }, 201)
    }
    if (path === '/api/projects/7/notes/3') return jsonResponse(detail)
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderNotes() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/notes'] })
  return { router, ...render(<RouterProvider router={router} />) }
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({
    aiPanelOpen: false,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
    focusedNoteId: null,
  })
  fetchMock.mockReset()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NotesPage', () => {
  it('lists a note, shows a file reference chip, and navigates to code', async () => {
    const { router } = renderNotes()
    expect(await screen.findByRole('heading', { name: 'Notes' })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Auth' }))
    expect(await screen.findByDisplayValue('See @file:src/App.java')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'file:src/App.java' }))
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/7/code')
      expect(router.state.location.search).toContain('path=src%2FApp.java')
    })
  })

  it('creates a note without rendering markdown as HTML', async () => {
    renderNotes()
    fireEvent.click(await screen.findByRole('button', { name: '새 노트' }))
    expect(await screen.findByRole('textbox', { name: '노트 제목' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '노트 제목' }), {
      target: { value: 'XSS' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: '노트 본문' }), {
      target: { value: '<img src=x onerror=alert(1)> @file:src/App.java' },
    })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => {
      const posted = fetchMock.mock.calls.some((call) => {
        const url = requestUrl(call[0] as RequestInfo | URL)
        return (
          url.pathname === '/api/projects/7/notes' &&
          (call[1] as RequestInit | undefined)?.method === 'POST'
        )
      })
      expect(posted).toBe(true)
    })
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
