import { apiGet, apiSend } from './client'
import type {
  CreateProjectResponse,
  LocalPreviewOutcome,
  LocalSourcePreview,
  LocalSourceStatus,
  Project,
} from './types'

export function listProjects(): Promise<Project[]> {
  return apiGet<Project[]>('/api/projects')
}

export function getProject(projectId: number): Promise<Project> {
  return apiGet<Project>(`/api/projects/${projectId}`)
}

export function createProject(
  repoOwner: string,
  repoName: string,
  branch?: string,
): Promise<CreateProjectResponse> {
  return apiSend<CreateProjectResponse>('/api/projects', {
    method: 'POST',
    body: { repoOwner, repoName, branch },
  })
}

/** `grant` is the native-dialog folder grant; a configured server root needs none. */
export type LocalSelectionOptions = { name?: string; grant?: string }

export function previewLocalProject(
  path: string,
  { name, grant }: LocalSelectionOptions = {},
): Promise<LocalSourcePreview> {
  return apiSend<LocalSourcePreview>('/api/projects/local/preview', {
    method: 'POST',
    body: { path, name: name || undefined, grant },
    retryOnCsrfFailure: false,
  })
}

export function previewLocalRefresh(projectId: number): Promise<LocalSourcePreview> {
  return apiSend<LocalSourcePreview>(`/api/projects/${projectId}/local-preview`, {
    method: 'POST',
    body: {},
    retryOnCsrfFailure: false,
  })
}

/** Reconciles a consumed approval or atomically abandons it; never starts a job. */
export function getLocalPreviewOutcome(previewToken: string): Promise<LocalPreviewOutcome> {
  return apiSend<LocalPreviewOutcome>('/api/projects/local/preview-outcome', {
    method: 'POST',
    body: { previewToken },
  })
}

export function createLocalProject(
  path: string,
  previewToken: string,
  { name, grant }: LocalSelectionOptions = {},
): Promise<CreateProjectResponse> {
  return apiSend<CreateProjectResponse>('/api/projects/local', {
    method: 'POST',
    body: { path, name: name || undefined, previewToken, grant },
    retryOnCsrfFailure: false,
  })
}
export function deleteProject(projectId: number): Promise<void> {
  return apiSend(`/api/projects/${projectId}`, { method: 'DELETE' })
}
export function relinkLocalProject(projectId: number, path: string, grant: string): Promise<Project> {
  return apiSend<Project>(`/api/projects/${projectId}/local-source`, {
    method: 'PATCH',
    body: { path, grant },
  })
}

export function getLocalSourceStatus(projectId: number): Promise<LocalSourceStatus> {
  return apiGet<LocalSourceStatus>(`/api/projects/${projectId}/local-source-status`)
}

/** Starts a fresh job on an existing GitHub project; never resumes a failed checkpoint. */
export function reanalyzeGithubProject(projectId: number): Promise<{ jobId: number }> {
  return apiSend<{ jobId: number }>(`/api/projects/${projectId}/reanalyze`, {
    method: 'POST',
    retryOnCsrfFailure: false,
  })
}

export function reanalyzeLocalProject(
  projectId: number,
  previewToken: string,
): Promise<{ jobId: number }> {
  return apiSend<{ jobId: number }>(`/api/projects/${projectId}/reanalyze`, {
    method: 'POST',
    body: { previewToken },
    retryOnCsrfFailure: false,
  })
}
