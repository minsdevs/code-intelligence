import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { getGraphRelations } from '../../api/graph'
import type { GraphNodeSummary } from '../../api/types'
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
        label: `${relation.edgeType} · ${relation.confidence}`,
        markerEnd: { type: MarkerType.ArrowClosed },
        labelStyle: { fontSize: 10, fill: 'var(--color-ink)' },
        labelBgStyle: { fill: 'var(--color-surface-1)' },
      }))
    return { nodes, edges, byId }
  }, [selected, relations, direction])
  return (
    <>
      <p className="mt-3 rounded border border-line p-3 text-xs text-ink-muted">
        확인된 정적 관계에 따른 검토 후보입니다. 런타임 영향이나 전체 경로를 보장하지 않습니다. 동적
        호출·reflection·미지원 문법·서비스 경계에서 추적이 끊길 수 있습니다.
      </p>
      <div className="my-3 flex flex-wrap gap-3 text-xs">
        <label>
          방향{' '}
          <select
            aria-label="관계 방향"
            value={direction}
            onChange={(event) => setDirection(event.target.value as 'in' | 'out')}
            className="rounded border border-line bg-surface-2 p-2"
          >
            <option value="in">들어오는 관계 · 함께 검토할 코드</option>
            <option value="out">나가는 관계 · 다음 처리 위치</option>
          </select>
        </label>
        <label>
          관계 종류{' '}
          <select
            aria-label="관계 종류"
            value={edgeType}
            onChange={(event) => setEdgeType(event.target.value)}
            className="rounded border border-line bg-surface-2 p-2"
          >
            <option value="">전체</option>
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
            선택한 항목의 보관된 소스
          </Link>
        )}
      </div>
      {query.isError ? (
        <p role="alert">관계를 불러오지 못했습니다. 영향 여부는 알 수 없습니다.</p>
      ) : query.isLoading ? (
        <p role="status">관계를 불러오는 중…</p>
      ) : (
        <>
          {(relations?.length ?? 0) === 0 ? (
            <p className="py-3 text-sm text-ink-muted">
              이 분석에서 기록된 관계를 찾지 못했습니다. 추적이 여기서 끊기며, 영향 없음의 근거가
              아닙니다.
            </p>
          ) : (
            <>
              <div className="h-72 rounded border border-line" aria-label="선택 주변 관계 그래프">
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
              <p className="mt-2 text-xs text-ink-muted">
                선은 기록된 관계 방향입니다. 아래 표에서 연결된 항목의 소스와 관계 종류를 확인하고
                다음 항목을 선택할 수 있습니다. 그래프는 주변 40개 관계까지 표시합니다. 소스 링크는
                연결된 심볼의 선언 위치이며, 정확한 호출 행을 뜻하지 않습니다.
              </p>
              {query.data?.truncated && (
                <p role="status" className="mt-2 text-xs text-warn">
                  관계 조회 한도에 도달했습니다. 종류를 좁혀 다시 확인하세요.
                </p>
              )}
              <div className="mt-2 max-h-80 overflow-auto">
                <table className="w-full text-left text-xs" aria-label="선택 주변 관계 표">
                  <thead>
                    <tr>
                      <th className="p-2">관계와 방향</th>
                      <th className="p-2">연결된 항목</th>
                      <th className="p-2">판정</th>
                      <th className="p-2">연결된 항목의 소스</th>
                    </tr>
                  </thead>
                  <tbody>
                    {relations?.map((relation, index) => (
                      <tr
                        key={`${relation.node.id}:${relation.edgeType}:${index}`}
                        className="border-t border-line"
                      >
                        <td className="p-2">
                          {direction === 'in' ? '→ 선택 항목' : '선택 항목 →'} · {relation.edgeType}
                        </td>
                        <td className="max-w-72 p-2 [overflow-wrap:anywhere]">
                          <button className="text-accent" onClick={() => onSelect(relation.node)}>
                            {relation.node.name}
                          </button>
                          <span className="block text-ink-muted">
                            {relation.node.filePath ?? relation.node.naturalKey}
                          </span>
                        </td>
                        <td className="p-2">{relation.confidence}</td>
                        <td className="p-2">
                          {relation.node.filePath ? (
                            <Link
                              className="text-accent"
                              to={`/projects/${projectId}/code${codeLocationSearch(relation.node.filePath, relation.node.lineStart, { snapshotId, versioned: true })}`}
                            >
                              보관된 소스
                            </Link>
                          ) : (
                            '파일 위치 미확인'
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
