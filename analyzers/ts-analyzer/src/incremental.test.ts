import { describe, expect, it } from 'vitest'
import { extractTs } from './ts-extractor'
import type { AnalyzeFile, AnalyzeResponse } from './types'

const canonical = ({ cache: _cache, ...result }: AnalyzeResponse) => result
const base: AnalyzeFile[] = [
  { path: 'a.ts', content: 'export function a() { return 1 }' },
  { path: 'b.ts', content: "import { a } from './a'; export function b() { return a() }" },
  { path: 'alone.ts', content: 'export function alone() { return 0 }' },
]
function seed(files: AnalyzeFile[], previous: AnalyzeResponse): AnalyzeFile[] {
  const cache = new Map((previous.cache ?? []).map((entry) => [JSON.parse(entry).path, entry]))
  return files.map((file) => ({ ...file, cache: cache.get(file.path) }))
}
function refresh(files: AnalyzeFile[], previous: AnalyzeResponse) {
  const reused: string[] = []
  const result = extractTs(seed(files, previous), { incremental: true, onReuse: (path) => reused.push(path) })
  expect(canonical(result)).toEqual(canonical(extractTs(files)))
  return { result, reused }
}

describe('incremental whole-manifest extraction', () => {
  it('reuses immutable results across destroyed workers, reparses edits and reverse dependencies', () => {
    const first = extractTs(base, { incremental: true })
    expect(first.cache).toHaveLength(3)
    expect(refresh(base, first).reused.sort()).toEqual(['a.ts', 'alone.ts', 'b.ts'])
    const changed = base.map((file) => file.path === 'a.ts' ? { ...file, content: 'export function a(value: string) { return value }' } : file)
    expect(refresh(changed, first).reused).toEqual(['alone.ts'])
    expect(refresh(base.map((file) => file.path === 'alone.ts' ? { ...file, content: 'export function alone() { return 2 }' } : file), first).reused.sort()).toEqual(['a.ts', 'b.ts'])
  })

  it.each([
    ['addition', [...base, { path: 'new.ts', content: 'export const added = 1' }]],
    ['deletion', base.filter((file) => file.path !== 'a.ts')],
    ['rename', base.map((file) => file.path === 'a.ts' ? { ...file, path: 'renamed.ts' } : file)],
    ['config', [...base, { path: 'tsconfig.json', content: '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}' }]],
    ['global', [...base, { path: 'globals.d.ts', content: 'declare function fetch(value: string): void' }]],
    ['routes', [...base, { path: 'app/page.tsx', content: 'export default function Page() { return <div/> }' }]],
  ])('matches independent clean extraction after %s', (_name, files) => {
    refresh(files as AnalyzeFile[], extractTs(base, { incremental: true }))
  })

  it('resolves previously missing imports and rejects corrupt or mismatched cache', () => {
    const missing = base.filter((file) => file.path !== 'a.ts')
    const first = extractTs(missing, { incremental: true })
    refresh(base, first)
    const valid = extractTs(base, { incremental: true })
    const corrupt = { ...valid, cache: valid.cache!.map((entry) => entry.replace('FUNCTION', 'CORRUPTED')) }
    refresh(base, corrupt)
    expect(canonical(extractTs(base.map((file) => ({ ...file, cache: 'unknown' })), { incremental: true }))).toEqual(canonical(extractTs(base)))
  })

  it('retains syntax rejection with reusable neighbours', () => {
    const first = extractTs(base, { incremental: true })
    expect(() => extractTs(seed([...base, { path: 'bad.ts', content: 'export function {' }], first), { incremental: true })).toThrow()
  })
})
