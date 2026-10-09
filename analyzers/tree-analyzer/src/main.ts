import express, { type Request, type Response } from 'express'
import { extract } from './tree'
import { parseAnalyzeRequest, parseLocalPaths, parseCacheKey } from './request'

function bootstrap(): void {
  const app = express()
  app.use(express.json({ limit: '10mb' }))

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' })
  })

  app.post('/analyze', (req: Request, res: Response) => {
    try {
      const files = parseAnalyzeRequest(req.body)
      const cacheKey = parseCacheKey(req.body)
      let reused = 0
      const result = extract(files, parseLocalPaths(req.body), () => { reused++ }, cacheKey)
      if (cacheKey) console.error('TREE_INCREMENTAL', JSON.stringify({ files: files.length, reused, parsed: files.length - reused }))
      res.json(result)
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
