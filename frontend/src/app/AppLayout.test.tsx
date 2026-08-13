import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from './router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../stores/uiStore'

function renderApp(initialPath = '/') {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({ aiPanelOpen: true, aiPanelWidth: AI_PANEL_DEFAULT_WIDTH })
})

describe('AppLayout', () => {
  it('renders the sidebar navigation and the home empty state', () => {
    renderApp('/')

    const nav = screen.getByRole('navigation', { name: '주 메뉴' })
    for (const label of ['Home', 'Projects', 'Search', 'Settings']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument()
    }

    expect(screen.getByText('프로젝트를 연결하면 여기에 표시됩니다')).toBeInTheDocument()
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
