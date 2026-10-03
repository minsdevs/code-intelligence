import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { askAiStream, getAiStatus, parseEvidenceRef } from '../api/ai'
import { previewAiContext } from '../api/aiPreview'
import { createAiRequestPlan } from '../api/aiRequestPlan'
import { AI_BUDGET_MUTATION_KEY, AI_BUDGET_QUERY_KEY, budgetAllowsRequests, getAiBudget, microUsdToDollars, type AiBudgetView } from '../api/aiBudget'
import { ApiError } from '../api/client'
import type { AiAlternative, AiAskBody, AiAskResponse, AiClaim, AiPreviewResponse, AiRequestPlanResponse, AiStatus } from '../api/types'
import { projectIdFromPath, workspaceViewFromPath } from '../lib/projectId'
import { useT } from '../lib/i18n'
import { AI_PANEL_MAX_WIDTH, AI_PANEL_MIN_WIDTH, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH, useUiStore } from '../stores/uiStore'
import { PanelRightIcon, SparkleIcon } from '../components/icons'
import { codeLocationSearch } from '../features/code/codeLocation'

type ChatTurn = {
  projectId: number
  question: string
  streamed: string
  response: AiAskResponse | null
  error: string | null
}

type PlanDraft = { projectId: number | null; body: AiAskBody }
type BudgetScope = { serialized: string }
type PlannedRequest = { draft: PlanDraft; budgetScope: BudgetScope; projectId: number; body: AiAskBody; response: AiRequestPlanResponse }
type RequestWork = { kind: 'plan' | 'send'; draft: PlanDraft }
type LocalPreview = { scope: PlanDraft; projectId: number; body: AiAskBody; response: AiPreviewResponse; selectionChanged: boolean }
type PreviewWork = { scope: PlanDraft }
type CopyWork = { preview: LocalPreview; draft: PlanDraft; selection: Set<string> }
type CopyFeedback = CopyWork & { copied: boolean; error: string | null }

// Called at asynchronous receipt/confirmation boundaries, never to derive render output.
function hasPlanExpired(plan: AiRequestPlanResponse): boolean {
  return planExpiry(plan) <= Date.now()
}

function planExpiry(plan: AiRequestPlanResponse): number {
  return Math.min(Date.parse(plan.expiresAt), plan.cost ? Date.parse(plan.cost.validUntil) : Infinity)
}

function matchesBudget(plan: PlannedRequest, scope: BudgetScope, budget: AiBudgetView | undefined, ready: boolean, desktop: boolean): boolean {
  if (plan.response.costStatus === 'UNAVAILABLE') return ready && !desktop && budget?.available === false
  const cost = plan.response.cost
  return Boolean(cost && plan.budgetScope === scope && ready && budget?.available && budget.state === 'READY'
    && budget.policyRevision === cost.policyRevision && budget.supportedModels.includes(plan.response.model))
}

function matchesLiveSelection(body: AiAskBody): boolean {
  const selected = useUiStore.getState()
  return body.intent === selected.pendingIntent && body.focusedFile === selected.focusedFile
    && body.focusedNodeId === (selected.focusedNode?.id ?? null)
    && body.focusedCommitSha === selected.focusedCommitSha && body.focusedFindingId === selected.focusedFindingId
    && body.focusedNoteId === selected.focusedNoteId && body.focusedTaskId === selected.focusedTaskId
    && JSON.stringify(body.selectedAreas) === JSON.stringify(selected.selectedAreas)
}

