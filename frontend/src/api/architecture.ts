import { apiGet } from './client'
import type { ArchitectureView } from './types'

export function getArchitecture(
  projectId: number,
  area: 'BACKEND' | 'FRONTEND' | 'SYSTEM',
): Promise<ArchitectureView> {
  return apiGet<ArchitectureView>(`/api/projects/${projectId}/architecture?area=${area}`)
}
