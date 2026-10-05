import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { AiSettingView } from '../../api/aiSettings'
import type { DesktopBridge, RuntimeStatus } from '../../desktop'
import { I18nProvider } from '../../lib/i18n'
import SettingsPage from './SettingsPage'

let accountLogin = 'fixture-user'
let githubIdentityType = 'LOCAL_LINKED'
let reauthenticationReason: string | null = null
let oauthAvailable = true
let initiallyConnected = true
let modelRequests = 0
let requests: Array<{ path: string; method: string; body?: unknown }> = []
let aiSettings: AiSettingView | null
let failFirstModels: boolean
let mutationGate: Promise<void> | null
let mutationFailure: { status: number; detail: string } | null
let firstStatusResponse: Promise<Response> | null
let statusRequests: number
let blockedReason: string | null
let inspectedClients: QueryClient[] = []

function renderSettings() {
  const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
  return render(<I18nProvider><RouterProvider router={router} /></I18nProvider>)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function installDesktopBridge(runtime: () => Promise<RuntimeStatus>) {
  const bridge = {
    appVersion: '0.1.0',
    platform: 'darwin', apiBaseUrl: 'http://127.0.0.1:4311', apiToken: 'synthetic-token',
    pickFolder: vi.fn(), authorizeDroppedFolder: vi.fn(), openExternal: vi.fn(),
    backup: vi.fn(() => Promise.resolve('/tmp/synthetic-backup')),
    restore: vi.fn<DesktopBridge['restore']>(() => Promise.resolve({ restored: true, recoveryBackup: '/tmp/synthetic-recovery' })),
    runtimeStatus: vi.fn(runtime), restartRuntime: vi.fn(runtime),
  }
  window.codeIntelligenceDesktop = bridge
  return bridge
}

function renderWithInspectableCache() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      // Keep old records to prove that changing observer/resetting the form cannot hide a leak.
      mutations: { gcTime: Infinity },
    },
  })
  inspectedClients.push(client)
  const snapshots: string[] = []
  client.getMutationCache().subscribe(() => {
    snapshots.push(JSON.stringify(client.getMutationCache().getAll().map(({ state }) => ({
      variables: state.variables, context: state.context, data: state.data,
      error: String(state.error), failureReason: String(state.failureReason),
    }))))
  })
  return {
    client,
    snapshots,
    ...render(<QueryClientProvider client={client}><I18nProvider><SettingsPage /></I18nProvider></QueryClientProvider>),
  }
}

function expectNoKeyInCache(client: QueryClient, snapshots: string[], sentinel: string) {
  expect(snapshots.length).toBeGreaterThan(0)
  expect(client.getMutationCache().getAll().length).toBeGreaterThan(0)
  for (const snapshot of snapshots) expect(snapshot).not.toContain(sentinel)
  for (const mutation of client.getMutationCache().getAll()) {
    expect(mutation.state.variables).not.toHaveProperty('apiKey')
    expect(String(mutation.state.error)).not.toContain(sentinel)
    expect(String(mutation.state.failureReason)).not.toContain(sentinel)
  }
  expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(sentinel)
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  window.localStorage.clear()
  accountLogin = 'fixture-user'
  githubIdentityType = 'LOCAL_LINKED'
  reauthenticationReason = null
  oauthAvailable = true
  initiallyConnected = true
  modelRequests = 0
  requests = []
  aiSettings = { provider: 'openai', model: 'gpt-4o-mini', keyMasked: 'sk-a…abcd', keySet: true, state: 'ENABLED', activeRequests: 0 }
  failFirstModels = true
  mutationGate = null
  mutationFailure = null
  firstStatusResponse = null
  statusRequests = 0
  blockedReason = null
  inspectedClients = []
  delete window.codeIntelligenceDesktop
  useUiStore.setState({ aiPanelOpen: false, aiPanelWidth: AI_PANEL_DEFAULT_WIDTH, selectedAreas: [] })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(href, 'http://localhost')
      const path = url.pathname
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      requests.push({ path, method, body })
      if (path === '/api/csrf') return new Response(null, { status: 204 })
      if (path === '/api/ai/budget') return jsonResponse({
        available: false, state: 'OFF', policyRevision: '0', activationToken: null,
        dailyLimitMicroUsd: '0', monthlyLimitMicroUsd: '0', allDatesHeldMicroUsd: '0',
        dailySettledMicroUsd: '0', monthlySettledMicroUsd: '0', supportedModels: [],
      })
      if (path === '/api/ai/status') {
        statusRequests += 1
        if (statusRequests === 1 && firstStatusResponse) return firstStatusResponse
        const configured = !blockedReason && Boolean(aiSettings?.state === 'ENABLED' && aiSettings.keySet)
        return jsonResponse({ configured, provider: configured ? aiSettings?.provider : null, model: configured ? aiSettings?.model : null, blockedReason })
      }
      if (path === '/api/ai/settings') {
        if (method === 'PUT' || method === 'DELETE') {
          if (mutationGate) await mutationGate
          if (mutationFailure) return jsonResponse({ detail: mutationFailure.detail }, mutationFailure.status)
          aiSettings = method === 'DELETE'
            ? { provider: aiSettings?.provider ?? null, model: aiSettings?.model ?? null, keySet: false, keyMasked: null, state: 'OFF', activeRequests: aiSettings?.activeRequests ?? 0 }
            : { provider: body.provider, model: body.model, keySet: true, keyMasked: 'synt…key', state: 'ENABLED', activeRequests: aiSettings?.activeRequests ?? 0 }
        }
        return jsonResponse(aiSettings)
      }
      if (path === '/api/ai/settings/models') {
        modelRequests += 1
        if (failFirstModels && modelRequests === 1) return jsonResponse({ title: 'Unavailable' }, 503)
        const ids = url.searchParams.get('provider') === 'gemini'
          ? ['gemini-2.0-flash', 'gemini-1.5-pro']
          : ['gpt-4o-mini', 'gpt-4o']
        return jsonResponse(ids.map((id) => ({
            id,
            supportsStreaming: false,
            supportsTools: false,
            supportsReasoning: false,
            supportsVision: false,
            maxContextTokens: 8000,
          })))
      }
      if (path === '/api/auth/me') return jsonResponse({ authenticated: true, login: accountLogin, name: 'Fixture', avatarUrl: null, credentialKind: 'OAUTH', oauthAvailable })
      if (path === '/api/auth/github/connection') {
        const disconnected = !initiallyConnected || requests.some((request) => request.path === path && request.method === 'DELETE')
        return jsonResponse({
          identityType: disconnected ? 'LOCAL' : githubIdentityType,
          connected: !disconnected && !reauthenticationReason,
          reauthenticationReason: disconnected ? null : reauthenticationReason,
          githubId: disconnected ? null : 42,
          oauthAvailable,
          githubRevocationUrl: 'https://github.com/settings/applications',
        })
      }
      return jsonResponse({ title: 'Not Found' }, 404)
    }),
  )
})

