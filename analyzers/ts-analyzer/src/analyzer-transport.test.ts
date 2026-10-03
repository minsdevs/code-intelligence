import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tls = vi.hoisted(() => ({ createSecureContext: vi.fn() }))
vi.mock('node:tls', () => tls)
import { analyzerTransport, callerAuthentication } from './analyzer-transport'

const token = 'aB'.repeat(32) // Public synthetic validator input, never a real credential.
let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  tls.createSecureContext.mockReset()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'analyzer-transport-test-')))
  env = { TS_ANALYZER_TLS_CERT_FILE: join(root, 'certificate-placeholder'),
    TS_ANALYZER_TLS_KEY_FILE: join(root, 'key-placeholder'), TS_ANALYZER_AUTH_TOKEN: token }
  // Deliberately not PEM or key material: TLS parsing is mocked in this filesystem/ordering suite.
  writeFileSync(env.TS_ANALYZER_TLS_CERT_FILE!, 'synthetic certificate placeholder', { mode: 0o600 })
  writeFileSync(env.TS_ANALYZER_TLS_KEY_FILE!, 'synthetic key placeholder', { mode: 0o600 })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('opt-in analyzer TLS configuration', () => {
  it('refuses protected file loading on Windows while retaining development HTTP', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    try {
      expect(() => analyzerTransport(env)).toThrow(/^Invalid analyzer transport configuration$/)
      expect(analyzerTransport({})).toEqual({ host: '127.0.0.1', port: 3040 })
      expect(tls.createSecureContext).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
  it('preserves development HTTP only when all transport settings are absent', () => {
    expect(analyzerTransport({})).toEqual({ host: '127.0.0.1', port: 3040 })
    expect(analyzerTransport({ TS_ANALYZER_HOST: '0.0.0.0', TS_ANALYZER_PORT: '4040' }))
      .toEqual({ host: '0.0.0.0', port: 4040 })
    expect(tls.createSecureContext).not.toHaveBeenCalled()
  })
  it.each([1, 2, 3, 4, 5, 6])('rejects partial configuration mask %i', mask => {
    const names = Object.keys(env)
    const partial = Object.fromEntries(names.filter((_, i) => mask & (1 << i)).map(name => [name, env[name]]))
    expect(() => analyzerTransport(partial)).toThrow('Invalid analyzer transport configuration')
    expect(tls.createSecureContext).not.toHaveBeenCalled()
  })
  it.each(['', 'abc', 'f'.repeat(63), 'f'.repeat(65), 'g'.repeat(64), `${token}\n`])('rejects malformed caller token', value => {
    expect(() => analyzerTransport({ ...env, TS_ANALYZER_AUTH_TOKEN: value })).toThrow()
    expect(tls.createSecureContext).not.toHaveBeenCalled()
  })
  it.each(['localhost', '0.0.0.0', '127.0.0.2', '[::1]', '::', 'example.com'])('rejects non-exact-loopback host %s', host => {
    expect(() => analyzerTransport({ ...env, TS_ANALYZER_HOST: host })).toThrow()
  })
  it.each(['-1', '65536', '1.5', 'NaN', '', '03040', ' 3040', '3040\n', '3e3'])('rejects port %s', port => {
    expect(() => analyzerTransport({ ...env, TS_ANALYZER_PORT: port })).toThrow()
  })
  it('allows the OS to choose an ephemeral loopback port', () => {
    expect(analyzerTransport({ ...env, TS_ANALYZER_PORT: '0' }).port).toBe(0)
  })
  it.each(['127.0.0.1', '::1'])('preflights TLS and returns only HTTPS options on %s', host => {
    const result = analyzerTransport({ ...env, TS_ANALYZER_HOST: host })
    expect(result.host).toBe(host)
    expect(result.authenticate).toBeTypeOf('function')
    expect(result.httpsOptions).toEqual({ cert: expect.any(Buffer), key: expect.any(Buffer), minVersion: 'TLSv1.2' })
    expect(tls.createSecureContext).toHaveBeenCalledWith(result.httpsOptions)
  })
  it('fails closed and sanitizes malformed/mismatched TLS material errors', () => {
    tls.createSecureContext.mockImplementation(() => { throw new Error('private certificate path and material') })
    expect(() => analyzerTransport(env)).toThrow(/^Invalid analyzer transport configuration$/)
    const options = tls.createSecureContext.mock.calls[0][0]
    expect(options.key.every((byte: number) => byte === 0)).toBe(true)
    expect(options.cert.every((byte: number) => byte === 0)).toBe(true)
  })
  it.each(['empty', 'oversize', 'directory', 'symlink', 'hardlink', 'public-key', 'writable-cert', 'relative', 'ancestor-link'])
    ('rejects unsafe material: %s before TLS', kind => {
      const file = env.TS_ANALYZER_TLS_KEY_FILE!
      if (kind === 'empty') writeFileSync(file, '')
      if (kind === 'oversize') writeFileSync(file, Buffer.alloc(65537))
      if (kind === 'directory') { rmSync(file); mkdirSync(file) }
      if (kind === 'symlink') { rmSync(file); symlinkSync(env.TS_ANALYZER_TLS_CERT_FILE!, file) }
      if (kind === 'hardlink') linkSync(file, join(root, 'another-link'))
      if (kind === 'public-key') chmodSync(file, 0o644)
      if (kind === 'writable-cert') chmodSync(env.TS_ANALYZER_TLS_CERT_FILE!, 0o622)
      if (kind === 'relative') env.TS_ANALYZER_TLS_KEY_FILE = './key-placeholder'
      if (kind === 'ancestor-link') {
        const real = join(root, 'real'); mkdirSync(real)
        writeFileSync(join(real, 'key'), 'synthetic placeholder', { mode: 0o600 })
        symlinkSync(real, join(root, 'alias'))
        env.TS_ANALYZER_TLS_KEY_FILE = join(root, 'alias', 'key')
      }
      expect(() => analyzerTransport(env)).toThrow(/^Invalid analyzer transport configuration$/)
      expect(tls.createSecureContext).not.toHaveBeenCalled()
    })
})

describe('caller admission before parsing', () => {
  function attempt(value: string | undefined, rawHeaders = value === undefined ? [] : ['Authorization', value]) {
    const next = vi.fn()
    const response = { status: vi.fn().mockReturnThis(), end: vi.fn() }
    callerAuthentication(token)({ headers: { authorization: value }, rawHeaders } as Request,
      response as unknown as Response, next)
    return { next, response }
  }
  it('admits only the exact case-preserved bearer token', () => {
    const result = attempt(`Bearer ${token}`)
    expect(result.next).toHaveBeenCalledOnce()
    expect(result.response.status).not.toHaveBeenCalled()
  })
  it.each([undefined, '', `Bearer ${'f'.repeat(64)}`, `Bearer ${token.toLowerCase()}`,
    `bearer ${token}`, `Bearer ${token} `, `Bearer ${token}\n`, `Basic ${token}`])('rejects missing/malformed/wrong auth', value => {
    const result = attempt(value)
    expect(result.next).not.toHaveBeenCalled()
    expect(result.response.status).toHaveBeenCalledWith(401)
    expect(result.response.end).toHaveBeenCalledWith()
  })
  it('rejects duplicate authorization even when Node retained one valid value', () => {
    const value = `Bearer ${token}`
    const result = attempt(value, ['Authorization', value, 'aUtHoRiZaTiOn', value])
    expect(result.next).not.toHaveBeenCalled()
    expect(result.response.status).toHaveBeenCalledWith(401)
  })
})
