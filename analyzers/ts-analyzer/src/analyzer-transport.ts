import { timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize, parse, join, sep } from 'node:path'
import { createSecureContext } from 'node:tls'
import type { RequestHandler } from 'express'
import { readWindowsProtectedMaterial } from './windows-protected-file'

const MAX_MATERIAL_BYTES = 64 * 1024
const invalid = (): never => { throw new Error('Invalid analyzer transport configuration') }

function readMaterial(file: string, privateKey: boolean): Buffer {
  if (process.platform === 'win32') return readWindowsProtectedMaterial(file, privateKey)
  if (!isAbsolute(file) || normalize(file) !== file || /[\x00-\x1f\x7f]/.test(file)) invalid()
  let cursor = parse(file).root
  const parts = file.slice(cursor.length).split(sep)
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part)
    const stat = lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
  }
  if (realpathSync(file) !== file) invalid()
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_MATERIAL_BYTES
      || (before.mode & 0o022) !== 0 || (privateKey && (before.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && before.uid !== process.getuid())) invalid()
    const bytes = Buffer.alloc(MAX_MATERIAL_BYTES + 1)
    let length = 0
    try {
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null)
        if (!count) break
        length += count
      }
      const same = (stat: ReturnType<typeof fstatSync>) => stat.isFile() && stat.nlink === 1
        && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size
        && stat.mode === before.mode && stat.uid === before.uid && stat.gid === before.gid
        && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs
      if (length !== before.size || !same(fstatSync(fd)) || !same(lstatSync(file))) invalid()
      return Buffer.from(bytes.subarray(0, length))
    } finally { bytes.fill(0) }
  } finally { closeSync(fd) }
}

export interface AnalyzerTransport {
  host: string
  port: number
  httpsOptions?: { cert: Buffer; key: Buffer; minVersion: 'TLSv1.2' }
  authenticate?: RequestHandler
}

export function callerAuthentication(token: string): RequestHandler {
  if (token.length !== 64 || !/^[a-fA-F0-9]{64}$/.test(token)) invalid()
  const expected = Buffer.from(token, 'ascii')
  return (request, response, next) => {
    let count = 0
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index].toLowerCase() === 'authorization') count++
    }
    const authorization = request.headers.authorization
    const match = typeof authorization === 'string' && authorization.length === 71
      ? /^Bearer ([a-fA-F0-9]{64})$/.exec(authorization) : null
    if (count !== 1 || !match || !timingSafeEqual(expected, Buffer.from(match[1], 'ascii'))) {
      response.status(401).end()
      return
    }
    next()
  }
}

// This opt-in transport authenticates a caller; it does not establish process ownership.
// Node path checks reject links but do not provide openat confinement from a hostile same-user ancestor race.
export function analyzerTransport(env: NodeJS.ProcessEnv): AnalyzerTransport {
  const host = env.TS_ANALYZER_HOST ?? '127.0.0.1'
  const port = Number(env.TS_ANALYZER_PORT ?? 3040)
  const names = ['TS_ANALYZER_TLS_CERT_FILE', 'TS_ANALYZER_TLS_KEY_FILE', 'TS_ANALYZER_AUTH_TOKEN'] as const
  const configured = names.some(name => env[name] !== undefined)
  if (!configured) return { host, port }
  let cert: Buffer | undefined
  let key: Buffer | undefined
  try {
    // Each platform must supply its real no-follow protected-file boundary.
    if ((process.platform !== 'win32' && (!constants.O_NOFOLLOW || typeof process.getuid !== 'function'))
      || names.some(name => !env[name]) || !['127.0.0.1', '::1'].includes(host)
      || !Number.isInteger(port) || port < 0 || port > 65535
      || (env.TS_ANALYZER_PORT !== undefined && String(port) !== env.TS_ANALYZER_PORT)) invalid()
    const authenticate = callerAuthentication(env.TS_ANALYZER_AUTH_TOKEN!)
    cert = readMaterial(env.TS_ANALYZER_TLS_CERT_FILE!, false)
    key = readMaterial(env.TS_ANALYZER_TLS_KEY_FILE!, true)
    const httpsOptions = { cert, key, minVersion: 'TLSv1.2' as const }
    // Parse and verify the cert/key pair before constructing any server; never fall back to HTTP.
    createSecureContext(httpsOptions)
    return { host, port, httpsOptions, authenticate }
  } catch {
    cert?.fill(0)
    key?.fill(0)
    return invalid()
  }
}
