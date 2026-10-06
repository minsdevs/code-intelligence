import { BadRequestException, Injectable } from '@nestjs/common'
import type { AnalyzeFile, AnalyzeRequest, AnalyzeResponse } from './types'
import { assertContentSize, assertSafeRelativePath } from './paths'
import { ParserSyntaxError } from './syntax-diagnostics'

// ts-morph carries the TypeScript compiler (~90 MiB resident, ~130 ms to load).
// Load it for the first analysis request instead of at sidecar startup.
let extractor: Promise<typeof import('./ts-extractor')> | undefined

@Injectable()
export class AnalyzeService {
  async analyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
    if (!request || !Array.isArray(request.files)) {
      throw new BadRequestException('files array is required')
    }
    // A request is one project: splitting it loses prefixes, aliases and call targets.
    // Match the backend inventory cap and the HTTP transport's 10 MiB limit.
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
      return { path, content: file.content }
    })
    const { extractTs } = await (extractor ??= import('./ts-extractor'))
    try {
      return extractTs(files)
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
