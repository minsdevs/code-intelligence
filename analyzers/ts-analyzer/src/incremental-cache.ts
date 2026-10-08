import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ts } from 'ts-morph'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { AnalyzeFile } from './types'
import { resolutionInputKind, type ManifestFacts, type ManifestFileFacts } from './semantic-extractor'

export const CACHE_ENTRY_BYTES = 128 * 1024
export const CACHE_TOTAL_BYTES = 16 * 1024 * 1024
export const CACHE_DECODED_BYTES = 64 * 1024 * 1024
export type CachedRow = { list: string; phase: number; items: Record<string, unknown>[] }
export type CachedEnvelope = {
  path: string; key: string; manifest: string; dependency: string
  codec: 'deflate-raw-v1'; data: string; checksum: string
}
export type CachedFile = CachedEnvelope & { rows: CachedRow[]; metadata?: ManifestFileFacts }
export type DecodeBudget = { remaining: number }
export const CACHE_LISTS = ['routes', 'endpoints', 'components', 'hooks', 'stores', 'apiCalls', 'symbols',
  'semantic.endpoints', 'semantic.imports', 'semantic.nodes', 'semantic.edges', 'semantic.unresolvedCalls'] as const
const localKey = randomBytes(32).toString('hex')

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

let binary: string | undefined
function binaryIdentity(): string {
  if (binary) return binary
  const hash = createHash('sha256').update(`ts-cache-3:${ts.version}:${process.version}`)
  for (const name of readdirSync(__dirname).filter((name) => /\.(js|ts)$/.test(name) && !/\.(test|d)\.ts$/.test(name)).sort()) {
    hash.update(name).update(readFileSync(join(__dirname, name)))
  }
  hash.update(readFileSync(join(__dirname, '../package-lock.json')))
  binary = hash.digest('hex')
  return binary
}

/** Merkle dependencies avoid quadratic closure materialization on long import chains. */
export function cacheKeys(files: AnalyzeFile[], plan: {
  order: string[]; targets: Map<string, string[]>; global: string[]; unknown: Set<string>
}): { keys(facts: ManifestFacts): Map<string, string>; dependencies: Map<string, string>; whole: string } {
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
  const global = plan.global.map((path) => [path, groupHashes.get(component.get(path)!)])
  const context = digest(JSON.stringify([binaryIdentity(), files.map((file) => file.path), global,
    files.filter((file) => resolutionInputKind(file.path) !== null).map((file) => [file.path, hashes.get(file.path)])]))
  const dependencies = new Map(plan.order.map((path) => [path, digest(JSON.stringify([context, groupHashes.get(component.get(path)!)]))]))
  return { whole, dependencies, keys(facts) {
    // Only facts consumed globally by extraction belong here. Method bodies and revision
    // constants remain in their per-file dependency keys, not every unrelated module's key.
    const ref = (value: { key: string; name: string; filePath: string }) => [value.key, value.name, value.filePath]
    const nest = digest(JSON.stringify([
      facts.providers.map((value) => [value.filePath, value.token, ref(value.ref)]),
      [...facts.providerMethods].map(([key, value]) => [key, ref(value)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [...facts.prefixFacts].sort(([a], [b]) => a.localeCompare(b)),
    ]))
    return new Map(plan.order.map((path) => [path, digest(JSON.stringify([dependencies.get(path), nest]))]))
  } }

}

function signature(value: Omit<CachedEnvelope, 'checksum'>, cacheKey: string): string {
  return createHmac('sha256', cacheKey).update(JSON.stringify([
    value.path, value.key, value.manifest, value.dependency, value.codec, value.data,
  ])).digest('hex')
}

/** No decompression or payload parsing happens before the envelope is authenticated. */
export function readCachedEnvelope(encoded: unknown, path: string, cacheKey = localKey): CachedEnvelope | undefined {
  if (typeof encoded !== 'string' || encoded.length * 2 > CACHE_ENTRY_BYTES) return undefined
  try {
    const value = JSON.parse(encoded) as CachedEnvelope
    if (!value || Object.keys(value).length !== 7 || value.path !== path || value.codec !== 'deflate-raw-v1'
      || ![value.key, value.manifest, value.dependency, value.checksum].every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
      || typeof value.data !== 'string' || value.checksum !== signature(value, cacheKey)) return undefined
    return value
  } catch {
    return undefined
  }
}

export function decodeCachedFile(value: CachedEnvelope, budget: DecodeBudget): CachedFile | undefined {
  if (budget.remaining <= 0) return undefined
  try {
    const compressed = Buffer.from(value.data, 'base64')
    if (compressed.toString('base64') !== value.data) return undefined
    const limit = Math.min(CACHE_ENTRY_BYTES, budget.remaining)
    budget.remaining -= limit
    const raw = inflateRawSync(compressed, { maxOutputLength: limit })
    budget.remaining += limit - raw.length
    const payload = JSON.parse(raw.toString('utf8')) as { rows: CachedRow[]; metadata?: ManifestFileFacts }
    if (!payload || Object.keys(payload).some((key) => key !== 'rows' && key !== 'metadata')
      || !Array.isArray(payload.rows) || payload.rows.length > 64) return undefined
    for (const row of payload.rows) {
      if (!row || !CACHE_LISTS.includes(row.list as typeof CACHE_LISTS[number]) || !Number.isInteger(row.phase)
        || row.phase < 1 || row.phase > 7 || !Array.isArray(row.items)
        || row.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) return undefined
    }
    if (payload.metadata !== undefined && !validMetadata(payload.metadata)) return undefined
    return { ...value, ...payload }
  } catch {
    return undefined
  }
}

function validMetadata(value: ManifestFileFacts): boolean {
  const ref = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3 && ['key', 'name', 'filePath'].every((key) => typeof (value as Record<string, unknown>)[key] === 'string')
  if (!value || Object.keys(value).length !== 3 || !Array.isArray(value.providers) || value.providers.length > 4096
    || value.providers.some((item) => !item || Object.keys(item).length !== 2 || typeof item.token !== 'string' || !ref(item.ref))
    || !Array.isArray(value.methods) || value.methods.length > 4096
    || value.methods.some((item) => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !ref(item[1]))) return false
  const prefix = value.prefix
  return !!prefix && Object.keys(prefix).length === 4 && typeof prefix.unknown === 'boolean' && typeof prefix.invalid === 'boolean'
    && Number.isSafeInteger(prefix.applications) && prefix.applications >= 0
    && Array.isArray(prefix.prefixes) && prefix.prefixes.every((value) => typeof value === 'string')
}

export function encodeCachedFile(value: {
  path: string; key: string; manifest: string; dependency: string; rows: CachedRow[]; metadata?: ManifestFileFacts
}, cacheKey = localKey): string | undefined {
  const raw = JSON.stringify({ rows: value.rows, metadata: value.metadata })
  if (Buffer.byteLength(raw) > CACHE_ENTRY_BYTES) return undefined
  const envelope: Omit<CachedEnvelope, 'checksum'> = {
    path: value.path, key: value.key, manifest: value.manifest, dependency: value.dependency,
    codec: 'deflate-raw-v1', data: deflateRawSync(raw).toString('base64'),
  }
  const encoded = JSON.stringify({ ...envelope, checksum: signature(envelope, cacheKey) })
  return encoded.length * 2 <= CACHE_ENTRY_BYTES ? encoded : undefined
}
