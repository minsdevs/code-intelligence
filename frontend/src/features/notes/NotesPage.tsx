import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { createNote, deleteNote, getNote, listNotes, updateNote } from '../../api/notes'
import type { NoteView } from '../../api/types'
import EmptyState from '../../components/EmptyState'
import { parseProjectId } from '../../lib/projectId'
import { useUiStore } from '../../stores/uiStore'
import { queryError } from '../code/codeLocation'
import { noteRefHref, parseNoteRefs } from './noteRefs'

export default function NotesPage() {
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const queryClient = useQueryClient()
  const setFocusedNoteId = useUiStore((state) => state.setFocusedNoteId)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const creating = params.get('new') === '1'

  const listQuery = useQuery({
    queryKey: ['notes', projectId],
    queryFn: () => listNotes(projectId!),
    enabled: projectId != null,
  })
  const notes = listQuery.data ?? []
  const resolvedId = creating ? null : selectedId

  const detailQuery = useQuery({
    queryKey: ['note', projectId, resolvedId],
    queryFn: () => getNote(projectId!, resolvedId!),
    enabled: projectId != null && resolvedId != null,
  })

  useEffect(() => {
    setFocusedNoteId(resolvedId)
    return () => setFocusedNoteId(null)
  }, [resolvedId, setFocusedNoteId])

  const listError = queryError(listQuery.error)

  if (projectId == null) {
    return (
      <EmptyState title="Notes" description="import한 프로젝트에서 마크다운 노트를 작성합니다." />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold text-ink">Notes</h2>
          <button
            type="button"
            onClick={() => {
              setSelectedId(null)
              setParams({ new: '1' })
            }}
            className="rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-[12px] text-ink hover:bg-surface-3"
          >
            새 노트
          </button>
        </div>
        {listError && (
          <p role="alert" className="px-4 py-2 text-[12px] text-danger">
            {listError}
          </p>
        )}
        {listQuery.isLoading && (
          <p className="px-4 py-3 text-[13px] text-ink-muted">노트를 불러오는 중…</p>
        )}
        {!listQuery.isLoading && notes.length === 0 && !creating && (
          <p className="px-4 py-3 text-[13px] text-ink-muted">작성된 노트가 없습니다.</p>
        )}
        <ul className="min-h-0 flex-1 overflow-auto">
          {notes.map((note) => {
            const active = !creating && note.id === resolvedId
            return (
              <li key={note.id}>
                <button
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    setParams({})
                    setSelectedId(note.id)
                  }}
                  className={`w-full px-4 py-2 text-left ${active ? 'bg-surface-3' : 'hover:bg-surface-2'}`}
                >
                  <span className="block text-[13px] text-ink">{note.title}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
      <section className="flex min-w-0 flex-1 flex-col">
        {!creating && resolvedId == null ? (
          <p className="px-5 py-8 text-[13px] text-ink-muted">노트를 선택하거나 새로 작성하세요.</p>
        ) : creating ? (
          <NoteEditor
            key="new"
            projectId={projectId}
            note={null}
            onSaved={async (note) => {
              setParams({})
              setSelectedId(note.id)
              await queryClient.invalidateQueries({ queryKey: ['notes', projectId] })
              await queryClient.invalidateQueries({ queryKey: ['note', projectId, note.id] })
            }}
            onNavigate={(href) => navigate(href)}
          />
        ) : !detailQuery.data ? (
          <p className="px-5 py-8 text-[13px] text-ink-muted">노트를 불러오는 중…</p>
        ) : (
          <NoteEditor
            key={detailQuery.data.id}
            projectId={projectId}
            note={detailQuery.data}
            onSaved={async (note) => {
              await queryClient.invalidateQueries({ queryKey: ['notes', projectId] })
              await queryClient.invalidateQueries({ queryKey: ['note', projectId, note.id] })
            }}
            onDeleted={async () => {
              setSelectedId(null)
              await queryClient.invalidateQueries({ queryKey: ['notes', projectId] })
            }}
            onNavigate={(href) => navigate(href)}
          />
        )}
      </section>
    </div>
  )
}

function NoteEditor({
  projectId,
  note,
  onSaved,
  onDeleted,
  onNavigate,
}: {
  projectId: number
  note: NoteView | null
  onSaved: (note: NoteView) => Promise<void>
  onDeleted?: () => Promise<void>
  onNavigate: (href: string) => void
}) {
  const [title, setTitle] = useState(note?.title ?? '')
  const [contentMd, setContentMd] = useState(note?.contentMd ?? '')
  const refs = useMemo(() => parseNoteRefs(contentMd), [contentMd])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (note == null) return createNote(projectId, { title, contentMd })
      return updateNote(projectId, note.id, { title, contentMd })
    },
    onSuccess: (saved) => onSaved(saved),
  })
  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (note == null) throw new Error('missing note')
      return deleteNote(projectId, note.id)
    },
    onSuccess: () => onDeleted?.(),
  })
  const saveError = queryError(saveMutation.error)

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <input
          aria-label="노트 제목"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="제목"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-[13px] text-ink"
        />
        <button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={!title.trim() || saveMutation.isPending}
          className="rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[12px] text-ink disabled:opacity-60"
        >
          저장
        </button>
        {note != null && (
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            className="rounded-md border border-line px-3 py-1.5 text-[12px] text-danger"
          >
            삭제
          </button>
        )}
      </div>
      {saveError && (
        <p role="alert" className="px-4 py-2 text-[12px] text-danger">
          {saveError}
        </p>
      )}
      <textarea
        aria-label="노트 본문"
        value={contentMd}
        onChange={(event) => setContentMd(event.target.value)}
        placeholder="@file:src/App.java, @class#save, [[다른 노트]]"
        className="min-h-0 flex-1 resize-none bg-surface-0 px-4 py-3 font-mono text-[13px] text-ink outline-none"
      />
      {refs.length > 0 && (
        <ul aria-label="노트 참조" className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
          {refs.map((ref, index) => (
            <li key={`${ref.type}-${ref.rawTarget}-${index}`}>
              <button
                type="button"
                onClick={() => onNavigate(noteRefHref(projectId, ref))}
                className="rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-accent hover:underline"
              >
                {ref.type.toLowerCase()}:{ref.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
