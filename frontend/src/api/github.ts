import { apiGet } from './client'
import type { GithubRepoList } from './types'

export function listRepos(options: { page: number; perPage?: number; q?: string }): Promise<GithubRepoList> {
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
