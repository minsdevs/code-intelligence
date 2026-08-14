import { ApiError } from '../../api/client'
import { tt } from '../../lib/i18n-core'
import type { GraphNodeSummary } from '../../api/types'
import type { FocusedNode } from '../../stores/uiStore'

export function queryError(error: unknown): string | null {
  if (!error) return null
  if (error instanceof ApiError) return error.message
  return tt('common.requestFailed')
}

export function codeLocationSearch(path: string, line: number | null | undefined): string {
  const params = new URLSearchParams()
  params.set('path', path)
  if (line != null && line > 0) params.set('line', String(line))
  return `?${params.toString()}`
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
