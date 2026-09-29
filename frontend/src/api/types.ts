/** Hand-written API types for Phase 1 Import Wizard. `npm run gen:api` writes generated.ts when the backend is up. */

export type CredentialKind = 'OAUTH' | 'PAT' | 'LOCAL'

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
export type GithubBranch = {
  name: string
  commitSha: string
  protected: boolean
}

export type GithubBranchList = {
  items: GithubBranch[]
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
  sourceAddress: string
  sourceType: 'GITHUB' | 'LOCAL'
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
  area: 'BACKEND' | 'FRONTEND' | 'SYSTEM'
  groups: ArchitectureGroupView[]
  edges: ArchitectureEdgeView[]
}

export type FeatureChildView = {
  id: number
  name: string
  detection: string
  confidence: number
  children: FeatureChildView[]
}

export type FeatureLinkView = {
  role: string
  nodeId: number
  name: string
  filePath: string | null
}

export type FeatureEvidenceView = {
  filePath: string | null
  lineStart: number | null
  lineEnd: number | null
  excerpt: string | null
}

export type FeatureDetailView = {
  id: number
  name: string
  detection: string
  confidence: number
  links: FeatureLinkView[]
  evidences: FeatureEvidenceView[]
}

export type FlowSummary = {
  id: number
  name: string
  kind: string
  entryNodeId: number | null
}

export type FlowStepView = {
  seq: number
  nodeId: number | null
  nodeName: string | null
  nodeType: string | null
  filePath: string | null
  line: number | null
  description: string | null
}

export type FlowDetail = {
  id: number
  name: string
  kind: string
  entryNodeId: number | null
  steps: FlowStepView[]
  evidences: FeatureEvidenceView[]
}

export type FindingJudgmentStatus = 'NEEDS_REVIEW' | 'ACCEPTED' | 'FALSE_POSITIVE' | 'RESOLVED'

export type FindingJudgment = {
  status: FindingJudgmentStatus
  reason: string
  judgedBy: number | null
  judgedAt: string | null
  needsReview: boolean
  hidden: boolean
}

export type FindingView = {
  id: number
  areaType: string | null
  category: string
  severity: string
  title: string
  detail: string | null
  status: string
  nodeId: number | null
  stableKey: string
  ruleId: string
  ruleVersion: string
  judgment: FindingJudgment
  evidences: FeatureEvidenceView[]
}

export type LocalSourceStatus = {
  state:
    | 'UP_TO_DATE'
    | 'CHANGED'
    | 'PATH_MISSING'
    | 'REAUTHORIZATION_REQUIRED'
    | 'NOT_LOCAL'
    | 'NO_SNAPSHOT'
  snapshotId: number | null
  changes: { added: number; modified: number; deleted: number; total: number }
  changedPaths: string[]
  fullAnalysisRequired: boolean
  message: string | null
}

export type SnapshotOption = {
  id: number
  commitSha: string
  status: string
  analyzedAt: string | null
}

export type SnapshotItemChange = {
  type: string
  key: string
  beforeName: string | null
  afterName: string | null
}

export type SnapshotCategoryChanges = {
  added: SnapshotItemChange[]
  removed: SnapshotItemChange[]
  changed: SnapshotItemChange[]
}

export type SnapshotComparison = {
  baseSnapshotId: number
  targetSnapshotId: number
  features: SnapshotCategoryChanges
  flows: SnapshotCategoryChanges
  findings: SnapshotCategoryChanges
  structure: { nodes: SnapshotCategoryChanges; relationships: SnapshotCategoryChanges }
  coverage: { before: CoverageReport; after: CoverageReport }
  renameCandidates: SnapshotItemChange[]
  regressionWarnings: string[]
}

export type ImpactNodeView = {
  depth: number
  edgeType: string
  nodeType: string
  nodeId: number
  name: string
  filePath: string | null
  line: number | null
}

export type ImpactView = {
  nodeId: number
  depth: number
  riskScore: number
  riskLevel: string
  dependents: ImpactNodeView[]
}

export type EraView = {
  label: string
  path: string
  sha: string
  committedAt: string | null
  changeType: string
}

export type AiStatus = {
  configured: boolean
  provider: string | null
  model: string | null
}

export type AiClaim = {
  text: string
  confidence: string
  evidence: string[]
}

export type AiAlternative = {
  name: string
  pros: string[]
  cons: string[]
  fitForThisProject: string
}

export type AiAskResponse = {
  conversationId: number
  messageId: number
  explanation: string
  claims: AiClaim[]
  alternatives: AiAlternative[]
}

export type AiAskBody = {
  conversationId?: number | null
  question: string
  intent?: string | null
  view?: string | null
  focusedFile?: string | null
  focusedNodeId?: number | null
  focusedCommitSha?: string | null
  focusedFindingId?: number | null
  focusedNoteId?: number | null
  focusedTaskId?: number | null
  selectedAreas?: string[]
  excludedContextIds?: string[]
}

