import { apiGet } from './client'
import type { FlowDetail, FlowSummary } from './types'

export function listFlows(projectId: number, kind?: string): Promise<FlowSummary[]> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  return apiGet<FlowSummary[]>(`/api/projects/${projectId}/flows${query}`)
}

export function getFlow(projectId: number, flowId: number): Promise<FlowDetail> {
  return apiGet<FlowDetail>(`/api/projects/${projectId}/flows/${flowId}`)
}
