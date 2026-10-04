import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  cancelNativeGithubOAuth,
  pollNativeGithubOAuth,
  startNativeGithubOAuth,
  type NativeOAuthAttempt,
  type NativeOAuthStart,
} from '../../api/desktopAuth'
import type { MeResponse } from '../../api/types'
import type { DesktopBridge } from '../../desktop'
import ConnectStep from './ConnectStep'

vi.mock('../../api/desktopAuth', () => ({
  cancelNativeGithubOAuth: vi.fn(),
  pollNativeGithubOAuth: vi.fn(),
  startNativeGithubOAuth: vi.fn(),
}))

const previousBridge = window.codeIntelligenceDesktop
const me: MeResponse = {
  authenticated: true,
  login: 'local',
  name: 'Local',
  avatarUrl: null,
  credentialKind: 'LOCAL',
  oauthAvailable: true,
}
const start: NativeOAuthStart = {
  attemptId: '00000000-0000-0000-0000-000000000001',
  verificationUri: 'https://github.com/login/device',
  userCode: 'ABCD-EFGH',
  expiresAt: '2026-10-04T00:05:00Z',
  pollAfterSeconds: 5,
}

function status(value: NativeOAuthAttempt['status'], pollAfterSeconds = 0): NativeOAuthAttempt {
  return { attemptId: start.attemptId, status: value, message: value, expiresAt: start.expiresAt, pollAfterSeconds }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function mount() {
  const onConnected = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const view = render(<ConnectStep me={me} onConnected={onConnected} onLocalPath={vi.fn()} />)
  return { ...view, onConnected }
}
async function begin() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /GitHub/ })) })
}
async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-04T00:00:00Z'))
  window.codeIntelligenceDesktop = {
    appVersion: '0.1.0',
    platform: 'darwin',
    apiBaseUrl: 'https://127.0.0.1:41000',
    apiToken: 'synthetic',
    pickFolder: vi.fn(),
    authorizeDroppedFolder: vi.fn(),
    openExternal: vi.fn().mockResolvedValue(undefined),
    backup: vi.fn(),
    restore: vi.fn(),
    runtimeStatus: vi.fn(),
    restartRuntime: vi.fn(),
  } satisfies DesktopBridge
  vi.mocked(startNativeGithubOAuth).mockResolvedValue(start)
  vi.mocked(cancelNativeGithubOAuth).mockResolvedValue(status('CANCELLED'))
})

afterEach(() => {
  cleanup()
  window.codeIntelligenceDesktop = previousBridge
  vi.useRealTimers()
})

it('keeps the device code visible while obeying the initial and increased provider poll intervals', async () => {
  vi.mocked(pollNativeGithubOAuth)
    .mockResolvedValueOnce(status('WAITING', 20))
    .mockResolvedValueOnce(status('CONNECTED'))
  const { onConnected } = mount()
  await begin()
  expect(screen.getByLabelText('GitHub device code')).toHaveTextContent(start.userCode)
  await advance(4_999)
  expect(pollNativeGithubOAuth).not.toHaveBeenCalled()
  await advance(1)
  expect(pollNativeGithubOAuth).toHaveBeenCalledTimes(1)
  await advance(19_999)
  expect(pollNativeGithubOAuth).toHaveBeenCalledTimes(1)
  expect(onConnected).not.toHaveBeenCalled()
  await advance(1)
  expect(onConnected).toHaveBeenCalledOnce()
  expect(screen.queryByLabelText('GitHub device code')).not.toBeInTheDocument()
})

it('disables duplicate starts and cancels an attempt that arrives after the user cancelled startup', async () => {
  const pending = deferred<NativeOAuthStart>()
  vi.mocked(startNativeGithubOAuth).mockReturnValue(pending.promise)
  const { onConnected } = mount()
  const button = screen.getByRole('button', { name: /GitHub/ })
  await act(async () => { fireEvent.click(button) })
  expect(button).toBeDisabled()
  fireEvent.click(button)
  expect(startNativeGithubOAuth).toHaveBeenCalledTimes(1)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
  await act(async () => { pending.resolve(start) })
  expect(cancelNativeGithubOAuth).toHaveBeenCalledExactlyOnceWith(start.attemptId)
  await advance(30_000)
  expect(pollNativeGithubOAuth).not.toHaveBeenCalled()
  expect(onConnected).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('GitHub device code')).not.toBeInTheDocument()
})

it('discards a late connected poll result after an acknowledged cancellation', async () => {
  const pending = deferred<NativeOAuthAttempt>()
  vi.mocked(pollNativeGithubOAuth).mockReturnValue(pending.promise)
  const { onConnected } = mount()
  await begin()
  await advance(5_000)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
  await act(async () => { pending.resolve(status('CONNECTED')) })
  await advance(30_000)
  expect(onConnected).not.toHaveBeenCalled()
  expect(pollNativeGithubOAuth).toHaveBeenCalledTimes(1)
  expect(screen.queryByLabelText('GitHub device code')).not.toBeInTheDocument()
})

it('cancels the backend attempt and pending timer when leaving the import screen', async () => {
  const { unmount, onConnected } = mount()
  await begin()
  unmount()
  await advance(30_000)
  expect(cancelNativeGithubOAuth).toHaveBeenCalledExactlyOnceWith(start.attemptId)
  expect(pollNativeGithubOAuth).not.toHaveBeenCalled()
  expect(onConnected).not.toHaveBeenCalled()
})

it('refreshes an account committed before cancellation without handling the late poll result twice', async () => {
  const pending = deferred<NativeOAuthAttempt>()
  vi.mocked(pollNativeGithubOAuth).mockReturnValue(pending.promise)
  vi.mocked(cancelNativeGithubOAuth).mockResolvedValue(status('CONNECTED'))
  const { onConnected } = mount()
  await begin()
  await advance(5_000)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
  expect(onConnected).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve(status('CONNECTED')) })
  expect(onConnected).toHaveBeenCalledOnce()
})

it('does not surface a stale browser-launch failure over a new authorization attempt', async () => {
  let rejectLaunch!: (reason: Error) => void
  vi.mocked(window.codeIntelligenceDesktop!.openExternal).mockImplementationOnce(
    () => new Promise<void>((_resolve, reject) => { rejectLaunch = reject }),
  )
  mount()
  await begin()
  fireEvent.click(screen.getByRole('button', { name: 'Open GitHub verification' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
  await begin()
  await act(async () => { rejectLaunch(new Error('Previous browser launch failed')) })
  expect(screen.queryByText('Previous browser launch failed')).not.toBeInTheDocument()
  expect(screen.getByLabelText('GitHub device code')).toHaveTextContent(start.userCode)
})
