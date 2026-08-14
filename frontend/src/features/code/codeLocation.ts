import { ApiError } from '../../api/client'
import type { GraphNodeSummary } from '../../api/types'
import type { FocusedNode } from '../../stores/uiStore'

export function queryError(error: unknown): string | null {
  if (!error) return null
  if (error instanceof ApiError) return error.message
  return '요청에 실패했습니다.'
}

export function parseLineParam(raw: string | null): number | null {
  if (raw == null || raw === '') return null
  if (!/^[0-9]+$/.test(raw)) return null
  const line = Number(raw)
  return Number.isSafeInteger(line) && line > 0 ? line : null
}

export function toFocusedNode(node: GraphNodeSummary): FocusedNode {
  return {
    id: node.id,
    name: node.name,
    nodeType: node.nodeType,
    filePath: node.filePath,
    lineStart: node.lineStart,
  }
}

export function isFileSymbol(node: GraphNodeSummary): boolean {
  return node.nodeType !== 'FILE' && node.nodeType !== 'DIRECTORY'
}
