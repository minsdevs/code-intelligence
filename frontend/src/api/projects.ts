import { apiGet, apiSend } from './client'
import type { CreateProjectResponse, Project } from './types'

export function listProjects(): Promise<Project[]> {
  return apiGet<Project[]>('/api/projects')
}

export function getProject(projectId: number): Promise<Project> {
  return apiGet<Project>(`/api/projects/${projectId}`)
}

export function createProject(repoOwner: string, repoName: string): Promise<CreateProjectResponse> {
  return apiSend<CreateProjectResponse>('/api/projects', {
    method: 'POST',
    body: { repoOwner, repoName },
  })
}
