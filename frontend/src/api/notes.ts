import { apiGet, apiSend } from './client'
import type { NoteSummary, NoteView } from './types'

export function listNotes(projectId: number): Promise<NoteSummary[]> {
  return apiGet<NoteSummary[]>(`/api/projects/${projectId}/notes`)
}

export function getNote(projectId: number, noteId: number): Promise<NoteView> {
  return apiGet<NoteView>(`/api/projects/${projectId}/notes/${noteId}`)
}

export function createNote(
  projectId: number,
  body: { title: string; contentMd: string },
): Promise<NoteView> {
  return apiSend<NoteView>(`/api/projects/${projectId}/notes`, { method: 'POST', body })
}

export function updateNote(
  projectId: number,
  noteId: number,
  body: { title: string; contentMd: string },
): Promise<NoteView> {
  return apiSend<NoteView>(`/api/projects/${projectId}/notes/${noteId}`, { method: 'PUT', body })
}

export function deleteNote(projectId: number, noteId: number): Promise<void> {
  return apiSend(`/api/projects/${projectId}/notes/${noteId}`, { method: 'DELETE' })
}
