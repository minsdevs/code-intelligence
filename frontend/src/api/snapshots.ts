import { apiGet } from './client'
import type { SnapshotComparison, SnapshotOption } from './types'

export function listSnapshots(projectId: number): Promise<SnapshotOption[]> {
  return apiGet<SnapshotOption[]>(`/api/projects/${projectId}/snapshots`)
}

export function compareSnapshots(
  projectId: number,
  baseSnapshotId: number,
  targetSnapshotId: number,
): Promise<SnapshotComparison> {
  const params = new URLSearchParams({
    baseSnapshotId: String(baseSnapshotId),
    targetSnapshotId: String(targetSnapshotId),
  })
  return apiGet<SnapshotComparison>(`/api/projects/${projectId}/snapshots/compare?${params}`)
}
