/** Hand-written API types for Phase 1 Import Wizard. `npm run gen:api` writes generated.ts when the backend is up. */

export type CredentialKind = 'OAUTH' | 'PAT'

export type MeResponse = {
  authenticated: boolean
  login: string | null
  name: string | null
  avatarUrl: string | null
  credentialKind: CredentialKind | null
  oauthAvailable: boolean
}

export type GithubRepo = {
  owner: string
  name: string
  fullName: string
  private: boolean
  defaultBranch: string
  description: string | null
  updatedAt: string | null
}

export type GithubRepoList = {
  items: GithubRepo[]
  page: number
  hasNext: boolean
}

export type JobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED'

export type StepStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED'

export type JobStep = {
  stepKey: string
  seq: number
  status: StepStatus
  progressPct: number | null
  attempt: number
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export type JobDetail = {
  id: number
  projectId: number
  snapshotId: number | null
  type: string
  status: JobStatus
  error: string | null
  createdAt: string | null
  startedAt: string | null
  finishedAt: string | null
  steps: JobStep[]
}

export type ProjectSnapshotView = {
  id: number
  commitSha: string
  status: string
  analyzedAt: string | null
}

export type Project = {
  id: number
  name: string
  repoOwner: string
  repoName: string
  defaultBranch: string
  currentSnapshot: ProjectSnapshotView | null
  latestJob: unknown
  createdAt: string
  updatedAt: string
}

export type CreateProjectResponse = {
  project: Project
  jobId: number
}

export type AreaType =
  | 'BACKEND'
  | 'FRONTEND'
  | 'MOBILE'
  | 'DATABASE'
  | 'INFRASTRUCTURE'
  | 'DEVOPS'
  | 'SECURITY'
  | 'TESTING'
  | 'AI_ML'
  | 'DOCUMENTATION'
  | 'BUILD_TOOLING'
  | 'OTHER'

export type AreaEvidence = {
  filePath: string
  line: number | null
  excerpt: string | null
}

export type ProjectArea = {
  areaType: AreaType
  confidence: number
  technologies: string[]
  evidences: AreaEvidence[]
  selected: boolean
}

export type AreaSelection = {
  areaType: AreaType
  selected: boolean
}

export type AreaSelectionsRequest = {
  selections: AreaSelection[]
}