export type NoteRefView = {
  subjectType: string
  subjectId: number | null
  rawTarget: string
  label: string | null
  hrefHint: string | null
}

export type NoteSummary = {
  id: number
  title: string
  updatedAt: string
}

export type NoteView = {
  id: number
  title: string
  contentMd: string
  updatedAt: string
  references: NoteRefView[]
}

export type TaskType = 'DEVELOPMENT' | 'LEARNING' | 'REVIEW' | 'RESEARCH' | 'REFACTORING'

export type TaskStatus = 'DRAFT' | 'OPEN' | 'DONE' | 'CANCELLED'

export type TaskOrigin = 'USER' | 'AI'

export type TaskGoalView = {
  id: number
  seq: number
  content: string
  done: boolean
}

export type LearningRecordView = {
  id: number
  note: string
  createdAt: string
}

export type TaskView = {
  id: number
  type: TaskType
  title: string
  description: string
  status: TaskStatus
  origin: TaskOrigin
  sourceFindingId: number | null
  updatedAt: string
  goals: TaskGoalView[]
  records: LearningRecordView[]
}

export type GeneratedTask = {
  id: number
  type: TaskType
  title: string
  description: string
  status: TaskStatus
  origin: TaskOrigin
  sourceFindingId: number | null
  goals: string[]
}

export type SearchHit = {
  type: string
  projectId: number
  id: number
  title: string
  snippet: string | null
  path: string | null
}

export type SearchGroup = {
  type: string
  hits: SearchHit[]
}

export type SearchResponse = {
  query: string
  groups: SearchGroup[]
}

export type ReviewComment = {
  id: number
  seq: number
  filePath: string | null
  line: number | null
  severity: string
  body: string
  confidence: string
  evidence: string[]
}

export type ReviewView = {
  id: number
  pullNumber: number
  summary: string
  origin: string
  createdAt: string
  comments: ReviewComment[]
}

export type PlaygroundSessionSummary = {
  id: number
  title: string
  updatedAt: string
}

export type PlaygroundSessionView = {
  id: number
  title: string
  selectedPaths: string[]
  proposedSnippet: string
  lastQuestion: string | null
  lastExplanation: string | null
  lastClaims: AiClaim[]
  updatedAt: string
}

export type GrowthTypeCounts = {
  type: string
  open: number
  done: number
  draft: number
  cancelled: number
}

export type GrowthWeeklyBucket = {
  weekStart: string
  learningRecords: number
  tasksDone: number
}

export type GrowthRecentRecord = {
  taskId: number
  taskTitle: string
  note: string
  createdAt: string
}

export type GrowthView = {
  notesCount: number
  learningRecords: number
  findingsOpen: number
  findingsDismissed: number
  tasksByType: GrowthTypeCounts[]
  weekly: GrowthWeeklyBucket[]
  recentRecords: GrowthRecentRecord[]
}

export type WhatIfView = {
  impact: ImpactView
  explanation: string
  claims: AiClaim[]
}

export type FileCoverage = {
  discoveredFiles: number
  analyzedFiles: number
  skippedForCount: number
  skippedForSize: number
  skippedBinary: number
}

export type LanguageCoverage = {
  language: string
  total: number
  analyzed: number
  skipped: number
  failed: number
}

export type ExcludedFolder = {
  path: string
  reason: string
}

export type AnalyzerStatusView = {
  name: string
  status: string
  failureReason: string | null
}

export type PartialResultInfo = {
  featuresPartial: boolean
  flowsPartial: boolean
  graphPartial: boolean
  reason: string | null
}

export type CoverageReport = {
  fileCoverage: FileCoverage
  languageCoverage: LanguageCoverage[]
  excludedFolders: ExcludedFolder[]
  analyzerStatuses: AnalyzerStatusView[]
  partialResults: PartialResultInfo
  retryableIssues: string[]
  unsupportedItems: string[]
}

// P1: IDE Open
export type IdeType = 'vscode' | 'cursor' | 'intellij' | 'webstorm'

export type IdeOpenRequest = {
  filePath: string
  line: number
  ide: IdeType
}

export type IdeOpenResponse = {
  uri: string
  commitMismatch: boolean
  snapshotCommit: string | null
  currentCommit: string | null
}

// P1: AI Preview
export type ContextItem = {
  id: string
  type: string
  label: string
  charCount: number
  masked: boolean
}

export type AiPreviewResponse = {
  contextItems: ContextItem[]
  fileRefs: string[]
  totalChars: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedCostUsd: number
  provider: string
  model: string
  maskedSecrets: number
  localOnly: boolean
  copyablePrompt: string
}
