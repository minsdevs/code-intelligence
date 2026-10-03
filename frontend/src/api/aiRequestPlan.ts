import { ApiError, apiSend } from './client'
import { isBudgetInteger } from './aiBudget'
import type { AiAskBody, AiRequestPlanResponse } from './types'

export async function createAiRequestPlan(
  projectId: number,
  body: Omit<AiAskBody, 'requestPlanToken'>,
): Promise<AiRequestPlanResponse> {
  const plan = await apiSend<AiRequestPlanResponse>(`/api/projects/${projectId}/ai/request-plan`, {
    method: 'POST', body, retryOnCsrfFailure: false,
  })
  // Incomplete confirmation content must never produce an actionable token in the UI.
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
  if (!plan || typeof plan.requestPlanToken !== 'string' || !plan.requestPlanToken
    || typeof plan.requestId !== 'string' || !plan.requestId
    || !isInstant(plan.expiresAt)
    || !Number.isSafeInteger(plan.snapshotId) || plan.snapshotId <= 0
    || typeof plan.provider !== 'string' || !plan.provider || typeof plan.model !== 'string' || !plan.model
    || typeof plan.intent !== 'string' || typeof plan.systemPrompt !== 'string' || typeof plan.userPrompt !== 'string'
    || typeof plan.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(plan.payloadSha256)
    || !validCost(plan) || !strings(plan.fileRefs) || !Array.isArray(plan.contextItems)
    || !plan.contextItems.every(item => item && typeof item.id === 'string' && typeof item.type === 'string'
      && typeof item.label === 'string' && Number.isSafeInteger(item.charCount) && item.charCount >= 0
      && typeof item.masked === 'boolean' && strings(item.fileRefs))) {
    throw new ApiError(502, 'AI request plan confirmation is incomplete.')
  }
  return plan
}

function validCost(plan: AiRequestPlanResponse): boolean {
  if (plan.costStatus === 'UNAVAILABLE') return plan.cost == null
  if (plan.costStatus !== 'AVAILABLE' || !plan.cost) return false
  const cost = plan.cost
  return isBudgetInteger(cost.reservedMicroUsd) && isBudgetInteger(cost.inputTokenUpperBound)
    && isBudgetInteger(cost.outputTokenMax) && isBudgetInteger(cost.policyRevision)
    && typeof cost.priceVersion === 'string' && cost.priceVersion.length > 0 && cost.priceVersion.length <= 200
    && isInstant(cost.validUntil)
}

function isInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19)
}
