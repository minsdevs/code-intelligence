import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { getImpact, listFindings, runWhatIf } from '../../api/analysis'
import { createTaskDraft } from '../../api/tasks'
import { listGraphNodes } from '../../api/graph'
import { parseEvidenceRef } from '../../api/ai'
import { ApiError } from '../../api/client'
import type { FindingView } from '../../api/types'
import EmptyState from '../../components/EmptyState'
import { useT } from '../../lib/i18n'
import { parseProjectId } from '../../lib/projectId'
import { useUiStore } from '../../stores/uiStore'
import { codeLocationSearch, queryError } from '../code/codeLocation'

const SEVERITIES = ['', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
const DEPTHS = [1, 2, 3, 4, 5, 6, 7, 8]

export default function AnalysisPage() {
  const t = useT()
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const navigate = useNavigate()
  const setFocusedFindingId = useUiStore((state) => state.setFocusedFindingId)
  const setPendingIntent = useUiStore((state) => state.setPendingIntent)
  const setAiPanelOpen = useUiStore((state) => state.setAiPanelOpen)
  const [severity, setSeverity] = useState('')
  const [selectedFindingId, setSelectedFindingId] = useState<number | null>(null)
  const [nodeQuery, setNodeQuery] = useState('')
  const [nodeId, setNodeId] = useState<number | null>(null)
  const [depth, setDepth] = useState(5)
  const [draftMessage, setDraftMessage] = useState<string | null>(null)
  const [whatIfError, setWhatIfError] = useState<string | null>(null)

  const findingsQuery = useQuery({
    queryKey: ['findings', projectId, severity],
    queryFn: () => listFindings(projectId!, severity || undefined),
    enabled: projectId != null,
  })

  const findings = findingsQuery.data ?? []
  const resolvedFindingId =
    selectedFindingId != null && findings.some((finding) => finding.id === selectedFindingId)
      ? selectedFindingId
      : (findings[0]?.id ?? null)
  const activeFinding = findings.find((finding) => finding.id === resolvedFindingId) ?? null
  const impactNodeId = nodeId ?? activeFinding?.nodeId ?? null

  const searchQuery = useQuery({
    queryKey: ['impact-nodes', projectId, nodeQuery],
    queryFn: () => listGraphNodes(projectId!, { q: nodeQuery.trim(), size: 20 }),
    enabled: projectId != null && nodeQuery.trim().length >= 2,
  })

  const impactQuery = useQuery({
    queryKey: ['impact', projectId, impactNodeId, depth],
    queryFn: () => getImpact(projectId!, impactNodeId!, depth),
    enabled: projectId != null && impactNodeId != null,
  })

  const draftMutation = useMutation({
    mutationFn: () => createTaskDraft(projectId!, activeFinding!.id),
    onSuccess: () => {
      navigate(`/projects/${projectId}/tasks`)
    },
    onError: (error) => {
      const message =
        error instanceof ApiError && error.status === 503
          ? t('analysis.draftAiDisabled')
          : (queryError(error) ?? t('analysis.draftFailed'))
      setDraftMessage(message)
    },
  })

  const whatIfMutation = useMutation({
    mutationFn: () => runWhatIf(projectId!, { nodeId: impactNodeId!, depth }),
    onError: (error) => {
      const message =
        error instanceof ApiError && error.status === 503
          ? t('analysis.whatIfAiDisabled')
          : (queryError(error) ?? t('analysis.whatIfFailed'))
      setWhatIfError(message)
    },
    onSuccess: () => setWhatIfError(null),
  })

  if (projectId == null) {
    return (
      <EmptyState title="Analysis" description={t('analysis.desc')} />
    )
  }

  const findingsError = queryError(findingsQuery.error)
  const impactError = queryError(impactQuery.error)
  const draftAiDisabled = draftMutation.error instanceof ApiError && draftMutation.error.status === 503
  const whatIfAiDisabled = whatIfMutation.error instanceof ApiError && whatIfMutation.error.status === 503

  function selectFinding(finding: FindingView) {
    setSelectedFindingId(finding.id)
    if (finding.nodeId != null) setNodeId(finding.nodeId)
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex min-w-0 flex-1 flex-col border-r border-line">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold text-ink">Findings</h2>
          <label className="flex items-center gap-2 text-[12px] text-ink-muted">
            Severity
            <select
              value={severity}
              onChange={(event) => {
                setSeverity(event.target.value)
                setSelectedFindingId(null)
              }}
              className="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[12px] text-ink"
            >
              {SEVERITIES.map((value) => (
                <option key={value || 'all'} value={value}>
                  {value || t('analysis.all')}
                </option>
              ))}
            </select>
          </label>
        </div>
        {findingsError && (
          <p role="alert" className="px-4 py-2 text-[12px] text-danger">
            {findingsError}
          </p>
        )}
        {findingsQuery.isLoading && (
          <p className="px-4 py-3 text-[13px] text-ink-muted">{t('analysis.loading')}</p>
        )}
        {!findingsQuery.isLoading && findings.length === 0 && !findingsError && (
          <p className="px-4 py-3 text-[13px] text-ink-muted">{t('analysis.noFindings')}</p>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-surface-1 text-[11px] uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Severity</th>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Area</th>
                <th className="px-4 py-2 font-medium">Category</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((finding) => {
                const active = finding.id === resolvedFindingId
                return (
                  <tr
                    key={finding.id}
                    aria-selected={active}
                    className={active ? 'bg-surface-3' : 'hover:bg-surface-2'}
                  >
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => selectFinding(finding)}
                        className={`font-mono text-[12px] ${severityClass(finding.severity)}`}
                      >
                        {finding.severity}
                      </button>
                    </td>
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => selectFinding(finding)}
                        className="text-left text-ink"
                      >
                        {finding.title}
                      </button>
                    </td>
                    <td className="px-4 py-2 font-mono text-[12px] text-ink-faint">
                      {finding.areaType ?? '—'}
                    </td>
                    <td className="px-4 py-2 font-mono text-[12px] text-ink-faint">
                      {finding.category}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {activeFinding && (
          <div className="border-t border-line px-4 py-3">
            <p className="text-[13px] text-ink-muted">
              {activeFinding.detail ?? t('analysis.noDetail')}
            </p>
            {activeFinding.evidences
              .filter((evidence) => evidence.filePath)
              .map((evidence, index) => (
                <button
                  key={`${evidence.filePath}-${index}`}
                  type="button"
                  onClick={() =>
                    navigate(
                      `/projects/${projectId}/code${codeLocationSearch(evidence.filePath!, evidence.lineStart)}`,
                    )
                  }
                  className="mt-2 block font-mono text-[12px] text-accent hover:underline"
                >
                  {evidence.filePath}
                  {evidence.lineStart != null ? `:${evidence.lineStart}` : ''}
                </button>
              ))}
            <button
              type="button"
              onClick={() => {
                setFocusedFindingId(activeFinding.id)
                setPendingIntent('FINDING')
                setAiPanelOpen(true)
              }}
              className="mt-3 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[12px] text-ink hover:bg-surface-3"
            >
              {t('analysis.verifyAi')}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftMessage(null)
                draftMutation.mutate()
              }}
              disabled={draftMutation.isPending}
              className="ml-2 mt-3 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[12px] text-ink hover:bg-surface-3 disabled:opacity-60"
            >
              {t('analysis.createDraft')}
            </button>
            {draftMessage && (
              <div role="alert" className="mt-2 text-[12px] text-danger">
                <p>{draftMessage}</p>
                {draftAiDisabled && (
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
          </div>
        )}
      </section>

      <aside className="flex w-[24rem] shrink-0 flex-col bg-surface-1" aria-label="Impact">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold text-ink">Impact</h2>
          <label className="mt-2 block text-[12px] text-ink-muted">
            {t('analysis.nodeSearch')}
            <input
              value={nodeQuery}
              onChange={(event) => setNodeQuery(event.target.value)}
              placeholder={t('analysis.nodeSearchPlaceholder')}
              className="mt-1 w-full rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[12px] text-ink"
            />
          </label>
          <label className="mt-2 flex items-center gap-2 text-[12px] text-ink-muted">
            Depth
            <select
              value={depth}
              onChange={(event) => setDepth(Number(event.target.value))}
              className="rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[12px] text-ink"
            >
              {DEPTHS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        {searchQuery.data && searchQuery.data.items.length > 0 && (
          <ul
            aria-label={t('analysis.searchResultsLabel')}
            className="max-h-40 overflow-y-auto border-b border-line px-2 py-2"
          >
            {searchQuery.data.items.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => {
                    setNodeId(node.id)
                    setNodeQuery('')
                  }}
                  className="mb-0.5 w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                >
                  <span className="block text-[13px] text-ink">{node.name}</span>
                  <span className="font-mono text-[11px] text-ink-faint">
                    {node.nodeType}
                    {node.filePath ? ` · ${node.filePath}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {impactError && (
          <p role="alert" className="px-4 py-2 text-[12px] text-danger">
            {impactError}
          </p>
        )}
        {impactNodeId == null && (
          <p className="px-4 py-3 text-[13px] text-ink-muted">{t('analysis.pickNode')}</p>
        )}
        {impactQuery.isLoading && (
          <p className="px-4 py-3 text-[13px] text-ink-muted">{t('analysis.impactLoading')}</p>
        )}
        {impactQuery.data && (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <p className="flex items-baseline gap-2">
              <span
                className={`font-mono text-[12px] ${severityClass(impactQuery.data.riskLevel)}`}
              >
                {impactQuery.data.riskLevel}
              </span>
              <span className="text-[13px] text-ink-muted">score {impactQuery.data.riskScore}</span>
            </p>
            {impactQuery.data.dependents.length === 0 ? (
              <p className="mt-3 text-[13px] text-ink-muted">{t('analysis.noReverseDeps')}</p>
            ) : (
              <ol aria-label="Impact dependents" className="mt-3 space-y-1">
                {impactQuery.data.dependents.map((dep) => (
                  <li key={`${dep.depth}-${dep.nodeId}-${dep.edgeType}`}>
                    {dep.filePath ? (
                      <button
                        type="button"
                        onClick={() =>
                          navigate(
                            `/projects/${projectId}/code${codeLocationSearch(dep.filePath!, dep.line)}`,
                          )
                        }
                        className="w-full rounded-md px-1 py-1 text-left hover:bg-surface-2"
                      >
                        <span className="block text-[13px] text-ink">{dep.name}</span>
                        <span className="font-mono text-[11px] text-ink-faint">
                          d{dep.depth} · {dep.edgeType} · {dep.filePath}
                          {dep.line != null ? `:${dep.line}` : ''}
                        </span>
                      </button>
                    ) : (
                      <div className="px-1 py-1">
                        <span className="block text-[13px] text-ink">{dep.name}</span>
                        <span className="font-mono text-[11px] text-ink-faint">
                          d{dep.depth} · {dep.edgeType}
                        </span>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
            <button
              type="button"
              onClick={() => {
                setWhatIfError(null)
                whatIfMutation.mutate()
              }}
              disabled={whatIfMutation.isPending}
              className="mt-4 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[12px] text-ink hover:bg-surface-3 disabled:opacity-60"
            >
              {t('analysis.whatIf')}
            </button>
            {whatIfError && (
              <div role="alert" className="mt-2 text-[12px] text-danger">
                <p>{whatIfError}</p>
                {whatIfAiDisabled && (
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
            {whatIfMutation.data && (
              <div className="mt-3 border-t border-line pt-3">
                <h3 className="text-[12px] font-semibold text-ink">What-if</h3>
                <p className="mt-1 text-[13px] text-ink">{whatIfMutation.data.explanation}</p>
                <ul aria-label="What-if claims" className="mt-2 space-y-1">
                  {whatIfMutation.data.claims.map((claim, index) => (
                    <li key={`${claim.text}-${index}`}>
                      <span className="font-mono text-[11px] text-ok">{claim.confidence}</span>
                      <p className="text-[12px] text-ink">{claim.text}</p>
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
          </div>
        )}
      </aside>
    </div>
  )
}

function severityClass(level: string): string {
  if (level === 'CRITICAL' || level === 'HIGH') return 'text-danger'
  if (level === 'MEDIUM') return 'text-warn'
  return 'text-ok'
}
