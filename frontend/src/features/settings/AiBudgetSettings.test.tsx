import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AI_BUDGET_QUERY_KEY, type AiBudgetView } from '../../api/aiBudget'
import { I18nProvider } from '../../lib/i18n'
import AiBudgetSettings from './AiBudgetSettings'
import SettingsPage from './SettingsPage'

const MODEL = 'gpt-4o-mini-2024-07-18'
let view: AiBudgetView
let client: QueryClient
let readFailure: number | null
let mutationFailure: number | null
let gate: Promise<void> | null
let keySet: boolean
const fetchMock = vi.fn()
function path(input: RequestInfo | URL) {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname
}
function changes() { return fetchMock.mock.calls.filter(call => call[1]?.method === 'POST' || call[1]?.method === 'PUT') }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function renderBudget(content = <AiBudgetSettings />) {
  return render(<QueryClientProvider client={client}><I18nProvider>{content}</I18nProvider></QueryClientProvider>)
}
async function loaded() {
  const daily = await screen.findByLabelText('Daily limit (USD)')
  await waitFor(() => expect(daily).toBeEnabled())
  return { daily, monthly: screen.getByLabelText('Monthly limit (USD)') }
}
beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('code-intelligence.lang', 'en')
  delete window.codeIntelligenceDesktop
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } })
  view = { available: true, state: 'OFF', policyRevision: '7', dailyLimitMicroUsd: '0', monthlyLimitMicroUsd: '0',
    activationToken: 'synthetic-activation-7',
    allDatesHeldMicroUsd: '0', dailySettledMicroUsd: '0', monthlySettledMicroUsd: '0', supportedModels: [MODEL] }
  readFailure = null; mutationFailure = null; gate = null; keySet = true
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = path(input)
    const method = init?.method ?? 'GET'
    if (endpoint === '/api/csrf') return new Response(null, { status: 204 })
    if (endpoint === '/api/ai/budget' || endpoint === '/api/ai/budget/activate') {
      if (method === 'GET') return readFailure ? Response.json({ detail: 'Synthetic private server detail' }, { status: readFailure }) : Response.json(view)
      if (gate) await gate
      if (mutationFailure) return Response.json({ detail: 'Synthetic private server detail' }, { status: mutationFailure })
      const body = JSON.parse(init?.body as string)
      view = method === 'PUT'
        ? { ...view, state: 'RECOVERY_REQUIRED', policyRevision: (BigInt(body.expectedRevision) + 1n).toString(), activationToken: 'synthetic-activation-next', dailyLimitMicroUsd: body.dailyLimitMicroUsd, monthlyLimitMicroUsd: body.monthlyLimitMicroUsd }
        : { ...view, state: 'READY', activationToken: null }
      return Response.json(view)
    }
    // The real status endpoint reports key/provider metadata independently of main's budget latch.
    if (endpoint === '/api/ai/status') return Response.json({ configured: keySet, provider: 'openai', model: MODEL, blockedReason: null })
    if (endpoint === '/api/ai/settings') {
      if (method === 'PUT') { keySet = true; view = { ...view, state: 'OFF' } }
      return Response.json({ provider: 'openai', model: MODEL, keySet, keyMasked: keySet ? 'synt…key' : null, state: keySet ? 'ENABLED' : 'OFF', activeRequests: 0 })
    }
    if (endpoint === '/api/ai/settings/models') return Response.json([{ id: MODEL, supportsStreaming: false }])
    if (endpoint === '/api/auth/github/connection') return Response.json({ identityType: 'LOCAL', connected: false, oauthAvailable: false })
    return Response.json({ detail: 'Synthetic missing route' }, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { client.clear(); vi.unstubAllGlobals() })

