import { expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { CACHE_DECODED_BYTES, CACHE_ENTRY_BYTES, CACHE_RAW_ENTRY_BYTES, decodeCachedFile, readCachedEnvelope } from './incremental-cache'
import * as cacheCodec from './incremental-cache'
import { extractTs } from './ts-extractor'
import type { AnalyzeFile, AnalyzeResponse } from './types'

const files: AnalyzeFile[] = [
  ...Array.from({ length: 20 }, (_, index) => [
    { path: `m${index}.ts`, content: `import { Module } from '@nestjs/common'; import { Service${index} } from './s${index}'; @Module({ providers: [Service${index}] }) export class Module${index} {}` },
    { path: `s${index}.ts`, content: `export class Service${index} { run() { return ${index} } }` },
  ]).flat(),
  { path: 'alone.ts', content: 'export function alone() { return 1 }' },
]
const canonical = ({ cache: _cache, ...result }: AnalyzeResponse) => result
function seed(input: AnalyzeFile[], result: AnalyzeResponse) {
  const cache = new Map(result.cache!.map((entry) => [JSON.parse(entry).path, entry]))
  return input.map((file) => ({ ...file, cache: cache.get(file.path) }))
}

it('returns compressed authenticated tokens rather than repeated result JSON', () => {
  const cold = extractTs(files, { incremental: true })
  expect(cold.cache).toHaveLength(files.length)
  for (const token of cold.cache!) expect(JSON.parse(token).codec).toBe('deflate-raw-v2')
  const decode = vi.spyOn(cacheCodec, 'decodeCachedFile')
  try {
    const warm = extractTs(seed(files, cold), { incremental: true })
    expect(canonical(warm)).toEqual(extractTs(files))
    expect(decode).toHaveBeenCalledTimes(files.length)
  } finally { decode.mockRestore() }
})

it('reuses unchanged Nest metadata without constructing its compiler context', () => {
  const cold = extractTs(files, { incremental: true })
  const changed = files.map((file) => file.path === 'alone.ts' ? { ...file, content: file.content.replace('return 1', 'return 2') } : file)
  const metadata: string[] = [], programs: number[] = []
  const warm = extractTs(seed(changed, cold), { incremental: true,
    onMetadataReuse: (path: string) => metadata.push(path), onProgram: (program) => programs.push(program.files) })
  expect(canonical(warm)).toEqual(extractTs(changed))
  expect(metadata).toHaveLength(20)
  expect(programs).toEqual([1])
})


it('invalidates metadata dependency, config and global changes without retaining ASTs', () => {
  const cold = extractTs(files, { incremental: true })
  const changed = files.map((file) => file.path === 's3.ts' ? { ...file, content: file.content.replace('run()', 'renamed()') } : file)
  const reused: string[] = []
  const warm = extractTs(seed(changed, cold), { incremental: true, onMetadataReuse: (path) => reused.push(path) })
  expect(canonical(warm)).toEqual(extractTs(changed))
  expect(reused).toHaveLength(19)
  expect(reused).not.toContain('m3.ts')
  for (const addition of [
    { path: 'tsconfig.json', content: '{"compilerOptions":{"baseUrl":"."}}' },
    { path: 'globals.d.ts', content: 'declare const globalVersion: number' },
  ]) {
    const observed: string[] = []
    const input = [...files, addition]
    const refreshed = extractTs(seed(input, cold), { incremental: true, onMetadataReuse: (path) => observed.push(path) })
    expect(canonical(refreshed)).toEqual(extractTs(input))
    expect(observed).toEqual([])
  }
})

it('does not invalidate provider metadata through unrelated Nest module import closures', () => {
  const linked = files.map((file) => file.path === 'm0.ts' ? { ...file,
    content: "import { Module1 } from './m1'; " + file.content.replace('providers:', 'imports: [Module1], providers:') } : file)
  const cold = extractTs(linked, { incremental: true })
  const changed = linked.map((file) => file.path === 's1.ts' ? { ...file, content: file.content.replace('return 1', 'return 2') } : file)
  const reused: string[] = []
  const warm = extractTs(seed(changed, cold), { incremental: true, onMetadataReuse: (path) => reused.push(path) })
  expect(canonical(warm)).toEqual(extractTs(changed))
  expect(reused).toContain('m0.ts')
  expect(reused).not.toContain('m1.ts')
  expect(reused).toHaveLength(19)
})

it('authenticates before inflate and bounds corrupt, oversized and cumulative payloads', () => {
  const cacheKey = 'c'.repeat(64)
  const cold = extractTs(files, { incremental: true, cacheKey })
  const original = JSON.parse(cold.cache![0])
  const signed = (data: string) => {
    const value = { ...original, data }
    value.checksum = createHmac('sha256', cacheKey).update(JSON.stringify([
      value.path, value.key, value.manifest, value.dependency, value.codec, value.data,
    ])).digest('hex')
    return JSON.stringify(value)
  }
  expect(readCachedEnvelope(JSON.stringify({ ...original, data: 'invalid' }), original.path, cacheKey)).toBeUndefined()
  for (const data of [Buffer.from('not compressed').toString('base64'),
    deflateRawSync(Buffer.alloc(CACHE_RAW_ENTRY_BYTES + 1, 65)).toString('base64'),
    deflateRawSync(JSON.stringify({ rows: [], metadata: { providers: [], methods: [], prefix: 'invalid' } })).toString('base64'),
  ]) {
    const encoded = signed(data)
    const envelope = readCachedEnvelope(encoded, original.path, cacheKey)!
    expect(envelope).toBeDefined()
    const budget = { remaining: CACHE_DECODED_BYTES }
    expect(decodeCachedFile(envelope, budget)).toBeUndefined()
    expect(budget.remaining).toBeLessThan(CACHE_DECODED_BYTES)
    const tokens = cold.cache!.map((token) => JSON.parse(token).path === original.path ? encoded : token)
    expect(canonical(extractTs(seed(files, { ...cold, cache: tokens }), { incremental: true, cacheKey }))).toEqual(extractTs(files))
  }
  const envelope = readCachedEnvelope(cold.cache![0], original.path, cacheKey)!
  const exhausted = { remaining: 1 }
  expect(decodeCachedFile(envelope, exhausted)).toBeUndefined()
  expect(exhausted.remaining).toBe(0)
  expect(decodeCachedFile(envelope, exhausted)).toBeUndefined()
  expect(decodeCachedFile(envelope, { remaining: CACHE_ENTRY_BYTES })).toBeDefined()
  const measured = { remaining: CACHE_DECODED_BYTES }
  expect(decodeCachedFile(envelope, measured)).toBeDefined()
  const rawBytes = CACHE_DECODED_BYTES - measured.remaining
  const cumulative = { remaining: rawBytes * 2 }
  expect(decodeCachedFile(envelope, cumulative)).toBeDefined()
  expect(decodeCachedFile(envelope, cumulative)).toBeDefined()
  expect(cumulative.remaining).toBe(0)
  expect(decodeCachedFile(envelope, cumulative)).toBeUndefined()
})


it('recomputes metadata for newly resolved declarations and unknown dependency or configuration inputs', () => {
  const missing = [
    { path: 'module.ts', content: "import { Module } from '@nestjs/common'; import { Service } from './service'; @Module({providers:[Service]}) export class AppModule {}" },
    { path: 'service.ts', content: 'export const pending = true' },
    { path: 'alone.ts', content: 'export const unrelated = 1' },
  ]
  const first = extractTs(missing, { incremental: true })
  const resolved = missing.map((file) => file.path === 'service.ts' ? { ...file, content: 'export class Service { run() { return 1 } }' } : file)
  const reused: string[] = []
  const changed = extractTs(seed(resolved, first), { incremental: true, onMetadataReuse: (path) => reused.push(path) })
  expect(canonical(changed)).toEqual(extractTs(resolved))
  expect(reused).toEqual([])
  for (const extra of [
    { path: 'module.ts', content: resolved[0].content + "; const dynamic = './service'; void import(dynamic)" },
    { path: 'tsconfig.json', content: '{"compilerOptions":{"baseUrl":"."}}' },
  ]) {
    const input = extra.path === 'module.ts' ? resolved.map((file) => file.path === extra.path ? extra : file) : [...resolved, extra]
    const cold = extractTs(input, { incremental: true })
    const next = input.map((file) => file.path === (extra.path === 'tsconfig.json' ? 'tsconfig.json' : 'alone.ts')
      ? { ...file, content: extra.path === 'tsconfig.json' ? '{ invalid' : 'export const unrelated = 2' } : file)
    const observed: string[] = []
    const warm = extractTs(seed(next, cold), { incremental: true, onMetadataReuse: (path) => observed.push(path) })
    expect(canonical(warm)).toEqual(extractTs(next))
    expect(observed).toEqual([])
  }
})
