import { afterEach, describe, expect, it, vi } from 'vitest'

describe('lazy TypeScript engine loading', () => {
  afterEach(() => {
    vi.doUnmock('./ts-extractor')
    vi.resetModules()
  })

  it('retries a failed engine load on the next request instead of caching the failure', async () => {
    vi.resetModules()
    vi.doMock('./ts-extractor', () => {
      throw new Error('synthetic engine load failure')
    })
    const { AnalyzeService } = await import('./analyze.service')
    const service = new AnalyzeService()
    const request = { files: [{ path: 'worker.ts', content: 'export class Worker {}' }] }
    await expect(service.analyze(request)).rejects.toThrow()
    vi.doUnmock('./ts-extractor')
    const result = await service.analyze(request)
    expect(result.nodes).toContainEqual(expect.objectContaining({ key: 'ts:worker.ts#Worker' }))
  })
})