afterEach(() => {
  for (const client of inspectedClients) client.clear()
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

  it('uses the linked GitHub ID instead of treating a local profile login as a GitHub username', async () => {
    accountLogin = 'local'
    renderSettings()
    expect(await screen.findByText('GitHub ID 42')).toBeInTheDocument()
    expect(screen.queryByText('@local')).not.toBeInTheDocument()
  })

  it('retains the username for a GitHub-only identity', async () => {
    githubIdentityType = 'GITHUB'
    renderSettings()
    expect(await screen.findByText('@fixture-user')).toBeInTheDocument()
  })

  it('offers reauthentication and disconnect for an expired linked account', async () => {
    reauthenticationReason = 'TOKEN_EXPIRED'
    renderSettings()
    expect(await screen.findByText(/GitHub 연결이 만료되었습니다/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /GitHub로 계속/ })).toHaveAttribute('href', '/oauth2/authorization/github')
    expect(screen.getByRole('button', { name: '로컬 GitHub credential 연결 해제' })).toBeEnabled()
    expect(screen.getByRole('link', { name: '계정 설정' })).toHaveTextContent('재인증 필요')
  })

  for (const [reason, message] of [
    ['REFRESH_IN_PROGRESS', 'GitHub 토큰을 갱신하고 있습니다. 잠시 기다린 뒤 연결 상태를 다시 확인하세요.'],
    ['REFRESH_UNCERTAIN', 'GitHub 갱신 결과를 확인하지 못했습니다. 같은 갱신 요청을 자동으로 반복하지 않습니다. 다시 로그인하세요. 로컬 분석 기록은 유지됩니다.'],
    ['TOKEN_REJECTED', 'GitHub가 현재 인증 정보를 거부했습니다. 다시 로그인하세요. 로컬 분석 기록은 유지됩니다.'],
  ]) {
    it(`explains ${reason} without incorrectly claiming refresh is unsupported`, async () => {
      reauthenticationReason = reason
      renderSettings()
      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(document.body).not.toHaveTextContent('자동 갱신은 아직 지원하지 않으며')
      expect(document.body).toHaveTextContent('검증된 갱신 토큰이 있는 기기 로그인만 자동 갱신합니다')
      expect(requests.some(request => request.path.includes('/native/poll'))).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'English' }))
      expect(await screen.findByText(/Only a device-login credential with a verified refresh token/)).toBeInTheDocument()
    })
  }

  it('offers login after a confirmed account switch and preserves local data', async () => {
    renderSettings()
    expect(await screen.findByText('GitHub ID 42')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '계정 전환' }))
    expect(screen.getByText(/계정을 전환하려면 현재 GitHub 연결/)).toBeInTheDocument()
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '계정 전환' }))
    fireEvent.click(screen.getByRole('button', { name: '연결 해제 확인' }))
    expect(await screen.findByText(/이전 연결을 해제했습니다/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /GitHub로 계속/ })).toHaveAttribute('href', '/oauth2/authorization/github')
    expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.path)).toEqual(['/api/auth/github/connection'])
    expect(screen.getByRole('link', { name: '계정 설정' })).toHaveTextContent('로컬 모드')
  })

  it('explains unavailable OAuth while retaining local mode and an account entry point', async () => {
    initiallyConnected = false
    oauthAvailable = false
    renderSettings()
    expect(await screen.findByText(/GitHub OAuth가 이 앱에 설정되지 않아/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /GitHub로 계속/ })).toBeDisabled()
    expect(screen.getByRole('link', { name: '계정 설정' })).toHaveTextContent('로컬 모드')
    expect(requests.some((request) => request.path.includes('/native/start'))).toBe(false)
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
    expect(await screen.findByRole('button', { name: 'AI 끄기 및 키 제거' })).toBeInTheDocument()
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
      appVersion: '0.1.0',
      platform: 'darwin',
      apiBaseUrl: 'http://127.0.0.1:4311',
      apiToken: 'test-token',
      pickFolder: vi.fn(),
      authorizeDroppedFolder: vi.fn(),
      openExternal: vi.fn(() => Promise.resolve()),
      backup: vi.fn(() => Promise.resolve('/tmp/backup')),
      restore: vi.fn<DesktopBridge['restore']>(() => Promise.resolve({ restored: true, recoveryBackup: '/tmp/recovery' })),
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
    await waitFor(() => expect(screen.getByRole('button', { name: '백업 생성' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '백업 생성' }))
    await waitFor(() => {
      expect(bridge.restartRuntime).toHaveBeenCalledTimes(1)
      expect(bridge.backup).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => expect(screen.getByRole('button', { name: '백업 복원' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '백업 복원' }))
    expect(bridge.restore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '복원 확인' }))
    await waitFor(() => expect(bridge.restore).toHaveBeenCalledTimes(1))
  })
})

