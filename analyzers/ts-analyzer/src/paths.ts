const MAX_CONTENT_BYTES = 1_048_576

export function assertSafeRelativePath(path: string): string {
  if (!path || path.trim().length === 0) {
    throw new Error('file path must not be blank')
  }
  if (path.includes('\0')) {
    throw new Error('file path must not contain NUL')
  }
  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('file path must be relative')
  }
  const parts = normalized.split('/')
  if (parts.some((part) => part === '..')) {
    throw new Error('file path must not contain ..')
  }
  return normalized.replace(/^\.\//, '')
}

export function assertContentSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error('file content exceeds 1 MiB')
  }
}

export function resolveRelativeImport(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const joined = (fromDir ? `${fromDir}/` : '') + specifier
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      if (parts.length === 0) {
        return null
      }
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

export function isTsJs(path: string): boolean {
  return /\.(tsx?|jsx?|mjs|cjs)$/i.test(path)
}

export function isPython(path: string): boolean {
  return path.toLowerCase().endsWith('.py')
}

export function isGo(path: string): boolean {
  return path.toLowerCase().endsWith('.go')
}
