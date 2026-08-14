import { apiGet, apiSend } from './client'
import type { MeResponse } from './types'

export function getMe(): Promise<MeResponse> {
  return apiGet<MeResponse>('/api/auth/me')
}

export function registerPat(token: string): Promise<void> {
  return apiSend('/api/auth/pat', { method: 'POST', body: { token } })
}
