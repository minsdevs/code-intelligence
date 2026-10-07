import type { LocalImportExclusionReason, LocalSourcePreview } from '../../api/types'

/** Translation keys of the exclusion reasons, in display order. */
export const importExclusionLabels: Record<LocalImportExclusionReason, string> = {
  GENERATED_DIRECTORY: 'preview.exclusion.GENERATED_DIRECTORY',
  SECRET_PATH: 'preview.exclusion.SECRET_PATH',
  IGNORED: 'preview.exclusion.IGNORED',
  BINARY: 'preview.exclusion.BINARY',
  OVERSIZED: 'preview.exclusion.OVERSIZED',
  FILE_LIMIT: 'preview.exclusion.FILE_LIMIT',
  SYMLINK: 'preview.exclusion.SYMLINK',
  HARD_LINK: 'preview.exclusion.HARD_LINK',
  SECRET_CONTENT: 'preview.exclusion.SECRET_CONTENT',
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

/** Fail closed on an incomplete approval response; counts never stand in for a token. */
export function isLocalSourcePreview(
  value: unknown,
  operation: 'INITIAL' | 'REFRESH',
): value is LocalSourcePreview {
  if (!value || typeof value !== 'object') return false
  const preview = value as Partial<LocalSourcePreview>
  if (
    preview.operation !== operation ||
    typeof preview.previewToken !== 'string' ||
    !preview.previewToken ||
    preview.previewToken.length > 512 ||
    typeof preview.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(preview.expiresAt)) ||
    typeof preview.sourceName !== 'string' ||
    !preview.sourceName ||
    preview.sourceName.length > 4096 ||
    !(
      preview.snapshotId === null ||
      (boundedInteger(preview.snapshotId, Number.MAX_SAFE_INTEGER) && preview.snapshotId > 0)
    ) ||
    (operation === 'INITIAL' && preview.snapshotId !== null)
  )
    return false
  const changes = preview.changes
  if (
    !changes ||
    !['added', 'modified', 'deleted', 'total'].every((key) =>
      boundedInteger(changes[key as keyof typeof changes], 200_000),
    ) ||
    changes.total !== changes.added + changes.modified + changes.deleted ||
    !Array.isArray(preview.changedPaths) ||
    preview.changedPaths.length > 50_000 ||
    !preview.changedPaths.every((path) => typeof path === 'string' && path.length <= 4096)
  )
    return false
  const summary = preview.localImport
  if (
    !summary ||
    summary.schemaVersion !== 1 ||
    summary.policyVersion !== 'local-ingest-v1' ||
    !boundedInteger(summary.acceptedFiles, 50_000) ||
    !boundedInteger(summary.bytesRead, 536_870_912) ||
    !summary.excludedEntriesByReason ||
    typeof summary.excludedEntriesByReason !== 'object' ||
    Array.isArray(summary.excludedEntriesByReason)
  )
    return false
  let encountered = summary.acceptedFiles
  for (const [reason, count] of Object.entries(summary.excludedEntriesByReason)) {
    if (!Object.hasOwn(importExclusionLabels, reason) || !boundedInteger(count, 200_000))
      return false
    encountered += count
  }
  return encountered <= 200_000
}
