import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { extractTs } from './ts-extractor'
import type { AnalyzeFile } from './types'

const require = createRequire(import.meta.url)
const { generateWorkload, mutateWorkload, planWorkload } = require('../../../validation/pre-release/workload-fixture.cjs')

it('reuses results for the real seeded 1% revision mutation including Nest services', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adapter-revision-')))
  try {
    const spec = { files: 1200, bytes: 6 * 1024 * 1024, seed: 'g-perf-1' }
    const manifest = generateWorkload({ root, ...spec })
    const files: AnalyzeFile[] = planWorkload(spec).files.map(({ path, content }: AnalyzeFile) => ({ path, content }))
    const coldPrograms: number[] = []
    const cold = extractTs(files, { incremental: true, onProgram: (program) => coldPrograms.push(program.files) })
    const previous = new Map(cold.cache!.map((entry) => [JSON.parse(entry).path, entry]))
    const mutation = mutateWorkload({ root, manifest })
    const changed = files.map((file) => ({ path: file.path, content: readFileSync(join(root, file.path), 'utf8'), cache: previous.get(file.path) }))
    const edited = changed.filter((file, index) => file.content !== files[index].content).map((file) => file.path)
    expect(edited).toHaveLength(mutation.changedFiles)
    expect(edited.some((path) => path.endsWith('.service.ts'))).toBe(true)
    const reused: string[] = [], programs: number[] = []
    const { cache: _cache, ...incremental } = extractTs(changed, { incremental: true,
      onReuse: (path) => reused.push(path), onProgram: (program) => programs.push(program.files) })
    expect(incremental).toEqual(extractTs(changed))
    console.log(JSON.stringify({ mutation: 'g-perf-change-1', changed: edited,
      reused: reused.length, coldProgramFiles: coldPrograms.reduce((a, b) => a + b, 0),
      refreshProgramFiles: programs.reduce((a, b) => a + b, 0), fullEquality: true }))
    expect(reused.length).toBeGreaterThan(0)
    expect(reused.some((path) => path.startsWith('web/'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
