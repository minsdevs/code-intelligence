import { apiGet, apiSend } from './client'
import type { CreateProjectResponse, LocalSourceStatus, Project } from './types'

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

export function createLocalProject(path: string, name?: string): Promise<CreateProjectResponse> {
  return apiSend<CreateProjectResponse>('/api/projects/local', {
    method: 'POST',
    body: { path, name: name || undefined },
  })
}

export function getLocalSourceStatus(projectId: number): Promise<LocalSourceStatus> {
  return apiGet<LocalSourceStatus>(`/api/projects/${projectId}/local-source-status`)
}

export function reanalyzeLocalProject(
  projectId: number,
  status: LocalSourceStatus,
): Promise<{ jobId: number }> {
  return apiSend<{ jobId: number }>(`/api/projects/${projectId}/reanalyze`, {
    method: 'POST',
    body: {
      snapshotId: status.snapshotId,
      added: status.changes.added,
      modified: status.changes.modified,
      deleted: status.changes.deleted,
    },
  })
}
