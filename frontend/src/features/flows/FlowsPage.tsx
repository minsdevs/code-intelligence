import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { getFlow, listFlows } from '../../api/flows'
import EmptyState from '../../components/EmptyState'
import EvidenceList from '../../components/EvidenceList'
import { parseProjectId } from '../../lib/projectId'
import { codeLocationSearch, queryError } from '../code/codeLocation'

const FLOW_KINDS = ['', 'BACKEND', 'FE_BE', 'INFRA', 'EVENT'] as const

export default function FlowsPage() {
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const navigate = useNavigate()
  const [kind, setKind] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const listQuery = useQuery({
    queryKey: ['flows', projectId, kind],
    queryFn: () => listFlows(projectId!, kind || undefined),
    enabled: projectId != null,
  })

  const flows = listQuery.data ?? []
  const resolvedId =
    selectedId != null && flows.some((flow) => flow.id === selectedId) ? selectedId : (flows[0]?.id ?? null)

  const detailQuery = useQuery({
    queryKey: ['flow', projectId, resolvedId],
    queryFn: () => getFlow(projectId!, resolvedId!),
    enabled: projectId != null && resolvedId != null,
  })

  if (projectId == null) {
    return (
      <EmptyState
        title="Flows"
        description="호출 흐름을 단계별로 추적하고 각 step의 source location을 확인합니다."
      />
    )
  }

  const listError = queryError(listQuery.error)
  const detail = detailQuery.data

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex w-[22rem] shrink-0 flex-col border-r border-line bg-surface-1">
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
                  {value || '전체'}
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
        {listQuery.isLoading && <p className="px-3 py-3 text-[13px] text-ink-muted">Flow를 불러오는 중…</p>}
        {!listQuery.isLoading && flows.length === 0 && !listError && (
          <p className="px-3 py-3 text-[13px] text-ink-muted">탐지된 Flow가 없습니다.</p>
        )}
        <ul aria-label="Flow 목록" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {flows.map((flow) => {
            const active = flow.id === resolvedId
            return (
              <li key={flow.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(flow.id)}
                  aria-current={active ? 'true' : undefined}
                  className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${
                    active ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                  }`}
                >
                  <span className="text-[13px] text-ink">{flow.name}</span>
                  <span className="font-mono text-[11px] text-ink-faint">{flow.kind}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      {detail ? (
        <article className="min-h-0 flex-1 overflow-y-auto px-5 py-4" aria-label="Flow 상세">
          <h3 className="text-[15px] font-semibold text-ink">{detail.name}</h3>
          <p className="mt-1 font-mono text-[12px] text-ink-faint">{detail.kind}</p>
          <ol aria-label="Flow steps" className="mt-5 space-y-1">
            {detail.steps.map((step) => (
              <li key={step.seq}>
                {step.filePath ? (
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/projects/${projectId}/code${codeLocationSearch(step.filePath!, step.line)}`)
                    }
                    className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                  >
                    <span className="w-6 shrink-0 font-mono text-[12px] text-ink-faint">{step.seq}</span>
                    <span className="min-w-0">
                      <span className="block text-[13px] text-ink">{step.nodeName ?? step.description ?? 'step'}</span>
                      <span className="font-mono text-[11px] text-ink-faint">
                        {step.nodeType ?? ''} {step.filePath}
                        {step.line != null ? `:${step.line}` : ''}
                      </span>
                    </span>
                  </button>
                ) : (
                  <div className="flex items-start gap-3 px-2 py-1.5">
                    <span className="w-6 shrink-0 font-mono text-[12px] text-ink-faint">{step.seq}</span>
                    <span className="text-[13px] text-ink">{step.nodeName ?? step.description ?? 'step'}</span>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <EvidenceList
            evidences={detail.evidences}
            onOpen={(path, line) =>
              navigate(`/projects/${projectId}/code${codeLocationSearch(path, line)}`)
            }
          />
        </article>
      ) : (
        <p className="px-5 py-8 text-[13px] text-ink-muted">
          {detailQuery.isLoading ? 'Flow 상세를 불러오는 중…' : '왼쪽에서 Flow를 선택하세요.'}
        </p>
      )}
    </div>
  )
}
