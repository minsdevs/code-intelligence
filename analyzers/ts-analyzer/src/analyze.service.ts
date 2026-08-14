import { BadRequestException, Injectable } from '@nestjs/common'
import type { AnalyzeFile, AnalyzeRequest, AnalyzeResponse } from './types'
import { assertContentSize, assertSafeRelativePath } from './paths'
import { extractTs } from './ts-extractor'

@Injectable()
export class AnalyzeService {
  analyze(request: AnalyzeRequest): AnalyzeResponse {
    if (!request || !Array.isArray(request.files)) {
      throw new BadRequestException('files array is required')
    }
    if (request.files.length > 500) {
      throw new BadRequestException('at most 500 files per request')
    }
    const files: AnalyzeFile[] = request.files.map((file) => {
      if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
        throw new BadRequestException('each file needs path and content strings')
      }
      const path = assertSafeRelativePath(file.path)
      assertContentSize(file.content)
      return { path, content: file.content }
    })
    return extractTs(files)
  }
}