describe('AI settings OFF and reconnection', () => {
  beforeEach(() => { failFirstModels = false })

  it('shows an initial OFF state with no key or availability and requires a new key', async () => {
    aiSettings = { provider: null, model: null, keySet: false, keyMasked: null, state: 'OFF', activeRequests: 0 }
    renderSettings()

    expect(await screen.findByText('AI 꺼짐')).toBeInTheDocument()
    expect(screen.queryByText('사용 가능')).not.toBeInTheDocument()
    expect(screen.queryByText('sk-a…abcd')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('API 키')).toBeEnabled())
    expect(screen.getByRole('button', { name: '키 저장' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'AI 끄기 및 키 제거' })).toBeDisabled()
    expect(screen.getByText(/환경 변수의 키를 사용하지 않으며 새 요청이 중지됩니다/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('API 키'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: '키 저장' })).toBeDisabled()
  })

  it('treats an initial null setting as unconfigured and never reuses a nonexistent key', async () => {
    aiSettings = null
    renderSettings()
    expect(await screen.findByText('비활성화')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('API 키')).toBeEnabled())
    const save = screen.getByRole('button', { name: '키 저장' })
    expect(save).toBeDisabled()
    fireEvent.submit(save.closest('form')!)
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
  })

  it('applies the DELETE response as OFF, removes both stored and entered keys, and keeps provider/model preferences', async () => {
    aiSettings = { provider: 'gemini', model: 'gemini-1.5-pro', keySet: true, keyMasked: 'synt…old', state: 'ENABLED', activeRequests: 0 }
    renderSettings()
    expect(await screen.findByText('synt…old')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('combobox', { name: '채팅 모델' })).toHaveValue('gemini-1.5-pro'))
    fireEvent.change(screen.getByLabelText('API 키'), { target: { value: 'unsaved-synthetic-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'AI 끄기 및 키 제거' }))

    expect(await screen.findByText('AI 꺼짐')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('API 키')).toBeEnabled())
    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveValue('gemini')
    expect(screen.getByRole('combobox', { name: '채팅 모델' })).toHaveValue('gemini-1.5-pro')
    expect(screen.getByLabelText('API 키')).toHaveValue('')
    expect(screen.queryByText('synt…old')).not.toBeInTheDocument()
    expect(screen.queryByText('사용 가능')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '키 저장' })).toBeDisabled()
    expect(requests.filter((request) => request.path === '/api/ai/settings' && request.method === 'DELETE')).toHaveLength(1)
  })

  it('preserves a reconnect preference that is not the first model and requires an explicitly entered key', async () => {
    aiSettings = { provider: 'gemini', model: 'gemini-1.5-pro', keySet: false, keyMasked: null, state: 'RECONNECT_REQUIRED', activeRequests: 0 }
    renderSettings()
    expect(await screen.findByText('재연결 필요')).toBeInTheDocument()
    expect(screen.getByText(/새 API 키를 입력해 다시 연결/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('combobox', { name: '채팅 모델' })).toBeEnabled())
    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveValue('gemini')
    expect(screen.getByRole('combobox', { name: '채팅 모델' })).toHaveValue('gemini-1.5-pro')
    expect(screen.queryByText('사용 가능')).not.toBeInTheDocument()
    const save = screen.getByRole('button', { name: '키 저장' })
    expect(save).toBeDisabled()
    fireEvent.submit(save.closest('form')!)
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
    fireEvent.change(screen.getByLabelText('API 키'), { target: { value: 'synthetic-reconnect-key' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(await screen.findByText('synt…key')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('API 키')).toHaveValue(''))
    expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({
      provider: 'gemini', model: 'gemini-1.5-pro', apiKey: 'synthetic-reconnect-key',
    })
    expect(await screen.findByText('사용 가능')).toBeInTheDocument()
  })

  it('keeps an unavailable saved model visible without silently replacing it or enabling save', async () => {
    aiSettings = { provider: 'gemini', model: 'synthetic-retired-model', keySet: false, keyMasked: null, state: 'RECONNECT_REQUIRED', activeRequests: 0 }
    renderSettings()
    expect(await screen.findByText(/저장된 모델이 현재 모델 목록에 없습니다/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '채팅 모델' })).toHaveValue('synthetic-retired-model')
    fireEvent.change(screen.getByLabelText('API 키'), { target: { value: 'synthetic-key' } })
    expect(screen.getByRole('button', { name: '키 저장' })).toBeDisabled()
    fireEvent.change(screen.getByRole('combobox', { name: '채팅 모델' }), { target: { value: 'gemini-2.0-flash' } })
    expect(screen.getByRole('button', { name: '키 저장' })).toBeEnabled()
  })

  it('reports previously admitted requests after OFF without promising that unsent requests were cancelled', async () => {
    aiSettings = { ...aiSettings!, activeRequests: 2 }
    renderSettings()
    const clear = await screen.findByRole('button', { name: 'AI 끄기 및 키 제거' })
    await waitFor(() => expect(clear).toBeEnabled())
    fireEvent.click(clear)
    expect(await screen.findByText('새 요청은 중지됐습니다. 이전 승인 요청 2개는 계속될 수 있습니다.')).toBeInTheDocument()
    expect(screen.getByText('AI 꺼짐')).toBeInTheDocument()
    expect(screen.queryByText(/모든 요청.*취소/)).not.toBeInTheDocument()
  })

  it('gives the same previously-approved-request warning in English', async () => {
    window.localStorage.setItem('code-intelligence.lang', 'en')
    aiSettings = { provider: 'openai', model: 'gpt-4o-mini', keySet: false, keyMasked: null, state: 'OFF', activeRequests: 3 }
    renderSettings()
    expect(await screen.findByText('New requests are stopped. 3 previously approved requests may still proceed.')).toBeInTheDocument()
    expect(screen.queryByText('Available')).not.toBeInTheDocument()
  })

  for (const action of ['save', 'clear'] as const) {
    it(`locks fields and both actions while ${action} is pending, including a direct duplicate form submit`, async () => {
      const gate = deferred<void>()
      mutationGate = gate.promise
      renderSettings()
      await waitFor(() => expect(screen.getByRole('button', { name: '키 저장' })).toBeEnabled())
      const save = screen.getByRole('button', { name: '키 저장' })
      const clear = screen.getByRole('button', { name: 'AI 끄기 및 키 제거' })
      const form = save.closest('form')!
      act(() => {
        fireEvent.click(action === 'save' ? save : clear)
        fireEvent.click(action === 'save' ? clear : save)
        fireEvent.submit(form)
      })
      const method = action === 'save' ? 'PUT' : 'DELETE'
      await waitFor(() => expect(requests.filter((request) => request.path === '/api/ai/settings' && request.method === method)).toHaveLength(1))
      expect(screen.getByRole('combobox', { name: 'Provider' })).toBeDisabled()
      expect(screen.getByRole('combobox', { name: '채팅 모델' })).toBeDisabled()
      expect(screen.getByLabelText('API 키')).toBeDisabled()
      expect(save).toBeDisabled()
      expect(clear).toBeDisabled()
      expect(form).toHaveAttribute('aria-busy', 'true')
      expect(requests.filter((request) => request.path === '/api/ai/settings' && ['PUT', 'DELETE'].includes(request.method))).toHaveLength(1)
      await act(async () => { gate.resolve(undefined) })
      await waitFor(() => expect(screen.getByLabelText('API 키')).toBeEnabled())
      expect(form).toHaveAttribute('aria-busy', 'false')
    })
  }

  for (const status of [409, 500]) {
    for (const action of ['save', 'clear'] as const) {
      it(`shows a safe ${status} error after failed ${action}, reconciles state and does not claim OFF`, async () => {
        mutationFailure = { status, detail: 'injected-provider-error with synthetic-PRIVATE-key and /private/path' }
        renderSettings()
        await waitFor(() => expect(screen.getByRole('button', { name: '키 저장' })).toBeEnabled())
        fireEvent.click(screen.getByRole('button', { name: action === 'save' ? '키 저장' : 'AI 끄기 및 키 제거' }))
        expect(await screen.findByRole('alert')).toHaveTextContent(status === 409 ? '다른 작업과 충돌' : '설정 변경을 확인하지 못했습니다')
        await waitFor(() => expect(screen.getByLabelText('API 키')).toBeEnabled())
        expect(screen.getByText('sk-a…abcd')).toBeInTheDocument()
        expect(screen.getByText('사용 가능')).toBeInTheDocument()
        expect(screen.queryByText('AI 꺼짐')).not.toBeInTheDocument()
        expect(document.body).not.toHaveTextContent('injected-provider-error')
        expect(document.body).not.toHaveTextContent('synthetic-PRIVATE-key')
        expect(requests.filter((request) => request.path === '/api/ai/settings' && request.method === 'GET').length).toBeGreaterThan(1)
        mutationFailure = null
        fireEvent.click(screen.getByRole('button', { name: 'AI 끄기 및 키 제거' }))
        expect(await screen.findByText('AI 꺼짐')).toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      })
    }
  }

  it('keeps the OFF result when an older status response arrives after clear', async () => {
    const earlier = deferred<Response>()
    firstStatusResponse = earlier.promise
    renderSettings()
    await waitFor(() => expect(screen.getByRole('button', { name: 'AI 끄기 및 키 제거' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '키 저장' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'AI 끄기 및 키 제거' }))
    expect(await screen.findByText('AI 꺼짐')).toBeInTheDocument()
    await act(async () => { earlier.resolve(jsonResponse({ configured: true, provider: 'openai', model: 'gpt-4o-mini' })) })
    expect(screen.getByText('AI 꺼짐')).toBeInTheDocument()
    expect(screen.queryByText('사용 가능')).not.toBeInTheDocument()
    expect(screen.queryByText('sk-a…abcd')).not.toBeInTheDocument()
  })
})

