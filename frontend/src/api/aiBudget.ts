import { ApiError, apiGet, apiSend } from './client'

export type AiBudgetView = {
  available: boolean
  state: 'OFF' | 'READY' | 'RECOVERY_REQUIRED'
  policyRevision: string
  activationToken: string | null
  dailyLimitMicroUsd: string
  monthlyLimitMicroUsd: string
  allDatesHeldMicroUsd: string
  dailySettledMicroUsd: string
  monthlySettledMicroUsd: string
  supportedModels: string[]
}

export type AiBudgetLimits = {
  expectedRevision: string
  dailyLimitMicroUsd: string
  monthlyLimitMicroUsd: string
}

const MAX_LONG = 9_223_372_036_854_775_807n
export const AI_BUDGET_QUERY_KEY = ['ai-budget'] as const
export const AI_BUDGET_MUTATION_KEY = ['ai-budget-change'] as const

/** Call only with a successfully read view; key/provider configuration is independent of readiness. */
export function budgetAllowsRequests(view: AiBudgetView | undefined, desktop: boolean): boolean {
  return Boolean(view && (view.available ? view.state === 'READY' : !desktop))
}

/** Aggregate amounts can exceed one database bigint; keep every digit on the wire. */
export function isCanonicalUnsigned(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^(0|[1-9][0-9]*)$/.test(value)
}

export function isBudgetInteger(value: unknown): value is string {
  return isCanonicalUnsigned(value) && value.length <= 19 && BigInt(value) <= MAX_LONG
}

function isActivationToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && [...value].every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) < 127)
}

/** No floating point, exponent, rounding, sign, or implicit nonzero default. */
export function dollarsToMicroUsd(value: string): string | null {
  if (value.length > 21 || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  return micro <= MAX_LONG ? micro.toString() : null
}

export function microUsdToDollars(value: string): string {
  if (!isCanonicalUnsigned(value)) throw new Error('Invalid dollar amount.')
  const padded = value.padStart(7, '0')
  const fraction = padded.slice(-6).replace(/0+$/, '')
  return padded.slice(0, -6) + (fraction ? `.${fraction}` : '')
}

function validateBudget(value: AiBudgetView): AiBudgetView {
  if (!value || typeof value.available !== 'boolean'
    || !['OFF', 'READY', 'RECOVERY_REQUIRED'].includes(value.state)
    || !isBudgetInteger(value.policyRevision) || !isBudgetInteger(value.dailyLimitMicroUsd)
    || !isBudgetInteger(value.monthlyLimitMicroUsd)
    || (value.activationToken !== null && !isActivationToken(value.activationToken))
    || !isCanonicalUnsigned(value.allDatesHeldMicroUsd) || !isCanonicalUnsigned(value.dailySettledMicroUsd)
    || !isCanonicalUnsigned(value.monthlySettledMicroUsd) || !Array.isArray(value.supportedModels)
    || !value.supportedModels.every(model => typeof model === 'string' && model.length > 0 && model.length <= 200)
    || new Set(value.supportedModels).size !== value.supportedModels.length
    || (!value.available && (value.state !== 'OFF' || value.activationToken !== null))) {
    throw new ApiError(502, 'AI budget status is incomplete.')
  }
  return value
}

export async function getAiBudget(): Promise<AiBudgetView> {
  return validateBudget(await apiGet<AiBudgetView>('/api/ai/budget'))
}

export async function saveAiBudget(input: AiBudgetLimits): Promise<AiBudgetView> {
  if (!isBudgetInteger(input.expectedRevision) || !isBudgetInteger(input.dailyLimitMicroUsd)
    || !isBudgetInteger(input.monthlyLimitMicroUsd)) throw new ApiError(400, 'Invalid AI budget limits.')
  const view = validateBudget(await apiSend<AiBudgetView>('/api/ai/budget', {
    method: 'PUT', body: input, retryOnCsrfFailure: false,
  }))
  // Saving limits never grants activation; inconsistent acknowledgments require a fresh read.
  if (!view.available || view.state === 'READY' || BigInt(view.policyRevision) <= BigInt(input.expectedRevision)
    || view.dailyLimitMicroUsd !== input.dailyLimitMicroUsd || view.monthlyLimitMicroUsd !== input.monthlyLimitMicroUsd) {
    throw new ApiError(502, 'AI budget change could not be confirmed.')
  }
  return view
}

export async function activateAiBudget(expectedRevision: string, activationToken: string): Promise<AiBudgetView> {
  if (!isBudgetInteger(expectedRevision) || !isActivationToken(activationToken)) throw new ApiError(400, 'Invalid AI budget approval.')
  const view = validateBudget(await apiSend<AiBudgetView>('/api/ai/budget/activate', {
    method: 'POST', body: { expectedRevision, activationToken }, retryOnCsrfFailure: false,
  }))
  if (!view.available || view.policyRevision !== expectedRevision) {
    throw new ApiError(502, 'AI budget activation could not be confirmed.')
  }
  return view
}
