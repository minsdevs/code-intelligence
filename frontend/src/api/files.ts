import { apiGet } from './client'
import type { FileContent, FileListItem } from './types'

export function listFiles(projectId: number): Promise<FileListItem[]> {
  return apiGet<FileListItem[]>(`/api/projects/${projectId}/files`)
}

export function getFileContent(projectId: number, path: string): Promise<FileContent> {
  const params = new URLSearchParams({ path })
  return apiGet<FileContent>(`/api/projects/${projectId}/file-content?${params.toString()}`)
}
