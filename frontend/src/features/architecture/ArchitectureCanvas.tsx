import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Background,
  Controls,
  ReactFlow,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ArchitectureView } from '../../api/types'
import { useT } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import { layoutArchitecture, nodeColor, type ArchitectureNodeData } from './layout'

type ArchitectureCanvasProps = {
  view: ArchitectureView
  onOpenNode: (path: string, line: number | null) => void
}

export default function ArchitectureCanvas({ view, onOpenNode }: ArchitectureCanvasProps) {
  const t = useT()
  const setFocusedFile = useUiStore((state) => state.setFocusedFile)
  const setFocusedNode = useUiStore((state) => state.setFocusedNode)
  const [selected, setSelected] = useState<Node<ArchitectureNodeData> | null>(null)
  const layoutQuery = useQuery({
    queryKey: ['architecture-layout', view],
    queryFn: () => layoutArchitecture(view),
  })

  const legend = useMemo(() => {
    const types = new Map<string, string>()
    for (const group of view.groups) {
      for (const node of group.nodes) {
        const key = node.nodeType?.toUpperCase()
        if (key) types.set(key, nodeColor(node.nodeType))
      }
    }
    return [...types.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [view])

  // Screen readers read these names; React Flow would otherwise fall back to database ids.
  const flow = useMemo(() => {
    const data = layoutQuery.data
    if (!data) return null
    const labels = new Map(data.nodes.map((node) => [node.id, node.data.label]))
    return {
      nodes: data.nodes.map((node) => ({
        ...node,
        ariaLabel:
          node.data.kind === 'group'
            ? t('arch.groupNode').replace('{layer}', node.data.label)
            : [node.data.label, node.data.nodeType, node.data.filePath].filter(Boolean).join(' · '),
      })),
      edges: data.edges.map((edge, index) => ({
        ...edge,
        ariaLabel: t('graph.edgeName')
          .replace('{source}', labels.get(edge.source) ?? t('graph.unknownItem'))
          .replace('{target}', labels.get(edge.target) ?? t('graph.unknownItem'))
          .replace('{details}', t('arch.edgeCount').replace('{count}', String(view.edges[index]?.count ?? ''))),
      })),
    }
  }, [layoutQuery.data, view, t])

  const openNode = (node: Node<ArchitectureNodeData>) => {
    if (node.data.kind !== 'node') return
    setSelected(node)
    if (node.data.nodeId != null) {
      setFocusedNode({
        id: node.data.nodeId,
        name: node.data.label,
        nodeType: node.data.nodeType ?? 'NODE',
        filePath: node.data.filePath,
        lineStart: node.data.line,
      })
    }
    if (node.data.filePath) {
      setFocusedFile(node.data.filePath)
      onOpenNode(node.data.filePath, node.data.line)
    }
  }
  const onNodeClick: NodeMouseHandler<Node<ArchitectureNodeData>> = (_event, node) => openNode(node)

  if (layoutQuery.isLoading) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{t('arch.layoutLoading')}</p>
  }
  if (layoutQuery.isError || !flow) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{t('arch.layoutError')}</p>
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div
        className="architecture-flow relative h-full min-h-0 min-w-0 flex-1"
        onKeyDown={(event) => {
          // React Flow only selects a node on Enter; open it as a click does.
          const element = (event.target as Element).closest('.react-flow__node')
          const node = flow.nodes.find((item) => item.id === element?.getAttribute('data-id'))
          if (event.key === 'Enter' && node) openNode(node)
        }}
      >
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          onNodeClick={onNodeClick}
          nodesDraggable={false}
          nodesConnectable={false}
          deleteKeyCode={null}
          ariaLabelConfig={{
            'node.a11yDescription.default': t('graph.nodeHint'),
            'node.a11yDescription.keyboardDisabled': t('graph.nodeHint'),
            'edge.a11yDescription.default': t('graph.edgeHint'),
          }}
          elementsSelectable
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#34343d" gap={18} />
          <Controls showInteractive={false} />
        </ReactFlow>

        {legend.length > 0 && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-line bg-surface-1/95 px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              {t('arch.legend')}
            </p>
            <ul className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1">
              {legend.map(([type, color]) => (
                <li key={type} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                  <span className="size-2.5 rounded-sm border" style={{ background: color }} />
                  {type}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {selected && (
        <aside
          aria-label={t('arch.nodeDetail')}
          className="flex w-72 shrink-0 flex-col border-l border-line bg-surface-1"
        >
          <div className="border-b border-line px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 truncate font-mono text-[13px] font-semibold text-ink">
                {selected.data.label}
              </h3>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label={t('arch.closeDetail')}
                className="rounded-md px-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                ✕
              </button>
            </div>
            {selected.data.nodeType && (
              <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-ink-muted">
                <span
                  className="size-2.5 rounded-sm border"
                  style={{ background: nodeColor(selected.data.nodeType) }}
                />
                {selected.data.nodeType}
              </p>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-ink-faint">{t('arch.file')}</p>
            {selected.data.filePath ? (
              <button
                type="button"
                onClick={() => onOpenNode(selected.data!.filePath!, selected.data!.line)}
                className="mt-1 block w-full text-left font-mono text-[12px] text-accent hover:underline"
              >
                {selected.data.filePath}
                {selected.data.line != null ? `:${selected.data.line}` : ''}
              </button>
            ) : (
              <p className="mt-1 text-[12px] text-ink-muted">—</p>
            )}
            <p className="mt-4 text-[11px] uppercase tracking-wide text-ink-faint">
              {t('arch.neighbors')}
            </p>
            <ul className="mt-1 space-y-1">
              {view.edges
                .filter(
                  (edge) =>
                    edge.sourceNodeId === selected.data.nodeId ||
                    edge.targetNodeId === selected.data.nodeId,
                )
                .map((edge) => {
                  const isSource = edge.sourceNodeId === selected.data.nodeId
                  const otherGroup = isSource ? edge.targetGroup : edge.sourceGroup
                  const otherNode = !isSource
                    ? view.groups
                        .flatMap((group) => group.nodes)
                        .find((node) => node.id === edge.sourceNodeId)
                    : view.groups
                        .flatMap((group) => group.nodes)
                        .find((node) => node.id === edge.targetNodeId)
                  return (
                    <li key={`${edge.sourceNodeId}-${edge.targetNodeId}`} className="text-[12px]">
                      {otherNode?.filePath ? (
                        <button
                          type="button"
                          onClick={() => onOpenNode(otherNode!.filePath!, otherNode!.line)}
                          className="font-mono text-accent hover:underline"
                        >
                          {otherNode.name}
                        </button>
                      ) : (
                        <span className="font-mono text-ink-muted">{otherGroup}</span>
                      )}
                      <span className="ml-2 text-[11px] text-ink-faint">
                        {isSource ? '→' : '←'} ×{edge.count}
                      </span>
                    </li>
                  )
                })}
            </ul>
          </div>
          <div className="border-t border-line p-3">
            <button
              type="button"
              disabled={!selected.data.filePath}
              onClick={() => onOpenNode(selected.data!.filePath!, selected.data!.line)}
              className="w-full rounded-md bg-surface-2 px-3 py-1.5 text-[12px] text-ink hover:bg-surface-3 disabled:opacity-50"
            >
              {t('arch.openCode')}
            </button>
          </div>
        </aside>
      )}
    </div>
  )
}
