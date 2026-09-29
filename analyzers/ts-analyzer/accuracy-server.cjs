// Local gate harness: the production Nest module on an ephemeral loopback port, without .env.
require('reflect-metadata')
const { NestFactory } = require('@nestjs/core')
const { json } = require('express')
const { AppModule } = require('./dist/app.module')

async function start() {
  const app = await NestFactory.create(AppModule, { logger: false })
  app.use(json({ limit: '10mb' }))
  await app.listen(0, '127.0.0.1')
  process.stdout.write(`${await app.getUrl()}\n`)
  process.on('SIGTERM', () => app.close().then(() => process.exit(0)))
}

start().catch((error) => {
  console.error(error)
  process.exit(1)
})
