import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import { workspaceTabs } from './workspaceTabs'

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({ aiPanelOpen: true, aiPanelWidth: AI_PANEL_DEFAULT_WIDTH })
})

describe('project workspace', () => {
  it('opens overview first and keeps supporting tools behind a separate menu', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/projects/demo-project'] })
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/demo-project/overview'))
    const tabs = screen.getByRole('navigation', { name: 'Workspace tabs' })
    expect(within(tabs).getByRole('link', { name: '개요' })).toHaveAttribute('aria-current', 'page')
    expect(within(within(tabs).getByRole('group', { name: 'Primary questions' })).getAllByRole('link').map((link) => link.textContent)).toEqual([
      '개요', '기능 위치', '코드', '분석',
    ])
    const tools = within(tabs).getByText('더 보기').closest('details')!
    expect(tools).not.toHaveAttribute('open')
    fireEvent.click(within(tabs).getByText('더 보기'))
    for (const tab of workspaceTabs.filter((tab) => tab.secondary)) {
      expect(within(tabs).getByRole('link', { name: tab.label })).toHaveAttribute(
        'href', `/projects/demo-project/${tab.path}`,
      )
    }
    expect(within(tabs).queryByRole('link', { name: 'Growth' })).not.toBeInTheDocument()
  })

  it('preserves the selected snapshot on supported tabs and closes tools after navigation', async () => {
    const router = createMemoryRouter(routes, {
      initialEntries: ['/projects/demo-project/overview?snapshotId=17&unrelated=discard'],
    })
    render(<RouterProvider router={router} />)
    const tabs = screen.getByRole('navigation', { name: 'Workspace tabs' })
    for (const name of ['개요', '기능 위치', '코드']) {
      expect(within(tabs).getByRole('link', { name }).getAttribute('href')).toMatch(/\?snapshotId=17$/)
    }
    expect(within(tabs).getByRole('link', { name: '분석' })).toHaveAttribute('href', '/projects/demo-project/analysis')
    const tools = within(tabs).getByText('더 보기').closest('details')!
    fireEvent.click(within(tabs).getByText('더 보기'))
    expect(tools).toHaveAttribute('open')
    const flows = within(tabs).getByRole('link', { name: 'Flows' })
    expect(flows).toHaveAttribute('href', '/projects/demo-project/flows?snapshotId=17')
    fireEvent.click(flows)
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/demo-project/flows'))
    expect(tools).not.toHaveAttribute('open')
  })

  it('opens overview for a retired Growth bookmark', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/projects/demo-project/growth'] })
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/demo-project/overview'))
    expect(screen.queryByText('학습 기록')).not.toBeInTheDocument()
  })
})
