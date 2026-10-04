import { apiGet } from './client'
import type { FlowDetail, FlowSummary } from './types'

export function listFlows(
  projectId: number,
  kind?: string,
  snapshotId?: number | null,
): Promise<FlowSummary[]> {
  const params = new URLSearchParams()
  if (kind) params.set('kind', kind)
  if (snapshotId != null) params.set('snapshotId', String(snapshotId))
  const query = params.size ? `?${params}` : ''
  return apiGet<FlowSummary[]>(`/api/projects/${projectId}/flows${query}`)
}

export function getFlow(
  projectId: number,
  flowId: number,
  snapshotId?: number | null,
): Promise<FlowDetail> {
  return apiGet<FlowDetail>(
    `/api/projects/${projectId}/flows/${flowId}${snapshotId == null ? '' : `?snapshotId=${snapshotId}`}`,
  )
}
