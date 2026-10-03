import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { BadRequestException } from '@nestjs/common'
import { AnalyzeService } from './analyze.service'
import { projectBoundaryFixture } from './fixtures/project-boundary'

describe('safe syntax error API contract without an HTTP server', () => {
  it('maps parser failure to HTTP 400 with a stable code and location-only diagnostics', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../backend/src/test/resources/fixtures/ts-syntax-error.json', import.meta.url), 'utf8'))
    let failure: unknown
    try { new AnalyzeService().analyze(fixture.input) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(BadRequestException)
    expect((failure as BadRequestException).getStatus()).toBe(400)
    expect((failure as BadRequestException).getResponse()).toEqual(fixture.response)
    expect(JSON.stringify((failure as BadRequestException).getResponse())).not.toContain(fixture.input.files[0].content)
  })

  it('preserves successful module extraction and ordinary request validation', () => {
    const service = new AnalyzeService()
    expect(service.analyze({ files: [{ path: 'worker.cts', content: 'export class Worker {}' }] }).nodes)
      .toContainEqual(expect.objectContaining({ key: 'ts:worker.cts#Worker' }))
    expect(() => service.analyze({ files: [{ path: '../escape.ts', content: '' }] })).toThrow()
    expect(() => service.analyze({ files: [] })).not.toThrow()
  })
})

describe('project-wide analysis contract', () => {
  it('preserves Nest prefix and controller-to-service calls across the old 500-file boundary', () => {
    const files = projectBoundaryFixture()
    expect(files).toHaveLength(501)
    const result = new AnalyzeService().analyze({ files })
    expect(result.endpoints.map((endpoint) => endpoint.path)).toEqual(['/api/users'])
    expect(result.edges).toContainEqual(expect.objectContaining({
      sourceKey: 'ts:z-users.controller.ts#UsersController.list',
      targetKey: 'ts:b-users.service.ts#UsersService.list',
      type: 'CALLS',
    }))
  })

  it('rejects a request over the byte budget instead of returning incomplete analysis', () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ path: `${i}.ts`, content: 'x'.repeat(1_000_000) }))
    expect(() => new AnalyzeService().analyze({ files })).toThrow(/10 MiB/)
  })
})