describe('AI key lifetime outside the React Query mutation cache', () => {
  beforeEach(() => { failFirstModels = false })

  it('never caches a submitted key while pending, after success, or in the retained record after OFF', async () => {
    const sentinel = 'SENTINEL-private-ai-key-success-123456789'
    const unsaved = 'SENTINEL-private-unsaved-off-key-987654321'
    const gate = deferred<void>()
    mutationGate = gate.promise
    const { client, snapshots } = renderWithInspectableCache()
    await waitFor(() => expect(screen.getByRole('button', { name: '키 저장' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('API 키'), { target: { value: sentinel } })
    fireEvent.click(screen.getByRole('button', { name: '키 저장' }))
    expect(screen.getByLabelText('API 키')).toHaveValue('')
    await waitFor(() => expect(requests.some((request) => request.method === 'PUT')).toBe(true))
    expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({
      provider: 'openai', model: 'gpt-4o-mini', apiKey: sentinel,
    })
    expectNoKeyInCache(client, snapshots, sentinel)
    await act(async () => { gate.resolve(undefined) })
    expect(await screen.findByText('synt…key')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('API 키')).toBeEnabled())
    expectNoKeyInCache(client, snapshots, sentinel)
    const previousMutation = client.getMutationCache().getAll()[0]
    expect(previousMutation.state.status).toBe('success')

    fireEvent.change(screen.getByLabelText('API 키'), { target: { value: unsaved } })
    fireEvent.click(screen.getByRole('button', { name: 'AI 끄기 및 키 제거' }))
    expect(screen.getByLabelText('API 키')).toHaveValue('')
    expect(await screen.findByText('AI 꺼짐')).toBeInTheDocument()
    await waitFor(() => expect(client.getMutationCache().getAll().every((mutation) => mutation.state.status === 'success')).toBe(true))
    const all = client.getMutationCache().getAll()
    expect(all).toHaveLength(2)
    expect(all[0]).toBe(previousMutation)
    expect(all.map((mutation) => mutation.state.variables)).toEqual([
      { action: 'save', provider: 'openai', model: 'gpt-4o-mini' }, { action: 'clear' },
    ])
    expectNoKeyInCache(client, snapshots, sentinel)
    expectNoKeyInCache(client, snapshots, unsaved)
    expect(requests.find((request) => request.path === '/api/ai/settings' && request.method === 'DELETE')?.body).toBeUndefined()
  })

  for (const status of [409, 500]) {
    it(`clears a failed ${status} submission and does not retain an echoed key in mutation errors or old records`, async () => {
      const sentinel = `SENTINEL-private-ai-key-failure-${status}-123456789`
      mutationFailure = { status, detail: `Provider echoed a private value: ${sentinel}` }
      const { client, snapshots } = renderWithInspectableCache()
      await waitFor(() => expect(screen.getByRole('button', { name: '키 저장' })).toBeEnabled())
      fireEvent.change(screen.getByLabelText('API 키'), { target: { value: sentinel } })
      fireEvent.click(screen.getByRole('button', { name: '키 저장' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(status === 409 ? '다른 작업과 충돌' : '설정 변경을 확인하지 못했습니다')
      await waitFor(() => expect(screen.getByLabelText('API 키')).toBeEnabled())
      expect(screen.getByLabelText('API 키')).toHaveValue('')
      expect(client.getMutationCache().getAll()[0].state.status).toBe('error')
      expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1)
      expectNoKeyInCache(client, snapshots, sentinel)
      mutationFailure = null
      fireEvent.click(screen.getByRole('button', { name: 'AI 끄기 및 키 제거' }))
      expect(await screen.findByText('AI 꺼짐')).toBeInTheDocument()
      expect(client.getMutationCache().getAll()).toHaveLength(2)
      expect(client.getMutationCache().getAll()[0].state.status).toBe('error')
      expectNoKeyInCache(client, snapshots, sentinel)
    })
  }

  it('releases the private pending key on unmount before mutationFn starts and never sends it later', async () => {
    const sentinel = 'SENTINEL-private-ai-key-unmounted-before-send'
    const gate = deferred<void>()
    const { client, snapshots, unmount } = renderWithInspectableCache()
    await waitFor(() => expect(screen.getByRole('button', { name: '키 저장' })).toBeEnabled())
    const cancel = vi.spyOn(client, 'cancelQueries').mockImplementation(() => gate.promise)
    fireEvent.change(screen.getByLabelText('API 키'), { target: { value: sentinel } })
    fireEvent.click(screen.getByRole('button', { name: '키 저장' }))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ queryKey: ['ai-budget'] }))
    expectNoKeyInCache(client, snapshots, sentinel)
    unmount()
    await act(async () => { gate.resolve(undefined) })
    await waitFor(() => expect(client.getMutationCache().getAll()[0].state.status).toBe('error'))
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
    expectNoKeyInCache(client, snapshots, sentinel)
  })

  it('keeps an already sent request key out of cache when its response completes after unmount', async () => {
    const sentinel = 'SENTINEL-private-ai-key-unmounted-after-send'
    const gate = deferred<void>()
    mutationGate = gate.promise
    const { client, snapshots, unmount } = renderWithInspectableCache()
    await waitFor(() => expect(screen.getByRole('button', { name: '키 저장' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('API 키'), { target: { value: sentinel } })
    fireEvent.click(screen.getByRole('button', { name: '키 저장' }))
    await waitFor(() => expect(requests.some((request) => request.method === 'PUT')).toBe(true))
    unmount()
    expectNoKeyInCache(client, snapshots, sentinel)
    await act(async () => { gate.resolve(undefined) })
    await waitFor(() => expect(client.getMutationCache().getAll()[0].state.status).toBe('success'))
    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1)
    expectNoKeyInCache(client, snapshots, sentinel)
  })
})

describe('Desktop feature availability in Settings', () => {
  beforeEach(() => { failFirstModels = false })

  it('blocks AI inputs and direct save submission while still allowing OFF with preserved preferences', async () => {
    blockedReason = 'DESKTOP_AI_SAFETY_UNAVAILABLE'
    aiSettings = { provider: 'openai', model: 'gpt-4o', keyMasked: 'synt…key', keySet: true, state: 'ENABLED', activeRequests: 2 }
    const { client } = renderWithInspectableCache()
    const notice = '이 데스크톱 빌드에서는 AI 연결을 사용할 수 없습니다. 로컬 분석은 계속 사용할 수 있습니다.'
    expect(await screen.findByText(notice)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('combobox', { name: '채팅 모델' })).toHaveValue('gpt-4o'))
    expect(screen.queryByText('사용 가능')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Provider' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '채팅 모델' })).toBeDisabled()
    expect(screen.getByLabelText('API 키')).toBeDisabled()
    const save = screen.getByRole('button', { name: '키 저장' })
    expect(save).toBeDisabled()
    fireEvent.submit(save.closest('form')!)
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
    const clear = screen.getByRole('button', { name: 'AI 끄기 및 키 제거' })
    await waitFor(() => expect(clear).toBeEnabled())
    fireEvent.click(clear)

    expect(await screen.findByText('AI 꺼짐')).toBeInTheDocument()
    expect(screen.getByText(notice)).toBeInTheDocument()
    expect(screen.getByText('새 요청은 중지됐습니다. 이전 승인 요청 2개는 계속될 수 있습니다.')).toBeInTheDocument()
    expect(screen.queryByText('synt…key')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '채팅 모델' })).toHaveValue('gpt-4o')
    expect(client.getQueryData(['ai-settings'])).toEqual({
      provider: 'openai', model: 'gpt-4o', keySet: false, keyMasked: null, state: 'OFF', activeRequests: 2,
    })
    expect(save).toBeDisabled()
    expect(clear).toBeDisabled()
  })

  it('does not suggest entering a new key for a blocked reconnection and translates the notice', async () => {
    blockedReason = 'DESKTOP_AI_SAFETY_UNAVAILABLE'
    aiSettings = { provider: 'gemini', model: 'gemini-1.5-pro', keyMasked: null, keySet: false, state: 'RECONNECT_REQUIRED', activeRequests: 0 }
    renderSettings()
    expect(await screen.findByText('이 데스크톱 빌드에서는 AI 연결을 사용할 수 없습니다. 로컬 분석은 계속 사용할 수 있습니다.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('combobox', { name: '채팅 모델' })).toHaveValue('gemini-1.5-pro'))
    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveValue('gemini')
    expect(screen.getByLabelText('API 키')).toBeDisabled()
    expect(screen.queryByText(/새 API 키를 입력해 다시 연결/)).not.toBeInTheDocument()
    expect(screen.queryByText(/저장하면 AI가 켜집니다/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(await screen.findByText('AI connections are unavailable in this desktop build. Local analysis is still available.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save key' })).toBeDisabled()
  })

  it('reconciles a rejected save to the desktop block without caching the key or preventing OFF', async () => {
    const sentinel = 'SENTINEL-private-ai-key-desktop-rejection'
    const gate = deferred<void>()
    mutationGate = gate.promise
    const { client, snapshots } = renderWithInspectableCache()
    await waitFor(() => expect(screen.getByRole('button', { name: '키 저장' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('API 키'), { target: { value: sentinel } })
    fireEvent.click(screen.getByRole('button', { name: '키 저장' }))
    await waitFor(() => expect(requests.some((request) => request.method === 'PUT')).toBe(true))
    blockedReason = 'DESKTOP_AI_SAFETY_UNAVAILABLE'
    mutationFailure = { status: 503, detail: `DESKTOP_AI_SAFETY_UNAVAILABLE ${sentinel}` }
    await act(async () => { gate.resolve(undefined) })
    expect(await screen.findByText('이 데스크톱 빌드에서는 AI 연결을 사용할 수 없습니다. 로컬 분석은 계속 사용할 수 있습니다.')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('설정 변경을 확인하지 못했습니다')
    expect(screen.getByLabelText('API 키')).toHaveValue('')
    expect(screen.getByLabelText('API 키')).toBeDisabled()
    expect(screen.getByRole('button', { name: '키 저장' })).toBeDisabled()
    expectNoKeyInCache(client, snapshots, sentinel)
    mutationFailure = null
    const clear = screen.getByRole('button', { name: 'AI 끄기 및 키 제거' })
    await waitFor(() => expect(clear).toBeEnabled())
    fireEvent.click(clear)
    expect(await screen.findByText('AI 꺼짐')).toBeInTheDocument()
    expectNoKeyInCache(client, snapshots, sentinel)
  })

  it('disables backup and restore before runtime status and for explicit unavailable flags', async () => {
    const gate = deferred<RuntimeStatus>()
    const bridge = installDesktopBridge(() => gate.promise)
    renderWithInspectableCache()
    const backup = screen.getByRole('button', { name: '백업 생성' })
    const restore = screen.getByRole('button', { name: '백업 복원' })
    expect(backup).toBeDisabled()
    expect(restore).toBeDisabled()
    fireEvent.click(backup)
    fireEvent.click(restore)
    expect(bridge.backup).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '복원 확인' })).not.toBeInTheDocument()
    await act(async () => {
      gate.resolve({ ready: true, error: null, services: ['postgres'], backupAvailable: false, restoreAvailable: false })
    })
    expect(await screen.findByText('현재 백업 또는 복원을 사용할 수 없습니다. 계속하기 전에 아래 실행 상태와 오류를 확인하세요.')).toBeInTheDocument()
    expect(backup).toBeDisabled()
    expect(restore).toBeDisabled()
    fireEvent.click(backup)
    fireEvent.click(restore)
    expect(bridge.backup).not.toHaveBeenCalled()
    expect(bridge.restore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(await screen.findByText('Backup or restore is currently unavailable. Check the runtime status and error below before continuing.')).toBeInTheDocument()
  })

  it('disables an already open restore confirmation on runtime error and later blocked status', async () => {
    const bridge = installDesktopBridge(() => Promise.resolve({ ready: true, error: null, services: ['postgres'] }))
    const { client } = renderWithInspectableCache()
    const restore = screen.getByRole('button', { name: '백업 복원' })
    await waitFor(() => expect(restore).toBeEnabled())
    fireEvent.click(restore)
    const confirm = screen.getByRole('button', { name: '복원 확인' })
    expect(confirm).toBeEnabled()
    bridge.runtimeStatus.mockRejectedValueOnce(new Error('Synthetic runtime unavailable'))
    await act(async () => { await client.invalidateQueries({ queryKey: ['desktop-runtime'] }) })
    expect(client.getQueryState(['desktop-runtime'])?.status).toBe('error')
    await waitFor(() => expect(confirm).toBeDisabled())
    expect(restore).toBeDisabled()
    expect(screen.getByRole('button', { name: '백업 생성' })).toBeDisabled()
    fireEvent.click(confirm)
    expect(bridge.restore).not.toHaveBeenCalled()
    act(() => {
      client.setQueryData(['desktop-runtime'], { ready: true, error: null, services: ['postgres'], backupAvailable: false, restoreAvailable: false })
    })
    await screen.findByText('현재 백업 또는 복원을 사용할 수 없습니다. 계속하기 전에 아래 실행 상태와 오류를 확인하세요.')
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(bridge.restore).not.toHaveBeenCalled()
  })

  it('shows a translated incompatible notice, removes an old recovery path and refreshes runtime status', async () => {
    const bridge = installDesktopBridge(() => Promise.resolve({ ready: true, error: null, services: ['postgres'] }))
    renderWithInspectableCache()
    const restore = screen.getByRole('button', { name: '백업 복원' })
    await waitFor(() => expect(restore).toBeEnabled())
    fireEvent.click(restore)
    fireEvent.click(screen.getByRole('button', { name: '복원 확인' }))
    expect(await screen.findByText('/tmp/synthetic-recovery')).toBeInTheDocument()
    await waitFor(() => expect(restore).toBeEnabled())

    bridge.restore.mockResolvedValueOnce({ restored: false, code: 'BACKUP_INCOMPATIBLE' })
    fireEvent.click(restore)
    fireEvent.click(screen.getByRole('button', { name: '복원 확인' }))
    const notice = '현재 앱과 호환되지 않는 백업이라 복원을 시작하지 않았습니다. 기존 데이터와 백업 파일은 유지됩니다. 백업을 만든 앱 버전에서 열어 확인하세요.'
    expect(await screen.findByText(notice)).toHaveAttribute('role', 'alert')
    expect(screen.queryByText('/tmp/synthetic-recovery')).not.toBeInTheDocument()
    expect(screen.queryByText('Recovery 백업')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '복원 확인' })).not.toBeInTheDocument()
    await waitFor(() => expect(restore).toBeEnabled())
    expect(bridge.runtimeStatus).toHaveBeenCalledTimes(3)
    expect(bridge.restore).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(await screen.findByText('This backup is incompatible with the current app, so restoration did not start. Your existing data and backup file are preserved. Open the backup in the app version that created it to check it.')).toBeInTheDocument()
    expect(screen.queryByText('Recovery backup')).not.toBeInTheDocument()
  })

  it('refreshes runtime after a rejected restore and blocks controls while recovering without showing native error details', async () => {
    const ready = { ready: true, error: null, services: ['postgres'] }
    const refreshed = deferred<RuntimeStatus>()
    const bridge = installDesktopBridge(() => Promise.resolve(ready))
    bridge.runtimeStatus.mockImplementationOnce(() => Promise.resolve(ready)).mockImplementationOnce(() => refreshed.promise)
    bridge.restore.mockRejectedValueOnce(Object.assign(new Error('SENTINEL-private-native-restore-detail'), {
      code: 'BACKUP_RUNTIME_RECOVERY_REQUIRED', recoveryRequired: true,
    }))
    const { client } = renderWithInspectableCache()
    const restore = screen.getByRole('button', { name: '백업 복원' })
    const backup = screen.getByRole('button', { name: '백업 생성' })
    await waitFor(() => expect(restore).toBeEnabled())
    fireEvent.click(restore)
    fireEvent.click(screen.getByRole('button', { name: '복원 확인' }))
    await waitFor(() => expect(bridge.runtimeStatus).toHaveBeenCalledTimes(2))
    expect(restore).toBeDisabled()
    expect(backup).toBeDisabled()
    const unavailable = { ready: false, error: 'Backup or restore requires offline recovery.', services: ['postgres'], recoveryOnly: true,
      backupAvailable: false, restoreAvailable: false }
    await act(async () => { refreshed.resolve(unavailable) })
    expect(await screen.findByText('요청에 실패했습니다.')).toBeInTheDocument()
    expect(screen.getByText('준비되지 않음')).toBeInTheDocument()
    expect(client.getQueryData(['desktop-runtime'])).toEqual(unavailable)
    expect(restore).toBeDisabled()
    expect(backup).toBeDisabled()
    expect(document.body.textContent).not.toContain('SENTINEL-private-native-restore-detail')
    expect(screen.queryByText(/호환되지 않는 백업이라/)).not.toBeInTheDocument()
    expect(screen.queryByText('Recovery 백업')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-guidance')).toHaveTextContent('데이터가 이미 교체되었을 수 있으므로')
    expect(screen.getByRole('button', { name: 'Runtime 재시작' })).toBeDisabled()
    expect(bridge.restore).toHaveBeenCalledTimes(1)
  })

  it('distinguishes explicit unsupported builds from unavailable operations without claiming preserved data', async () => {
    const bridge = installDesktopBridge(() => Promise.resolve({ ready: true, error: null, services: [], backupSupported: false }))
    renderWithInspectableCache()
    expect(await screen.findByText('이 앱 빌드는 보호된 백업과 복원 기능을 지원하지 않습니다.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '백업 생성' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '백업 복원' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Runtime 재시작' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '백업 생성' }))
    expect(bridge.backup).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(await screen.findByText('This app build does not support protected backup and restore.')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('kept unchanged')
  })

  it('gives recovery guidance precedence over contradictory ready and supported flags in both languages', async () => {
    const bridge = installDesktopBridge(() => Promise.resolve({ ready: true, error: null, services: ['postgres'],
      recoveryOnly: true, backupSupported: false, backupAvailable: true, restoreAvailable: true }))
    renderWithInspectableCache()
    expect(await screen.findByTestId('runtime-guidance')).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId('runtime-guidance')).toHaveTextContent('백업·체크포인트·복구 파일을 삭제하지 마세요')
    expect(screen.getByTestId('runtime-guidance')).not.toHaveTextContent('지원하지 않습니다')
    for (const name of ['백업 생성', '백업 복원', 'Runtime 재시작']) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    expect(bridge.restartRuntime).not.toHaveBeenCalled()
    expect(bridge.backup).not.toHaveBeenCalled()
    expect(bridge.restore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(screen.getByTestId('runtime-guidance')).toHaveTextContent('Data may already have been replaced')
    expect(screen.getByTestId('runtime-guidance')).toHaveTextContent('Restart runtime does not perform this recovery')
    expect(document.body).not.toHaveTextContent('kept unchanged')
  })

  it('keeps known recovery guidance through a failed status refresh instead of clearing it with stale ready data', async () => {
    const bridge = installDesktopBridge(() => Promise.resolve({ ready: false, error: null, services: [], recoveryOnly: true }))
    const { client } = renderWithInspectableCache()
    await screen.findByTestId('runtime-guidance')
    bridge.runtimeStatus.mockRejectedValueOnce(new Error('status unavailable'))
    await act(async () => { await client.invalidateQueries({ queryKey: ['desktop-runtime'] }) })
    expect(screen.getByTestId('runtime-guidance')).toHaveTextContent('복구 검증이 필요합니다')
    expect(screen.getByRole('button', { name: 'Runtime 재시작' })).toBeDisabled()
  })

  it('never describes a loading or ordinary unready runtime as an unsupported build', async () => {
    const gate = deferred<RuntimeStatus>()
    installDesktopBridge(() => gate.promise)
    const { client } = renderWithInspectableCache()
    expect(screen.queryByTestId('runtime-guidance')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Runtime 재시작' })).toBeDisabled()
    await act(async () => { gate.resolve({ ready: false, error: null, services: [], backupSupported: true }) })
    expect(await screen.findByTestId('runtime-guidance')).toHaveTextContent('현재 백업 또는 복원을 사용할 수 없습니다')
    expect(document.body).not.toHaveTextContent('이 앱 빌드는 보호된 백업과 복원 기능을 지원하지 않습니다')
    act(() => { client.setQueryData(['desktop-runtime'], { ready: true, error: null, services: [], backupSupported: true }) })
    await waitFor(() => expect(screen.queryByTestId('runtime-guidance')).not.toBeInTheDocument())
  })

  it('refreshes status after backup failure, prevents a concurrent runtime restart, and reconciles to recovery', async () => {
    const gate = deferred<string | null>()
    const ready = { ready: true, error: null, services: [], backupSupported: true }
    const bridge = installDesktopBridge(() => Promise.resolve(ready))
    bridge.backup.mockImplementationOnce(() => gate.promise.then(() => { throw new Error('backup failed') }))
    renderWithInspectableCache()
    const backup = screen.getByRole('button', { name: '백업 생성' })
    await waitFor(() => expect(backup).toBeEnabled())
    fireEvent.click(backup)
    expect(await screen.findByTestId('runtime-guidance')).toHaveTextContent('실행 환경 작업이 진행 중입니다')
    const restart = screen.getByRole('button', { name: 'Runtime 재시작' })
    expect(restart).toBeDisabled()
    fireEvent.click(restart)
    expect(bridge.restartRuntime).not.toHaveBeenCalled()
    bridge.runtimeStatus.mockResolvedValueOnce({ ready: false, error: null, services: [], recoveryOnly: true })
    await act(async () => { gate.resolve(null) })
    await waitFor(() => expect(screen.getByTestId('runtime-guidance')).toHaveTextContent('복구 검증이 필요합니다'))
    expect(bridge.runtimeStatus).toHaveBeenCalledTimes(2)
    expect(restart).toBeDisabled()
  })

  it('hides an older incompatible preservation notice if later runtime state requires recovery', async () => {
    const bridge = installDesktopBridge(() => Promise.resolve({ ready: true, error: null, services: [] }))
    bridge.restore.mockResolvedValueOnce({ restored: false, code: 'BACKUP_INCOMPATIBLE' })
    const { client } = renderWithInspectableCache()
    const restore = screen.getByRole('button', { name: '백업 복원' })
    await waitFor(() => expect(restore).toBeEnabled())
    fireEvent.click(restore)
    fireEvent.click(screen.getByRole('button', { name: '복원 확인' }))
    await screen.findByText(/기존 데이터와 백업 파일은 유지됩니다/)
    act(() => { client.setQueryData(['desktop-runtime'], { ready: false, error: null, services: [], recoveryOnly: true }) })
    expect(await screen.findByTestId('runtime-guidance')).toHaveTextContent('복구 검증이 필요합니다')
    expect(screen.queryByText(/기존 데이터와 백업 파일은 유지됩니다/)).not.toBeInTheDocument()
  })

  it('clears the prior incompatible notice when a later native restore selection is canceled', async () => {
    const bridge = installDesktopBridge(() => Promise.resolve({ ready: true, error: null, services: ['postgres'] }))
    bridge.restore.mockResolvedValueOnce({ restored: false, code: 'BACKUP_INCOMPATIBLE' }).mockResolvedValueOnce(null)
    renderWithInspectableCache()
    const restore = screen.getByRole('button', { name: '백업 복원' })
    await waitFor(() => expect(restore).toBeEnabled())
    fireEvent.click(restore)
    fireEvent.click(screen.getByRole('button', { name: '복원 확인' }))
    await screen.findByText(/호환되지 않는 백업이라/)
    await waitFor(() => expect(restore).toBeEnabled())
    fireEvent.click(restore)
    fireEvent.click(screen.getByRole('button', { name: '복원 확인' }))
    await waitFor(() => expect(bridge.runtimeStatus).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(restore).toBeEnabled())
    expect(screen.queryByText(/호환되지 않는 백업이라/)).not.toBeInTheDocument()
    expect(screen.queryByText('Recovery 백업')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '복원 확인' })).not.toBeInTheDocument()
    expect(bridge.restore).toHaveBeenCalledTimes(2)
  })
})
