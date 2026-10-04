import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import RepoStep from './RepoStep'
import { ApiError, UnauthorizedError } from '../../api/client'
import { listInstallations, listInstallationRepos, listRepos, listBranches } from '../../api/github'

vi.mock('../../api/github', () => ({
  listInstallations: vi.fn(),
  listInstallationRepos: vi.fn(),
  listRepos: vi.fn(),
  listBranches: vi.fn(),
}))
vi.mock('../../api/projects', () => ({ createProject: vi.fn() }))
const installs = {
  items: [
    {
      id: 81,
      accountLogin: 'team',
      appSlug: 'ci',
      repositorySelection: 'selected',
      suspended: false,
    },
    { id: 82, accountLogin: 'other', appSlug: 'ci', repositorySelection: 'all', suspended: false },
  ],
  page: 1,
  hasNext: true,
}
const repo = {
  owner: 'team',
  name: 'private-repo',
  fullName: 'team/private-repo',
  private: true,
  defaultBranch: 'main',
  description: null,
  updatedAt: '',
}
const onUnauthorized = vi.fn()
const show = (credentialKind: 'OAUTH' | 'PAT' = 'OAUTH') =>
  render(
    <RepoStep
      credentialKind={credentialKind}
      onImported={vi.fn()}
      onUnauthorized={onUnauthorized}
    />,
  )

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'codeIntelligenceDesktop', { configurable: true, value: {} })
  vi.mocked(listInstallations).mockResolvedValue(installs)
  vi.mocked(listInstallationRepos).mockResolvedValue({ items: [repo], page: 1, hasNext: true })
  vi.mocked(listRepos).mockResolvedValue({ items: [repo], page: 1, hasNext: false })
  vi.mocked(listBranches).mockResolvedValue({
    items: [{ name: 'main', commitSha: 'abc', protected: false }],
    page: 1,
    hasNext: false,
  })
})
afterEach(() => {
  cleanup()
  delete window.codeIntelligenceDesktop
})

describe('GitHub App installation repository selection', () => {
  it('waits for an explicit installation and scopes page/search requests without fanout', async () => {
    show()
    const select = await screen.findByRole('combobox', { name: '설치된 계정 · 조직' })
    expect(listInstallationRepos).not.toHaveBeenCalled()
    expect(listRepos).not.toHaveBeenCalled()
    fireEvent.change(select, { target: { value: '81' } })
    await screen.findByRole('option', { name: /team\/private-repo/ })
    expect(listInstallationRepos).toHaveBeenLastCalledWith(81, { page: 1, q: undefined })
    fireEvent.click(screen.getByRole('button', { name: /^(Next|다음)$/i }))
    await waitFor(() =>
      expect(listInstallationRepos).toHaveBeenLastCalledWith(81, { page: 2, q: undefined }),
    )
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'private' } })
    await waitFor(() =>
      expect(listInstallationRepos).toHaveBeenLastCalledWith(81, { page: 1, q: 'private' }),
    )
    fireEvent.change(select, { target: { value: '82' } })
    await waitFor(() =>
      expect(listInstallationRepos).toHaveBeenLastCalledWith(82, { page: 1, q: undefined }),
    )
    expect(listRepos).not.toHaveBeenCalled()
  })
  it('pages installation lists and clears the previous repository before another selection', async () => {
    show()
    fireEvent.change(await screen.findByRole('combobox', { name: '설치된 계정 · 조직' }), {
      target: { value: '81' },
    })
    await screen.findByRole('option', { name: /team\/private-repo/ })
    fireEvent.click(screen.getByRole('button', { name: '다음 설치 페이지' }))
    await waitFor(() => expect(listInstallations).toHaveBeenLastCalledWith(2))
    expect(screen.queryByRole('option', { name: /team\/private-repo/ })).not.toBeInTheDocument()
    expect(listInstallationRepos).toHaveBeenCalledTimes(1)
  })
  it('explains missing installation permissions without broadening repository access', async () => {
    vi.mocked(listInstallations).mockResolvedValue({ items: [], page: 1, hasNext: false })
    show()
    expect(await screen.findByText(/접근 가능한 설치가 없습니다/)).toBeInTheDocument()
    expect(listRepos).not.toHaveBeenCalled()
    expect(listInstallationRepos).not.toHaveBeenCalled()
  })
  it.each([403, 429])(
    'keeps installation errors actionable without fallback (%s)',
    async (status) => {
      vi.mocked(listInstallations).mockRejectedValue(new ApiError(status, 'upstream denied'))
      show()
      expect(await screen.findByRole('alert')).toHaveTextContent(
        status === 403 ? /설치와 저장소 선택 권한/ : /요청 한도/,
      )
      expect(listRepos).not.toHaveBeenCalled()
      expect(listInstallationRepos).not.toHaveBeenCalled()
    },
  )
  it('returns to connection when authentication expires', async () => {
    vi.mocked(listInstallations).mockRejectedValue(new UnauthorizedError())
    show()
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
    expect(listRepos).not.toHaveBeenCalled()
  })
  it('preserves the existing PAT repository path', async () => {
    show('PAT')
    await screen.findByRole('option', { name: /team\/private-repo/ })
    expect(listRepos).toHaveBeenCalled()
    expect(listInstallations).not.toHaveBeenCalled()
  })
  it('preserves browser OAuth repository behavior', async () => {
    delete window.codeIntelligenceDesktop
    show()
    await screen.findByRole('option', { name: /team\/private-repo/ })
    expect(listRepos).toHaveBeenCalled()
    expect(listInstallations).not.toHaveBeenCalled()
  })
})
