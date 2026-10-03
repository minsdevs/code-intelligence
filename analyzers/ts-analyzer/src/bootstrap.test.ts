import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ create: vi.fn(), transport: vi.fn(), json: vi.fn(),
  use: vi.fn(), listen: vi.fn(), parser: vi.fn(), authenticate: vi.fn() }))
vi.mock('@nestjs/core', () => ({ NestFactory: { create: mocks.create } }))
vi.mock('./app.module', () => ({ AppModule: class AppModule {} }))
vi.mock('./analyzer-transport', () => ({ analyzerTransport: mocks.transport }))
vi.mock('express', () => ({ json: mocks.json }))
import { bootstrap } from './bootstrap'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockResolvedValue({ use: mocks.use, listen: mocks.listen })
  mocks.json.mockReturnValue(mocks.parser)
})

it('validates transport before creating or listening and has no HTTP fallback', async () => {
  mocks.transport.mockImplementation(() => { throw new Error('Invalid analyzer transport configuration') })
  await expect(bootstrap({})).rejects.toThrow('Invalid analyzer transport configuration')
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.listen).not.toHaveBeenCalled()
})

it('disables automatic parsing and authenticates before JSON/controller admission on the only HTTPS listener', async () => {
  const httpsOptions = { cert: Buffer.from('placeholder'), key: Buffer.from('placeholder') }
  mocks.transport.mockReturnValue({ host: '127.0.0.1', port: 4040, httpsOptions, authenticate: mocks.authenticate })
  await bootstrap({})
  expect(mocks.create).toHaveBeenCalledOnce()
  expect(mocks.create.mock.calls[0][1]).toMatchObject({ bodyParser: false, httpsOptions })
  expect(mocks.use.mock.calls).toEqual([[mocks.authenticate], [mocks.parser]])
  expect(mocks.json).toHaveBeenCalledWith({ limit: '10mb' })
  expect(mocks.listen).toHaveBeenCalledExactlyOnceWith(4040, '127.0.0.1')
})

it('retains unauthenticated development HTTP when TLS is not configured', async () => {
  mocks.transport.mockReturnValue({ host: '127.0.0.1', port: 3040 })
  await bootstrap({})
  expect(mocks.create.mock.calls[0][1]).not.toHaveProperty('httpsOptions')
  expect(mocks.use.mock.calls).toEqual([[mocks.parser]])
  expect(mocks.listen).toHaveBeenCalledExactlyOnceWith(3040, '127.0.0.1')
})
