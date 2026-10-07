import 'reflect-metadata'
import { AnalyzeService } from './analyze.service'
import { serveStdio } from './stdio-transport'
import type { AnalyzeRequest } from './types'

// ADR-01 production entry: one framed session on stdin/stdout, started by the adapter supervisor.
// stdout carries frames only, so any library logging is moved to stderr.
console.log = console.info = console.debug = console.warn = console.error.bind(console)
const runToken = process.env.ADAPTER_RUN_TOKEN ?? ''
delete process.env.ADAPTER_RUN_TOKEN
const service = new AnalyzeService()

void serveStdio({
  input: process.stdin,
  output: process.stdout,
  runToken,
  analyze: (body) => service.analyze(body as AnalyzeRequest),
}).then(
  (code) => { process.exitCode = code },
  () => {
    console.error('Analyzer stdio session failed')
    process.exitCode = 1
  },
)
