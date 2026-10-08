import { BadRequestException } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import type { AnalyzeFile, AnalyzeResponse, SessionCommand, SessionReply } from './types'
import { assertContentSize, assertSafeRelativePath } from './paths'

// 03 §6 session contract: open(manifest) -> put(chunk <= 1 MiB, seq) -> seal(exact manifest)
// -> analyze -> result pages -> close. Chunks are only the transport unit; the compiler project
// is still built once over the whole sealed manifest, so imports, DI and route prefixes resolve
// exactly as in a single request.
export const SESSION_MAX_FILES = 50_000
export const SESSION_MAX_BYTES = 512 * 1024 * 1024
export const SESSION_CHUNK_BYTES = 1024 * 1024
export const SESSION_PAGE_BYTES = 1024 * 1024
export const SESSION_IDLE_MS = 60_000
export const SESSION_MAX_OPEN = 2

const RESULT_KEYS = [
  'fileOutcomes', 'routes', 'components', 'hooks', 'stores', 'apiCalls',
  'imports', 'symbols', 'endpoints', 'nodes', 'edges', 'unresolvedCalls',
  'cache',
] as const
type ResultKey = (typeof RESULT_KEYS)[number]
export type ResultPage = Pick<AnalyzeResponse, ResultKey>

type Manifest = { files: number; bytes: number; digest: string }
type Session = {
  manifest: Manifest
  files: AnalyzeFile[] | undefined
  paths: Set<string>
  bytes: number
  digest: ReturnType<typeof createHash>
  nextSeq: number
  sealed: boolean
  pages: ResultPage[] | undefined
  lastUsed: number
  cacheBytes: number
  cacheKey?: string
}

const reject = (code: string, message: string): never => {
  throw new BadRequestException({ statusCode: 400, code, message, retryable: false })
}

/** Manifest digest shared with the backend: SHA-256 over `path\nsha256(content)\n` in put order. */
export function manifestLine(path: string, content: string): string {
  return `${path}\n${createHash('sha256').update(content, 'utf8').digest('hex')}\n`
}

