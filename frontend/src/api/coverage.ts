import { apiGet } from './client'
import type { CoverageReport } from './types'

export function getCoverage(projectId: number, snapshotId?: number): Promise<CoverageReport> {
  return apiGet<CoverageReport>(`/api/projects/${projectId}/coverage${snapshotId == null ? '' : `?snapshotId=${snapshotId}`}`)
}
