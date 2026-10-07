import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getFlow, listFlows } from '../../api/flows'
import { getProject } from '../../api/projects'
import EmptyState from '../../components/EmptyState'
import EvidenceList from '../../components/EvidenceList'
import { useT } from '../../lib/i18n'
import { isConfirmedRelation, relationConfidenceLabel } from '../../lib/relationConfidence'
import { parseProjectId } from '../../lib/projectId'
import { codeLocationSearch, parseLineParam, queryError } from '../code/codeLocation'
import { nodeColor } from '../architecture/layout'
import type { FlowDetail, FlowStepView } from '../../api/types'

const FLOW_KINDS = ['', 'BACKEND', 'FE_BE', 'INFRA', 'EVENT'] as const

const KIND_COLORS: Record<string, string> = {
  BACKEND: 'text-ok',
  FE_BE: 'text-accent',
  INFRA: 'text-warn',
  EVENT: 'text-danger',
}

/** A path inherits its weakest step; a step without a recorded relation is not confirmed. */
function includesInferredStep(detail: FlowDetail): boolean {
  return (
    detail.inferredStepIncluded === true ||
    detail.steps.some((step) => !step.entry && !isConfirmedRelation(step.confidence))
  )
}

function stepVerdict(t: (key: string) => string, step: FlowStepView): string {
  if (step.entry) return t('flows.step.entry')
  if (!step.confidence) return t('flows.step.noRelation')
  const label = relationConfidenceLabel(t, step.confidence)
  return step.relationType ? `${step.relationType} · ${label}` : label
}

