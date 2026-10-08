import { BadRequestException, Injectable } from '@nestjs/common'
import type { AnalyzeFile, AnalyzeRequest, AnalyzeResponse } from './types'
import { assertContentSize, assertSafeRelativePath } from './paths'
import { AnalyzeSessions } from './analyze-session'
import { ParserSyntaxError } from './syntax-diagnostics'

// ts-morph carries the TypeScript compiler (~90 MiB resident, ~130 ms to load).
// Load it for the first analysis request instead of at sidecar startup.
let extractor: Promise<typeof import('./ts-extractor')> | undefined

@Injectable()
export class AnalyzeService {
  private readonly sessions = new AnalyzeSessions((files, cacheKey) => this.extract(files, cacheKey))

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
    if (request && request.session !== undefined) {
      if (request.files !== undefined && !(Array.isArray(request.files) && request.files.length === 0)) {
        throw new BadRequestException('session commands carry files only inside the command')
      }
      // Session replies carry only the session state, or one page of the result.
      return this.sessions.handle(request.session) as unknown as Promise<AnalyzeResponse>
    }
    if (!request || !Array.isArray(request.files)) {
      throw new BadRequestException('files array is required')
    }
    // A request is one project: splitting it loses prefixes, aliases and call targets.
    // Match the HTTP transport's 10 MiB limit; larger projects use the session commands.
    if (request.files.length > 20_000) {
      throw new BadRequestException('at most 20000 files per project')
    }
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 10 * 1024 * 1024) {
      throw new BadRequestException('project analysis request exceeds 10 MiB; narrow the source scope')
    }
    const files: AnalyzeFile[] = request.files.map((file) => {
      if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
        throw new BadRequestException('each file needs path and content strings')
      }
      const path = assertSafeRelativePath(file.path)
      assertContentSize(file.content)
      const cache = typeof file.cache === 'string' && Buffer.byteLength(file.cache) <= 128 * 1024 ? file.cache : undefined
      return { path, content: file.content, ...(cache === undefined ? {} : { cache }) }
    })
    return this.extract(files, request.cacheKey)
  }

  private async extract(files: AnalyzeFile[], cacheKey?: string): Promise<AnalyzeResponse> {
    // A failed load is not cached: the next request retries instead of failing until restart.
    const { extractTs } = await (extractor ??= import('./ts-extractor').catch((error: unknown) => {
      extractor = undefined
      throw error
    }))
    try {
      const incremental = typeof cacheKey === 'string' && /^[0-9a-f]{64}$/.test(cacheKey)
      let reused = 0
      let programFiles = 0
      const result = extractTs(files, { incremental, cacheKey: incremental ? cacheKey : undefined,
        onReuse: () => { reused++ }, onProgram: (program) => { programFiles += program.files } })
      if (incremental) console.error('TS_INCREMENTAL', JSON.stringify({ files: files.length, reused, programFiles }))
      return result
    } catch (error) {
      if (!(error instanceof ParserSyntaxError)) throw error
      throw new BadRequestException({
        statusCode: 400,
        code: 'TS_SYNTAX_ERROR',
        message: 'Input contains syntax errors. Fix the source and start a new analysis.',
        retryable: false,
        totalDiagnostics: error.totalDiagnostics,
        diagnostics: error.diagnostics,
      })
    }
  }
}
