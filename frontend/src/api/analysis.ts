import { apiGet, apiSend } from './client'
import type {
  FindingJudgment,
  FindingJudgmentStatus,
  FindingView,
  ImpactView,
  WhatIfView,
} from './types'

export function listFindings(
  projectId: number,
  severity?: string,
  includeHidden = false,
): Promise<FindingView[]> {
  const params = new URLSearchParams()
  if (severity) params.set('severity', severity)
  if (includeHidden) params.set('includeHidden', 'true')
  const query = params.size ? `?${params}` : ''
  return apiGet<FindingView[]>(`/api/projects/${projectId}/findings${query}`)
}

export function judgeFinding(
  projectId: number,
  findingId: number,
  status: FindingJudgmentStatus,
  reason: string,
): Promise<FindingJudgment> {
  return apiSend<FindingJudgment>(`/api/projects/${projectId}/findings/${findingId}/judgment`, {
    method: 'PUT',
    body: { status, reason },
  })
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
