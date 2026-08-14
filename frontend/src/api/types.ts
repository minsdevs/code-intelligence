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

export type JobSummary = {
  id: number
  type: string
  status: JobStatus
  error: string | null
  createdAt: string | null
  startedAt: string | null
  finishedAt: string | null
}

export type ProjectSnapshotView = {
  id: number
  commitSha: string
  status: string
  analyzedAt: string | null
}

export type LatestCommit = {
  sha: string
  message: string
}

export type LatestPull = {
  number: number
  title: string
  state: string
  author: string
  mergedAt: string | null
}

export type Project = {
  id: number
  name: string
  repoOwner: string
  repoName: string
  defaultBranch: string
  currentSnapshot: ProjectSnapshotView | null
  latestJob: JobSummary | null
  selectedAreas: AreaType[]
  topTechnologies: string[]
  latestCommit: LatestCommit | null
  latestPull: LatestPull | null
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

export type CommitSummary = {
  sha: string
  author: string
  message: string
  committedAt: string | null
  additions: number
  deletions: number
}

export type CommitFile = {
  path: string
  changeType: string
}

export type CommitDetail = {
  sha: string
  author: string
  message: string
  committedAt: string | null
  additions: number
  deletions: number
  files: CommitFile[]
}

export type CommitDiff = {
  changeType: string
  oldContent: string | null
  newContent: string | null
}

export type GitRef = {
  name: string
  headSha: string
}

export type PullRequest = {
  number: number
  title: string
  body: string | null
  state: string
  author: string
  mergedAt: string | null
  headSha: string | null
  baseSha: string | null
}

export type FileListItem = {
  path: string
  language: string | null
  size: number
  lineCount: number | null
}

export type FileContent = {
  path: string
  language: string | null
  content: string
}

export type GraphNodeSummary = {
  id: number
  nodeType: string
  naturalKey: string
  name: string
  filePath: string | null
  lineStart: number | null
  lineEnd: number | null
  areaType: string | null
}

export type GraphNodePage = {
  items: GraphNodeSummary[]
  page: number
  size: number
  total: number
}

export type GraphEvidenceView = {
  filePath: string | null
  lineStart: number | null
  lineEnd: number | null
  excerpt: string | null
}

export type GraphNodeDetail = GraphNodeSummary & {
  metadata: Record<string, unknown>
  evidences: GraphEvidenceView[]
}

export type GraphRelation = {
  depth: number
  direction: string
  edgeType: string
  confidence: string
  node: GraphNodeSummary
}

export type GraphRelationsResponse = {
  nodeId: number
  direction: string
  depth: number
  relations: GraphRelation[]
}

export type ArchitectureNodeView = {
  id: number
  name: string
  nodeType: string
  filePath: string | null
  line: number | null
}

export type ArchitectureGroupView = {
  layer: string
  nodes: ArchitectureNodeView[]
}

export type ArchitectureEdgeView = {
  sourceGroup: string
  targetGroup: string
  sourceNodeId: number | null
  targetNodeId: number | null
  count: number
}

export type ArchitectureView = {
  area: 'BACKEND' | 'SYSTEM'
  groups: ArchitectureGroupView[]
  edges: ArchitectureEdgeView[]
}
