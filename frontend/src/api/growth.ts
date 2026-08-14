import { apiGet } from './client'
import type { GrowthView } from './types'

export function getGrowth(projectId: number): Promise<GrowthView> {
  return apiGet<GrowthView>(`/api/projects/${projectId}/growth`)
}
