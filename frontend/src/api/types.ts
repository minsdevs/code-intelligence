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

export type JobStatus = 'QUEUED' | 'RUNNING' | 'CANCELLING' | 'DONE' | 'FAILED' | 'CANCELLED'

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
  /** Input recovery codes (e.g. LOCAL_PREVIEW_REQUIRED, TS_SYNTAX_ERROR) disable same-snapshot retry. */
  failureCode?: string | null
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

export type FileAnalysisStatus = 'LEGACY_UNMEASURED' | 'UNMEASURED' | 'TARGETED' | 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'UNSUPPORTED'

export type FileListItem = {
  analysisStatus?: FileAnalysisStatus
  analysisReason?: string | null
  analysisTargeted?: boolean
  resolvedSnapshotId?: number
  path: string
  language: string | null
  size: number
  lineCount: number | null
}

export type FileContent = {
  resolvedSnapshotId: number
  contentOid: string
  sourceState: 'AVAILABLE'
  snapshotTime: string | null
  currentSnapshot: boolean
  evidenceState: 'LEGACY_SOURCE_UNVERIFIED' | null
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
  resolvedSnapshotId?: number
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
  resolvedSnapshotId?: number
  metadata: Record<string, unknown>
  evidences: GraphEvidenceView[]
}

export type GraphRelation = {
  sourceNodeId?: number
  targetNodeId?: number
  depth: number
  direction: string
  edgeType: string
  confidence: string
  node: GraphNodeSummary
}

export type GraphRelationsResponse = {
  resolvedSnapshotId?: number
  truncated?: boolean
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
  evidenceId?: number
  snapshotId?: number
  sourceState?: 'LEGACY_SOURCE_UNVERIFIED' | 'SOURCE_CONTEXT_UNKNOWN'
  filePath: string | null
  lineStart: number | null
  lineEnd: number | null
  excerpt: string | null
}

export type FeatureDetailView = {
  resolvedSnapshotId?: number
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
  resolvedSnapshotId?: number
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
    | 'INSPECTION_FAILED'
    | 'NOT_LOCAL'
    | 'NO_SNAPSHOT'
  snapshotId: number | null
  changes: { added: number; modified: number; deleted: number; total: number }
  changedPaths: string[]
  fullAnalysisRequired: boolean
  message: string | null
}

/** Short-lived approval: keep only in component memory, never in URLs, storage, or query caches. */
export type LocalSourcePreview = {
  previewToken: string
  expiresAt: string
  operation: 'INITIAL' | 'REFRESH'
  sourceName: string
  snapshotId: number | null
  changes: LocalSourceStatus['changes']
  changedPaths: string[]
  localImport: LocalImportSummary
}

export type LocalPreviewOutcome =
  | { state: 'CONSUMED'; projectId: number; jobId: number }
  | { state: 'ABANDONED'; projectId: null; jobId: null }

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
  resolvedSnapshotId?: number
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
  blockedReason?: string | null
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
  requestPlanToken?: string
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

export type AiRequestPlanResponse = {
  requestPlanToken: string
  requestId: string
  expiresAt: string
  snapshotId: number
  provider: string
  model: string
  intent: string
  contextItems: Array<ContextItem & { fileRefs: string[] }>
  fileRefs: string[]
  systemPrompt: string
  userPrompt: string
  payloadSha256: string
  costStatus: 'UNAVAILABLE' | 'AVAILABLE'
  cost?: {
    reservedMicroUsd: string
    inputTokenUpperBound: string
    outputTokenMax: string
    priceVersion: string
    validUntil: string
    policyRevision: string
  } | null
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

export type TaskType = 'DEVELOPMENT' | 'REVIEW' | 'RESEARCH' | 'REFACTORING'

export type TaskStatus = 'DRAFT' | 'OPEN' | 'DONE' | 'CANCELLED'

export type TaskOrigin = 'USER' | 'AI'

export type TaskGoalView = {
  id: number
  seq: number
  content: string
  done: boolean
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

export type WhatIfView = {
  impact: ImpactView
  explanation: string
  claims: AiClaim[]
}

export type FileCoverage = {
  /** Missing on old responses; never substitute analyzedFiles for a measurement. */
  inventoriedFiles?: number
  /** @deprecated Inventory alias, not a complete discovery denominator. */
  discoveredFiles: number
  /** @deprecated Null for legacy snapshots without per-file outcomes. */
  analyzedFiles: number | null
  /** Recorded inventory omissions only; null means absent or ambiguous evidence. */
  skippedForCount: number | null
  skippedForSize: number | null
  skippedBinary: number | null
}

export type LanguageCoverage = {
  language: string
  inventoriedFiles?: number
  /** @deprecated Inventory alias; does not establish language support. */
  total: number
  /** @deprecated Null when per-file outcomes were not recorded. */
  analyzed: number | null
  /** @deprecated Null when per-file outcomes were not recorded. */
  skipped: number | null
  /** @deprecated Null when per-file outcomes were not recorded. */
  failed: number | null
}

export type ExcludedFolder = {
  path: string
  reason: string
}

export type AnalyzerStatusView = {
  name: string
  /** Persisted step status or unknown. Old active/disabled values are not historical evidence. */
  status: string
  failureReason: string | null
}

export type PartialResultInfo = {
  /** Missing on old responses also means unknown. Deprecated flags do not prove completeness. */
  status?: 'UNKNOWN'
  /** @deprecated Use status; false does not establish completeness. */
  featuresPartial: boolean
  /** @deprecated Use status; false does not establish completeness. */
  flowsPartial: boolean
  /** @deprecated Use status; false does not establish completeness. */
  graphPartial: boolean
  reason: string | null
}

export type LocalImportExclusionReason =
  | 'GENERATED_DIRECTORY'
  | 'SECRET_PATH'
  | 'IGNORED'
  | 'BINARY'
  | 'OVERSIZED'
  | 'FILE_LIMIT'
  | 'SYMLINK'
  | 'HARD_LINK'
  | 'SECRET_CONTENT'

/** Recorded import counts only. Excluded directories count once; descendants are unmeasured. */
export type LocalImportSummary = {
  schemaVersion: 1
  policyVersion: 'local-ingest-v1'
  acceptedFiles: number
  /** Bytes read during selection, including policy files; not stored-source size. */
  bytesRead: number
  excludedEntriesByReason: Partial<Record<LocalImportExclusionReason, number>>
}

export type CoverageOutcomes = {
  discoveredFiles: number
  targetedFiles: number
  successfulFiles: number
  partialFiles: number
  failedFiles: number
  excludedFiles: number
  unsupportedFiles: number
  unmeasuredFiles: number
  pendingFiles: number
  excludedSubmodules: number
}

export type CoverageReport = {
  snapshotId?: number | null
  outcomes?: CoverageOutcomes | null
  /** Missing on old responses must be treated as unmeasured. */
  measurementStatus?: 'LEGACY_UNMEASURED' | 'PER_FILE_RECORDED'
  /** Inventory and parser presence do not verify public capability support. */
  supportStatus?: 'UNVERIFIED'
  /** Missing, malformed, or conflicting import evidence remains unavailable, never inferred zero. */
  localImport?: LocalImportSummary | null
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

export type GraphOverview = {
  resolvedSnapshotId: number
  nodeCounts: Record<string, number>
  edgeCounts: Record<string, number>
}
