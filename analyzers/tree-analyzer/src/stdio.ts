import { parseAnalyzeRequest, parseLocalPaths, parseCacheKey } from './request'
import { serveStdio } from './stdio-transport'
import { extract } from './tree'

// ADR-01 production entry: one framed session on stdin/stdout, started by the adapter supervisor.
// stdout carries frames only, so any library logging is moved to stderr.
console.log = console.info = console.debug = console.warn = console.error.bind(console)
const runToken = process.env.ADAPTER_RUN_TOKEN ?? ''
delete process.env.ADAPTER_RUN_TOKEN

void serveStdio({
  input: process.stdin,
  output: process.stdout,
  runToken,
  analyze: async (body) => {
    const files = parseAnalyzeRequest(body)
    const cacheKey = parseCacheKey(body)
    let reused = 0
    const result = extract(files, parseLocalPaths(body), () => { reused++ }, cacheKey)
    if (cacheKey) console.error('TREE_INCREMENTAL', JSON.stringify({ files: files.length, reused, parsed: files.length - reused }))
    return result
  },
}).then(
  (code) => { process.exitCode = code },
  () => {
    console.error('Analyzer stdio session failed')
    process.exitCode = 1
  },
)
