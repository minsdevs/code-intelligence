import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AnalyzeFile, AnalyzeResponse } from './types'

const LIMIT = 128 * 1024
const LISTS = ['fileOutcomes', 'routes', 'components', 'hooks', 'stores', 'apiCalls', 'imports', 'symbols', 'endpoints', 'entities'] as const
let binary: string | undefined
const localKey = randomBytes(32).toString('hex')

export function treeContext(paths: Set<string>): string {
  if (!binary) {
    const hash = createHash('sha256').update(`tree-cache-1:${process.version}`)
    for (const name of readdirSync(__dirname).filter((name) => /\.(js|ts)$/.test(name) && !/\.(test|d)\.ts$/.test(name)).sort()) {
      hash.update(name).update(readFileSync(join(__dirname, name)))
    }
    hash.update(readFileSync(join(__dirname, '../package-lock.json')))
    binary = hash.digest('hex')
  }
  return createHash('sha256').update(JSON.stringify([binary, [...paths].sort()])).digest('hex')
}

/** Current tree extractors depend on local source and Python's complete module-path inventory. */
export function treeFile(file: AnalyzeFile, context: string, compute: () => AnalyzeResponse, onReuse?: (path: string) => void, cacheKey = localKey): { result: AnalyzeResponse; cache?: string } {
  const key = createHash('sha256').update(JSON.stringify([context, file.path, file.content])).digest('hex')
  if (typeof file.cache === 'string' && Buffer.byteLength(file.cache) <= LIMIT) {
    try {
      const value = JSON.parse(file.cache)
      if (value.path === file.path && value.key === key && value.result && !value.result.cache
        && LISTS.every((name) => Array.isArray(value.result[name]) && value.result[name].every((item: unknown) => item && typeof item === 'object' && !Array.isArray(item)))
        && value.checksum === createHmac('sha256', cacheKey).update(JSON.stringify([value.path, key, value.result])).digest('hex')) {
        onReuse?.(file.path)
        return { result: value.result, cache: file.cache }
      }
    } catch {
      // Optional corrupt entries are recomputed.
    }
  }
  const result = compute()
  if (result.fileOutcomes?.some((outcome) => outcome.status === 'FAILED')) return { result }
  const checksum = createHmac('sha256', cacheKey).update(JSON.stringify([file.path, key, result])).digest('hex')
  const cache = JSON.stringify({ path: file.path, key, result, checksum })
  return { result, ...(Buffer.byteLength(cache) <= LIMIT ? { cache } : {}) }
}
