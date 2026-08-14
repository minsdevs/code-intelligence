import { apiGet, apiSend } from './client'
import type { ReviewView } from './types'

export function getPullReview(projectId: number, number: number): Promise<ReviewView> {
  return apiGet<ReviewView>(`/api/projects/${projectId}/pulls/${number}/review`)
}

export function generatePullReview(projectId: number, number: number): Promise<ReviewView> {
  return apiSend<ReviewView>(`/api/projects/${projectId}/pulls/${number}/review`, {
    method: 'POST',
  })
}
