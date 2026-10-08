import { expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { CACHE_DECODED_BYTES, CACHE_ENTRY_BYTES, decodeCachedFile, readCachedEnvelope } from './incremental-cache'
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
  for (const token of cold.cache!) expect(JSON.parse(token).codec).toBe('deflate-raw-v1')
  const warm = extractTs(seed(files, cold), { incremental: true })
  expect(canonical(warm)).toEqual(extractTs(files))
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
    deflateRawSync(Buffer.alloc(CACHE_ENTRY_BYTES + 1, 65)).toString('base64'),
    deflateRawSync(JSON.stringify({ rows: [], metadata: { providers: [], methods: [], prefix: 'invalid' } })).toString('base64'),
  ]) {
    const encoded = signed(data)
    const envelope = readCachedEnvelope(encoded, original.path, cacheKey)!
    expect(envelope).toBeDefined()
    expect(decodeCachedFile(envelope, { remaining: CACHE_DECODED_BYTES })).toBeUndefined()
    const tokens = cold.cache!.map((token) => JSON.parse(token).path === original.path ? encoded : token)
    expect(canonical(extractTs(seed(files, { ...cold, cache: tokens }), { incremental: true, cacheKey }))).toEqual(extractTs(files))
  }
  const envelope = readCachedEnvelope(cold.cache![0], original.path, cacheKey)!
  const exhausted = { remaining: 1 }
  expect(decodeCachedFile(envelope, exhausted)).toBeUndefined()
  expect(exhausted.remaining).toBe(0)
  expect(decodeCachedFile(envelope, exhausted)).toBeUndefined()
  expect(decodeCachedFile(envelope, { remaining: CACHE_ENTRY_BYTES })).toBeDefined()
})
