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

    const tabs = screen.getByRole('navigation', { name: 'Workspace tabs' })
    for (const tab of workspaceTabs) {
      expect(within(tabs).getByRole('link', { name: tab.label })).toBeInTheDocument()
    }
    expect(within(tabs).getByRole('link', { name: 'Features' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(tabs).getByRole('link', { name: 'Architecture' })).toHaveAttribute(
      'href',
      '/projects/demo-project/architecture',
    )

    // 숫자 id가 아닌 미리보기에서는 Areas 자리 표시가 보인다
    expect(screen.getByText(/저장소를 import한 뒤 이곳에 표시됩니다/)).toBeInTheDocument()
  })
})
