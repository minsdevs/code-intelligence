import { apiSend } from './client'
import type { IdeOpenRequest, IdeOpenResponse } from './types'

export function openInIde(projectId: number, body: IdeOpenRequest): Promise<IdeOpenResponse> {
  return apiSend<IdeOpenResponse>(`/api/projects/${projectId}/ide/open`, { method: 'POST', body })
}
