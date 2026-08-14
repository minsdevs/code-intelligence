import { apiGet } from './client'
import type { FindingView, ImpactView } from './types'

export function listFindings(projectId: number, severity?: string): Promise<FindingView[]> {
  const query = severity ? `?severity=${encodeURIComponent(severity)}` : ''
  return apiGet<FindingView[]>(`/api/projects/${projectId}/findings${query}`)
}

export function getImpact(projectId: number, nodeId: number, depth?: number): Promise<ImpactView> {
  const params = new URLSearchParams({ nodeId: String(nodeId) })
  if (depth != null) params.set('depth', String(depth))
  return apiGet<ImpactView>(`/api/projects/${projectId}/impact?${params.toString()}`)
}