describe('AiBudgetSettings', () => {
  it('starts with server zero limits and never activates on mount or refresh', async () => {
    renderBudget()
    const { daily, monthly } = await loaded()
    expect(daily).toHaveValue('0'); expect(monthly).toHaveValue('0')
    expect(await screen.findByText('Budget is off')).toBeInTheDocument()
    await act(async () => { await client.invalidateQueries({ queryKey: AI_BUDGET_QUERY_KEY }) })
    expect(changes()).toHaveLength(0)
  })

  it('saves exact six-place limits, stays unactivated and activates only the reviewed new revision', async () => {
    renderBudget()
    const { daily, monthly } = await loaded()
    fireEvent.change(daily, { target: { value: '0.000001' } })
    fireEvent.change(monthly, { target: { value: '9007199254.740993' } })
    expect(screen.getByRole('button', { name: 'Activate AI with these limits' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save limits and turn off' }))
    expect(await screen.findByText('Reconciliation needed')).toBeInTheDocument()
    expect(changes()).toHaveLength(1)
    expect(JSON.parse(changes()[0][1].body)).toEqual({ expectedRevision: '7', dailyLimitMicroUsd: '1', monthlyLimitMicroUsd: '9007199254740993' })
    const activate = screen.getByRole('button', { name: 'Activate AI with these limits' })
    await waitFor(() => expect(activate).toBeEnabled())
    fireEvent.click(activate)
    expect(await screen.findByText('Budget is active')).toBeInTheDocument()
    expect(JSON.parse(changes()[1][1].body)).toEqual({ expectedRevision: '8', activationToken: 'synthetic-activation-next' })
    expect(changes()).toHaveLength(2)
  })

  it('keeps pending actions and fields disabled and stops same-tick duplicates', async () => {
    const pending = deferred(); gate = pending.promise
    renderBudget()
    const { daily, monthly } = await loaded()
    const save = screen.getByRole('button', { name: 'Save limits and turn off' })
    const activate = screen.getByRole('button', { name: 'Activate AI with these limits' })
    act(() => { fireEvent.click(save); fireEvent.click(save); fireEvent.click(activate) })
    await waitFor(() => expect(changes()).toHaveLength(1))
    expect(daily).toBeDisabled(); expect(monthly).toBeDisabled(); expect(save).toBeDisabled(); expect(activate).toBeDisabled()
    await act(async () => { pending.resolve() })
    expect(await screen.findByText('Reconciliation needed')).toBeInTheDocument()
    expect(changes()).toHaveLength(1)
  })

  it('allows explicit reconciliation activation but keeps OFF after an unresolved recovery error', async () => {
    view.state = 'RECOVERY_REQUIRED'; mutationFailure = 503
    renderBudget(); await loaded()
    const activate = screen.getByRole('button', { name: 'Activate AI with these limits' })
    expect(activate).toBeEnabled()
    fireEvent.click(activate)
    expect(await screen.findByRole('alert')).toHaveTextContent('The change could not be confirmed')
    expect(await screen.findByText('Reconciliation needed')).toBeInTheDocument()
    expect(screen.queryByText('Budget is active')).not.toBeInTheDocument()
    expect(screen.queryByText('Synthetic private server detail')).not.toBeInTheDocument()
    expect(changes()).toHaveLength(1)
  })

  it('does not automatically retry a conflicting save or activate the refreshed revision', async () => {
    mutationFailure = 409
    renderBudget(); await loaded()
    view = { ...view, policyRevision: '8', dailyLimitMicroUsd: '1000001' }
    fireEvent.click(screen.getByRole('button', { name: 'Save limits and turn off' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('budget changed in another operation')
    await waitFor(() => expect(screen.getByLabelText('Daily limit (USD)')).toHaveValue('1.000001'))
    expect(changes()).toHaveLength(1)
    expect(JSON.parse(changes()[0][1].body).expectedRevision).toBe('7')
  })

  it('blocks unavailable controls even if form handlers are called directly', async () => {
    view = { ...view, available: false, activationToken: null }
    renderBudget()
    await screen.findByText('Spending limits and budget activation are unavailable in this connection.')
    const save = screen.getByRole('button', { name: 'Save limits and turn off' })
    expect(save).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Activate AI with these limits' })).toBeDisabled()
    fireEvent.submit(save.closest('form')!)
    expect(changes()).toHaveLength(0)
  })

  it('allows saving zero limits but cannot activate without an issued approval', async () => {
    view.activationToken = null
    renderBudget(); await loaded()
    expect(screen.getByRole('button', { name: 'Save limits and turn off' })).toBeEnabled()
    const activate = screen.getByRole('button', { name: 'Activate AI with these limits' })
    expect(activate).toBeDisabled(); fireEvent.click(activate)
    expect(changes()).toHaveLength(0)
  })

  it('uses an approval once and never retains it in mutation variables or replays it after failure', async () => {
    const token = view.activationToken!
    mutationFailure = 403
    renderBudget(); await loaded()
    const activate = screen.getByRole('button', { name: 'Activate AI with these limits' })
    act(() => { fireEvent.click(activate); fireEvent.click(activate) })
    await screen.findByRole('alert')
    await loaded()
    expect(activate).toBeDisabled()
    expect(changes()).toHaveLength(1)
    expect(JSON.parse(changes()[0][1].body)).toEqual({ expectedRevision: '7', activationToken: token })
    for (const mutation of client.getMutationCache().getAll()) {
      expect(JSON.stringify(mutation.state.variables)).not.toContain(token)
      expect(String(mutation.state.error)).not.toContain(token)
      expect(mutation.state.variables).toEqual({ action: 'activate', expectedRevision: '7' })
    }
    view = { ...view, activationToken: 'synthetic-fresh-activation' }
    mutationFailure = null
    fireEvent.click(screen.getByRole('button', { name: 'Refresh spending limits' }))
    await waitFor(() => expect(activate).toBeEnabled())
    expect(changes()).toHaveLength(1)
    fireEvent.click(activate)
    expect(await screen.findByText('Budget is active')).toBeInTheDocument()
    expect(changes()).toHaveLength(2)
    expect(JSON.parse(changes()[1][1].body).activationToken).toBe('synthetic-fresh-activation')
  })

  it('discards a private activation waiting in onMutate when the component unmounts', async () => {
    const pending = deferred()
    const { unmount } = renderBudget(); await loaded()
    const cancel = vi.spyOn(client, 'cancelQueries').mockImplementation(() => pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Activate AI with these limits' }))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ queryKey: AI_BUDGET_QUERY_KEY }))
    unmount()
    await act(async () => { pending.resolve() })
    await waitFor(() => expect(client.getMutationCache().getAll()[0].state.status).toBe('error'))
    expect(changes()).toHaveLength(0)
    cancel.mockRestore()
  })

  it('rejects an old activation token when a refreshed token arrives in the click tick', async () => {
    renderBudget(); await loaded()
    const activate = screen.getByRole('button', { name: 'Activate AI with these limits' })
    act(() => {
      client.setQueryData(AI_BUDGET_QUERY_KEY, { ...view, activationToken: 'synthetic-new-approval' })
      fireEvent.click(activate)
    })
    expect(changes()).toHaveLength(0)
  })

  it('blocks on a failed read and refreshes without sending any mutation', async () => {
    readFailure = 503
    renderBudget()
    await screen.findByText(/Current spending limits could not be read/)
    expect(screen.getByRole('button', { name: 'Activate AI with these limits' })).toBeDisabled()
    readFailure = null
    fireEvent.click(screen.getByRole('button', { name: 'Refresh spending limits' }))
    await loaded()
    expect(changes()).toHaveLength(0)
  })

  it('does not round invalid input and requires edits to be saved before activation', async () => {
    renderBudget(); const { daily } = await loaded()
    fireEvent.change(daily, { target: { value: '0.0000001' } })
    expect(screen.getByRole('alert')).toHaveTextContent('up to six decimal places')
    const save = screen.getByRole('button', { name: 'Save limits and turn off' })
    expect(save).toBeDisabled(); fireEvent.submit(save.closest('form')!)
    expect(changes()).toHaveLength(0)
  })

  it('shows all-date held liability separately from UTC settled totals with exact amounts', async () => {
    view = { ...view, allDatesHeldMicroUsd: '18446744073709551614', dailySettledMicroUsd: '1', monthlySettledMicroUsd: '2000001' }
    renderBudget(); await loaded()
    expect(screen.getByText('Held across all dates')).toBeInTheDocument()
    expect(screen.getByText('$18446744073709.551614')).toBeInTheDocument()
    expect(screen.getByText('$0.000001')).toBeInTheDocument()
    expect(screen.getByText('$2.000001')).toBeInTheDocument()
  })

  it('ignores a same-tick stale revision when the cache changes before submit', async () => {
    renderBudget(); await loaded()
    const save = screen.getByRole('button', { name: 'Save limits and turn off' })
    act(() => {
      client.setQueryData(AI_BUDGET_QUERY_KEY, { ...view, policyRevision: '8' })
      fireEvent.submit(save.closest('form')!)
    })
    expect(changes()).toHaveLength(0)
  })

  it('mounts in Settings and explains that key saving stays OFF until separate activation', async () => {
    keySet = false
    renderBudget(<SettingsPage />)
    const settings = await screen.findByRole('region', { name: 'AI Provider' })
    await loaded()
    expect(within(settings).getByText(/Saving stores the key and keeps AI off without contacting the provider/)).toBeInTheDocument()
    expect(within(settings).queryByRole('option', { name: 'gemini' })).not.toBeInTheDocument()
    fireEvent.change(within(settings).getByLabelText('API key'), { target: { value: 'synthetic-key-for-ui' } })
    const save = within(settings).getByRole('button', { name: 'Save key' })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)
    await screen.findByText('synt…key')
    expect(screen.getByText('Budget is off')).toBeInTheDocument()
    expect(changes().map(call => path(call[0]))).toEqual(['/api/ai/settings'])
    expect(screen.queryByText('Available')).not.toBeInTheDocument()
  })

  for (const state of ['OFF', 'RECOVERY_REQUIRED'] as const) {
    it(`M1 does not label stored credentials Available while the budget is ${state}`, async () => {
      view.state = state
      renderBudget(<SettingsPage />); await loaded()
      await screen.findByText('synt…key')
      expect(screen.queryByText('Available')).not.toBeInTheDocument()
      expect(changes()).toHaveLength(0)
    })
  }

  it('M1 does not label stored credentials Available after a failed budget read', async () => {
    readFailure = 503
    renderBudget(<SettingsPage />)
    await screen.findByText(/Current spending limits could not be read/)
    await screen.findByText('synt…key')
    expect(screen.queryByText('Available')).not.toBeInTheDocument()
    expect(changes()).toHaveLength(0)
  })

  it('M1 replaces a cached active budget with an unconfirmed label when its refresh fails', async () => {
    view.state = 'READY'
    renderBudget(<SettingsPage />); await loaded()
    await screen.findByText('Available')
    await screen.findByText('Budget is active')
    readFailure = 503
    await act(async () => { await client.invalidateQueries({ queryKey: AI_BUDGET_QUERY_KEY }) })
    await screen.findByText(/Current spending limits could not be read/)
    expect(screen.queryByText('Available')).not.toBeInTheDocument()
    expect(screen.queryByText('Budget is active')).not.toBeInTheDocument()
    expect(screen.getByText('Budget status unconfirmed')).toBeInTheDocument()
  })
})
