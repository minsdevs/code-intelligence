import { apiGet, apiSend } from './client'

export type AiSettingView = {
  provider: 'openai' | 'gemini' | null
  model: string | null
  keyMasked: string | null
  keySet: boolean
  state: 'ENABLED' | 'OFF' | 'RECONNECT_REQUIRED'
  /** Previously admitted requests; diagnostic only, not a budget or cancellation guarantee. */
  activeRequests: number
}

export type AiModelView = {
  id: string
  supportsStreaming: boolean
  supportsTools: boolean
  supportsReasoning: boolean
  supportsVision: boolean
  maxContextTokens: number
}

export function getAiSettings(): Promise<AiSettingView | null> {
  return apiGet<AiSettingView | null>('/api/ai/settings')
}

export function getAiModels(provider: string): Promise<AiModelView[]> {
  return apiGet<AiModelView[]>(`/api/ai/settings/models?provider=${encodeURIComponent(provider)}`)
}

export function saveAiSettings(provider: string, model: string, apiKey: string): Promise<AiSettingView> {
  return apiSend<AiSettingView>('/api/ai/settings', {
    method: 'PUT',
    body: { provider, model, apiKey },
  })
}

export function clearAiSettings(): Promise<AiSettingView> {
  return apiSend<AiSettingView>('/api/ai/settings', { method: 'DELETE' })
}
