import 'reflect-metadata'
import { bootstrap } from './bootstrap'

void bootstrap().catch(() => {
  console.error('Analyzer startup failed')
  process.exitCode = 1
})