export class AnalyzeSessions {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly extract: (files: AnalyzeFile[], cacheKey?: string) => Promise<AnalyzeResponse>,
    private readonly now: () => number = Date.now,
  ) {}

  async handle(command: SessionCommand): Promise<{ session: SessionReply } & Partial<ResultPage>> {
    this.expire()
    if (!command || typeof command !== 'object') return reject('SESSION_INVALID', 'session command is required')
    switch (command.op) {
      case 'open': return { session: this.open(command) }
      case 'put': return { session: this.put(command) }
      case 'seal': return { session: this.seal(command) }
      case 'analyze': return this.analyze(command)
      case 'page': return this.page(command)
      case 'close': {
        const id = this.id(command)
        this.sessions.delete(id)
        return { session: { id, op: 'close' } }
      }
      default: return reject('SESSION_INVALID', 'unknown session operation')
    }
  }

  private open(command: SessionCommand): SessionReply {
    const manifest = manifestOf(command)
    if (manifest.files > SESSION_MAX_FILES || manifest.bytes > SESSION_MAX_BYTES) {
      reject('ANALYSIS_LIMIT', `project analysis exceeds ${SESSION_MAX_FILES} files / 512 MiB`)
    }
    if (this.sessions.size >= SESSION_MAX_OPEN) reject('SESSION_LIMIT', 'too many open analysis sessions')
    const id = randomBytes(16).toString('hex')
    this.sessions.set(id, {
      manifest, files: [], paths: new Set(), bytes: 0, digest: createHash('sha256'),
      nextSeq: 0, sealed: false, pages: undefined, lastUsed: this.now(), cacheBytes: 0,
      cacheKey: typeof command.cacheKey === 'string' && /^[0-9a-f]{64}$/.test(command.cacheKey) ? command.cacheKey : undefined,
    })
    return { id, op: 'open' }
  }

  private put(command: SessionCommand): SessionReply {
    const id = this.id(command)
    const session = this.session(id)
    const files = session.files
    if (session.sealed || !files) return this.fail(id, 'SESSION_STATE', 'session is already sealed')
    if (command.seq !== session.nextSeq) return this.fail(id, 'SESSION_SEQUENCE', 'chunk out of sequence')
    if (!Array.isArray(command.files) || command.files.length === 0) {
      return this.fail(id, 'SESSION_INVALID', 'chunk needs at least one file')
    }
    let chunkBytes = 0
    for (const file of command.files) {
      if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
        return this.fail(id, 'SESSION_INVALID', 'each file needs path and content strings')
      }
      let path: string
      try {
        path = assertSafeRelativePath(file.path)
        assertContentSize(file.content)
      } catch {
        return this.fail(id, 'SESSION_INVALID', 'file path or size is not allowed')
      }
      if (session.paths.has(path)) return this.fail(id, 'SESSION_DUPLICATE', 'file was already sent')
      const bytes = Buffer.byteLength(file.content, 'utf8')
      chunkBytes += bytes
      session.bytes += bytes
      if (chunkBytes > SESSION_CHUNK_BYTES && command.files.length > 1) {
        return this.fail(id, 'SESSION_CHUNK', 'chunk exceeds 1 MiB')
      }
      if (session.paths.size + 1 > session.manifest.files || session.bytes > session.manifest.bytes) {
        return this.fail(id, 'SESSION_MANIFEST', 'chunk exceeds the opened manifest')
      }
      session.paths.add(path)
      session.digest.update(manifestLine(path, file.content), 'utf8')
      let cache: string | undefined
      if (typeof file.cache === 'string') {
        const cacheBytes = Buffer.byteLength(file.cache)
        if (cacheBytes <= 128 * 1024 && session.cacheBytes + cacheBytes <= 16 * 1024 * 1024) {
          cache = file.cache
          session.cacheBytes += cacheBytes
        }
      }
      files.push({ path, content: file.content, ...(cache === undefined ? {} : { cache }) })
    }
    session.nextSeq++
    return { id, op: 'put', seq: command.seq }
  }

  private seal(command: SessionCommand): SessionReply {
    const id = this.id(command)
    const session = this.session(id)
    if (session.sealed) return this.fail(id, 'SESSION_STATE', 'session is already sealed')
    const manifest = manifestOf(command)
    const received = session.digest.digest('hex')
    if (manifest.files !== session.manifest.files || manifest.bytes !== session.manifest.bytes
      || manifest.digest !== session.manifest.digest || session.paths.size !== manifest.files
      || session.bytes !== manifest.bytes || received !== manifest.digest) {
      return this.fail(id, 'SESSION_MANIFEST', 'received files do not match the sealed manifest')
    }
    session.sealed = true
    return { id, op: 'seal' }
  }

  private async analyze(command: SessionCommand): Promise<{ session: SessionReply } & ResultPage> {
    const id = this.id(command)
    const session = this.session(id)
    if (!session.sealed || !session.files) return this.fail(id, 'SESSION_STATE', 'session is not sealed')
    const files = session.files
    session.files = undefined
    let result: AnalyzeResponse
    try {
      result = await this.extract(files, session.cacheKey)
    } catch (error) {
      this.sessions.delete(id)
      throw error
    }
    session.pages = paginate(result)
    session.lastUsed = this.now()
    return { session: { id, op: 'analyze', page: 0, pages: session.pages.length }, ...session.pages[0] }
  }

  private page(command: SessionCommand): { session: SessionReply } & ResultPage {
    const id = this.id(command)
    const pages = this.session(id).pages
    if (!pages) return this.fail(id, 'SESSION_STATE', 'session has no result')
    const page = command.page
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 0 || page >= pages.length) {
      return reject('SESSION_INVALID', 'result page out of range')
    }
    return { session: { id, op: 'page', page, pages: pages.length }, ...pages[page] }
  }

  private id(command: SessionCommand): string {
    if (typeof command.id !== 'string' || !/^[0-9a-f]{32}$/.test(command.id)) {
      return reject('SESSION_INVALID', 'session id is required')
    }
    return command.id
  }

  private session(id: string): Session {
    const session = this.sessions.get(id)
    if (!session) return reject('SESSION_UNKNOWN', 'analysis session is closed or expired')
    session.lastUsed = this.now()
    return session
  }

  private fail(id: string, code: string, message: string): never {
    this.sessions.delete(id)
    return reject(code, message)
  }

  private expire(): void {
    const now = this.now()
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsed > SESSION_IDLE_MS) this.sessions.delete(id)
    }
  }
}

function manifestOf(command: SessionCommand): Manifest {
  const { fileCount: files, bytes, digest } = command
  if (typeof files !== 'number' || !Number.isSafeInteger(files) || files < 1
    || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0
    || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    return reject('SESSION_INVALID', 'manifest needs files, bytes and a SHA-256 digest')
  }
  return { files, bytes, digest }
}

/** Splits a result into pages of at most 1 MiB JSON; concatenating the pages restores it in order. */
export function paginate(result: AnalyzeResponse, limit = SESSION_PAGE_BYTES): ResultPage[] {
  const empty = (): ResultPage => Object.fromEntries(RESULT_KEYS.filter((key) => key !== 'cache' || result.cache !== undefined).map((key) => [key, []])) as unknown as ResultPage
  const overhead = Buffer.byteLength(JSON.stringify({ session: { id: '0'.repeat(32), op: 'analyze', page: 0, pages: 0 }, ...empty() }))
    + 64
  const pages: ResultPage[] = []
  let page = empty()
  let size = overhead
  let items = 0
  for (const key of RESULT_KEYS) {
    for (const item of (result[key] ?? []) as unknown[]) {
      const bytes = Buffer.byteLength(JSON.stringify(item)) + 1
      if (overhead + bytes > limit) reject('RESULT_ITEM_LIMIT', 'one analysis result item exceeds the page limit')
      if (size + bytes > limit) {
        pages.push(page)
        page = empty()
        size = overhead
        items = 0
      }
      ;(page[key] as unknown[]).push(item)
      size += bytes
      items++
    }
  }
  if (items > 0 || pages.length === 0) pages.push(page)
  return pages
}
