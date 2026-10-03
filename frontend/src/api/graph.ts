import { apiGet } from './client'
import type { GraphNodeDetail, GraphNodePage, GraphRelationsResponse } from './types'

/** Matches backend GraphService.MAX_PAGE_SIZE so a file's symbols fit in one request. */
export const GRAPH_NODE_PAGE_SIZE = 100

export function listGraphNodes(
  projectId: number,
  options: {
    snapshotId?: number | null
    type?: string
    area?: string
    q?: string
    path?: string
    page?: number
    size?: number
  } = {},
): Promise<GraphNodePage> {
  const params = new URLSearchParams()
  if (options.snapshotId != null) params.set('snapshotId', String(options.snapshotId))
  if (options.type) params.set('type', options.type)
  if (options.area) params.set('area', options.area)
  if (options.q) params.set('q', options.q)
  if (options.path) params.set('path', options.path)
  if (options.page != null) params.set('page', String(options.page))
  params.set('size', String(options.size ?? GRAPH_NODE_PAGE_SIZE))
  const query = params.toString()
  return apiGet<GraphNodePage>(`/api/projects/${projectId}/graph/nodes${query ? `?${query}` : ''}`)
}

export function getGraphNode(projectId: number, nodeId: number): Promise<GraphNodeDetail> {
  return apiGet<GraphNodeDetail>(`/api/projects/${projectId}/graph/nodes/${nodeId}`)
}

export function getGraphRelations(
  projectId: number,
  nodeId: number,
  options: {
    snapshotId?: number | null
    direction?: 'in' | 'out'
    edgeType?: string
    depth?: 1 | 2
  } = {},
): Promise<GraphRelationsResponse> {
  const params = new URLSearchParams()
  if (options.snapshotId != null) params.set('snapshotId', String(options.snapshotId))
  if (options.direction) params.set('direction', options.direction)
  if (options.edgeType) params.set('edgeType', options.edgeType)
  if (options.depth != null) params.set('depth', String(options.depth))
  const query = params.toString()
  return apiGet<GraphRelationsResponse>(
    `/api/projects/${projectId}/graph/nodes/${nodeId}/relations${query ? `?${query}` : ''}`,
  )
}
