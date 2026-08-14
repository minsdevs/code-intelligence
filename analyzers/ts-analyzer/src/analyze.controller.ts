import { Body, Controller, Get, Post } from '@nestjs/common'
import { AnalyzeService } from './analyze.service'
import type { AnalyzeRequest } from './types'

@Controller()
export class AnalyzeController {
  constructor(private readonly analyzeService: AnalyzeService) {}

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' }
  }

  @Post('analyze')
  analyze(@Body() body: AnalyzeRequest) {
    return this.analyzeService.analyze(body)
  }
}
