import { apiGet, apiSend } from './client'
import type { AreaSelectionsRequest, ProjectArea } from './types'

export function listAreas(projectId: number): Promise<ProjectArea[]> {
  return apiGet<ProjectArea[]>(`/api/projects/${projectId}/areas`)
}

export function updateAreaSelections(projectId: number, body: AreaSelectionsRequest): Promise<void> {
  return apiSend(`/api/projects/${projectId}/area-selections`, { method: 'PUT', body })
}
