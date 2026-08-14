import { apiGet } from './client'
import type { FeatureChildView, FeatureDetailView } from './types'

export function listFeatures(projectId: number): Promise<FeatureChildView[]> {
  return apiGet<FeatureChildView[]>(`/api/projects/${projectId}/features`)
}

export function getFeature(projectId: number, featureId: number): Promise<FeatureDetailView> {
  return apiGet<FeatureDetailView>(`/api/projects/${projectId}/features/${featureId}`)
}
