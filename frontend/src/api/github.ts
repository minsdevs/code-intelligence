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
