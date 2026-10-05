import type { ReactNode } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UnauthorizedError } from '../../api/client'
import { listBranches, listRepos } from '../../api/github'
import { cancelJob, getJob, retryJob } from '../../api/jobs'
import { createProject, getProject, listProjects, reanalyzeGithubProject } from '../../api/projects'
import type { JobDetail, Project } from '../../api/types'
import { renderWithRouter } from '../../test/renderWithRouter'
import GithubAnalysisStatus from '../projects/GithubAnalysisStatus'
import ProgressStep from './ProgressStep'
import RepoStep from './RepoStep'

vi.mock('../../api/jobs', () => ({
  getJob: vi.fn(), retryJob: vi.fn(), cancelJob: vi.fn(), subscribeJobEvents: vi.fn(),
}))
vi.mock('../../api/projects', () => ({
  createProject: vi.fn(), getProject: vi.fn(), listProjects: vi.fn(), reanalyzeGithubProject: vi.fn(),
}))
vi.mock('../../api/github', () => ({
  listBranches: vi.fn(), listRepos: vi.fn(), listInstallations: vi.fn(), listInstallationRepos: vi.fn(),
}))

const failed: JobDetail = {
  id: 42, projectId: 7, snapshotId: 9, type: 'IMPORT', status: 'FAILED', error: 'Analysis failed.',
  failureCode: null, createdAt: null, startedAt: null, finishedAt: null, steps: [],
}
const project: Project = {
  id: 7, name: 'repo', repoOwner: 'team', repoName: 'repo', defaultBranch: 'main',
  sourceType: 'GITHUB', sourceAddress: 'team/repo', currentSnapshot: null, latestJob: failed,
  selectedAreas: [], topTechnologies: [], latestCommit: null, latestPull: null, createdAt: '', updatedAt: '',
}
const clients: QueryClient[] = []

function showRoutes(component: ReactNode) {
  return renderWithRouter(
    <Routes>
      <Route path="/" element={component} />
      <Route path="/projects/7" element={<h1>기존 프로젝트 화면</h1>} />
      <Route path="/settings" element={<h1>계정 설정 화면</h1>} />
    </Routes>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  delete window.codeIntelligenceDesktop
  vi.mocked(getJob).mockResolvedValue(failed)
})
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear())
})

describe('recovery links navigate inside the application', () => {
  it.each([
    { status: 'FAILED', failureCode: 'LOCAL_PREVIEW_REQUIRED', label: '기존 프로젝트에서 새 미리보기' },
    { status: 'FAILED', failureCode: 'TS_SYNTAX_ERROR', label: '프로젝트로 돌아가기' },
    { status: 'FAILED', failureCode: 'RETRY_SOURCE_UNVERIFIED', label: '기존 프로젝트에서 새 분석' },
    { status: 'FAILED', failureCode: null, label: '기존 프로젝트에서 새 분석' },
    { status: 'CANCELLED', failureCode: null, label: '기존 프로젝트에서 새 분석' },
  ] as const)('opens the project for $status / $failureCode without a document reload', async ({ status, failureCode, label }) => {
    vi.mocked(getJob).mockResolvedValue({ ...failed, status, failureCode })
    showRoutes(<ProgressStep jobId={42} onDone={vi.fn()} onUnauthorized={vi.fn()} />)

    fireEvent.click(await screen.findByRole('link', { name: label }))

    expect(await screen.findByRole('heading', { name: '기존 프로젝트 화면' })).toBeInTheDocument()
    expect(retryJob).not.toHaveBeenCalled()
    expect(cancelJob).not.toHaveBeenCalled()
  })

  it('opens account settings inside the app after an authentication failure', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    vi.mocked(getProject).mockResolvedValue(project)
    vi.mocked(reanalyzeGithubProject).mockRejectedValue(new UnauthorizedError())
    showRoutes(<QueryClientProvider client={client}><GithubAnalysisStatus project={project} /></QueryClientProvider>)

    fireEvent.click(screen.getByRole('button', { name: '새 분석 시작' }))
    fireEvent.click(await screen.findByRole('link', { name: '계정 설정' }))

    expect(await screen.findByRole('heading', { name: '계정 설정 화면' })).toBeInTheDocument()
    expect(reanalyzeGithubProject).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('opens the existing project after a duplicate import without another import', async () => {
    const repo = {
      owner: 'team', name: 'repo', fullName: 'team/repo', defaultBranch: 'main',
      private: false, description: null, updatedAt: '',
    }
    vi.mocked(listRepos).mockResolvedValue({ items: [repo], page: 1, hasNext: false })
    vi.mocked(listBranches).mockResolvedValue({ items: [{ name: 'main', commitSha: 'abc', protected: false }], page: 1, hasNext: false })
    vi.mocked(createProject).mockRejectedValue(new ApiError(409, 'This repository is already imported.'))
    vi.mocked(listProjects).mockResolvedValue([project])
    showRoutes(<RepoStep credentialKind="PAT" onImported={vi.fn()} onUnauthorized={vi.fn()} />)
    fireEvent.click(await screen.findByRole('option', { name: 'team/repo' }))
    const start = screen.getByRole('button', { name: '저장소 가져오기' })
    await waitFor(() => expect(start).toBeEnabled())
    fireEvent.click(start)

    fireEvent.click(await screen.findByRole('link', { name: '기존 프로젝트에서 새 분석' }))

    expect(await screen.findByRole('heading', { name: '기존 프로젝트 화면' })).toBeInTheDocument()
    expect(createProject).toHaveBeenCalledOnce()
    expect(reanalyzeGithubProject).not.toHaveBeenCalled()
  })
})
