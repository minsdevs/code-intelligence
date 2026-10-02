import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'

let modelRequests = 0
let requests: Array<{ path: string; method: string }> = []

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  window.localStorage.clear()
  modelRequests = 0
  requests = []
  delete window.codeIntelligenceDesktop
  useUiStore.setState({ aiPanelOpen: false, aiPanelWidth: AI_PANEL_DEFAULT_WIDTH, selectedAreas: [] })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = new URL(href, 'http://localhost').pathname
      const method = init?.method ?? 'GET'
      requests.push({ path, method })
      if (path === '/api/csrf') return new Response(null, { status: 204 })
      if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'openai' })
      if (path === '/api/ai/settings') {
        return jsonResponse({ provider: 'openai', model: 'gpt-4o-mini', keyMasked: 'sk-a…abcd', keySet: true })
      }
      if (path === '/api/ai/settings/models') {
        modelRequests += 1
        if (modelRequests === 1) return jsonResponse({ title: 'Unavailable' }, 503)
        return jsonResponse([
          {
            id: 'gpt-4o-mini',
            supportsStreaming: false,
            supportsTools: false,
            supportsReasoning: false,
            supportsVision: false,
            maxContextTokens: 8000,
          },
        ])
      }
      if (path === '/api/auth/github/connection') {
        return jsonResponse({
          identityType: requests.some((request) => request.method === 'DELETE') ? 'LOCAL' : 'LOCAL_LINKED',
          connected: !requests.some((request) => request.method === 'DELETE'),
          githubId: requests.some((request) => request.method === 'DELETE') ? null : 42,
          oauthAvailable: true,
          githubRevocationUrl: 'https://github.com/settings/applications',
        })
      }
      return jsonResponse({ title: 'Not Found' }, 404)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SettingsPage', () => {
  it('shows the local identity and GitHub connection separately', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
    render(<RouterProvider router={router} />)

    expect(await screen.findByText('LOCAL_LINKED')).toBeInTheDocument()
    expect(screen.getByText('연결됨')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '로컬 GitHub credential 연결 해제' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'GitHub authorization 설정 열기' })).toBeDisabled()
  })

  it('does not delete before confirmation and disconnects after confirmation', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
    render(<RouterProvider router={router} />)

    fireEvent.click(await screen.findByRole('button', { name: '로컬 GitHub credential 연결 해제' }))
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '연결 해제 확인' }))

    await waitFor(() => expect(requests.some((request) => request.method === 'DELETE')).toBe(true))
  })

  it('shows provider status and the stored key', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
    render(<RouterProvider router={router} />)
    expect(await screen.findByText('사용 가능')).toBeInTheDocument()
    expect(screen.getAllByText('openai').length).toBeGreaterThan(0)
    expect(await screen.findByText('sk-a…abcd')).toBeInTheDocument()
  })

  it('offers an API key field and a save button', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
    render(<RouterProvider router={router} />)
    expect(await screen.findByLabelText('API 키')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '키 저장' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '키 제거' })).toBeInTheDocument()
  })

  it('retries a failed model list request', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
    render(<RouterProvider router={router} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable')
    fireEvent.click(screen.getByRole('button', { name: '모델 목록 다시 시도' }))

    await waitFor(() => expect(screen.getByRole('combobox', { name: '채팅 모델' })).toBeEnabled())
    expect(screen.getByRole('option', { name: 'gpt-4o-mini' })).toBeInTheDocument()
  })

  it('uses the desktop runtime bridge and requires restore confirmation', async () => {
    const bridge = {
      platform: 'darwin',
      apiBaseUrl: 'http://127.0.0.1:4311',
      apiToken: 'test-token',
      pickFolder: vi.fn(),
      authorizeDroppedFolder: vi.fn(),
      openExternal: vi.fn(() => Promise.resolve()),
      backup: vi.fn(() => Promise.resolve('/tmp/backup')),
      restore: vi.fn(() => Promise.resolve({ restored: true, recoveryBackup: '/tmp/recovery' })),
      runtimeStatus: vi.fn(() => Promise.resolve({ ready: true, error: null, services: ['postgres'] })),
      restartRuntime: vi.fn(() => Promise.resolve({ ready: true, error: null, services: ['postgres'] })),
    }
    window.codeIntelligenceDesktop = bridge
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
    render(<RouterProvider router={router} />)

    expect(await screen.findByText('준비됨')).toBeInTheDocument()
    const revokeButton = await screen.findByRole('button', { name: 'GitHub authorization 설정 열기' })
    expect(bridge.openExternal).not.toHaveBeenCalled()
    fireEvent.click(revokeButton)
    expect(bridge.openExternal).toHaveBeenCalledWith('https://github.com/settings/applications')

    fireEvent.click(screen.getByRole('button', { name: 'Runtime 재시작' }))
    fireEvent.click(screen.getByRole('button', { name: '백업 생성' }))
    await waitFor(() => {
      expect(bridge.restartRuntime).toHaveBeenCalledTimes(1)
      expect(bridge.backup).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByRole('button', { name: '백업 복원' }))
    expect(bridge.restore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '복원 확인' }))
    await waitFor(() => expect(bridge.restore).toHaveBeenCalledTimes(1))
  })
})
