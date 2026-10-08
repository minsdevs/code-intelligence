import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ts } from 'ts-morph'
import type { AnalyzeFile } from './types'

export const CACHE_ENTRY_BYTES = 128 * 1024
export const CACHE_TOTAL_BYTES = 16 * 1024 * 1024
export type CachedRow = { list: string; phase: number; items: Record<string, unknown>[] }
export type CachedFile = { path: string; key: string; rows: CachedRow[]; checksum: string }
export const CACHE_LISTS = ['routes', 'endpoints', 'components', 'hooks', 'stores', 'apiCalls', 'symbols',
  'semantic.endpoints', 'semantic.imports', 'semantic.nodes', 'semantic.edges', 'semantic.unresolvedCalls'] as const

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

let binary: string | undefined
function binaryIdentity(): string {
  if (binary) return binary
  const hash = createHash('sha256').update(`ts-cache-1:${ts.version}:${process.version}`)
  for (const name of readdirSync(__dirname).filter((name) => /\.(js|ts)$/.test(name) && !/\.(test|d)\.ts$/.test(name)).sort()) {
    hash.update(name).update(readFileSync(join(__dirname, name)))
  }
  hash.update(readFileSync(join(__dirname, '../package-lock.json')))
  binary = hash.digest('hex')
  return binary
}

/** Merkle dependencies avoid quadratic closure materialization on long import chains. */
export function cacheKeys(files: AnalyzeFile[], plan: {
  order: string[]; targets: Map<string, string[]>; global: string[]; nestCandidate(path: string): boolean
}): { keys: Map<string, string>; whole: string } {
  const hashes = new Map(files.map((file) => [file.path, digest(file.content)]))
  const manifest = files.map((file) => [file.path, hashes.get(file.path)])
  const whole = digest(JSON.stringify([binaryIdentity(), manifest]))
  const byPath = new Map(files.map((file) => [file.path, file]))
  const modules = new Map<string, string>()
  const visiting = new Set<string>()
  // Computed imports, script globals and Nest provider/prefix facts have nonlocal dependencies.
  // They intentionally invalidate against the complete manifest, never a guessed closure.
  const nonlocal = plan.global.length > 0 || plan.order.some((path) => plan.nestCandidate(path))
  const context = digest(JSON.stringify([binaryIdentity(), files.map((file) => file.path),
    files.filter((file) => !plan.targets.has(file.path)).map((file) => [file.path, hashes.get(file.path)])]))
  const keys = new Map<string, string>()
  for (const start of plan.order) {
    const stack: { path: string; exit: boolean }[] = [{ path: start, exit: false }]
    while (stack.length) {
      const { path, exit } = stack.pop()!
      if (modules.has(path)) continue
      const targets = plan.targets.get(path)
      if (!targets || nonlocal || /(?:import|require)\s*\(\s*[^'"\s]/.test(byPath.get(path)!.content)) {
        modules.set(path, whole)
        continue
      }
      if (exit) {
        visiting.delete(path)
        modules.set(path, digest(JSON.stringify([path, hashes.get(path), targets.map((target) => modules.get(target) ?? whole)])))
      } else if (visiting.has(path)) {
        modules.set(path, whole)
      } else {
        visiting.add(path)
        stack.push({ path, exit: true })
        for (const target of targets) if (!modules.has(target)) stack.push({ path: target, exit: false })
      }
    }
    keys.set(start, digest(JSON.stringify([context, modules.get(start)])))
  }
  return { keys, whole }
}

export function readCachedFile(encoded: unknown, path: string, key: string, whole: string): CachedFile | undefined {
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > CACHE_ENTRY_BYTES) return undefined
  try {
    const value = JSON.parse(encoded) as CachedFile
    if (!value || value.path !== path || (value.key !== key && value.key !== whole) || !Array.isArray(value.rows)
      || value.rows.length > 64 || typeof value.checksum !== 'string') return undefined
    if (value.checksum !== digest(JSON.stringify([value.path, value.key, value.rows]))) return undefined
    for (const row of value.rows) {
      if (!CACHE_LISTS.includes(row.list as typeof CACHE_LISTS[number]) || !Number.isInteger(row.phase)
        || row.phase < 1 || row.phase > 7 || !Array.isArray(row.items)
        || row.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) return undefined
    }
    return value
  } catch {
    return undefined
  }
}

export function encodeCachedFile(path: string, key: string, rows: CachedRow[]): string | undefined {
  const checksum = digest(JSON.stringify([path, key, rows]))
  const encoded = JSON.stringify({ path, key, rows, checksum })
  return Buffer.byteLength(encoded) <= CACHE_ENTRY_BYTES ? encoded : undefined
}
