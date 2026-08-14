import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from './router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../stores/uiStore'
import type { ProjectArea } from '../api/types'

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

const sampleAreas: ProjectArea[] = [
  {
    areaType: 'BACKEND',
    confidence: 0.9,
    technologies: ['Java'],
    evidences: [],
    selected: true,
  },
  {
    areaType: 'FRONTEND',
    confidence: 0.7,
    technologies: ['React'],
    evidences: [],
    selected: false,
  },
]

const fetchMock = vi.fn()

function renderWorkspace() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/features'] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  window.localStorage.clear()
  document.cookie = 'XSRF-TOKEN=test-csrf'
  useUiStore.setState({
    aiPanelOpen: true,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
  })
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Sidebar Areas', () => {
  it('toggles an area with PUT and optimistic update', async () => {
    let releasePut: (() => void) | undefined
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.pathname
      if (path === '/api/csrf') {
        return emptyResponse(204)
      }
      if (method === 'GET' && path === '/api/projects/7/areas') {
        return jsonResponse(sampleAreas)
      }
      if (method === 'PUT' && path === '/api/projects/7/area-selections') {
        await new Promise<void>((resolve) => {
          releasePut = resolve
        })
        return emptyResponse(204)
      }
      return jsonResponse({ title: 'Not Found' }, 404)
    })

    renderWorkspace()

    const backend = await screen.findByRole('checkbox', { name: 'Backend' })
    expect(backend).toBeChecked()
    expect(useUiStore.getState().selectedAreas).toEqual(['BACKEND'])

    fireEvent.click(backend)
    await waitFor(() => {
      expect(backend).not.toBeChecked()
    })
    expect(useUiStore.getState().selectedAreas).toEqual([])

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([req, init]) => {
        return (
          requestUrl(req as RequestInfo | URL).pathname === '/api/projects/7/area-selections' &&
          (init?.method ?? 'GET').toUpperCase() === 'PUT'
        )
      })
      expect(putCall).toBeTruthy()
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
        selections: [
          { areaType: 'BACKEND', selected: false },
          { areaType: 'FRONTEND', selected: false },
        ],
      })
    })

    releasePut?.()
  })
})
