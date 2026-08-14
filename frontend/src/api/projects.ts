import { apiSend } from './client'
import type { CreateProjectResponse } from './types'

export function createProject(repoOwner: string, repoName: string): Promise<CreateProjectResponse> {
  return apiSend<CreateProjectResponse>('/api/projects', {
    method: 'POST',
    body: { repoOwner, repoName },
  })
}
