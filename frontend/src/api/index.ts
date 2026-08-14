export { ApiError, UnauthorizedError } from './client'
export { getMe, registerPat } from './auth'
export { listRepos } from './github'
export { createProject, getProject, listProjects } from './projects'
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
export { listFindings, getImpact } from './analysis'
export { GRAPH_NODE_PAGE_SIZE, getGraphNode, getGraphRelations, listGraphNodes } from './graph'
export { askAi, askAiStream, getAiStatus, parseEvidenceRef } from './ai'
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
  Project,
  ProjectArea,
  PullRequest,
} from './types'
