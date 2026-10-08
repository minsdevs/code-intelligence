import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { AnalyzeService } from './analyze.service'
import { manifestLine } from './analyze-session'
import { extractTs } from './ts-extractor'
import type { AnalyzeFile, AnalyzeResponse, SessionReply } from './types'

it('carries bounded opaque cache through a new sealed session with the complete changed manifest', async () => {
  const files: AnalyzeFile[] = [
    { path: 'a.ts', content: 'export const a = 1', cache: '' },
    { path: 'b.ts', content: "import { a } from './a'; export const b = a", cache: '' },
    { path: 'independent.ts', content: 'export function independent() { return 0 }', cache: '' },
  ]
  async function run(input: AnalyzeFile[]) {
    // A new service stands for a destroyed per-job worker, not a surviving parser cache.
    const service = new AnalyzeService()
    const manifest = { fileCount: input.length, bytes: input.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
      digest: createHash('sha256').update(input.map((file) => manifestLine(file.path, file.content)).join('')).digest('hex') }
    const opened = await service.analyze({ files: [], session: { op: 'open', ...manifest, cacheKey: 'a'.repeat(64) } }) as unknown as { session: SessionReply }
    const id = opened.session.id
    for (let seq = 0; seq < input.length; seq++) await service.analyze({ files: [], session: { op: 'put', id, seq, files: [input[seq]] } })
    await service.analyze({ files: [], session: { op: 'seal', id, ...manifest } })
    const first = await service.analyze({ files: [], session: { op: 'analyze', id } }) as AnalyzeResponse & { session: SessionReply }
    const { session, ...result } = first
    for (let page = 1; page < session.pages!; page++) {
      const next = await service.analyze({ files: [], session: { op: 'page', id, page } })
      for (const key of Object.keys(result) as (keyof AnalyzeResponse)[]) (result[key] as unknown[]).push(...(next[key] ?? []))
    }
    await service.analyze({ files: [], session: { op: 'close', id } })
    return result
  }
  const first = await run(files)
  expect(first.cache).toHaveLength(3)
  const cache = new Map(first.cache!.map((entry) => [JSON.parse(entry).path, entry]))
  const changed = files.map((file) => ({ ...file, content: file.path === 'a.ts' ? 'export const a = "changed"' : file.content, cache: cache.get(file.path) }))
  const second = await run(changed)
  const { cache: _cache, ...graph } = second
  expect(graph).toEqual(extractTs(changed))
  expect(second.cache).toHaveLength(3)
})
