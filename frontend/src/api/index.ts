export { ApiError, UnauthorizedError } from './client'
export { getMe, registerPat } from './auth'
export { listRepos } from './github'
export {
  createProject,
  createLocalProject,
  getProject,
  listProjects,
  getLocalSourceStatus,
  reanalyzeLocalProject,
} from './projects'
export { getJob, retryJob, subscribeJobEvents } from './jobs'
export { listAreas, updateAreaSelections } from './areas'
export {
  COMMIT_PAGE_SIZE,
  getCommit,
  getCommitDiff,
  listBranches,
  listCommits,
  listEras,
  listPulls,
  listTags,
} from './history'
export { getFileContent, listFiles } from './files'
export { getArchitecture } from './architecture'
export { listFeatures, getFeature } from './features'
export { listFlows, getFlow } from './flows'
export { listFindings, judgeFinding, getImpact, runWhatIf } from './analysis'
export { listSnapshots, compareSnapshots } from './snapshots'
export { GRAPH_NODE_PAGE_SIZE, getGraphNode, getGraphRelations, listGraphNodes } from './graph'
export { askAi, askAiStream, getAiStatus, parseEvidenceRef } from './ai'
export { listNotes, getNote, createNote, updateNote, deleteNote } from './notes'
export {
  listTasks,
  getTask,
  createTask,
  updateTask,
  approveTask,
  patchTaskGoal,
} from './tasks'
export { searchWorkspace } from './search'
export { getPullReview, generatePullReview } from './review'
export {
  listPlaygroundSessions,
  getPlaygroundSession,
  createPlaygroundSession,
  updatePlaygroundSession,
  deletePlaygroundSession,
  askPlayground,
} from './playground'
export { getCoverage } from './coverage'
export { openInIde } from './ide'
export { previewAiContext } from './aiPreview'
export { exportSummary } from './export'
export type {
  AreaSelection,
  AreaType,
  CommitDetail,
  CommitDiff,
  CommitSummary,
  CreateProjectResponse,
  EraView,
  FeatureChildView,
  FeatureDetailView,
  FileContent,
  FileListItem,
  FindingView,
  FindingJudgment,
  FindingJudgmentStatus,
  LocalSourceStatus,
  SnapshotOption,
  SnapshotComparison,
  FlowDetail,
  FlowSummary,
  GithubRepo,
  GraphNodeDetail,
  GraphNodePage,
  GraphNodeSummary,
  GraphRelation,
  GraphRelationsResponse,
  ArchitectureView,
  ImpactView,
  JobDetail,
  MeResponse,
  NoteView,
  Project,
  ProjectArea,
  PullRequest,
  SearchResponse,
  TaskView,
  ReviewView,
  PlaygroundSessionView,
  WhatIfView,
  CoverageReport,
  IdeOpenRequest,
  IdeOpenResponse,
  IdeType,
  ContextItem,
  AiPreviewResponse,
} from './types'
