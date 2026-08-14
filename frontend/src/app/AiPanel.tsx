import { useMemo, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { askAiStream, getAiStatus, parseEvidenceRef } from '../api/ai'
import { ApiError } from '../api/client'
import type { AiAlternative, AiAskBody, AiAskResponse, AiClaim } from '../api/types'
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