export default function FlowsPage() {
  const t = useT()
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const requestedSnapshot = parseLineParam(params.get('snapshotId'))
  const invalidSnapshot = params.has('snapshotId') && requestedSnapshot == null
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: projectId != null,
  })
  const snapshotId = invalidSnapshot
    ? null
    : (requestedSnapshot ?? projectQuery.data?.currentSnapshot?.id ?? null)
  const [kind, setKind] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const listQuery = useQuery({
    queryKey: ['flows', projectId, snapshotId, kind],
    queryFn: () => listFlows(projectId!, kind || undefined, snapshotId),
    enabled: projectId != null && snapshotId != null,
  })

  const flows = listQuery.data ?? []
  const resolvedId =
    selectedId != null && flows.some((flow) => flow.id === selectedId)
      ? selectedId
      : (flows[0]?.id ?? null)

  const detailQuery = useQuery({
    queryKey: ['flow', projectId, snapshotId, resolvedId],
    queryFn: () => getFlow(projectId!, resolvedId!, snapshotId),
    enabled: projectId != null && snapshotId != null && resolvedId != null,
  })

  if (invalidSnapshot || projectQuery.isError)
    return (
      <p role="alert" className="p-4">
        {t('workspace.snapshotUnknown')}
      </p>
    )

  if (projectQuery.isLoading)
    return (
      <p role="status" className="p-4">
        {t('workspace.snapshotLoading')}
      </p>
    )
  if (projectId != null && snapshotId == null)
    return (
      <p role="status" className="p-4">
        {t('workspace.noCompletedResult')}
      </p>
    )

  if (projectId == null) {
    return <EmptyState title="Flows" description={t('flows.desc')} />
  }

  const listError = queryError(listQuery.error)
  const detail = detailQuery.data
  const inferredIncluded = detail != null && includesInferredStep(detail)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden @min-[640px]:flex-row">
      <section className="flex max-h-[35%] min-h-0 w-full shrink-0 flex-col border-b border-line bg-surface-1 @min-[640px]:max-h-none @min-[640px]:w-72 @min-[640px]:border-b-0 @min-[640px]:border-r">
        <div className="border-b border-line px-3 py-3">
          <h2 className="text-[13px] font-semibold text-ink">Flows</h2>
          <label className="mt-2 flex items-center gap-2 text-[12px] text-ink-muted">
            Kind
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value)
                setSelectedId(null)
              }}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[12px] text-ink"
            >
              {FLOW_KINDS.map((value) => (
                <option key={value || 'all'} value={value}>
                  {value || t('flows.all')}
                </option>
              ))}
            </select>
          </label>
        </div>
        {listError && (
          <p role="alert" className="px-3 py-2 text-[12px] text-danger">
            {listError}
          </p>
        )}
        {listQuery.isLoading && (
          <p className="px-3 py-3 text-[13px] text-ink-muted">{t('flows.loading')}</p>
        )}
        {!listQuery.isLoading && flows.length === 0 && !listError && (
          <p className="px-3 py-3 text-[13px] text-ink-muted">{t('flows.empty')}</p>
        )}
        <ul aria-label={t('flows.listLabel')} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {flows.map((flow) => {
            const active = flow.id === resolvedId
            return (
              <li key={flow.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(flow.id)}
                  aria-current={active ? 'true' : undefined}
                  className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${
                    active
                      ? 'bg-surface-3 text-ink'
                      : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                  }`}
                >
                  <span className="max-w-full text-[13px] text-ink [overflow-wrap:anywhere]">
                    {flow.name}
                  </span>
                  <span className="font-mono text-[11px] text-ink-faint">{flow.kind}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      {detail ? (
        <article
          className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 [overflow-wrap:anywhere]"
          aria-label="Flow detail"
          tabIndex={0}
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 text-[16px] font-semibold text-ink">{detail.name}</h3>
            {detail.kind && (
              <span
                className={`rounded-full border border-line-strong px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
                  KIND_COLORS[detail.kind] ?? 'text-ink-muted'
                }`}
              >
                {detail.kind}
              </span>
            )}
            {inferredIncluded && (
              <span className="rounded-full border border-warn px-2 py-0.5 text-[11px] text-warn">
                {t('flows.inferredBadge')}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-ink-muted">
            {t('flows.stepCount').replace('{count}', String(detail.steps.length))}
          </p>

          <p className="mt-3 text-xs text-ink-muted">{t('flows.staticPathNote')}</p>
          <p className="mt-1 text-xs text-ink-muted">{t('flows.stepConfidenceNote')}</p>
          <ol aria-label={t('flows.stepsLabel')} className="mt-5 flex flex-col">
            {detail.steps.map((step, index) => (
              <li key={step.seq} className="relative flex gap-3 pb-4 pl-8">
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-0 flex size-6 items-center justify-center rounded-full border border-line-strong bg-surface-2 font-mono text-[11px] text-ink"
                >
                  {index + 1}
                </span>
                {index < detail.steps.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-[11px] top-7 w-px bg-line-strong"
                  />
                )}
                <div
                  className={`min-w-0 flex-1 rounded-md border border-line bg-surface-1 px-3 py-2.5 ${
                    step.filePath
                      ? 'cursor-pointer transition-colors hover:border-line-strong hover:bg-surface-2'
                      : ''
                  }`}
                  role={step.filePath ? 'button' : undefined}
                  tabIndex={step.filePath ? 0 : undefined}
                  onClick={
                    step.filePath
                      ? () =>
                          navigate(
                            `/projects/${projectId}/code${codeLocationSearch(step.filePath!, step.line, { snapshotId: detail.resolvedSnapshotId, versioned: true })}`,
                          )
                      : undefined
                  }
                  onKeyDown={
                    step.filePath
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            navigate(
                              `/projects/${projectId}/code${codeLocationSearch(step.filePath!, step.line, { snapshotId: detail.resolvedSnapshotId, versioned: true })}`,
                            )
                          }
                        }
                      : undefined
                  }
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                      {step.nodeName ?? step.description ?? 'step'}
                    </span>
                    {step.nodeType && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
                        <span
                          className="size-1.5 rounded-full"
                          style={{ background: nodeColor(step.nodeType) }}
                        />
                        {step.nodeType}
                      </span>
                    )}
                  </div>
                  <p
                    className={`mt-0.5 text-[11px] ${
                      step.entry || isConfirmedRelation(step.confidence) ? 'text-ink-muted' : 'text-warn'
                    }`}
                  >
                    {stepVerdict(t, step)}
                  </p>
                  {step.description && step.nodeName !== step.description && (
                    <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
                      {step.description}
                    </p>
                  )}
                  {step.filePath && (
                    <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">
                      {step.filePath}
                      {step.line != null ? `:${step.line}` : ''}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>

          <EvidenceList
            evidences={detail.evidences}
            projectId={projectId}
            onOpen={(path, line, evidence) =>
              navigate(
                `/projects/${projectId}/code${codeLocationSearch(path, line, { snapshotId: evidence.snapshotId, evidenceId: evidence.evidenceId, versioned: true })}`,
              )
            }
          />
        </article>
      ) : (
        <p className="px-5 py-8 text-[13px] text-ink-muted">
          {detailQuery.isLoading ? t('flows.loadingDetail') : t('flows.select')}
        </p>
      )}
    </div>
  )
}
