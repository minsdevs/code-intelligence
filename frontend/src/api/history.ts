import { apiGet } from './client'
import type { CommitDetail, CommitDiff, CommitSummary, GitRef, PullRequest } from './types'

/** Matches backend HistoryService.PAGE_SIZE */
export const COMMIT_PAGE_SIZE = 50

export function listCommits(
  projectId: number,
  options: { page?: number; branch?: string } = {},
): Promise<CommitSummary[]> {
  const params = new URLSearchParams()
  if (options.page != null) {
    params.set('page', String(options.page))
  }
  if (options.branch) {
    params.set('branch', options.branch)
  }
  const query = params.toString()
  return apiGet<CommitSummary[]>(`/api/projects/${projectId}/commits${query ? `?${query}` : ''}`)
}

export function getCommit(projectId: number, sha: string): Promise<CommitDetail> {
  return apiGet<CommitDetail>(`/api/projects/${projectId}/commits/${encodeURIComponent(sha)}`)
}

export function getCommitDiff(projectId: number, sha: string, path: string): Promise<CommitDiff> {
  const params = new URLSearchParams({ path })
  return apiGet<CommitDiff>(
    `/api/projects/${projectId}/commits/${encodeURIComponent(sha)}/diff?${params.toString()}`,
  )
}

export function listBranches(projectId: number): Promise<GitRef[]> {
  return apiGet<GitRef[]>(`/api/projects/${projectId}/branches`)
}

export function listTags(projectId: number): Promise<GitRef[]> {
  return apiGet<GitRef[]>(`/api/projects/${projectId}/tags`)
}

export function listPulls(projectId: number, state?: string): Promise<PullRequest[]> {
  const query = state ? `?state=${encodeURIComponent(state)}` : ''
  return apiGet<PullRequest[]>(`/api/projects/${projectId}/pulls${query}`)
}
