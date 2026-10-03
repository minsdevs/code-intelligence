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
    sidebarCollapsed: false,
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
      if (path === '/api/ai/status') {
        return jsonResponse({ configured: false, provider: null })
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

    const nav = screen.getByRole('navigation', { name: 'Main menu' })
    for (const label of ['Home', 'Projects', 'Search', 'Settings']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument()
    }

    expect(await screen.findByText('프로젝트를 연결하면 여기에 표시됩니다')).toBeInTheDocument()
  })

  it('collapses and expands the AI panel', () => {
    renderApp('/')

    expect(screen.getByRole('textbox', { name: 'AI 질문 입력' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'AI 패널 접기' }))
    expect(useUiStore.getState().aiPanelOpen).toBe(false)
    expect(screen.queryByRole('textbox', { name: 'AI 질문 입력' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'AI 패널 펼치기' }))
    expect(useUiStore.getState().aiPanelOpen).toBe(true)
    expect(screen.getByRole('textbox', { name: 'AI 질문 입력' })).toBeInTheDocument()
  })

  it('keeps sidebar navigation accessible while collapsed and persists the choice', () => {
    const app = renderApp('/')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    expect(JSON.parse(window.localStorage.getItem('code-intelligence.ui')!).state.sidebarCollapsed).toBe(true)
    const nav = screen.getByRole('navigation', { name: 'Main menu' })
    for (const label of ['Home', 'Projects', 'Search', 'Settings']) {
      expect(within(nav).getByRole('link', { name: label })).toBeVisible()
    }
    app.unmount()
    renderApp('/')
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(useUiStore.getState().sidebarCollapsed).toBe(false)
  })

  it('temporarily caps the AI width on resize without losing its saved preference', () => {
    vi.stubGlobal('innerWidth', 980)
    useUiStore.setState({ aiPanelWidth: 560 })
    renderApp('/')
    const separator = screen.getByRole('separator')
    expect(separator).toHaveAttribute('tabindex', '0')
    expect(separator).toHaveAttribute('aria-valuenow', '334')
    expect(separator).toHaveAttribute('aria-valuemax', '334')
    expect(useUiStore.getState().aiPanelWidth).toBe(560)
    vi.stubGlobal('innerWidth', 1440)
    fireEvent(window, new Event('resize'))
    expect(separator).toHaveAttribute('aria-valuenow', '560')
    expect(useUiStore.getState().aiPanelWidth).toBe(560)
  })

  it('resizes by keyboard within current bounds and adapts to sidebar collapse', () => {
    vi.stubGlobal('innerWidth', 980)
    renderApp('/')
    const separator = screen.getByRole('separator')
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator).toHaveAttribute('aria-valuenow', '280')
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(separator).toHaveAttribute('aria-valuenow', '304')
    fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true })
    expect(separator).toHaveAttribute('aria-valuenow', '280')
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', '334')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', '518')
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(separator).toHaveAttribute('aria-valuenow', '334')
  })
})
