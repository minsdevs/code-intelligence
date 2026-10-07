import express, { type Request, type Response } from 'express'
import { extract } from './tree'
import { parseAnalyzeRequest } from './request'

function bootstrap(): void {
  const app = express()
  app.use(express.json({ limit: '10mb' }))

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' })
  })

  app.post('/analyze', (req: Request, res: Response) => {
    try {
      res.json(extract(parseAnalyzeRequest(req.body)))
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
