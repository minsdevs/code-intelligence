import { apiSend } from './client'
import type { AiAskBody, AiPreviewResponse } from './types'

export function previewAiContext(projectId: number, body: AiAskBody): Promise<AiPreviewResponse> {
  return apiSend<AiPreviewResponse>(`/api/projects/${projectId}/ai/preview`, { method: 'POST', body })
}
