import { ApiError } from '../../api/client'
import { tt } from '../../lib/i18n-core'
import type { GraphNodeSummary } from '../../api/types'
import type { FocusedNode } from '../../stores/uiStore'

export function queryError(error: unknown): string | null {
  if (!error) return null
  if (error instanceof ApiError) return error.message
  return tt('common.requestFailed')
}

export type SourceContext = {
  snapshotId?: number | null
  evidenceId?: number | null
  current?: boolean
  versioned?: boolean
}

// Existing versioned links without a server-resolved snapshot fail closed. Plain notes opt into current.
export function codeLocationSearch(
  path: string,
  line: number | null | undefined,
  context: SourceContext = {},
): string {
  const params = new URLSearchParams({ path })
  if (line != null && line > 0) params.set('line', String(line))
  if (context.snapshotId != null) params.set('snapshotId', String(context.snapshotId))
  if (context.evidenceId != null) params.set('evidenceId', String(context.evidenceId))
  params.set(
    'sourceContext',
    context.current
      ? 'current'
      : context.snapshotId != null
        ? context.versioned
          ? 'evidence'
          : 'snapshot'
        : 'unknown',
  )
  return `?${params}`
}

export function parseLineParam(raw: string | null): number | null {
  if (raw == null || raw === '') return null
  if (!/^[0-9]+$/.test(raw)) return null
  const line = Number(raw)
  return Number.isSafeInteger(line) && line > 0 ? line : null
}

// Match harmless spellings accepted by SafeRelativePath without making an unsafe path safe.
// Invalid input is left intact so the authenticated server remains the validation boundary.
export function canonicalSourcePath(raw: string | null): string | null {
  if (raw == null) return null
  const path = raw.replaceAll('\\', '/')
  if (
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    /%2e|%2f|%5c/i.test(path) ||
    path.includes('\0') ||
    path.split('/').includes('..')
  )
    return raw
  const canonical = path
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/')
  return canonical || raw
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
