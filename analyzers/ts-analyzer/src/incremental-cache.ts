import { createHash, createHmac, randomBytes } from 'node:crypto'
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
const localKey = randomBytes(32).toString('hex')

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
  order: string[]; targets: Map<string, string[]>; global: string[]; unknown: Set<string>; nestCandidate(path: string): boolean
}): { keys: Map<string, string>; whole: string } {
  const hashes = new Map(files.map((file) => [file.path, digest(file.content)]))
  const whole = digest(JSON.stringify([binaryIdentity(), files.map((file) => [file.path, hashes.get(file.path)])]))
  const reverse = new Map(plan.order.map((path) => [path, [] as string[]]))
  for (const [path, targets] of plan.targets) for (const target of targets) reverse.get(target)?.push(path)
  const visited = new Set<string>()
  const finish: string[] = []
  for (const start of plan.order) {
    const stack: { path: string; exit: boolean }[] = [{ path: start, exit: false }]
    while (stack.length) {
      const { path, exit } = stack.pop()!
      if (exit) { finish.push(path); continue }
      if (visited.has(path)) continue
      visited.add(path)
      stack.push({ path, exit: true })
      for (const target of plan.targets.get(path) ?? []) if (!visited.has(target)) stack.push({ path: target, exit: false })
    }
  }
  // Collapse known dependency cycles instead of expanding each file's closure or invalidating
  // unrelated modules. The condensed graph is acyclic and can be hashed once bottom-up.
  const component = new Map<string, number>()
  const groups: string[][] = []
  for (const start of finish.reverse()) {
    if (component.has(start)) continue
    const group: string[] = []
    const stack = [start]
    component.set(start, groups.length)
    while (stack.length) {
      const path = stack.pop()!
      group.push(path)
      for (const target of reverse.get(path) ?? []) if (!component.has(target)) {
        component.set(target, groups.length)
        stack.push(target)
      }
    }
    groups.push(group.sort())
  }
  const groupHashes = new Map<number, string>()
  for (let index = groups.length - 1; index >= 0; index--) {
    const members = groups[index]
    const targets = new Set<number>()
    let unknown = false
    for (const path of members) {
      unknown ||= !plan.targets.has(path) || plan.unknown.has(path)
      for (const target of plan.targets.get(path) ?? []) {
        const targetGroup = component.get(target)
        if (targetGroup === undefined) unknown = true
        else if (targetGroup !== index) targets.add(targetGroup)
      }
    }
    const dependencies = [...targets].sort((a, b) => a - b).map((target) => groupHashes.get(target) ?? whole)
    groupHashes.set(index, unknown ? whole : digest(JSON.stringify([members.map((path) => [path, hashes.get(path)]), dependencies])))
  }
  const global = [...new Set([...plan.global, ...plan.order.filter((path) => plan.nestCandidate(path))])]
    .map((path) => [path, groupHashes.get(component.get(path)!)])
  const context = digest(JSON.stringify([binaryIdentity(), files.map((file) => file.path), global,
    files.filter((file) => !plan.targets.has(file.path)).map((file) => [file.path, hashes.get(file.path)])]))
  const keys = new Map(plan.order.map((path) => [path, digest(JSON.stringify([context, groupHashes.get(component.get(path)!)]))]))
  return { keys, whole }
}

export function readCachedFile(encoded: unknown, path: string, key: string, whole: string, cacheKey = localKey): CachedFile | undefined {
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > CACHE_ENTRY_BYTES) return undefined
  try {
    const value = JSON.parse(encoded) as CachedFile
    if (!value || value.path !== path || (value.key !== key && value.key !== whole) || !Array.isArray(value.rows)
      || value.rows.length > 64 || typeof value.checksum !== 'string') return undefined
    if (value.checksum !== createHmac('sha256', cacheKey).update(JSON.stringify([value.path, value.key, value.rows])).digest('hex')) return undefined
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

export function encodeCachedFile(path: string, key: string, rows: CachedRow[], cacheKey = localKey): string | undefined {
  const checksum = createHmac('sha256', cacheKey).update(JSON.stringify([path, key, rows])).digest('hex')
  const encoded = JSON.stringify({ path, key, rows, checksum })
  return Buffer.byteLength(encoded) <= CACHE_ENTRY_BYTES ? encoded : undefined
}
