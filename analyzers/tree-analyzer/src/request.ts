import type { AnalyzeFile, AnalyzeRequest } from './types'

const MAX_CONTENT_BYTES = 1_048_576

/** A client error in the analyze request; both transports answer it with 400 and its message. */
export class AnalyzeRequestError extends Error {}

function assertSafeRelativePath(path: string): string {
  if (!path || path.trim().length === 0) {
    throw new AnalyzeRequestError('file path must not be blank')
  }
  if (path.includes('\0')) {
    throw new AnalyzeRequestError('file path must not contain NUL')
  }
  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new AnalyzeRequestError('file path must be relative')
  }
  if (normalized.split('/').some((part) => part === '..')) {
    throw new AnalyzeRequestError('file path must not contain ..')
  }
  return normalized.replace(/^\.\//, '')
}

export function parseAnalyzeRequest(value: unknown): AnalyzeFile[] {
  const body = value as AnalyzeRequest | undefined
  if (!body || !Array.isArray(body.files)) {
    throw new AnalyzeRequestError('files array is required')
  }
  if (body.files.length > 500) {
    throw new AnalyzeRequestError('at most 500 files per request')
  }
  return body.files.map((file) => {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new AnalyzeRequestError('each file needs path and content strings')
    }
    const path = assertSafeRelativePath(file.path)
    if (Buffer.byteLength(file.content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new AnalyzeRequestError('file content exceeds 1 MiB')
    }
    const cache = parseCacheKey(value) && typeof file.cache === 'string' && Buffer.byteLength(file.cache) <= 128 * 1024 ? file.cache : undefined
    return { path, content: file.content, ...(cache === undefined ? {} : { cache }) }
  })
}

export function parseLocalPaths(value: unknown): string[] | undefined {
  const paths = (value as AnalyzeRequest | undefined)?.localPaths
  if (paths === undefined) return undefined
  if (!Array.isArray(paths) || paths.length > 50_000 || Buffer.byteLength(JSON.stringify(paths)) > 2 * 1024 * 1024) {
    throw new AnalyzeRequestError('localPaths exceeds the project inventory limit')
  }
  return paths.map((path) => {
    if (typeof path !== 'string') throw new AnalyzeRequestError('localPaths needs path strings')
    return assertSafeRelativePath(path)
  })
}

export function parseCacheKey(value: unknown): string | undefined {
  const key = (value as AnalyzeRequest | undefined)?.cacheKey
  return typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) ? key : undefined
}
