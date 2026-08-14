import { apiGet, apiSend } from './client'
import type { PlaygroundSessionSummary, PlaygroundSessionView } from './types'

export function listPlaygroundSessions(projectId: number): Promise<PlaygroundSessionSummary[]> {
  return apiGet<PlaygroundSessionSummary[]>(`/api/projects/${projectId}/playground/sessions`)
}

export function getPlaygroundSession(
  projectId: number,
  sessionId: number,
): Promise<PlaygroundSessionView> {
  return apiGet<PlaygroundSessionView>(
    `/api/projects/${projectId}/playground/sessions/${sessionId}`,
  )
}

export function createPlaygroundSession(
  projectId: number,
  body: { title?: string; selectedPaths?: string[]; proposedSnippet?: string } = {},
): Promise<PlaygroundSessionView> {
  return apiSend<PlaygroundSessionView>(`/api/projects/${projectId}/playground/sessions`, {
    method: 'POST',
    body,
  })
}

export function updatePlaygroundSession(
  projectId: number,
  sessionId: number,
  body: { title?: string; selectedPaths?: string[]; proposedSnippet?: string },
): Promise<PlaygroundSessionView> {
  return apiSend<PlaygroundSessionView>(
    `/api/projects/${projectId}/playground/sessions/${sessionId}`,
    { method: 'PUT', body },
  )
}

export function deletePlaygroundSession(projectId: number, sessionId: number): Promise<void> {
  return apiSend(`/api/projects/${projectId}/playground/sessions/${sessionId}`, {
    method: 'DELETE',
  })
}

export function askPlayground(
  projectId: number,
  sessionId: number,
  body: { question: string; selectedPaths?: string[]; proposedSnippet?: string },
): Promise<PlaygroundSessionView> {
  return apiSend<PlaygroundSessionView>(
    `/api/projects/${projectId}/playground/sessions/${sessionId}/ask`,
    { method: 'POST', body },
  )
}
