import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { getFeature, listFeatures } from '../../api/features'
import type { FeatureChildView } from '../../api/types'
import EmptyState from '../../components/EmptyState'
import EvidenceList from '../../components/EvidenceList'
import { useT } from '../../lib/i18n'
import { parseProjectId } from '../../lib/projectId'
import { codeLocationSearch, queryError } from '../code/codeLocation'

export default function FeaturesPage() {
  const t = useT()
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const treeQuery = useQuery({
    queryKey: ['features', projectId],
    queryFn: () => listFeatures(projectId!),
    enabled: projectId != null,
  })

  const tree = treeQuery.data ?? []
  const resolvedId =
    selectedId != null && containsFeature(tree, selectedId) ? selectedId : (tree[0]?.id ?? null)

  const detailQuery = useQuery({
    queryKey: ['feature', projectId, resolvedId],
    queryFn: () => getFeature(projectId!, resolvedId!),
    enabled: projectId != null && resolvedId != null,
  })

  if (projectId == null) {
    return (
      <EmptyState title="Features" description={t('features.desc')} />
    )
  }

  const treeError = queryError(treeQuery.error)
  const detail = detailQuery.data

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex w-[22rem] shrink-0 flex-col border-r border-line bg-surface-1">
        <div className="border-b border-line px-3 py-3">
          <h2 className="text-[13px] font-semibold text-ink">Features</h2>
        </div>
        {treeError && (
          <p role="alert" className="px-3 py-2 text-[12px] text-danger">
            {treeError}
          </p>
        )}
        {treeQuery.isLoading && <p className="px-3 py-3 text-[13px] text-ink-muted">{t('features.loading')}</p>}
        {!treeQuery.isLoading && tree.length === 0 && !treeError && (
          <p className="px-3 py-3 text-[13px] text-ink-muted">{t('features.empty')}</p>
        )}
        <ul aria-label={t('features.treeLabel')} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {tree.map((node) => (
            <FeatureNode key={node.id} node={node} selectedId={resolvedId} onSelect={setSelectedId} />
          ))}
        </ul>
      </section>

      {detail ? (
        <article className="min-h-0 flex-1 overflow-y-auto px-5 py-4" aria-label="Feature detail">
          <h3 className="text-[15px] font-semibold text-ink">{detail.name}</h3>
          <p className="mt-1 flex flex-wrap gap-x-3 font-mono text-[12px] text-ink-faint">
            <span>{detail.detection}</span>
            <span>{Math.round(detail.confidence * 100)}%</span>
          </p>
          <h4 className="mt-5 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">{t('features.links')}</h4>
          {detail.links.length === 0 ? (
            <p className="mt-2 text-[13px] text-ink-muted">{t('features.noLinks')}</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {detail.links.map((link) => (
                <li key={`${link.role}-${link.nodeId}`}>
                  {link.filePath ? (
                    <button
                      type="button"
                      onClick={() =>
                        navigate(`/projects/${projectId}/code${codeLocationSearch(link.filePath!, null)}`)
                      }
                      className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                    >
                      <span className="text-[13px] text-ink">{link.name}</span>
                      <span className="font-mono text-[11px] text-ink-faint">
                        {link.role} · {link.filePath}
                      </span>
                    </button>
                  ) : (
                    <span className="flex flex-col px-2 py-1.5">
                      <span className="text-[13px] text-ink">{link.name}</span>
                      <span className="font-mono text-[11px] text-ink-faint">{link.role}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <EvidenceList
            evidences={detail.evidences}
            onOpen={(path, line) =>
              navigate(`/projects/${projectId}/code${codeLocationSearch(path, line)}`)
            }
          />
        </article>
      ) : (
        <p className="px-5 py-8 text-[13px] text-ink-muted">
          {detailQuery.isLoading ? t('features.loadingDetail') : t('features.select')}
        </p>
      )}
    </div>
  )
}

function FeatureNode({
  node,
  selectedId,
  onSelect,
}: {
  node: FeatureChildView
  selectedId: number | null
  onSelect: (id: number) => void
}) {
  const active = node.id === selectedId
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        aria-current={active ? 'true' : undefined}
        className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${
          active ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
        }`}
      >
        <span className="text-[13px] text-ink">{node.name}</span>
        <span className="font-mono text-[11px] text-ink-faint">
          {node.detection} · {Math.round(node.confidence * 100)}%
        </span>
      </button>
      {node.children.length > 0 && (
        <ul className="ml-3 border-l border-line pl-2">
          {node.children.map((child) => (
            <FeatureNode key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  )
}

function containsFeature(nodes: FeatureChildView[], id: number): boolean {
  return nodes.some((node) => node.id === id || containsFeature(node.children, id))
}
