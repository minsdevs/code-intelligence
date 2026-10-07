import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { BadRequestException } from '@nestjs/common'
import { AnalyzeService } from './analyze.service'
import { AnalyzeSessions, SESSION_IDLE_MS, manifestLine, paginate } from './analyze-session'
import { projectBoundaryFixture } from './fixtures/project-boundary'
import type { AnalyzeFile, AnalyzeResponse, SessionCommand } from './types'

const manifest = (files: AnalyzeFile[]) => ({
  fileCount: files.length,
  bytes: files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0),
  digest: createHash('sha256').update(files.map((file) => manifestLine(file.path, file.content)).join(''), 'utf8').digest('hex'),
})

const code = (expected: string) => (error: unknown) =>
  error instanceof BadRequestException && (error.getResponse() as { code?: string }).code === expected

async function runSession(service: AnalyzeService, files: AnalyzeFile[], chunk: number): Promise<AnalyzeResponse> {
  const call = (session: SessionCommand) => service.analyze({ files: [], session }) as unknown as Promise<
    AnalyzeResponse & { session: { id: string; pages?: number } }>
  const { id } = (await call({ op: 'open', ...manifest(files) })).session
  for (let seq = 0; seq * chunk < files.length; seq++) {
    await call({ op: 'put', id, seq, files: files.slice(seq * chunk, (seq + 1) * chunk) })
  }
  await call({ op: 'seal', id, ...manifest(files) })
  const first = await call({ op: 'analyze', id })
  const pages = [first]
  for (let page = 1; page < first.session.pages!; page++) pages.push(await call({ op: 'page', id, page }))
  await call({ op: 'close', id })
  const merged = {} as Record<string, unknown[]>
  for (const page of pages) {
    for (const [key, value] of Object.entries(page)) {
      if (key !== 'session') merged[key] = [...(merged[key] ?? []), ...(value as unknown[])]
    }
  }
  return merged as unknown as AnalyzeResponse
}

describe('chunked whole-project analysis session (03 §6)', () => {
  it('resolves cross-file calls and prefixes exactly like one request when the project arrives in chunks', async () => {
    const files = projectBoundaryFixture()
    const service = new AnalyzeService()
    const single = await service.analyze({ files })
    const chunked = await runSession(service, files, 7)
    expect(chunked).toEqual(single)
    expect(chunked.endpoints.map((endpoint) => endpoint.path)).toEqual(['/api/users'])
    expect(chunked.edges).toContainEqual(expect.objectContaining({
      sourceKey: 'ts:z-users.controller.ts#UsersController.list',
      targetKey: 'ts:b-users.service.ts#UsersService.list',
      type: 'CALLS',
    }))
  })

  it('accepts a project above the 10 MiB single-request budget', async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ path: `${i}.ts`, content: `export class C${i} {}\n//${'x'.repeat(1_000_000)}` }))
    const result = await runSession(new AnalyzeService(), files, 1)
    expect(result.nodes.map((node) => node.key)).toContain('ts:10.ts#C10')
  })

  it('pages a result within the page limit and restores it by concatenation', () => {
    const result = {
      fileOutcomes: [], routes: [], components: [], hooks: [], stores: [], apiCalls: [], imports: [], symbols: [], endpoints: [],
      nodes: Array.from({ length: 200 }, (_, i) => ({ key: `n${i}`, type: 'FUNCTION', name: `n${i}`, filePath: 'a.ts', lineStart: i, lineEnd: i, layer: null, metadata: { pad: 'p'.repeat(50) } })),
      edges: Array.from({ length: 100 }, (_, i) => ({ sourceKey: `n${i}`, targetKey: `n${i + 1}`, type: 'CALLS', confidence: 'CONFIRMED' as const, filePath: null, lineStart: null, lineEnd: null, metadata: {} })),
      unresolvedCalls: [],
    } as AnalyzeResponse
    const pages = paginate(result, 4096)
    expect(pages.length).toBeGreaterThan(5)
    for (const page of pages) expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
    expect(pages.flatMap((page) => page.nodes)).toEqual(result.nodes)
    expect(pages.flatMap((page) => page.edges)).toEqual(result.edges)
    expect(paginate({ ...result, nodes: [], edges: [] }, 4096)).toHaveLength(1)
  })

  it('fails seal on a missing, duplicated or changed file and forgets the session', async () => {
    const files = [{ path: 'a.ts', content: 'export const a = 1' }, { path: 'b.ts', content: 'export const b = 2' }]
    const sessions = new AnalyzeSessions(async () => { throw new Error('not reached') })

    let id = (await sessions.handle({ op: 'open', ...manifest(files) })).session.id
    await sessions.handle({ op: 'put', id, seq: 0, files: files.slice(0, 1) })
    await expect(sessions.handle({ op: 'seal', id, ...manifest(files) })).rejects.toSatisfy(code('SESSION_MANIFEST'))
    await expect(sessions.handle({ op: 'analyze', id })).rejects.toSatisfy(code('SESSION_UNKNOWN'))

    id = (await sessions.handle({ op: 'open', ...manifest(files) })).session.id
    await sessions.handle({ op: 'put', id, seq: 0, files: files.slice(0, 1) })
    await expect(sessions.handle({ op: 'put', id, seq: 1, files: files.slice(0, 1) })).rejects.toSatisfy(code('SESSION_DUPLICATE'))

    id = (await sessions.handle({ op: 'open', ...manifest(files) })).session.id
    await sessions.handle({ op: 'put', id, seq: 0, files: [files[0], { path: 'b.ts', content: 'export const b = 3' }] })
    await expect(sessions.handle({ op: 'seal', id, ...manifest(files) })).rejects.toSatisfy(code('SESSION_MANIFEST'))

    id = (await sessions.handle({ op: 'open', ...manifest(files) })).session.id
    await expect(sessions.handle({ op: 'put', id, seq: 1, files })).rejects.toSatisfy(code('SESSION_SEQUENCE'))
    await expect(sessions.handle({ op: 'put', id, seq: 0, files })).rejects.toSatisfy(code('SESSION_UNKNOWN'))
  })

  it('bounds manifests, open sessions and idle time', async () => {
    let now = 0
    const sessions = new AnalyzeSessions(async () => { throw new Error('not reached') }, () => now)
    const small = manifest([{ path: 'a.ts', content: '' }])
    await expect(sessions.handle({ op: 'open', ...small, fileCount: 50_001 })).rejects.toSatisfy(code('ANALYSIS_LIMIT'))
    await expect(sessions.handle({ op: 'open', ...small, bytes: 512 * 1024 * 1024 + 1 })).rejects.toSatisfy(code('ANALYSIS_LIMIT'))
    const first = (await sessions.handle({ op: 'open', ...small })).session.id
    await sessions.handle({ op: 'open', ...small })
    await expect(sessions.handle({ op: 'open', ...small })).rejects.toSatisfy(code('SESSION_LIMIT'))
    now += SESSION_IDLE_MS + 1
    await expect(sessions.handle({ op: 'put', id: first, seq: 0, files: [{ path: 'a.ts', content: '' }] }))
      .rejects.toSatisfy(code('SESSION_UNKNOWN'))
    await expect(sessions.handle({ op: 'open', ...small })).resolves.toBeDefined()
  })
})
