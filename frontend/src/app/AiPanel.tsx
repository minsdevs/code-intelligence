import { useMemo, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { askAiStream, getAiStatus, parseEvidenceRef } from '../api/ai'
import { previewAiContext } from '../api/aiPreview'
import { ApiError } from '../api/client'
import type { AiAlternative, AiAskBody, AiAskResponse, AiClaim, AiPreviewResponse } from '../api/types'
import { projectIdFromPath, workspaceViewFromPath } from '../lib/projectId'
import { useT } from '../lib/i18n'
import { useUiStore } from '../stores/uiStore'
import { PanelRightIcon, SparkleIcon } from '../components/icons'
import { codeLocationSearch } from '../features/code/codeLocation'

type ChatTurn = {
  question: string
  streamed: string
  response: AiAskResponse | null
  error: string | null
}

export default function AiPanel() {
  const t = useT()
  const open = useUiStore((state) => state.aiPanelOpen)
  const width = useUiStore((state) => state.aiPanelWidth)
  const toggle = useUiStore((state) => state.toggleAiPanel)
  const setWidth = useUiStore((state) => state.setAiPanelWidth)
  const focusedFile = useUiStore((state) => state.focusedFile)
  const focusedNode = useUiStore((state) => state.focusedNode)
  const focusedCommitSha = useUiStore((state) => state.focusedCommitSha)
  const focusedFindingId = useUiStore((state) => state.focusedFindingId)
  const focusedNoteId = useUiStore((state) => state.focusedNoteId)
  const focusedTaskId = useUiStore((state) => state.focusedTaskId)
  const selectedAreas = useUiStore((state) => state.selectedAreas)
  const pendingIntent = useUiStore((state) => state.pendingIntent)
  const setPendingIntent = useUiStore((state) => state.setPendingIntent)

  const location = useLocation()
  const navigate = useNavigate()
  const projectId = projectIdFromPath(location.pathname)
  const view = workspaceViewFromPath(location.pathname)

  const statusQuery = useQuery({
    queryKey: ['ai-status'],
    queryFn: getAiStatus,
    retry: false,
  })

  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [preview, setPreview] = useState<AiPreviewResponse | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [localDataOnly, setLocalDataOnly] = useState(false)
  const [excludedItems, setExcludedItems] = useState<Set<string>>(new Set())

  const chips = useMemo(() => {
    const items: string[] = []
    if (view) items.push(view)
    if (focusedFile) items.push(focusedFile)
    if (focusedNode) items.push(focusedNode.name)
    if (focusedCommitSha) items.push(focusedCommitSha.slice(0, 10))
    if (focusedFindingId != null) items.push(`finding #${focusedFindingId}`)
    if (focusedNoteId != null) items.push(`note #${focusedNoteId}`)
    if (focusedTaskId != null) items.push(`task #${focusedTaskId}`)
    for (const area of selectedAreas) items.push(area)
    return items
  }, [
    view,
    focusedFile,
    focusedNode,
    focusedCommitSha,
    focusedFindingId,
    focusedNoteId,
    focusedTaskId,
    selectedAreas,
  ])

  const quick = quickQuestions(view, t)
  const configured = statusQuery.data?.configured === true
  const canAsk = projectId != null && configured && !sending

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    setWidth(window.innerWidth - event.clientX)
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  async function submit(text: string, intent?: string | null) {
    const trimmed = text.trim()
    if (!trimmed || projectId == null || sending) return
    if (localDataOnly) {
      // Local data only mode: do not send any external AI request.
      // Show preview info only — no external API call is made.
      const turn: ChatTurn = { question: trimmed, streamed: '', response: null, error: 'Local data only mode is active. No external AI request was sent. Disable "Local data only" to ask AI questions.' }
      setTurns((prev) => [...prev, turn])
      return
    }
    const usedIntent = intent ?? pendingIntent
    setPendingIntent(null)
    setQuestion('')
    setSending(true)
    const body: AiAskBody = {
      conversationId,
      question: trimmed,
      intent: usedIntent,
      view,
      focusedFile,
      focusedNodeId: focusedNode?.id ?? null,
      focusedCommitSha,
      focusedFindingId,
      focusedNoteId,
      focusedTaskId,
      selectedAreas,
      excludedContextIds: excludedItems.size > 0 ? Array.from(excludedItems) : undefined,
    }
    const turn: ChatTurn = { question: trimmed, streamed: '', response: null, error: null }
    setTurns((prev) => [...prev, turn])
    const patchLast = (patch: Partial<ChatTurn>) => {
      setTurns((prev) =>
        prev.map((item, i) => (i === prev.length - 1 ? { ...item, ...patch } : item)),
      )
    }
    try {
      const response = await askAiStream(projectId, body, (token) => {
        setTurns((prev) =>
          prev.map((item, i) =>
            i === prev.length - 1 ? { ...item, streamed: item.streamed + token } : item,
          ),
        )
      })
      setConversationId(response.conversationId)
      patchLast({ response })
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t('ai.questionError')
      patchLast({ error: message })
    } finally {
      setSending(false)
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void submit(question)
  }

  async function onPreview() {
    const trimmed = question.trim()
    if (!trimmed || projectId == null || previewing) return
    setPreviewing(true)
    setPreview(null)
    const body: AiAskBody = {
      conversationId,
      question: trimmed,
      view,
      focusedFile,
      focusedNodeId: focusedNode?.id ?? null,
      focusedCommitSha,
      focusedFindingId,
      focusedNoteId,
      focusedTaskId,
      selectedAreas,
    }
    try {
      const result = await previewAiContext(projectId, body)
      setPreview(result)
    } catch {
      setPreview(null)
    } finally {
      setPreviewing(false)
    }
  }

  if (!open) {
    return (
      <aside
        aria-label={t('ai.panelLabel')}
        className="flex w-10 shrink-0 flex-col items-center gap-3 border-l border-line bg-surface-1 py-2"
      >
        <button
          type="button"
          aria-label={t('ai.panelOpen')}
          aria-expanded={false}
          onClick={toggle}
          className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <PanelRightIcon />
        </button>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint [writing-mode:vertical-rl]">
          AI Assistant
        </span>
      </aside>
    )
  }

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('ai.panelResize')}
        className="w-[3px] shrink-0 cursor-col-resize touch-none bg-line transition-colors hover:bg-accent/70 active:bg-accent"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
      <aside
        aria-label={t('ai.panelLabel')}
        style={{ width }}
        className="flex shrink-0 flex-col bg-surface-1"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line pl-4 pr-2">
          <div className="flex items-center gap-2">
            <SparkleIcon className="text-accent" />
            <span className="font-medium text-ink">AI Assistant</span>
          </div>
          <button
            type="button"
            aria-label={t('ai.panelClose')}
            aria-expanded={true}
            onClick={toggle}
            className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <PanelRightIcon />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            className="flex flex-wrap gap-1 border-b border-line px-3 py-2"
            aria-label={t('ai.context')}
          >
            {chips.length === 0 ? (
              <span className="text-[12px] text-ink-muted">{t('ai.noContext')}</span>
            ) : (
              chips.map((chip) => (
                <span
                  key={chip}
                  className="max-w-full truncate rounded-full border border-line-strong px-2 py-0.5 font-mono text-[11px] text-ink-muted"
                >
                  {chip}
                </span>
              ))
            )}
          </div>

          {quick.length > 0 && (
            <div
              className="flex flex-wrap gap-1 border-b border-line px-3 py-2"
              aria-label={t('ai.quick')}
            >
              {quick.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  disabled={!canAsk}
                  onClick={() => void submit(item.question, item.intent)}
                  className="rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-ink hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {statusQuery.isError && (
              <div className="text-[13px] text-danger">
                <p role="alert">{t('ai.statusError')}</p>
                <button
                  type="button"
                  onClick={() => void statusQuery.refetch()}
                  className="mt-2 rounded-md border border-line-strong px-2 py-1 text-[12px] text-ink hover:bg-surface-2"
                >
                  {t('ai.retryStatus')}
                </button>
              </div>
            )}
            {statusQuery.data && !configured && (
              <div className="text-[13px] text-ink-muted">
                <p>{t('ai.notConfigured')}</p>
                <Link
                  to="/settings"
                  className="mt-2 inline-block text-[12px] text-accent hover:underline"
                >
                  {t('ai.openSettings')}
                </Link>
              </div>
            )}
            {projectId == null && configured && (
              <p className="text-[13px] text-ink-muted">{t('ai.openProjectHint')}</p>
            )}
            {turns.length === 0 && configured && projectId != null && (
              <p className="text-[13px] text-ink-muted">{t('ai.askHint')}</p>
            )}
            {turns.map((turn, index) => (
              <article key={`${turn.question}-${index}`} className="mb-4">
                <p className="text-[13px] font-medium text-ink">{turn.question}</p>
                {turn.error && (
                  <p role="alert" className="mt-1 text-[12px] text-danger">
                    {turn.error}
                  </p>
                )}
                {!turn.response && !turn.error && (
                  <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-muted">
                    {turn.streamed || t('ai.generating')}
                  </p>
                )}
                {turn.response && (
                  <Answer
                    response={turn.response}
                    onOpen={(path, line) => {
                      if (projectId == null) return
                      navigate(`/projects/${projectId}/code${codeLocationSearch(path, line)}`)
                    }}
                  />
                )}
              </article>
            ))}
          </div>
        </div>

        <form onSubmit={onSubmit} className="shrink-0 border-t border-line p-3">
          {preview && (
            <div className="mb-2 rounded-md border border-line bg-surface-2 p-2 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink">Context Preview</span>
                <button type="button" onClick={() => { setPreview(null); setExcludedItems(new Set()) }} className="text-ink-muted hover:text-ink">✕</button>
              </div>
              <div className="mt-1 space-y-0.5 text-ink-muted">
                <p>Provider: {preview.provider} / {preview.model}</p>
                <p>Input tokens: ~{preview.estimatedInputTokens.toLocaleString()} · Output: ~{preview.estimatedOutputTokens.toLocaleString()}</p>
                <p>Est. cost: ${preview.estimatedCostUsd.toFixed(5)}</p>
                <p>Masked secrets: {preview.maskedSecrets} · Files: {preview.fileRefs.length}</p>
                {localDataOnly ? (
                  <p className="text-warn">🔒 Local data only — AI request will be blocked</p>
                ) : (
                  <p className="text-ok">✓ Preview only — no external request yet</p>
                )}
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-ink-muted hover:text-ink">Context items ({preview.contextItems.length - excludedItems.size} / {preview.contextItems.length} included)</summary>
                <ul className="mt-1 max-h-24 overflow-y-auto space-y-0.5">
                  {preview.contextItems.map((item) => (
                    <li key={item.id} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!excludedItems.has(item.id)}
                        onChange={() => {
                          setExcludedItems(prev => {
                            const next = new Set(prev)
                            if (next.has(item.id)) next.delete(item.id)
                            else next.add(item.id)
                            return next
                          })
                        }}
                        className="h-3 w-3 rounded"
                        aria-label={`Include ${item.type}: ${item.label}`}
                      />
                      <span className={`rounded bg-surface-3 px-1 text-[10px] font-mono ${excludedItems.has(item.id) ? 'opacity-40 line-through' : ''}`}>{item.type}</span>
                      <span className={`truncate ${excludedItems.has(item.id) ? 'opacity-40 line-through' : ''}`}>{item.label}</span>
                      <span className="ml-auto text-ink-faint">{item.charCount}c</span>
                      {item.masked && <span className="text-warn">🔒</span>}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
          <div className="mb-2 flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={localDataOnly}
                onChange={(e) => setLocalDataOnly(e.target.checked)}
                className="h-3 w-3 rounded"
              />
              Local data only (no external AI)
            </label>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              disabled={!canAsk}
              aria-label={t('ai.inputLabel')}
              placeholder={configured ? t('ai.placeholder') : t('ai.placeholderDisabled')}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-3 py-1.5 text-ink placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void onPreview()}
              disabled={!canAsk || question.trim().length === 0 || previewing}
              className="rounded-md border border-line-strong bg-surface-2 px-2 py-1.5 text-[12px] text-ink-muted disabled:cursor-not-allowed disabled:opacity-60"
              title="Preview what will be sent"
            >
              {previewing ? '...' : '👁'}
            </button>
            <button
              type="submit"
              disabled={!canAsk || question.trim().length === 0}
              className="rounded-md border border-line-strong bg-surface-3 px-3 py-1.5 text-ink disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
            >
              {t('ai.send')}
            </button>
          </div>
        </form>
      </aside>
    </>
  )
}

function Answer({
  response,
  onOpen,
}: {
  response: AiAskResponse
  onOpen: (path: string, line: number | null) => void
}) {
  return (
    <div className="mt-1">
      <p className="whitespace-pre-wrap text-[13px] text-ink">{response.explanation}</p>
      {response.claims.map((claim, index) => (
        <ClaimBlock key={`${claim.text}-${index}`} claim={claim} onOpen={onOpen} />
      ))}
      {response.alternatives.map((alt) => (
        <AlternativeBlock key={alt.name} alternative={alt} />
      ))}
    </div>
  )
}

function ClaimBlock({
  claim,
  onOpen,
}: {
  claim: AiClaim
  onOpen: (path: string, line: number | null) => void
}) {
  return (
    <div className="mt-2 rounded-md border border-line bg-surface-2 px-2 py-1.5">
      <p className="text-[13px] text-ink">{claim.text}</p>
      <p className={`mt-0.5 font-mono text-[11px] ${confidenceClass(claim.confidence)}`}>
        {claim.confidence}
      </p>
      <ul className="mt-1 space-y-0.5">
        {claim.evidence.map((ref) => {
          const parsed = parseEvidenceRef(ref)
          if (!parsed) {
            return (
              <li key={ref} className="font-mono text-[11px] text-ink-faint">
                {ref}
              </li>
            )
          }
          return (
            <li key={ref}>
              <button
                type="button"
                onClick={() => onOpen(parsed.path, parsed.line)}
                className="font-mono text-[11px] text-accent hover:underline"
              >
                {parsed.path}:{parsed.line}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function AlternativeBlock({ alternative }: { alternative: AiAlternative }) {
  const t = useT()
  return (
    <div className="mt-2 rounded-md border border-line px-2 py-1.5">
      <p className="text-[13px] font-medium text-ink">{alternative.name}</p>
      <p className="mt-1 text-[12px] text-ink-muted">{t('ai.pros')}: {alternative.pros.join(', ') || '—'}</p>
      <p className="text-[12px] text-ink-muted">{t('ai.cons')}: {alternative.cons.join(', ') || '—'}</p>
      <p className="text-[12px] text-ink-muted">{t('ai.fit')}: {alternative.fitForThisProject || '—'}</p>
    </div>
  )
}

function confidenceClass(confidence: string): string {
  const value = confidence.toUpperCase()
  if (value === 'CONFIRMED') return 'text-ok'
  if (value === 'LIKELY') return 'text-accent'
  if (value === 'POSSIBLE') return 'text-warn'
  return 'text-ink-muted'
}

function quickQuestions(
  view: string | null,
  t: (key: string) => string,
): { label: string; question: string; intent: string }[] {
  if (view === 'features') {
    return [
      { label: t('ai.qq.featureFlow'), question: t('ai.qq.featureFlowQ'), intent: 'EXPLAIN' },
    ]
  }
  if (view === 'architecture') {
    return [{ label: t('ai.qq.whyNeeded'), question: t('ai.qq.whyNeededQ'), intent: 'WHY' }]
  }
  if (view === 'code') {
    return [
      { label: t('ai.qq.explainSimply'), question: t('ai.qq.explainSimplyQ'), intent: 'EXPLAIN' },
      { label: t('ai.qq.whyThisWay'), question: t('ai.qq.whyThisWayQ'), intent: 'WHY' },
      { label: t('ai.qq.alternatives'), question: t('ai.qq.alternativesQ'), intent: 'ALTERNATIVE' },
      { label: t('ai.qq.problems'), question: t('ai.qq.problemsQ'), intent: 'FINDING' },
    ]
  }
  if (view === 'history') {
    return [{ label: t('ai.qq.whyChanged'), question: t('ai.qq.whyChangedQ'), intent: 'WHY' }]
  }
  if (view === 'analysis') {
    return [{ label: t('ai.qq.realIssue'), question: t('ai.qq.realIssueQ'), intent: 'FINDING' }]
  }
  if (view === 'flows') {
    return [{ label: t('ai.qq.explainFlow'), question: t('ai.qq.explainFlowQ'), intent: 'EXPLAIN' }]
  }
  if (view === 'tasks') {
    return [{ label: t('ai.qq.currentCode'), question: t('ai.qq.currentCodeQ'), intent: 'EXPLAIN' }]
  }
  if (view === 'notes') {
    return [{ label: t('ai.qq.explainNote'), question: t('ai.qq.explainNoteQ'), intent: 'EXPLAIN' }]
  }
  if (view === 'review') {
    return [{ label: t('ai.qq.prReview'), question: t('ai.qq.prReviewQ'), intent: 'EXPLAIN' }]
  }
  if (view === 'playground') {
    return [
      {
        label: t('ai.qq.explainHypothesis'),
        question: t('ai.qq.explainHypothesisQ'),
        intent: 'EXPLAIN',
      },
    ]
  }
  if (view === 'growth') {
    return [
      {
        label: t('ai.qq.learningSummary'),
        question: t('ai.qq.learningSummaryQ'),
        intent: 'EXPLAIN',
      },
    ]
  }
  return []
}
