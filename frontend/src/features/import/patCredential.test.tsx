import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { registerPat } from '../../api/auth'
import { ApiError } from '../../api/client'
import { I18nProvider } from '../../lib/i18n'
import ConnectStep from './ConnectStep'

vi.mock('../../api/auth', () => ({ registerPat: vi.fn() }))
const me = { authenticated: false, login: null, name: null, avatarUrl: null, credentialKind: null, oauthAvailable: false }
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); localStorage.setItem('code-intelligence.lang', 'en'); delete window.codeIntelligenceDesktop })

it('removes an entered PAT before awaiting and blocks a same-turn duplicate submission', async () => {
  let release!: () => void
  vi.mocked(registerPat).mockImplementation(() => new Promise<void>(done => { release = done }))
  const connected = vi.fn()
  render(<I18nProvider><ConnectStep me={me} onConnected={connected} onLocalPath={vi.fn()} /></I18nProvider>)
  const input = screen.getByLabelText('Personal access token')
  fireEvent.change(input, { target: { value: 'private-pat-sentinel' } })
  const form = input.closest('form')!
  act(() => { fireEvent.submit(form); fireEvent.submit(form) })
  await waitFor(() => expect(registerPat).toHaveBeenCalledOnce())
  expect(registerPat).toHaveBeenCalledWith('private-pat-sentinel')
  expect(input).toHaveValue(''); expect(input).toBeDisabled()
  await act(async () => { release() })
  expect(connected).toHaveBeenCalledOnce(); expect(input).toHaveValue('')
})

it('shows fixed failure copy rather than echoing a submitted token or upstream detail', async () => {
  vi.mocked(registerPat).mockRejectedValue(new ApiError(401, 'provider echoed private-pat-sentinel', 'GITHUB_REAUTHENTICATION_REQUIRED'))
  render(<I18nProvider><ConnectStep me={me} onConnected={vi.fn()} onLocalPath={vi.fn()} /></I18nProvider>)
  const input = screen.getByLabelText('Personal access token')
  fireEvent.change(input, { target: { value: 'private-pat-sentinel' } }); fireEvent.submit(input.closest('form')!)
  expect(await screen.findByRole('alert')).toHaveTextContent('GitHub rejected this credential')
  expect(document.body).not.toHaveTextContent('private-pat-sentinel')
  expect(input).toHaveValue(''); expect(input).toBeEnabled()
})

it('rejects oversized input even when programmatic input bypasses maxlength', async () => {
  render(<I18nProvider><ConnectStep me={me} onConnected={vi.fn()} onLocalPath={vi.fn()} /></I18nProvider>)
  const input = screen.getByLabelText('Personal access token'); expect(input).toHaveAttribute('maxlength', '4096')
  fireEvent.change(input, { target: { value: 'x'.repeat(4097) } }); fireEvent.submit(input.closest('form')!)
  expect(await screen.findByRole('alert')).toBeVisible(); expect(registerPat).not.toHaveBeenCalled()
})
