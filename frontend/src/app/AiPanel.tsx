import { useMemo, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { askAi, askAiStream, getAiStatus, parseEvidenceRef } from '../api/ai'
import { ApiError } from '../api/client'
import type { AiAlternative, AiAskBody, AiAskResponse, AiClaim } from '../api/types'
import { projectIdFromPath, workspaceViewFromPath } from '../lib/projectId'
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

  const quick = quickQuestions(view)
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
      let response: AiAskResponse
      try {
        response = await askAiStream(projectId, body, (token) => {
          setTurns((prev) =>
            prev.map((item, i) =>
              i === prev.length - 1 ? { ...item, streamed: item.streamed + token } : item,
            ),
          )
        })
      } catch {
        response = await askAi(projectId, body)
      }
      setConversationId(response.conversationId)
      patchLast({ response })
    } catch (error) {
      const message = error instanceof ApiError ? error.message : '질문을 처리하지 못했습니다.'
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
        aria-label="AI Assistant 패널"
        className="flex w-10 shrink-0 flex-col items-center gap-3 border-l border-line bg-surface-1 py-2"
      >
        <button
          type="button"
          aria-label="AI 패널 펼치기"
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
        aria-label="AI 패널 너비 조절"
        className="w-[3px] shrink-0 cursor-col-resize touch-none bg-line transition-colors hover:bg-accent/70 active:bg-accent"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
      <aside
        aria-label="AI Assistant 패널"
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
            aria-label="AI 패널 접기"
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
            aria-label="현재 컨텍스트"
          >
            {chips.length === 0 ? (
              <span className="text-[12px] text-ink-muted">컨텍스트 없음</span>
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
              aria-label="빠른 질문"
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
            {statusQuery.data && !configured && (
              <p className="text-[13px] text-ink-muted">
                AI provider가 설정되지 않았습니다. 키는 환경 변수로만 넣습니다.
              </p>
            )}
            {projectId == null && configured && (
              <p className="text-[13px] text-ink-muted">
                프로젝트를 열면 현재 화면 기준으로 질문할 수 있습니다.
              </p>
            )}
            {turns.length === 0 && configured && projectId != null && (
              <p className="text-[13px] text-ink-muted">
                현재 컨텍스트를 근거로 질문하세요. 단정은 evidence와 함께 표시됩니다.
              </p>
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
                    {turn.streamed || '답변을 생성하는 중…'}
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
              aria-label="AI 질문 입력"
              placeholder={configured ? '질문 입력…' : 'AI가 비활성화되어 있습니다'}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-3 py-1.5 text-ink placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!canAsk || question.trim().length === 0}
              className="rounded-md border border-line-strong bg-surface-3 px-3 py-1.5 text-ink disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
            >
              전송
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
  return (
    <div className="mt-2 rounded-md border border-line px-2 py-1.5">
      <p className="text-[13px] font-medium text-ink">{alternative.name}</p>
      <p className="mt-1 text-[12px] text-ink-muted">장점: {alternative.pros.join(', ') || '—'}</p>
      <p className="text-[12px] text-ink-muted">단점: {alternative.cons.join(', ') || '—'}</p>
      <p className="text-[12px] text-ink-muted">적합도: {alternative.fitForThisProject || '—'}</p>
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
): { label: string; question: string; intent: string }[] {
  if (view === 'features') {
    return [{ label: '기능 흐름', question: '이 기능 전체 흐름 설명해줘', intent: 'EXPLAIN' }]
  }
  if (view === 'architecture') {
    return [{ label: '왜 필요해?', question: '이 컴포넌트가 왜 필요해?', intent: 'WHY' }]
  }
  if (view === 'code') {
    return [
      { label: '쉽게 설명', question: '이 메서드 쉽게 설명', intent: 'EXPLAIN' },
      { label: '왜 이렇게?', question: '왜 이렇게 구현?', intent: 'WHY' },
      { label: '대안', question: '대안은?', intent: 'ALTERNATIVE' },
      { label: '문제점', question: '문제점 찾아줘', intent: 'FINDING' },
    ]
  }
  if (view === 'history') {
    return [{ label: '왜 바뀌었어?', question: '이 변경이 왜 발생했어?', intent: 'WHY' }]
  }
  if (view === 'analysis') {
    return [{ label: '실제 문제?', question: '실제 문제인지 확인해줘', intent: 'FINDING' }]
  }
  if (view === 'flows') {
    return [{ label: '흐름 설명', question: '이 흐름을 설명해줘', intent: 'EXPLAIN' }]
  }
  if (view === 'tasks') {
    return [{ label: '현재 코드 기준', question: '현재 코드 기준으로 설명해줘', intent: 'EXPLAIN' }]
  }
  if (view === 'notes') {
    return [{ label: '노트 설명', question: '이 노트와 연결된 코드를 설명해줘', intent: 'EXPLAIN' }]
  }
  return []
}
