import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { ParserSyntaxError } from './syntax-diagnostics'
import { extractTs } from './ts-extractor'
import type { AnalyzeFile } from './types'

// A deep relative import chain, like the workload fixture's `u{i}.js` helper chain.
function importChain(length: number): AnalyzeFile[] {
  return Array.from({ length }, (_, i) => ({
    path: `src/chain/c${i}.ts`,
    content: i === length - 1
      ? `export const v${i} = ${i}\n`
      : `import { v${i + 1} } from './c${i + 1}'\nexport const v${i} = v${i + 1} + 1\n`,
  }))
}

describe('TS extraction at the large size class', () => {
  it('resolves a 6,000-file import chain without recursing once per link', () => {
    const result = extractTs(importChain(6000))
    expect(result.imports).toHaveLength(5999)
    expect(result.imports[0]).toEqual(expect.objectContaining({ fromPath: 'src/chain/c0.ts', toPath: 'src/chain/c1.ts' }))
    expect(result.fileOutcomes).toHaveLength(6000)
  }, 120_000)
})

const require = createRequire(import.meta.url)
const { planWorkload } = require('../../../validation/pre-release/workload-fixture.cjs') as {
  planWorkload(spec: { files: number; bytes: number; seed: string }): { files: { path: string; content: string }[] }
}
const SLICED = { singleProgramBytes: 0 }

function workload(files: number, bytes: number): AnalyzeFile[] {
  return planWorkload({ files, bytes, seed: 'g-perf-1' }).files.map(({ path, content }) => ({ path, content }))
}

describe('sliced whole-manifest TS extraction', () => {
  it('equals one whole-manifest program on the reduced workload fixture, in order, with bounded programs', () => {
    const files = workload(600, 3 * 1024 * 1024)
    const programs: { files: number; bytes: number }[] = []
    const sliced = extractTs(files, { ...SLICED, sliceProgramBytes: 256 * 1024, onProgram: (program) => programs.push(program) })
    expect(sliced).toEqual(extractTs(files))
    const tsBytes = files.filter((file) => /\.(ts|tsx|js)$/.test(file.path)).reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)
    expect(programs.length).toBeGreaterThan(4)
    // A program is the budget plus the hubs' direct imports (the router imports every page).
    expect(Math.max(...programs.map((program) => program.bytes))).toBeLessThan(tsBytes / 2)
  }, 120_000)

  it('resolves across slice boundaries: barrels, path aliases, Nest tokens, global prefix and global scripts', () => {
    const files: AnalyzeFile[] = [
      { path: 'web/tsconfig.json', content: '{ "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["src/shared/*"] } } }' },
      { path: 'web/src/routes.tsx', content: `import { Route } from 'react-router-dom'\nimport { Orders } from './pages'\n`
        + `export const routes = <Route path="/orders" element={<Orders />} />\n` },
      { path: 'web/src/pages/index.ts', content: `export { Orders } from './orders/Orders'\n` },
      { path: 'web/src/pages/orders/Orders.tsx', content: `import { label } from '@shared/label'\n`
        + `export function Orders() { return <section>{label('orders')}</section> }\n` },
      { path: 'web/src/shared/label.ts', content: `export function label(value: string) { return value.toUpperCase() }\n` },
      { path: 'web/src/api.ts', content: `export function load() { return fetch('/api/orders') }\n` },
      { path: 'web/legacy/globals.js', content: `var fetch = function () { return null }\n` },
      { path: 'server/src/main.ts', content: `import { NestFactory } from '@nestjs/core'\nimport { AppModule } from './app.module'\n`
        + `async function bootstrap() { const app = await NestFactory.create(AppModule); app.setGlobalPrefix('api'); await app.listen(3000) }\nbootstrap()\n` },
      { path: 'server/src/app.module.ts', content: `import { Module } from '@nestjs/common'\nimport { SystemClock } from './time/clock'\n`
        + `import { OrdersController } from './orders/orders.controller'\n`
        + `@Module({ controllers: [OrdersController], providers: [{ provide: 'CLOCK', useClass: SystemClock }] })\nexport class AppModule {}\n` },
      { path: 'server/src/time/clock.ts', content: `export class SystemClock {\n  now(): number { return 1 }\n}\n` },
      { path: 'server/src/orders/orders.controller.ts', content: `import { Controller, Get, Inject } from '@nestjs/common'\n`
        + `@Controller('orders')\nexport class OrdersController {\n  constructor(@Inject('CLOCK') private readonly clock: any) {}\n`
        + `  @Get()\n  list() { return this.clock.now() }\n}\n` },
    ]
    const single = extractTs(files)
    // One owned file per program: every cross-file fact crosses a slice boundary.
    const programs: { files: number; bytes: number }[] = []
    const sliced = extractTs(files, { ...SLICED, sliceProgramBytes: 1, onProgram: (program) => programs.push(program) })
    expect(sliced).toEqual(single)
    // Two Nest-fact programs, one per owned TS/JS file, and one re-run of the route file whose
    // component sits behind the barrel's re-export (two import hops).
    expect(programs).toHaveLength(2 + 10 + 1)
    expect(single.routes).toEqual([expect.objectContaining({ path: '/orders',
      componentResolution: expect.objectContaining({ status: 'RESOLVED', target: expect.objectContaining({ filePath: 'web/src/pages/orders/Orders.tsx' }) }) })])
    expect(single.endpoints).toEqual([expect.objectContaining({ method: 'GET', path: '/api/orders' })])
    expect(single.edges).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'CALLS',
      sourceKey: expect.stringContaining('OrdersController.list'), targetKey: expect.stringContaining('SystemClock.now') })]))
    expect(single.imports).toEqual(expect.arrayContaining([expect.objectContaining({ fromPath: 'web/src/pages/orders/Orders.tsx', toPath: 'web/src/shared/label.ts' })]))
    // The global script shadows fetch for every file, including those in other slices.
    expect(single.apiCalls).toEqual([])
    const coldPrograms: number[] = []
    const first = extractTs(files, { incremental: true, onProgram: (program) => coldPrograms.push(program.files) })
    const { cache, ...firstGraph } = first
    expect(firstGraph).toEqual(single)
    expect(coldPrograms).toEqual([10])
    const previous = new Map(cache!.map((entry) => [JSON.parse(entry).path, entry]))
    for (const changed of [null, 'web/tsconfig.json', 'web/legacy/globals.js', 'server/src/main.ts', 'server/src/app.module.ts', 'server/src/time/clock.ts']) {
      const current = files.map((file) => ({ ...file, content: file.path === changed ? file.content.replace(/api|CLOCK|number|baseUrl|fetch/, 'changed') : file.content,
        cache: previous.get(file.path) }))
      const programs: number[] = []
      const { cache: _cache, ...incremental } = extractTs(current, { incremental: true, onProgram: (program) => programs.push(program.files) })
      expect(incremental).toEqual(extractTs(current))
      if (changed === null) expect(programs).toEqual([])
    }
  }, 60_000)

  it('rejects a syntax error in any slice with the whole-manifest diagnostics', () => {
    const files = [...importChain(40), { path: 'src/broken/z.ts', content: 'export const = 1\n' }, { path: 'src/broken/y.ts', content: 'let (\n' }]
    const failure = (options = {}) => {
      try { extractTs(files, options); return null } catch (error) { return error }
    }
    const single = failure()
    expect(single).toBeInstanceOf(ParserSyntaxError)
    expect(failure({ ...SLICED, sliceProgramBytes: 64 })).toEqual(single)
  })
})
