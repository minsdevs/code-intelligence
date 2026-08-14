import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode } from 'elkjs'
import type { Edge, Node } from '@xyflow/react'
import type { ArchitectureView } from '../../api/types'

const NODE_WIDTH = 180
const NODE_HEIGHT = 40

export type ArchitectureNodeData = {
  label: string
  filePath: string | null
  line: number | null
  kind: 'node' | 'group'
}

function groupId(layer: string): string {
  return `group:${layer}`
}

function nodeId(id: number): string {
  return `node:${id}`
}

export async function layoutArchitecture(view: ArchitectureView): Promise<{
  nodes: Node<ArchitectureNodeData>[]
  edges: Edge[]
}> {
  const elk = new ELK()
  const children: ElkNode[] = view.groups.map((group) => ({
    id: groupId(group.layer),
    layoutOptions: {
      'elk.algorithm': 'rectpacking',
      'elk.padding': '[top=28,left=12,bottom=12,right=12]',
      'elk.spacing.nodeNode': '16',
    },
    children: group.nodes.map((node) => ({
      id: nodeId(node.id),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
  }))
  const elkEdges = view.edges.map((edge, index) => {
    const source =
      edge.sourceNodeId != null ? nodeId(edge.sourceNodeId) : groupId(edge.sourceGroup)
    const target =
      edge.targetNodeId != null ? nodeId(edge.targetNodeId) : groupId(edge.targetGroup)
    return { id: `e${index}`, sources: [source], targets: [target] }
  })
  const laidOut = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.spacing.nodeNode': '32',
    },
    children,
    edges: elkEdges,
  })
  return toFlow(view, laidOut)
}

function toFlow(
  view: ArchitectureView,
  laidOut: ElkNode,
): { nodes: Node<ArchitectureNodeData>[]; edges: Edge[] } {
  const nodes: Node<ArchitectureNodeData>[] = []
  const byId = new Map(view.groups.flatMap((group) => group.nodes.map((node) => [nodeId(node.id), node])))
  for (const group of laidOut.children ?? []) {
    const layer = group.id.replace(/^group:/, '')
    nodes.push({
      id: group.id,
      type: 'group',
      position: { x: group.x ?? 0, y: group.y ?? 0 },
      data: { label: layer, filePath: null, line: null, kind: 'group' },
      style: {
        width: group.width ?? 220,
        height: group.height ?? 80,
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-line-strong)',
        borderRadius: 8,
      },
    })
    for (const child of group.children ?? []) {
      const source = byId.get(child.id)
      nodes.push({
        id: child.id,
        parentId: group.id,
        extent: 'parent',
        position: { x: child.x ?? 12, y: child.y ?? 28 },
        data: {
          label: source?.name ?? child.id,
          filePath: source?.filePath ?? null,
          line: source?.line ?? null,
          kind: 'node',
        },
        style: {
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-line-strong)',
          borderRadius: 6,
          color: 'var(--color-ink)',
          fontSize: 12,
        },
      })
    }
  }
  const edges: Edge[] = view.edges.map((edge, index) => ({
    id: `e${index}`,
    source: edge.sourceNodeId != null ? nodeId(edge.sourceNodeId) : groupId(edge.sourceGroup),
    target: edge.targetNodeId != null ? nodeId(edge.targetNodeId) : groupId(edge.targetGroup),
    label: String(edge.count),
    style: { stroke: 'var(--color-ink-muted)' },
    labelStyle: { fill: 'var(--color-ink-muted)', fontSize: 11 },
  }))
  return { nodes, edges }
}
