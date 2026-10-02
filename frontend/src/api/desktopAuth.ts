import { apiGet, apiSend } from './client'

export type GithubConnection = {
  identityType: string
  connected: boolean
  githubId: number | null
  oauthAvailable: boolean
  githubRevocationUrl: string | null
}

export type NativeOAuthStatus =
  | 'WAITING'
  | 'CONNECTED'
  | 'CANCELLED'
  | 'DENIED'
  | 'EXPIRED'
  | 'CONFLICT'
  | 'FAILED'
  | 'INVALID'

export type NativeOAuthAttempt = {
  attemptId: string
  authorizationUrl?: string
  status?: NativeOAuthStatus
  message?: string
  expiresAt: string
}

export function getGithubConnection(): Promise<GithubConnection> {
  return apiGet<GithubConnection>('/api/auth/github/connection')
}

export function startNativeGithubOAuth(): Promise<NativeOAuthAttempt> {
  return apiSend<NativeOAuthAttempt>('/api/auth/github/native/start', { method: 'POST' })
}

export function getNativeGithubOAuthStatus(attemptId: string): Promise<NativeOAuthAttempt> {
  return apiGet<NativeOAuthAttempt>(
    `/api/auth/github/native/status/${encodeURIComponent(attemptId)}`,
  )
}

export function cancelNativeGithubOAuth(attemptId: string): Promise<NativeOAuthAttempt> {
  return apiSend<NativeOAuthAttempt>(
    `/api/auth/github/native/cancel/${encodeURIComponent(attemptId)}`,
    { method: 'POST' },
  )
}

export function disconnectGithub(): Promise<GithubConnection> {
  return apiSend<GithubConnection>('/api/auth/github/connection', { method: 'DELETE' })
}
