import { apiGet } from './client'
import type { FileContent, FileListItem } from './types'

export function listFiles(projectId: number, snapshotId?: number | null): Promise<FileListItem[]> {
  const query = snapshotId == null ? '' : `?snapshotId=${snapshotId}`
  return apiGet<FileListItem[]>(`/api/projects/${projectId}/files${query}`)
}

export function getFileContent(
  projectId: number,
  path: string,
  snapshotId?: number | null,
  evidenceId?: number | null,
): Promise<FileContent> {
  const params = new URLSearchParams({ path })
  if (snapshotId != null) params.set('snapshotId', String(snapshotId))
  if (evidenceId != null) params.set('evidenceId', String(evidenceId))
  return apiGet<FileContent>(`/api/projects/${projectId}/file-content?${params}`)
}
