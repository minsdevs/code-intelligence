import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import {
  askPlayground,
  createPlaygroundSession,
  listPlaygroundSessions,
} from '../../api/playground'
import { listFiles } from '../../api/files'
import { parseEvidenceRef } from '../../api/ai'
import { ApiError } from '../../api/client'
import EmptyState from '../../components/EmptyState'
import { useT } from '../../lib/i18n'
import { parseProjectId } from '../../lib/projectId'
import { codeLocationSearch, queryError } from '../code/codeLocation'

export default function PlaygroundPage() {
  const t = useT()
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [snippet, setSnippet] = useState('')
  const [question, setQuestion] = useState('')
  const [fileFilter, setFileFilter] = useState('')

  const sessionsQuery = useQuery({
    queryKey: ['playground-sessions', projectId],
    queryFn: () => listPlaygroundSessions(projectId!),
    enabled: projectId != null,
  })
  const filesQuery = useQuery({
    queryKey: ['files', projectId],
    queryFn: () => listFiles(projectId!),
    enabled: projectId != null,
  })

  const createMutation = useMutation({
    mutationFn: () =>
      createPlaygroundSession(projectId!, {
        title: selectedPaths[0] ?? 'Playground',
        selectedPaths,
        proposedSnippet: snippet,
      }),
    onSuccess: async (session) => {
      setSelectedId(session.id)
      await queryClient.invalidateQueries({ queryKey: ['playground-sessions', projectId] })
    },
  })

  const askMutation = useMutation({
    mutationFn: async () => {
      let sessionId = selectedId
      if (sessionId == null) {
        const created = await createPlaygroundSession(projectId!, {
          title: selectedPaths[0] ?? 'Playground',
          selectedPaths,
          proposedSnippet: snippet,
        })
        sessionId = created.id
        setSelectedId(sessionId)
      }
      return askPlayground(projectId!, sessionId, {
        question,
        selectedPaths,
        proposedSnippet: snippet,
      })
    },
    onSuccess: async () => {
      setQuestion('')
      await queryClient.invalidateQueries({ queryKey: ['playground-sessions', projectId] })
    },
  })

  if (projectId == null) {
    return <EmptyState title="Playground" description={t('playground.desc')} />
  }

  const sessions = sessionsQuery.data ?? []
  const files = filesQuery.data ?? []
  const filteredFiles =
    fileFilter.trim() === ''
      ? files
      : files.filter((file) => file.path.toLowerCase().includes(fileFilter.trim().toLowerCase()))
  const sessionError = queryError(sessionsQuery.error)
  const askError =
    askMutation.error instanceof ApiError && askMutation.error.status === 503
      ? t('playground.aiDisabled')
      : queryError(askMutation.error)
  const askAiDisabled = askMutation.error instanceof ApiError && askMutation.error.status === 503
  const result = askMutation.data

  function togglePath(path: string) {
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path],
    )
  }

  function onAsk(event: FormEvent) {
    event.preventDefault()
    if (question.trim() === '') return
    askMutation.mutate()
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex w-56 shrink-0 flex-col border-r border-line">
        <div className="flex items-center justify-between border-b border-line px-3 py-3">
          <h2 className="text-[13px] font-semibold text-ink">Sessions</h2>
          <button
            type="button"
            onClick={() => createMutation.mutate()}
            className="rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-[12px] text-ink hover:bg-surface-3"
          >
            {t('playground.new')}
          </button>
        </div>
        {sessionError && (
          <p role="alert" className="px-3 py-2 text-[12px] text-danger">
            {sessionError}
          </p>
        )}
        {sessionsQuery.isLoading && (
          <p className="px-3 py-3 text-[13px] text-ink-muted">{t('playground.loading')}</p>
        )}
        {!sessionsQuery.isLoading && sessions.length === 0 && (
          <p className="px-3 py-3 text-[13px] text-ink-muted">{t('playground.empty')}</p>
        )}
        <ul aria-label={t('playground.sessionsLabel')} className="min-h-0 flex-1 overflow-auto">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => setSelectedId(session.id)}
                aria-current={session.id === selectedId ? 'true' : undefined}
                className={`mb-0.5 w-full rounded-md px-3 py-1.5 text-left text-[13px] ${
                  session.id === selectedId
                    ? 'bg-surface-3 text-ink'
                    : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                }`}
              >
                {session.title}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex w-64 shrink-0 flex-col border-r border-line">
        <div className="border-b border-line px-3 py-3">
          <h2 className="text-[13px] font-semibold text-ink">Files</h2>
          <input
            value={fileFilter}
            onChange={(event) => setFileFilter(event.target.value)}
            placeholder={t('playground.filterPlaceholder')}
            aria-label={t('playground.filterLabel')}
            className="mt-2 w-full rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[12px] text-ink"
          />
        </div>
        <ul aria-label={t('playground.filesLabel')} className="min-h-0 flex-1 overflow-auto px-2 py-2">
          {filteredFiles.map((file) => (
            <li key={file.path}>
              <label className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-ink hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={selectedPaths.includes(file.path)}
                  onChange={() => togglePath(file.path)}
                />
                <span className="font-mono">{file.path}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <p className="border-b border-line px-4 py-2 text-[12px] text-ink-muted">
          {t('playground.hint')}
        </p>
        <form onSubmit={onAsk} className="border-b border-line px-4 py-3">
          <label className="block text-[12px] text-ink-muted">
            {t('playground.snippetLabel')}
            <textarea
              value={snippet}
              onChange={(event) => setSnippet(event.target.value)}
              aria-label={t('playground.snippetLabel')}
              rows={6}
              className="mt-1 w-full rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[12px] text-ink"
            />
          </label>
          <label className="mt-3 block text-[12px] text-ink-muted">
            {t('playground.questionLabel')}
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              aria-label={t('playground.questionLabel')}
              className="mt-1 w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-[13px] text-ink"
            />
          </label>
          <button
            type="submit"
            disabled={askMutation.isPending || question.trim() === ''}
            className="mt-3 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[12px] text-ink hover:bg-surface-3 disabled:opacity-60"
          >
            {t('playground.ask')}
          </button>
        </form>
        {askError && (
          <div role="alert" className="px-4 py-2 text-[12px] text-danger">
            <p>{askError}</p>
            {askAiDisabled && (
              <button
                type="button"
                onClick={() => navigate('/settings')}
                className="mt-1 text-accent hover:underline"
              >
                {t('ai.openSettings')}
              </button>
            )}
          </div>
        )}
        {result?.lastExplanation && (
          <div className="px-4 py-3">
            <p className="text-[13px] text-ink">{result.lastExplanation}</p>
            <ul aria-label="Playground claims" className="mt-3 space-y-2">
              {(result.lastClaims ?? []).map((claim, index) => (
                <li key={`${claim.text}-${index}`}>
                  <span className="font-mono text-[11px] text-ok">{claim.confidence}</span>
                  <p className="text-[13px] text-ink">{claim.text}</p>
                  {claim.evidence.map((ref) => {
                    const parsed = parseEvidenceRef(ref)
                    if (!parsed) return null
                    return (
                      <button
                        key={ref}
                        type="button"
                        onClick={() =>
                          navigate(
                            `/projects/${projectId}/code${codeLocationSearch(parsed.path, parsed.line)}`,
                          )
                        }
                        className="mr-2 font-mono text-[11px] text-accent hover:underline"
                      >
                        {parsed.path}:{parsed.line}
                      </button>
                    )
                  })}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}
