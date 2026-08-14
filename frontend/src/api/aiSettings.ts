import { apiGet, apiSend } from './client'

export type AiSettingView = {
  provider: 'openai' | 'gemini'
  keyMasked: string
  keySet: boolean
}

export function getAiSettings(): Promise<AiSettingView | null> {
  return apiGet<AiSettingView | null>('/api/ai/settings')
}

export function saveAiSettings(provider: string, apiKey: string): Promise<AiSettingView> {
  return apiSend<AiSettingView>('/api/ai/settings', {
    method: 'PUT',
    body: { provider, apiKey },
  })
}

export function clearAiSettings(): Promise<void> {
  return apiSend<void>('/api/ai/settings', { method: 'DELETE' })
}
