import { apiGet } from './client'
import type { FeatureChildView, FeatureDetailView } from './types'

export function listFeatures(
  projectId: number,
  snapshotId?: number | null,
): Promise<FeatureChildView[]> {
  return apiGet<FeatureChildView[]>(
    `/api/projects/${projectId}/features${snapshotId == null ? '' : `?snapshotId=${snapshotId}`}`,
  )
}

export function getFeature(
  projectId: number,
  featureId: number,
  snapshotId?: number | null,
): Promise<FeatureDetailView> {
  return apiGet<FeatureDetailView>(
    `/api/projects/${projectId}/features/${featureId}${snapshotId == null ? '' : `?snapshotId=${snapshotId}`}`,
  )
}
