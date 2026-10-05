import { apiGet, apiSend } from './client'

export type GithubConnection = {
  identityType: string
  connected: boolean
  reauthenticationReason?: 'TOKEN_EXPIRED' | 'EXPIRY_UNKNOWN' | 'CREDENTIAL_MISSING' | 'TOKEN_REJECTED'
    | 'REFRESH_IN_PROGRESS' | 'REFRESH_UNCERTAIN' | 'REFRESH_EXPIRED' | 'CLIENT_CHANGED'
    | 'CONNECTION_CHANGED' | 'CREDENTIAL_INVALID' | null
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

export type NativeOAuthStart = {
  attemptId: string
  verificationUri: string
  userCode: string
  expiresAt: string
  pollAfterSeconds: number
}

export type NativeOAuthAttempt = {
  attemptId: string
  status: NativeOAuthStatus
  message: string
  expiresAt: string
  pollAfterSeconds: number
}

export function getGithubConnection(): Promise<GithubConnection> {
  return apiGet<GithubConnection>('/api/auth/github/connection')
}

export function startNativeGithubOAuth(): Promise<NativeOAuthStart> {
  return apiSend<NativeOAuthStart>('/api/auth/github/native/start', { method: 'POST' })
}

export function pollNativeGithubOAuth(attemptId: string): Promise<NativeOAuthAttempt> {
  return apiSend<NativeOAuthAttempt>(
    `/api/auth/github/native/poll/${encodeURIComponent(attemptId)}`,
    { method: 'POST' },
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
