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
import { layoutArchitecture, type ArchitectureNodeData } from './layout'

type ArchitectureCanvasProps = {
  view: ArchitectureView
  onOpenNode: (path: string, line: number | null) => void
}

export default function ArchitectureCanvas({ view, onOpenNode }: ArchitectureCanvasProps) {
  const layoutQuery = useQuery({
    queryKey: ['architecture-layout', view],
    queryFn: () => layoutArchitecture(view),
  })

  const onNodeClick: NodeMouseHandler<Node<ArchitectureNodeData>> = (_event, node) => {
    if (node.data.kind !== 'node' || !node.data.filePath) return
    onOpenNode(node.data.filePath, node.data.line)
  }

  if (layoutQuery.isLoading) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">레이아웃을 계산하는 중…</p>
  }
  if (layoutQuery.isError || !layoutQuery.data) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">레이아웃을 계산하지 못했습니다.</p>
  }

  return (
    <div className="architecture-flow min-h-0 flex-1">
      <ReactFlow
        nodes={layoutQuery.data.nodes}
        edges={layoutQuery.data.edges}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#34343d" gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
