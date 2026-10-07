import { HttpException } from '@nestjs/common'
import type { Readable, Writable } from 'node:stream'
import { timingSafeEqual } from 'node:crypto'

// ADR-01 production adapter transport: 4-byte big-endian length, then one UTF-8 JSON object.
// The HTTPS server (bootstrap.ts) stays as the development and test harness only.
export const ADAPTER_STDIO_PROTOCOL = 'code-intelligence.adapter.stdio'
export const ADAPTER_STDIO_VERSION = 1
// 03 §6: the 10 MiB whole-project bound stays until the T05 session protocol passes.
export const MAX_REQUEST_FRAME_BYTES = 10 * 1024 * 1024 + 4096
const MAX_HANDSHAKE_BYTES = 1024

export type FrameErrorCode =
  | 'FRAME_TOO_LARGE' | 'FRAME_EMPTY' | 'FRAME_INVALID_JSON' | 'FRAME_NOT_OBJECT'
  | 'FRAME_TRUNCATED' | 'FRAME_STREAM_FAILED'

export class FrameError extends Error {
  constructor(readonly code: FrameErrorCode) {
    super(code)
    this.name = 'FrameError'
  }
}

export function encodeFrame(value: unknown, maxBytes: number): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.length === 0 || body.length > maxBytes) throw new FrameError('FRAME_TOO_LARGE')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(body.length)
  return Buffer.concat([prefix, body])
}

/** Never buffers more than one frame of at most maxBytes; any violation poisons the stream. */
export class FrameDecoder {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private expected: number | null = null
  private failed = false

  /** The limit may be raised between frames, for example after a handshake. */
  constructor(public maxBytes: number) {}

  push(chunk: Buffer): Record<string, unknown>[] {
    return [...this.decode(chunk)]
  }

  /** Yields frames one at a time so the caller can change maxBytes before the next prefix is read. */
  *decode(chunk: Buffer): Generator<Record<string, unknown>> {
    if (this.failed) throw new FrameError('FRAME_STREAM_FAILED')
    try {
      yield* this.consume(chunk)
    } catch (error) {
      this.failed = true
      this.pending = []
      throw error
    }
  }

  end(): void {
    if (this.failed) throw new FrameError('FRAME_STREAM_FAILED')
    if (this.pendingBytes > 0 || this.expected !== null) {
      this.failed = true
      throw new FrameError('FRAME_TRUNCATED')
    }
  }

  private *consume(chunk: Buffer): Generator<Record<string, unknown>> {
    let rest = chunk
    while (rest.length > 0) {
      if (this.expected === null) {
        const need = 4 - this.pendingBytes
        this.take(rest.subarray(0, need))
        rest = rest.subarray(need)
        if (this.pendingBytes < 4) break
        const length = Buffer.concat(this.pending).readUInt32BE(0)
        this.pending = []
        this.pendingBytes = 0
        if (length === 0) throw new FrameError('FRAME_EMPTY')
        if (length > this.maxBytes) throw new FrameError('FRAME_TOO_LARGE')
        this.expected = length
      }
      const need = this.expected - this.pendingBytes
      this.take(rest.subarray(0, need))
      rest = rest.subarray(need)
      if (this.pendingBytes < this.expected) break
      const body = Buffer.concat(this.pending)
      this.pending = []
      this.pendingBytes = 0
      this.expected = null
      yield parse(body)
    }
  }

  private take(bytes: Buffer): void {
    if (bytes.length === 0) return
    this.pending.push(bytes)
    this.pendingBytes += bytes.length
  }
}

function parse(body: Buffer): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    throw new FrameError('FRAME_INVALID_JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FrameError('FRAME_NOT_OBJECT')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function sameToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !/^[0-9a-f]{64}$/.test(actual)) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

export type StdioOptions = {
  input: Readable
  output: Writable
  /** Issued by the supervisor for this run; never chosen by repository content. */
  runToken: string
  analyze: (body: unknown) => Promise<unknown>
}

/**
 * Serves one adapter session. Exit codes: 0 clean end of input, 2 handshake refused,
 * 3 framing or envelope violation (the stream is not read further).
 */
export async function serveStdio({ input, output, runToken, analyze }: StdioOptions): Promise<number> {
  if (!/^[0-9a-f]{64}$/.test(runToken)) throw new Error('Invalid adapter run token')
  const write = (value: unknown) => new Promise<void>((resolve, reject) => {
    output.write(encodeFrame(value, Number.MAX_SAFE_INTEGER), (error) => (error ? reject(error) : resolve()))
  })
  const decoder = new FrameDecoder(MAX_HANDSHAKE_BYTES)
  let greeted = false
  let lastId = 0
  try {
    for await (const chunk of input) {
      for (const frame of decoder.decode(chunk as Buffer)) {
        if (!greeted) {
          if (!exactKeys(frame, ['protocol', 'version', 'runToken']) || frame.protocol !== ADAPTER_STDIO_PROTOCOL
              || frame.version !== ADAPTER_STDIO_VERSION || !sameToken(frame.runToken, runToken)) {
            await write({ protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, error: 'PROTOCOL_MISMATCH' })
            return 2
          }
          greeted = true
          decoder.maxBytes = MAX_REQUEST_FRAME_BYTES
          await write({ protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, ready: true })
          continue
        }
        const id = frame.id
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= lastId) return 3
        lastId = id
        if (!exactKeys(frame, ['id', 'op', 'body'])) {
          await write({ id, ok: false, error: { status: 400, code: 'INVALID_ENVELOPE' } })
          continue
        }
        if (frame.op !== 'analyze') {
          await write({ id, ok: false, error: { status: 400, code: 'UNSUPPORTED_OP' } })
          continue
        }
        await write(await analyze(frame.body).then(
          (result) => ({ id, ok: true, result }),
          (error: unknown) => error instanceof HttpException
            ? { id, ok: false, error: { status: error.getStatus(), response: error.getResponse() } }
            : { id, ok: false, error: { status: 500, code: 'ANALYZER_FAILURE' } },
        ))
      }
    }
    decoder.end()
  } catch (error) {
    if (error instanceof FrameError) return 3
    throw error
  }
  return 0
}