export default function AiPanel() {
  const t = useT()
  const queryClient = useQueryClient()
  const desktop = Boolean(window.codeIntelligenceDesktop)
  const open = useUiStore((state) => state.aiPanelOpen)
  const width = useUiStore((state) => state.aiPanelWidth)
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  // Keep the saved preference while reserving usable workspace space at smaller sizes.
  const maxWidth = Math.max(AI_PANEL_MIN_WIDTH, Math.min(AI_PANEL_MAX_WIDTH,
    viewportWidth - (sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH) - 400 - 6))
  const panelWidth = Math.max(AI_PANEL_MIN_WIDTH, Math.min(width, maxWidth))
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

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const location = useLocation()
  const navigate = useNavigate()
  const projectId = projectIdFromPath(location.pathname)
  const view = workspaceViewFromPath(location.pathname)

  const statusQuery = useQuery({
    queryKey: ['ai-status'],
    queryFn: getAiStatus,
    retry: false,
  })
  const budgetChanging = useIsMutating({ mutationKey: AI_BUDGET_MUTATION_KEY }) > 0
  const budgetQuery = useQuery({
    queryKey: AI_BUDGET_QUERY_KEY, queryFn: getAiBudget, enabled: open && !budgetChanging, retry: false,
  })
  const budgetScopeJson = JSON.stringify({
    available: budgetQuery.data?.available, state: budgetQuery.data?.state,
    revision: budgetQuery.data?.policyRevision, models: budgetQuery.data?.supportedModels, failed: budgetQuery.isError,
  })
  const [budgetScope, setBudgetScope] = useState<BudgetScope>(() => ({ serialized: budgetScopeJson }))
  if (budgetScope.serialized !== budgetScopeJson) setBudgetScope({ serialized: budgetScopeJson })
  const latestBudgetScope = useRef(budgetScope)

  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [conversation, setConversation] = useState<{ projectId: number; id: number } | null>(null)
  const conversationId = conversation?.projectId === projectId ? conversation.id : null
  const visibleTurns = turns.filter(turn => turn.projectId === projectId)
  const [sending, setSending] = useState(false)
  const [localPreview, setLocalPreview] = useState<LocalPreview | null>(null)
  const [previewOperation, setPreviewOperation] = useState<PreviewWork | null>(null)
  const [copyOperation, setCopyOperation] = useState<CopyWork | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null)
  const [localDataOnly, setLocalDataOnly] = useState(false)
  const [excludedItems, setExcludedItems] = useState<Set<string>>(new Set())
  const latestExclusions = useRef(excludedItems)
  const [planned, setPlanned] = useState<PlannedRequest | null>(null)
  const [planning, setPlanning] = useState<RequestWork | null>(null)
  const [planError, setPlanError] = useState<{ draft: PlanDraft; message: string } | null>(null)
  const [expiredPlan, setExpiredPlan] = useState<PlannedRequest | null>(null)
  const requestWork = useRef<RequestWork | null>(null)
  const readyPlan = useRef<PlannedRequest | null>(null)
  const availablePreview = useRef<LocalPreview | null>(null)
  const previewWork = useRef<PreviewWork | null>(null)
  const copyWork = useRef<CopyWork | null>(null)
  const mounted = useRef(true)

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
  const desktopAiUnavailable = statusQuery.data?.blockedReason === 'DESKTOP_AI_SAFETY_UNAVAILABLE'
  const configured = statusQuery.isSuccess && statusQuery.data?.configured === true && !desktopAiUnavailable
  const budgetReadReady = budgetQuery.isSuccess && !budgetQuery.isFetching && !budgetChanging
  const remoteReady = configured && !statusQuery.isFetching && budgetReadReady && budgetAllowsRequests(budgetQuery.data, desktop)
  const remoteBlockedMessage = desktopAiUnavailable ? 'ai.desktopUnavailable'
    : !statusQuery.data?.configured ? 'ai.notConfigured'
      : !budgetReadReady || !statusQuery.isSuccess || statusQuery.isFetching ? 'ai.readinessUnknown'
        : budgetQuery.data?.available && budgetQuery.data.state === 'OFF' ? 'ai.budgetOff'
          : budgetQuery.data?.available && budgetQuery.data.state === 'RECOVERY_REQUIRED' ? 'ai.budgetRecovery'
            : 'ai.desktopUnavailable'
  const contextBody: AiAskBody = {
    conversationId, question, intent: pendingIntent, view, focusedFile,
    focusedNodeId: focusedNode?.id ?? null, focusedCommitSha, focusedFindingId,
    focusedNoteId, focusedTaskId, selectedAreas,
  }
  const draftJson = JSON.stringify({
    projectId,
    body: {
      ...contextBody,
      excludedContextIds: excludedItems.size > 0 ? [...excludedItems] : undefined,
    },
    navigation: location.key, configured, provider: statusQuery.data?.provider,
    model: statusQuery.data?.model, localDataOnly, open,
  })
  // Keep generations in state, not a disposable memo cache: changing a draft back cannot revive approval.
  const [draftState, setDraftState] = useState(() => ({ serialized: draftJson, value: JSON.parse(draftJson) as PlanDraft }))
  if (draftState.serialized !== draftJson) {
    setDraftState({ serialized: draftJson, value: JSON.parse(draftJson) as PlanDraft })
  }
  const draft = draftState.value
  // Exclusions remain editable within a preview; a copy is also bound to the full draft below.
  const previewScopeJson = JSON.stringify({ projectId, body: contextBody, navigation: location.key, localDataOnly, open })
  const [previewScopeState, setPreviewScopeState] = useState(() => ({ serialized: previewScopeJson, value: JSON.parse(previewScopeJson) as PlanDraft }))
  if (previewScopeState.serialized !== previewScopeJson) {
    setPreviewScopeState({ serialized: previewScopeJson, value: JSON.parse(previewScopeJson) as PlanDraft })
  }
  const previewScope = previewScopeState.value
  const latestDraft = useRef(draft)
  const latestPreviewScope = useRef(previewScope)
  useLayoutEffect(() => {
    latestBudgetScope.current = budgetScope
    if (readyPlan.current?.response.costStatus === 'AVAILABLE' && readyPlan.current.budgetScope !== budgetScope) readyPlan.current = null
  }, [budgetScope])
  useLayoutEffect(() => {
    latestDraft.current = draft
    if (readyPlan.current?.draft !== draft) readyPlan.current = null
    if (copyWork.current?.draft !== draft) copyWork.current = null
  }, [draft])
  useLayoutEffect(() => {
    latestPreviewScope.current = previewScope
    if (availablePreview.current?.scope !== previewScope) availablePreview.current = null
    if (previewWork.current?.scope !== previewScope) previewWork.current = null
  }, [previewScope])
  useLayoutEffect(() => { latestExclusions.current = excludedItems }, [excludedItems])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      readyPlan.current = null
      requestWork.current = null
      availablePreview.current = null
      previewWork.current = null
      copyWork.current = null
    }
  }, [])
  const currentPlan = planned?.draft === draft ? planned : null
  useEffect(() => {
    if (!currentPlan) return
    const timeout = setTimeout(() => {
      if (readyPlan.current === currentPlan) readyPlan.current = null
      setExpiredPlan(currentPlan)
    }, Math.max(0, Math.min(planExpiry(currentPlan.response) - Date.now(), 2_147_483_647)))
    return () => clearTimeout(timeout)
  }, [currentPlan])
  const currentPreview = localPreview?.scope === previewScope ? localPreview : null
  const preview = currentPreview?.response
  const previewing = previewOperation?.scope === previewScope
  const copying = copyOperation?.preview === currentPreview && copyOperation?.draft === draft
  const currentCopyFeedback = copyFeedback?.preview === currentPreview && copyFeedback?.draft === draft ? copyFeedback : null
  const promptCopied = currentCopyFeedback?.copied === true
  const copyError = currentCopyFeedback?.error
  const selectionChanged = currentPreview?.selectionChanged === true
  const canPreview = projectId != null && !sending && !copying
  const canAsk = canPreview && !previewing && planning?.draft !== draft
    && !desktopAiUnavailable && (remoteReady || localDataOnly)
  const budgetConfirmed = currentPlan ? matchesBudget(currentPlan, budgetScope, budgetQuery.data,
    budgetQuery.isSuccess && !budgetQuery.isFetching && !budgetChanging, desktop) : false

  function discardPlan() {
    readyPlan.current = null
    if (requestWork.current?.kind === 'plan') requestWork.current = null
    setPlanning(null)
    setPlanned(null)
    setPlanError(null)
  }

  function discardCopy() {
    copyWork.current = null
    setCopyOperation(null)
    setCopyFeedback(null)
  }

  function discardPreview() {
    availablePreview.current = null
    previewWork.current = null
    setLocalPreview(null)
    setPreviewOperation(null)
    discardCopy()
  }

  function liveRemoteReady(): boolean {
    const status = queryClient.getQueryState<AiStatus>(['ai-status'])
    const budget = queryClient.getQueryState<AiBudgetView>(AI_BUDGET_QUERY_KEY)
    return status?.status === 'success' && status.fetchStatus === 'idle' && !status.isInvalidated
      && status.data?.configured === true && status.data.blockedReason !== 'DESKTOP_AI_SAFETY_UNAVAILABLE'
      && budget?.status === 'success' && budget.fetchStatus === 'idle' && !budget.isInvalidated
      && queryClient.isMutating({ mutationKey: AI_BUDGET_MUTATION_KEY }) === 0
      && budgetAllowsRequests(budget.data, desktop)
  }

  async function refreshAiState() {
    // These are reads only. An uncertain request may have changed the latch and held liability.
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: AI_BUDGET_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['ai-status'] }),
      queryClient.invalidateQueries({ queryKey: ['ai-settings'] }),
    ])
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    setWidth(Math.min(maxWidth, window.innerWidth - event.clientX))
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  async function submit(text: string, intent?: string | null) {
    const trimmed = text.trim()
    if (!trimmed || projectId == null || !canAsk) return
    if (requestWork.current?.kind === 'send' || requestWork.current?.draft === draft) return
    if (localDataOnly) {
      // Local data only mode: do not send any external AI request.
      // Show preview info only — no external API call is made.
      const turn: ChatTurn = { projectId, question: trimmed, streamed: '', response: null, error: 'Local data only mode is active. No external AI request was sent. Disable "Local data only" to ask AI questions.' }
      setTurns((prev) => [...prev, turn])
      return
    }
    if (!liveRemoteReady()) return
    const body: AiAskBody = { ...draft.body, question: trimmed, intent: intent ?? pendingIntent }
    const work: RequestWork = { kind: 'plan', draft }
    requestWork.current = work
    readyPlan.current = null
    setPlanning(work)
    setPlanned(null)
    setPlanError(null)
    let reconcile = false
    try {
      const response = await createAiRequestPlan(projectId, body)
      if (!mounted.current || requestWork.current !== work || latestDraft.current !== draft || !matchesLiveSelection(draft.body)) return
      if (hasPlanExpired(response)) {
        setPlanError({ draft, message: t('ai.planExpired') })
        return
      }
      const plan = { draft, budgetScope: latestBudgetScope.current, projectId, body, response }
      readyPlan.current = plan
      setPlanned(plan)
    } catch {
      reconcile = true
      if (mounted.current && requestWork.current === work && latestDraft.current === draft) {
        setPlanError({ draft, message: t('ai.planFailed') })
      }
    } finally {
      if (requestWork.current === work) {
        requestWork.current = null
        if (mounted.current) setPlanning(null)
      }
      if (reconcile) await refreshAiState()
    }
  }

  async function confirmPlan() {
    const plan = currentPlan
    if (!plan || readyPlan.current !== plan || requestWork.current || !canAsk || localDataOnly
      || latestDraft.current !== plan.draft || !matchesLiveSelection(plan.draft.body)) return
    if (!liveRemoteReady()) return
    const budget = queryClient.getQueryState<AiBudgetView>(AI_BUDGET_QUERY_KEY)
    if (!matchesBudget(plan, latestBudgetScope.current, budget?.data,
      budget?.status === 'success' && budget.fetchStatus === 'idle'
        && queryClient.isMutating({ mutationKey: AI_BUDGET_MUTATION_KEY }) === 0, desktop)) return
    if (hasPlanExpired(plan.response)) {
      readyPlan.current = null
      setExpiredPlan(plan)
      return
    }
    // Consume before any await: duplicate clicks and uncertain outcomes cannot reuse this approval.
    readyPlan.current = null
    const work: RequestWork = { kind: 'send', draft }
    requestWork.current = work
    setPlanned(null)
    setSending(true)
    setPendingIntent(null)
    setQuestion('')
    const turn: ChatTurn = { projectId: plan.projectId, question: plan.body.question, streamed: '', response: null, error: null }
    setTurns((prev) => [...prev, turn])
    const patchLast = (patch: Partial<ChatTurn>) => {
      setTurns((prev) =>
        prev.map((item, i) => (i === prev.length - 1 ? { ...item, ...patch } : item)),
      )
    }
    try {
      const response = await askAiStream(plan.projectId, { ...plan.body, requestPlanToken: plan.response.requestPlanToken }, (token) => {
        if (!mounted.current) return
        setTurns((prev) =>
          prev.map((item, i) =>
            i === prev.length - 1 ? { ...item, streamed: item.streamed + token } : item,
          ),
        )
      })
      if (mounted.current) {
        setConversation({ projectId: plan.projectId, id: response.conversationId })
        patchLast({ response })
      }
    } catch (error) {
      const message = error instanceof ApiError && error.code === 'AI_REQUEST_OUTCOME_UNKNOWN'
        ? t('ai.outcomeUnknown')
        : error instanceof ApiError ? error.message : t('ai.outcomeUnknown')
      if (mounted.current) patchLast({ error: message })
    } finally {
      if (requestWork.current === work) requestWork.current = null
      if (mounted.current) setSending(false)
      await refreshAiState()
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void submit(question)
  }

  async function onPreview() {
    const trimmed = question.trim()
    if (!trimmed || projectId == null || !canPreview || previewWork.current?.scope === previewScope
      || latestExclusions.current !== excludedItems) return
    discardPlan()
    discardPreview()
    const work = { scope: previewScope }
    previewWork.current = work
    setPreviewOperation(work)
    const body: AiAskBody = { ...previewScope.body, question: trimmed, intent: undefined }
    const excluded = [...excludedItems]
    try {
      const result = await previewAiContext(projectId, body)
      if (!mounted.current || previewWork.current !== work || latestPreviewScope.current !== previewScope
        || !matchesLiveSelection(previewScope.body)) return
      const availableIds = new Set(result.contextItems.map(item => item.id))
      const staleSelection = excluded.some(id => !availableIds.has(id))
      if (staleSelection) {
        latestExclusions.current = availableIds
        setExcludedItems(availableIds)
      }
      const next = { scope: previewScope, projectId, body, response: result, selectionChanged: staleSelection }
      availablePreview.current = next
      setLocalPreview(next)
    } catch {
      if (mounted.current && previewWork.current === work) setLocalPreview(null)
    } finally {
      if (previewWork.current === work) {
        previewWork.current = null
        if (mounted.current) setPreviewOperation(null)
      }
    }
  }

  function isCurrentCopy(work: CopyWork): boolean {
    return mounted.current && copyWork.current === work && availablePreview.current === work.preview
      && latestPreviewScope.current === work.preview.scope && latestDraft.current === work.draft
      && latestExclusions.current === work.selection
      && matchesLiveSelection(work.preview.scope.body)
  }

  async function copyPrompt() {
    if (!currentPreview?.response.copyablePrompt || !navigator.clipboard || copying || copyWork.current?.draft === draft
      || availablePreview.current !== currentPreview || latestPreviewScope.current !== currentPreview.scope
      || latestExclusions.current !== excludedItems || !matchesLiveSelection(currentPreview.scope.body)) return
    const work = { preview: currentPreview, draft, selection: excludedItems }
    const excluded = [...excludedItems]
    copyWork.current = work
    setCopyOperation(work)
    setCopyFeedback(null)
    try {
      const selected = excluded.length > 0
        ? await previewAiContext(currentPreview.projectId, {
            ...currentPreview.body,
            excludedContextIds: excluded,
          })
        : currentPreview.response
      if (!isCurrentCopy(work)) return
      // Scope is checked immediately before the native call; an already started write cannot be undone.
      await navigator.clipboard.writeText(selected.copyablePrompt)
      if (isCurrentCopy(work)) setCopyFeedback({ ...work, copied: true, error: null })
    } catch (error) {
      if (isCurrentCopy(work)) {
        setCopyFeedback({ ...work, copied: false, error: error instanceof ApiError ? error.message : 'Prompt copy failed. Create a new preview and try again.' })
      }
    } finally {
      if (copyWork.current === work) {
        copyWork.current = null
        if (mounted.current) setCopyOperation(null)
      }
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
        aria-controls="ai-assistant-panel"
        aria-valuemin={AI_PANEL_MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={panelWidth}
        aria-valuetext={`${panelWidth} pixels`}
        tabIndex={0}
        className="w-1.5 shrink-0 cursor-col-resize touch-none bg-line transition-colors hover:bg-accent/70 focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-accent active:bg-accent"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 48 : 24
          const next = event.key === 'Home' ? AI_PANEL_MIN_WIDTH
            : event.key === 'End' ? maxWidth
            : event.key === 'ArrowLeft' ? panelWidth + step
            : event.key === 'ArrowRight' ? panelWidth - step : null
          if (next == null) return
          event.preventDefault()
          setWidth(Math.min(maxWidth, next))
        }}
      />
      <aside
        id="ai-assistant-panel"
        aria-label={t('ai.panelLabel')}
        style={{ width: panelWidth }}
        className="flex min-w-0 shrink-0 flex-col bg-surface-1 [overflow-wrap:anywhere]"
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
            {statusQuery.data && !remoteReady && (
              <div className="text-[13px] text-ink-muted">
                <p>{t(remoteBlockedMessage)}</p>
                <Link
                  to="/settings"
                  className="mt-2 inline-block text-[12px] text-accent hover:underline"
                >
                  {t('ai.openSettings')}
                </Link>
              </div>
            )}
            {projectId == null && remoteReady && (
              <p className="text-[13px] text-ink-muted">{t('ai.openProjectHint')}</p>
            )}
            {visibleTurns.length === 0 && remoteReady && projectId != null && (
              <p className="text-[13px] text-ink-muted">{t('ai.askHint')}</p>
            )}
            {planning?.draft === draft && <p role="status" className="mt-3 text-[12px] text-ink-muted">{t('ai.planCreating')}</p>}
            {planError?.draft === draft && <p role="alert" className="mt-3 text-[12px] text-danger">{planError.message}</p>}
            {planned && !currentPlan && <p role="status" className="mt-3 text-[12px] text-ink-muted">{t('ai.planChanged')}</p>}
            {currentPlan && (
              <section aria-label={t('ai.planTitle')} className="my-3 rounded-md border border-line-strong bg-surface-2 p-3 text-[12px]">
                <h2 className="font-semibold text-ink">{t('ai.planTitle')}</h2>
                <p className="mt-2 text-ink-muted">{t('ai.planNotice')}</p>
                <p className="mt-2 whitespace-pre-wrap break-words text-ink">{currentPlan.body.question}</p>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words">
                  <dt>{t('settings.provider')}</dt><dd>{currentPlan.response.provider}</dd>
                  <dt>{t('settings.model')}</dt><dd>{currentPlan.response.model}</dd>
                  <dt>{t('ai.planIntent')}</dt><dd>{currentPlan.response.intent}</dd>
                  <dt>{t('ai.planSnapshot')}</dt><dd>{currentPlan.response.snapshotId}</dd>
                  <dt>{t('ai.planExpires')}</dt><dd>{currentPlan.response.expiresAt}</dd>
                </dl>
                {currentPlan.response.costStatus === 'AVAILABLE' && currentPlan.response.cost ? (
                  <div className="mt-3 rounded border border-line p-2">
                    <p className="font-semibold">{t('ai.costMaximum')}: ${microUsdToDollars(currentPlan.response.cost.reservedMicroUsd)}</p>
                    <p className="mt-1 text-ink-muted">{t('ai.costBoundHint')}</p>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words">
                      <dt>{t('ai.costInputBound')}</dt><dd>{currentPlan.response.cost.inputTokenUpperBound}</dd>
                      <dt>{t('ai.costOutputMax')}</dt><dd>{currentPlan.response.cost.outputTokenMax}</dd>
                      <dt>{t('ai.costPriceVersion')}</dt><dd>{currentPlan.response.cost.priceVersion}</dd>
                      <dt>{t('ai.costValidUntil')}</dt><dd>{currentPlan.response.cost.validUntil}</dd>
                      <dt>{t('ai.costPolicyRevision')}</dt><dd>{currentPlan.response.cost.policyRevision}</dd>
                    </dl>
                  </div>
                ) : <p className="mt-2 text-warn">{t('ai.costUnavailable')}</p>}
                {!budgetConfirmed && <p className="mt-2 text-danger" role="alert">{t('ai.costBudgetUnavailable')}</p>}
                <h3 className="mt-3 font-medium">{t('ai.planContext')}</h3>
                <ul className="mt-1 space-y-2 break-words">
                  {currentPlan.response.contextItems.map((item, index) => (
                    <li key={`${item.id}-${index}`}>
                      <p>{item.label} · {item.type} · {item.charCount} {t('ai.planCharacters')} · {t(item.masked ? 'ai.planMasked' : 'ai.planUnmasked')}</p>
                      {item.fileRefs.map((ref, refIndex) => <p className="font-mono text-ink-muted" key={`${ref}-${refIndex}`}>{ref}</p>)}
                    </li>
                  ))}
                </ul>
                <h3 className="mt-3 font-medium">{t('ai.planEvidence')}</h3>
                <ul className="mt-1 break-words font-mono text-ink-muted">
                  {currentPlan.response.fileRefs.map((ref, index) => <li key={`${ref}-${index}`}>{ref}</li>)}
                </ul>
                <h3 className="mt-3 font-medium">System prompt</h3>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line p-2 font-mono">{currentPlan.response.systemPrompt}</pre>
                <h3 className="mt-3 font-medium">User prompt</h3>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line p-2 font-mono">{currentPlan.response.userPrompt}</pre>
                {expiredPlan === currentPlan && <p role="alert" className="mt-2 text-danger">{t('ai.planExpired')}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void confirmPlan()} disabled={!canAsk || !budgetConfirmed || localDataOnly || expiredPlan === currentPlan}
                    className="rounded border border-line-strong bg-surface-3 px-3 py-1.5 disabled:opacity-50">{t('ai.confirmSend')}</button>
                  <button type="button" onClick={discardPlan} className="rounded border border-line px-3 py-1.5">{t('ai.discardPlan')}</button>
                </div>
              </section>
            )}
            {visibleTurns.map((turn, index) => (
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

        <form onSubmit={onSubmit} className="max-h-[50%] shrink-0 overflow-y-auto border-t border-line p-3">
          {preview && (
            <div className="mb-2 rounded-md border border-line bg-surface-2 p-2 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink">Context Preview</span>
                <button type="button" disabled={copying} onClick={() => {
                  discardPlan()
                  discardPreview()
                  latestExclusions.current = new Set()
                  setExcludedItems(latestExclusions.current)
                }} className="text-ink-muted hover:text-ink">✕</button>
              </div>
              <div className="mt-1 space-y-0.5 text-ink-muted">
                <p>Provider: {preview.provider} / {preview.model}</p>
                <p>Input tokens: ~{preview.estimatedInputTokens.toLocaleString()} · Output: ~{preview.estimatedOutputTokens.toLocaleString()}</p>
                <p>Est. cost: ${preview.estimatedCostUsd.toFixed(5)}</p>
                <p>Masked secrets: {preview.maskedSecrets} · Files: {preview.fileRefs.length}</p>
                <button
                  type="button"
                  onClick={() => void copyPrompt()}
                  disabled={!preview.copyablePrompt || !navigator.clipboard || copying}
                  className="mt-1 rounded border border-line-strong px-2 py-1 text-[11px] text-ink hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {promptCopied ? t('ai.promptCopied') : t('ai.copyPrompt')}
                </button>
                {copyError && <p role="alert" className="text-danger">{copyError}</p>}
                {selectionChanged && <p className="text-warn">Context changed. All items were excluded; select the items to include.</p>}
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
                        disabled={copying}
                        onChange={() => {
                          discardPlan()
                          discardCopy()
                          const next = new Set(latestExclusions.current)
                          if (next.has(item.id)) next.delete(item.id)
                          else next.add(item.id)
                          latestExclusions.current = next
                          setExcludedItems(next)
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
                onChange={(e) => { discardPlan(); discardPreview(); setLocalDataOnly(e.target.checked) }}
                className="h-3 w-3 rounded"
              />
              Local data only (no external AI)
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={question}
              onChange={(event) => { discardPlan(); discardPreview(); setQuestion(event.target.value) }}
              disabled={!canPreview}
              aria-label={t('ai.inputLabel')}
              placeholder={canPreview ? t('ai.placeholder') : t('ai.placeholderDisabled')}
              className="min-w-0 flex-1 basis-full rounded-md border border-line bg-surface-2 px-3 py-1.5 text-ink placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void onPreview()}
              disabled={!canPreview || question.trim().length === 0 || previewing}
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
              {planning?.draft === draft ? t('ai.planCreating') : t('ai.reviewRequest')}
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
