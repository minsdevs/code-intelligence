import { apiGet } from './client'
import type { GithubBranchList, GithubRepoList } from './types'

export function listRepos(options: {
  page: number
  perPage?: number
  q?: string
}): Promise<GithubRepoList> {
  const params = new URLSearchParams({
    page: String(options.page),
    perPage: String(options.perPage ?? 30),
  })
  const query = options.q?.trim()
  if (query) {
    params.set('q', query)
  }
  return apiGet<GithubRepoList>(`/api/github/repos?${params}`)
}
export function listBranches(owner: string, repo: string): Promise<GithubBranchList> {
  return apiGet<GithubBranchList>(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
  )
}

export type GithubInstallation = {
  id: number
  accountLogin: string | null
  appSlug: string | null
  repositorySelection: string | null
  suspended: boolean
}
export type GithubInstallationList = { items: GithubInstallation[]; page: number; hasNext: boolean }

export function listInstallations(page: number): Promise<GithubInstallationList> {
  return apiGet(`/api/github/installations?page=${page}&perPage=30`)
}
export function listInstallationRepos(
  installationId: number,
  options: { page: number; q?: string },
): Promise<GithubRepoList> {
  const params = new URLSearchParams({ page: String(options.page), perPage: '30' })
  if (options.q?.trim()) params.set('q', options.q.trim())
  return apiGet(`/api/github/installations/${installationId}/repos?${params}`)
}
