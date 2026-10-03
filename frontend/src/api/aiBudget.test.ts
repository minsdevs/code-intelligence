import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateAiBudget, dollarsToMicroUsd, getAiBudget, microUsdToDollars, saveAiBudget, type AiBudgetView } from './aiBudget'

const fetchMock = vi.fn()
const budget: AiBudgetView = {
  available: true, state: 'OFF', policyRevision: '7', activationToken: 'synthetic-activation-token', dailyLimitMicroUsd: '0', monthlyLimitMicroUsd: '0',
  allDatesHeldMicroUsd: '0', dailySettledMicroUsd: '0', monthlySettledMicroUsd: '0', supportedModels: ['gpt-4o-mini-2024-07-18'],
}
function path(input: RequestInfo | URL) {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname
}
function respond(value: unknown, status = 200) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => path(input) === '/api/csrf'
    ? new Response(null, { status: 204 }) : Response.json(value, { status }))
}
function changes() { return fetchMock.mock.calls.filter(call => call[1]?.method === 'POST' || call[1]?.method === 'PUT') }
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('exact dollar amounts', () => {
  it('round trips zero, six decimals, unsafe JS integers and the database bigint maximum exactly', () => {
    for (const [dollars, micro] of [
      ['0', '0'], ['0.000001', '1'], ['1.000001', '1000001'], ['9007199254.740993', '9007199254740993'],
      ['9223372036854.775807', '9223372036854775807'],
    ]) {
      expect(dollarsToMicroUsd(dollars)).toBe(micro)
      expect(microUsdToDollars(micro)).toBe(dollars)
    }
    expect(dollarsToMicroUsd('1.230000')).toBe('1230000')
    expect(microUsdToDollars('1230000')).toBe('1.23')
    expect(microUsdToDollars('18446744073709551614')).toBe('18446744073709.551614')
  })

  it('rejects negative, exponent, grouping, rounding, noncanonical and overflowing amounts', () => {
    for (const dollars of ['', '-0', '-1', '+1', '1e2', '1,000', '1.0000001', ' 1', '1 ', '1\n', '.5', '1.', '00', '01', 'NaN', 'Infinity', '9223372036854.775808']) {
      expect(dollarsToMicroUsd(dollars), dollars).toBeNull()
    }
    for (const micro of ['01', '-1', '1.1', '1e6', '1\n', '1'.repeat(129)]) expect(() => microUsdToDollars(micro)).toThrow()
  })
})

describe('AI budget wire contract', () => {
  it('reads strings without normalizing large aggregate balances or activating', async () => {
    const large = { ...budget, allDatesHeldMicroUsd: '18446744073709551614' }
    respond(large)
    await expect(getAiBudget()).resolves.toEqual(large)
    expect(changes()).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('posts the exact reviewed revision only on explicit activation and accepts the same authoritative view', async () => {
    respond({ ...budget, state: 'READY' })
    await expect(activateAiBudget('7', 'synthetic-activation-token')).resolves.toMatchObject({ state: 'READY', policyRevision: '7' })
    expect(changes()).toHaveLength(1)
    expect(path(changes()[0][0])).toBe('/api/ai/budget/activate')
    expect(JSON.parse(changes()[0][1].body)).toEqual({ expectedRevision: '7', activationToken: 'synthetic-activation-token' })
  })

  it('saves exact limits and accepts reconciliation state without claiming activation', async () => {
    const input = { expectedRevision: '7', dailyLimitMicroUsd: '9007199254740993', monthlyLimitMicroUsd: '9223372036854775807' }
    respond({ ...budget, ...input, policyRevision: '8', state: 'RECOVERY_REQUIRED' })
    await expect(saveAiBudget(input)).resolves.toMatchObject({ state: 'RECOVERY_REQUIRED', policyRevision: '8' })
    expect(changes()[0][1].method).toBe('PUT')
    expect(JSON.parse(changes()[0][1].body)).toEqual(input)
  })

  for (const field of ['policyRevision', 'dailyLimitMicroUsd', 'monthlyLimitMicroUsd', 'allDatesHeldMicroUsd', 'dailySettledMicroUsd', 'monthlySettledMicroUsd']) {
    it(`rejects lossy numeric ${field} in a status response`, async () => {
      respond({ ...budget, [field]: 9007199254740992 })
      await expect(getAiBudget()).rejects.toMatchObject({ status: 502 })
    })
  }

  it('rejects malformed status, unavailable READY, duplicate models and oversized values', async () => {
    for (const invalid of [
      null, { ...budget, state: 'ON' }, { ...budget, available: false, state: 'READY' },
      { ...budget, policyRevision: '01' }, { ...budget, dailyLimitMicroUsd: '9223372036854775808' },
      { ...budget, allDatesHeldMicroUsd: '1'.repeat(129) }, { ...budget, supportedModels: ['x', 'x'] },
      { ...budget, activationToken: undefined }, { ...budget, activationToken: '' },
    ]) {
      respond(invalid)
      await expect(getAiBudget()).rejects.toMatchObject({ status: 502 })
    }
  })

  it('rejects a save ACK that activates, loses exact limits, or does not advance revision', async () => {
    const input = { expectedRevision: '7', dailyLimitMicroUsd: '1', monthlyLimitMicroUsd: '2' }
    for (const invalid of [
      { state: 'READY', policyRevision: '8' }, { state: 'OFF', policyRevision: '7' },
      { state: 'OFF', policyRevision: '8', dailyLimitMicroUsd: '0' },
    ]) {
      respond({ ...budget, ...input, ...invalid })
      await expect(saveAiBudget(input)).rejects.toMatchObject({ status: 502 })
    }
  })

  it('rejects invalid outbound amounts before any CSRF or mutation request', async () => {
    await expect(saveAiBudget({ expectedRevision: '7', dailyLimitMicroUsd: '1e6', monthlyLimitMicroUsd: '0' })).rejects.toMatchObject({ status: 400 })
    await expect(activateAiBudget('01', 'synthetic-activation-token')).rejects.toMatchObject({ status: 400 })
    await expect(activateAiBudget('7', '')).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  for (const [name, call] of [
    ['save', () => saveAiBudget({ expectedRevision: '7', dailyLimitMicroUsd: '0', monthlyLimitMicroUsd: '0' })],
    ['activate', () => activateAiBudget('7', 'synthetic-activation-token')],
  ] as const) {
    it(`does not replay ${name} after a CSRF 403`, async () => {
      respond({ detail: 'Synthetic forbidden' }, 403)
      await expect(call()).rejects.toMatchObject({ status: 403 })
      expect(changes()).toHaveLength(1)
      expect(fetchMock.mock.calls.filter(call => path(call[0]) === '/api/csrf')).toHaveLength(1)
    })
  }
})
