import express, { type Request, type Response } from 'express'
import { extract } from './tree'
import type { AnalyzeRequest } from './types'

const MAX_CONTENT_BYTES = 1_048_576

function assertSafeRelativePath(path: string): string {
  if (!path || path.trim().length === 0) {
    throw new Error('file path must not be blank')
  }
  if (path.includes('\0')) {
    throw new Error('file path must not contain NUL')
  }
  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('file path must be relative')
  }
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error('file path must not contain ..')
  }
  return normalized.replace(/^\.\//, '')
}

function bootstrap(): void {
  const app = express()
  app.use(express.json({ limit: '10mb' }))

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' })
  })

  app.post('/analyze', (req: Request, res: Response) => {
    const body = req.body as AnalyzeRequest | undefined
    if (!body || !Array.isArray(body.files)) {
      res.status(400).json({ error: 'files array is required' })
      return
    }
    if (body.files.length > 500) {
      res.status(400).json({ error: 'at most 500 files per request' })
      return
    }
    try {
      const files = body.files.map((file) => {
        if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
          throw new Error('each file needs path and content strings')
        }
        const path = assertSafeRelativePath(file.path)
        if (Buffer.byteLength(file.content, 'utf8') > MAX_CONTENT_BYTES) {
          throw new Error('file content exceeds 1 MiB')
        }
        return { path, content: file.content }
      })
      res.json(extract(files))
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  const host = process.env.TREE_ANALYZER_HOST ?? '127.0.0.1'
  const port = Number(process.env.TREE_ANALYZER_PORT ?? 3041)
  app.listen(port, host, () => {
    console.log(`tree-analyzer listening on ${host}:${port}`)
  })
}

void bootstrap()
