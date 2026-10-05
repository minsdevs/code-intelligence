import type { JobStatus, Project } from '../../api/types'

export function isActiveJob(status: JobStatus | undefined): boolean {
  return status === 'QUEUED' || status === 'RUNNING' || status === 'CANCELLING'
}

/** A retained snapshot is not evidence that its worker is still running. */
export function isProjectAnalyzing(project: Project): boolean {
  return project.latestJob
    ? isActiveJob(project.latestJob.status)
    : project.currentSnapshot?.status === 'ANALYZING'
}

export function projectAnalysisStatus(project: Project): string {
  const job = project.latestJob?.status
  if (job === 'DONE' && project.currentSnapshot?.status === 'READY') return 'READY'
  return job ?? project.currentSnapshot?.status ?? 'NOT_ANALYZED'
}
