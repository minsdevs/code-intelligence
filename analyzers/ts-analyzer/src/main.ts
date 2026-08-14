import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { json } from 'express'
import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] })
  app.use(json({ limit: '10mb' }))
  const host = process.env.TS_ANALYZER_HOST ?? '127.0.0.1'
  const port = Number(process.env.TS_ANALYZER_PORT ?? 3040)
  await app.listen(port, host)
}

void bootstrap()
