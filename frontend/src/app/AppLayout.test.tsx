import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from './router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../stores/uiStore'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderApp(initialPath = '/') {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({
    aiPanelOpen: true,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = new URL(href, 'http://localhost').pathname
      if (path === '/api/projects') {
        return jsonResponse([])
      }
      return jsonResponse({ title: 'Not Found' }, 404)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AppLayout', () => {
  it('renders the sidebar navigation and the home empty state', async () => {
    renderApp('/')

    const nav = screen.getByRole('navigation', { name: '주 메뉴' })
    for (const label of ['Home', 'Projects', 'Search', 'Settings']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument()
    }

    expect(await screen.findByText('프로젝트를 연결하면 여기에 표시됩니다')).toBeInTheDocument()
  })

  it('collapses and expands the AI panel', () => {
    renderApp('/')

    expect(screen.getByText('AI Assistant — Phase 3에서 활성화됩니다')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'AI 패널 접기' }))
    expect(useUiStore.getState().aiPanelOpen).toBe(false)
    expect(screen.queryByText('AI Assistant — Phase 3에서 활성화됩니다')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'AI 패널 펼치기' }))
    expect(useUiStore.getState().aiPanelOpen).toBe(true)
    expect(screen.getByText('AI Assistant — Phase 3에서 활성화됩니다')).toBeInTheDocument()
  })
})
