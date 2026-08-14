import { apiGet } from './client'
import type { SearchResponse } from './types'

export function searchWorkspace(q: string, projectId?: number): Promise<SearchResponse> {
  const params = new URLSearchParams({ q })
  if (projectId != null) params.set('projectId', String(projectId))
  return apiGet<SearchResponse>(`/api/search?${params.toString()}`)
}
