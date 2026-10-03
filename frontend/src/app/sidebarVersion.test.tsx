import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { DesktopBridge } from '../desktop'
import Sidebar from './Sidebar'

vi.mock('../api/projects', () => ({ listProjects: async () => [] }))

const previousBridge = window.codeIntelligenceDesktop

afterEach(() => {
  window.codeIntelligenceDesktop = previousBridge
  vi.unstubAllEnvs()
})

function renderSidebar() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><Sidebar /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Sidebar app version', () => {
  it.each(['2.4.6', '7.8.9-rc.2'])('displays the desktop runtime version %s', (appVersion) => {
    window.codeIntelligenceDesktop = {
      appVersion,
      platform: 'darwin',
      apiBaseUrl: 'http://127.0.0.1:41000',
      apiToken: 'synthetic',
      pickFolder: vi.fn(),
      authorizeDroppedFolder: vi.fn(),
      openExternal: vi.fn(),
      backup: vi.fn(),
      restore: vi.fn(),
      runtimeStatus: vi.fn(),
      restartRuntime: vi.fn(),
    } satisfies DesktopBridge
    renderSidebar()
    expect(screen.getByText(`v${appVersion}`)).toBeVisible()
    expect(screen.queryByText(/Browser (development|build)/)).not.toBeInTheDocument()
    expect(screen.queryByText('v0.0.0')).not.toBeInTheDocument()
  })

  it.each([
    [true, 'Browser development'],
    [false, 'Browser build'],
  ] as const)('identifies the browser source when DEV=%s', (development, label) => {
    delete window.codeIntelligenceDesktop
    vi.stubEnv('DEV', development)
    renderSidebar()
    expect(screen.getByText(label)).toBeVisible()
    expect(screen.queryByText('v0.0.0')).not.toBeInTheDocument()
  })
})
