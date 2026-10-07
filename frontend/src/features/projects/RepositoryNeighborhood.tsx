import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { getGraphRelations } from '../../api/graph'
import type { GraphNodeSummary } from '../../api/types'
import { useT } from '../../lib/i18n'
import { relationConfidenceLabel } from '../../lib/relationConfidence'
import { codeLocationSearch } from '../code/codeLocation'

export default function RepositoryNeighborhood({
  projectId,
  snapshotId,
  selected,
  onSelect,
  edgeTypes,
}: {
  projectId: number
  snapshotId: number
  selected: GraphNodeSummary
  onSelect: (node: GraphNodeSummary) => void
  edgeTypes: string[]
}) {
  const t = useT()
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [edgeType, setEdgeType] = useState('')
  const query = useQuery({
    queryKey: ['investigation-relations', projectId, snapshotId, selected.id, direction, edgeType],
    queryFn: () =>
      getGraphRelations(projectId, selected.id, { snapshotId, direction, edgeType, depth: 1 }),
  })
  const relations = query.data?.relations
  const graph = useMemo(() => {
    const byId = new Map<number, GraphNodeSummary>([[selected.id, selected]])
    for (const relation of (relations ?? []).slice(0, 40)) byId.set(relation.node.id, relation.node)
    const nodes: Node[] = [...byId.values()].map((node, index) => ({
      id: String(node.id),
      position:
        index === 0 ? { x: 320, y: 0 } : { x: direction === 'in' ? 0 : 640, y: (index - 1) * 90 },
      data: { label: `${node.name}\n${node.filePath ?? node.nodeType}` },
      style: {
        width: 260,
        fontSize: 11,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        background: 'var(--color-surface-2)',
        color: 'var(--color-ink)',
        border: `1px solid ${index === 0 ? 'var(--color-accent)' : 'var(--color-line-strong)'}`,
      },
    }))
    const edges: Edge[] = (relations ?? [])
      .slice(0, 40)
      .filter((relation) => relation.sourceNodeId != null && relation.targetNodeId != null)
      .map((relation, index) => ({
        id: `${relation.sourceNodeId}:${relation.targetNodeId}:${relation.edgeType}:${index}`,
        source: String(relation.sourceNodeId),
        target: String(relation.targetNodeId),
        label: `${relation.edgeType} · ${relationConfidenceLabel(t, relation.confidence)}`,
        markerEnd: { type: MarkerType.ArrowClosed },
        labelStyle: { fontSize: 10, fill: 'var(--color-ink)' },
        labelBgStyle: { fill: 'var(--color-surface-1)' },
      }))
    return { nodes, edges, byId }
  }, [selected, relations, direction, t])
  return (
    <>
      <p className="mt-3 rounded border border-line p-3 text-xs text-ink-muted">
        {t('neighborhood.intro')}
      </p>
      <div className="my-3 flex flex-wrap gap-3 text-xs">
        <label>
          {t('neighborhood.direction')}{' '}
          <select
            aria-label={t('neighborhood.directionLabel')}
            value={direction}
            onChange={(event) => setDirection(event.target.value as 'in' | 'out')}
            className="rounded border border-line bg-surface-2 p-2"
          >
            <option value="in">{t('neighborhood.in')}</option>
            <option value="out">{t('neighborhood.out')}</option>
          </select>
        </label>
        <label>
          {t('neighborhood.type')}{' '}
          <select
            aria-label={t('neighborhood.type')}
            value={edgeType}
            onChange={(event) => setEdgeType(event.target.value)}
            className="rounded border border-line bg-surface-2 p-2"
          >
            <option value="">{t('neighborhood.all')}</option>
            {edgeTypes.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
        {selected.filePath && (
          <Link
            className="self-center text-accent"
            to={`/projects/${projectId}/code${codeLocationSearch(selected.filePath, selected.lineStart, { snapshotId, versioned: true })}`}
          >
            {t('neighborhood.selectedSource')}
          </Link>
        )}
      </div>
      {query.isError ? (
        <p role="alert">{t('neighborhood.error')}</p>
      ) : query.isLoading ? (
        <p role="status">{t('neighborhood.loading')}</p>
      ) : (
        <>
          {(relations?.length ?? 0) === 0 ? (
            <p className="py-3 text-sm text-ink-muted">{t('neighborhood.empty')}</p>
          ) : (
            <>
              <div className="h-72 rounded border border-line" aria-label={t('neighborhood.graph')}>
                <ReactFlow
                  nodes={graph.nodes}
                  edges={graph.edges}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  fitView
                  minZoom={0.15}
                  maxZoom={1.5}
                  onNodeClick={(_event, node) => {
                    const target = graph.byId.get(Number(node.id))
                    if (target) onSelect(target)
                  }}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
              <p className="mt-2 text-xs text-ink-muted">{t('neighborhood.graphNote')}</p>
              {query.data?.truncated && (
                <p role="status" className="mt-2 text-xs text-warn">
                  {t('neighborhood.truncated')}
                </p>
              )}
              <div className="mt-2 max-h-80 overflow-auto">
                <table className="w-full text-left text-xs" aria-label={t('neighborhood.table')}>
                  <thead>
                    <tr>
                      <th className="p-2">{t('neighborhood.col.relation')}</th>
                      <th className="p-2">{t('neighborhood.col.item')}</th>
                      <th className="p-2">{t('neighborhood.col.verdict')}</th>
                      <th className="p-2">{t('neighborhood.col.source')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {relations?.map((relation, index) => (
                      <tr
                        key={`${relation.node.id}:${relation.edgeType}:${index}`}
                        className="border-t border-line"
                      >
                        <td className="p-2">
                          {t(direction === 'in' ? 'neighborhood.toSelected' : 'neighborhood.fromSelected')}{' '}
                          · {relation.edgeType}
                        </td>
                        <td className="max-w-72 p-2 [overflow-wrap:anywhere]">
                          <button className="text-accent" onClick={() => onSelect(relation.node)}>
                            {relation.node.name}
                          </button>
                          <span className="block text-ink-muted">
                            {relation.node.filePath ?? relation.node.naturalKey}
                          </span>
                        </td>
                        <td className="p-2">{relationConfidenceLabel(t, relation.confidence)}</td>
                        <td className="p-2">
                          {relation.node.filePath ? (
                            <Link
                              className="text-accent"
                              to={`/projects/${projectId}/code${codeLocationSearch(relation.node.filePath, relation.node.lineStart, { snapshotId, versioned: true })}`}
                            >
                              {t('neighborhood.storedSource')}
                            </Link>
                          ) : (
                            t('neighborhood.noLocation')
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}
