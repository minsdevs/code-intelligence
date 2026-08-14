import { apiGet, apiSend } from './client'
import type { FindingView, ImpactView, WhatIfView } from './types'

export function listFindings(projectId: number, severity?: string): Promise<FindingView[]> {
  const query = severity ? `?severity=${encodeURIComponent(severity)}` : ''
  return apiGet<FindingView[]>(`/api/projects/${projectId}/findings${query}`)
}

export function getImpact(projectId: number, nodeId: number, depth?: number): Promise<ImpactView> {
  const params = new URLSearchParams({ nodeId: String(nodeId) })
  if (depth != null) params.set('depth', String(depth))
  return apiGet<ImpactView>(`/api/projects/${projectId}/impact?${params.toString()}`)
}

export function runWhatIf(
  projectId: number,
  body: { nodeId: number; depth?: number },
): Promise<WhatIfView> {
  return apiSend<WhatIfView>(`/api/projects/${projectId}/what-if`, { method: 'POST', body })
}
