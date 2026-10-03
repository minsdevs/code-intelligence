import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'
import { json } from 'express'
import { AppModule } from './app.module'
import { analyzerTransport } from './analyzer-transport'

export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<INestApplication> {
  const transport = analyzerTransport(env)
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'], bodyParser: false,
    ...(transport.httpsOptions ? { httpsOptions: transport.httpsOptions } : {}),
  })
  // Nest's automatic parser is disabled so unauthenticated source never reaches a parser or controller.
  if (transport.authenticate) app.use(transport.authenticate)
  app.use(json({ limit: '10mb' }))
  await app.listen(transport.port, transport.host)
  return app
}
