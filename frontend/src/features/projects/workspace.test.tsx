import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import { workspaceTabs } from './workspaceTabs'

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({ aiPanelOpen: true, aiPanelWidth: AI_PANEL_DEFAULT_WIDTH })
})

describe('project workspace', () => {
  it('renders all tabs, redirects index to features, and shows the Areas placeholder', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/projects/demo-project'] })
    render(<RouterProvider router={router} />)

    // index route는 features 탭으로 redirect된다
    expect(await screen.findByRole('heading', { level: 2, name: 'Features' })).toBeInTheDocument()

    const tabs = screen.getByRole('navigation', { name: '워크스페이스 탭' })
    for (const tab of workspaceTabs) {
      expect(within(tabs).getByRole('link', { name: tab.label })).toBeInTheDocument()
    }
    expect(within(tabs).getByRole('link', { name: 'Features' })).toHaveAttribute(
      'aria-current',
      'page',
    )

    // 프로젝트 안에서는 사이드바에 Areas 자리 표시가 보인다 (기획서 §15.1)
    expect(screen.getByText(/영역 감지 후 이곳에 표시됩니다/)).toBeInTheDocument()
  })
})
