import ELK from 'elkjs/lib/elk-api.js'
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker'
import type { ELK as ElkLayoutEngine, ElkNode } from 'elkjs'
import type { Edge, Node } from '@xyflow/react'
import type { ArchitectureView } from '../../api/types'

const NODE_WIDTH = 180
const NODE_HEIGHT = 40
let elk: ElkLayoutEngine | null = null

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    elk?.terminateWorker()
    elk = null
  })
}

function layoutEngine(): ElkLayoutEngine {
  elk ??= new ELK({ workerFactory: () => new ElkWorker({ name: 'architecture-layout' }) })
  return elk
}

export type ArchitectureNodeData = {
  label: string
  filePath: string | null
  line: number | null
  kind: 'node' | 'group'
  nodeId: number | null
  nodeType: string | null
}

/** Learnable color coding for common node types (falls back to a neutral tint). */
export const NODE_TYPE_COLORS: Record<string, string> = {
  // backend
  CONTROLLER: '#d97757',
  SERVICE: '#5b8def',
  REPOSITORY: '#8b5cf6',
  ENTITY: '#e879f9',
  CONFIG: '#f59e0b',
  // frontend
  COMPONENT: '#34d399',
  HOOK: '#2dd4bf',
  STORE: '#f472b6',
  API_CLIENT: '#60a5fa',
  FE_ROUTE: '#a3e635',
  // system
  INFRA: '#94a3b8',
  CI_PIPELINE: '#facc15',
  DOCKER: '#38bdf8',
  DB: '#22d3ee',
  // generic
  FILE: '#94a3b8',
  CLASS: '#c084fc',
  INTERFACE: '#a78bfa',
  ENUM: '#f0abfc',
  FUNCTION: '#7dd3fc',
  METHOD: '#67e8f9',
}

export function nodeColor(nodeType: string | null): string {
  if (!nodeType) return '#64748b'
  const exact = NODE_TYPE_COLORS[nodeType.toUpperCase()]
  if (exact) return exact
  return '#64748b'
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
  const laidOut = await layoutEngine().layout({
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
      data: { label: layer, filePath: null, line: null, kind: 'group', nodeId: null, nodeType: null },
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
          nodeId: source?.id ?? null,
          nodeType: source?.nodeType ?? null,
        },
        style: {
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          background: 'var(--color-surface-2)',
          border: `1.5px solid ${nodeColor(source?.nodeType ?? null)}`,
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
    style: { stroke: 'var(--color-ink-muted)', strokeWidth: 1.5 },
    labelStyle: { fill: 'var(--color-ink-muted)', fontSize: 11 },
    markerEnd: { type: 'arrowclosed', color: 'var(--color-ink-muted)', width: 14, height: 14 },
  }))
  return { nodes, edges }
}
