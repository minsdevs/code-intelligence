import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AnalyzeService } from './analyze.service'
import {
  ADAPTER_STDIO_PROTOCOL,
  ADAPTER_STDIO_VERSION,
  FrameDecoder,
  FrameError,
  MAX_REQUEST_FRAME_BYTES,
  encodeFrame,
  serveStdio,
} from './stdio-transport'

const TOKEN = 'a'.repeat(64)
const hello = { protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, runToken: TOKEN }

function prefixed(length: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(length)
  return Buffer.concat([prefix, body])
}

function code(action: () => unknown): string | undefined {
  try {
    action()
  } catch (error) {
    return error instanceof FrameError ? error.code : 'OTHER'
  }
  return undefined
}

describe('ADR-01 length-prefixed stdio framing', () => {
  it('decodes frames split across chunks and several frames in one chunk', () => {
    const decoder = new FrameDecoder(1024)
    const bytes = Buffer.concat([encodeFrame({ a: 1 }, 1024), encodeFrame({ b: [2] }, 1024)])
    expect(decoder.push(bytes.subarray(0, 3))).toEqual([])
    expect(decoder.push(bytes.subarray(3, 9))).toEqual([])
    expect(decoder.push(bytes.subarray(9))).toEqual([{ a: 1 }, { b: [2] }])
    expect(() => decoder.end()).not.toThrow()
  })

  it('accepts a frame of exactly the limit and refuses one byte more from the prefix alone', () => {
    const body = Buffer.from(JSON.stringify({ pad: 'x'.repeat(90) }))
    expect(new FrameDecoder(body.length).push(prefixed(body.length, body))).toHaveLength(1)
    const decoder = new FrameDecoder(body.length)
    // Only the 4-byte prefix arrives: the decoder must refuse before buffering any body.
    expect(code(() => decoder.push(prefixed(body.length + 1)))).toBe('FRAME_TOO_LARGE')
    expect(code(() => decoder.push(Buffer.from('{}')))).toBe('FRAME_STREAM_FAILED')
    expect(code(() => new FrameDecoder(16).push(prefixed(0xffffffff)))).toBe('FRAME_TOO_LARGE')
  })

  it('refuses empty, non-JSON, non-object, invalid UTF-8 and truncated frames', () => {
    expect(code(() => new FrameDecoder(64).push(prefixed(0)))).toBe('FRAME_EMPTY')
    expect(code(() => new FrameDecoder(64).push(prefixed(3, Buffer.from('{x}'))))).toBe('FRAME_INVALID_JSON')
    for (const value of ['[]', '7', '"text"', 'null']) {
      expect(code(() => new FrameDecoder(64).push(prefixed(value.length, Buffer.from(value)))), value).toBe('FRAME_NOT_OBJECT')
    }
    const invalidUtf8 = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])
    expect(code(() => new FrameDecoder(64).push(prefixed(invalidUtf8.length, invalidUtf8)))).toBe('FRAME_INVALID_JSON')
    const truncated = new FrameDecoder(64)
    truncated.push(prefixed(10, Buffer.from('{"a"')))
    expect(code(() => truncated.end())).toBe('FRAME_TRUNCATED')
    const partialPrefix = new FrameDecoder(64)
    partialPrefix.push(Buffer.from([0, 0]))
    expect(code(() => partialPrefix.end())).toBe('FRAME_TRUNCATED')
  })

  it('keeps the request frame limit at the current 10 MiB analysis bound plus a small envelope', () => {
    expect(MAX_REQUEST_FRAME_BYTES).toBe(10 * 1024 * 1024 + 4096)
    expect(code(() => encodeFrame({ pad: 'x'.repeat(64) }, 32))).toBe('FRAME_TOO_LARGE')
  })
})

type Session = { input: PassThrough; frames: unknown[]; done: Promise<number> }

function session(analyze = (body: unknown) => new AnalyzeService().analyze(body as never)): Session {
  const input = new PassThrough()
  const output = new PassThrough()
  const frames: unknown[] = []
  const decoder = new FrameDecoder(64 * 1024 * 1024)
  output.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)))
  return { input, frames, done: serveStdio({ input, output, runToken: TOKEN, analyze }) }
}

describe('ADR-01 stdio adapter session', () => {
  it('answers the handshake and runs the unchanged extraction engine over stdio', async () => {
    const s = session()
    s.input.write(encodeFrame(hello, 1024))
    s.input.write(encodeFrame({ id: 1, op: 'analyze', body: { files: [{ path: 'src/a.ts', content: 'export function twice(x: number) { return x * 2 }\n' }] } }, MAX_REQUEST_FRAME_BYTES))
    s.input.write(encodeFrame({ id: 2, op: 'analyze', body: { notFiles: [] } }, MAX_REQUEST_FRAME_BYTES))
    s.input.write(encodeFrame({ id: 3, op: 'analyze', body: { files: [{ path: '../escape.ts', content: '' }] } }, MAX_REQUEST_FRAME_BYTES))
    s.input.end()
    expect(await s.done).toBe(0)
    expect(s.frames[0]).toEqual({ protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, ready: true })
    expect(s.frames[1]).toMatchObject({ id: 1, ok: true, result: { fileOutcomes: [{ path: 'src/a.ts', status: 'SUCCESS', reason: 'TS_PARSED' }] } })
    expect(s.frames[2]).toEqual({ id: 2, ok: false, error: { status: 400, response: expect.objectContaining({ message: 'files array is required' }) } })
    // Path validation throws a plain Error, which HTTP also maps to 500; the message is not echoed.
    expect(s.frames[3]).toEqual({ id: 3, ok: false, error: { status: 500, code: 'ANALYZER_FAILURE' } })
    expect(s.frames).toHaveLength(4)
  })

  it('refuses a wrong run token, protocol version or extra handshake field without analysing', async () => {
    for (const handshake of [
      { ...hello, runToken: 'b'.repeat(64) },
      { ...hello, version: 2 },
      { ...hello, protocol: 'other' },
      { ...hello, sourcePath: '/Users/someone/project' },
      { protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION },
    ]) {
      let analysed = 0
      const s = session(async () => { analysed++; return {} as never })
      s.input.write(encodeFrame(handshake, 1024))
      s.input.write(encodeFrame({ id: 1, op: 'analyze', body: { files: [] } }, 1024))
      s.input.end()
      expect(await s.done, JSON.stringify(handshake)).toBe(2)
      expect(s.frames).toEqual([{ protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, error: 'PROTOCOL_MISMATCH' }])
      expect(analysed).toBe(0)
    }
  })

  it('stops on a framing violation without reading or answering further frames', async () => {
    let analysed = 0
    const s = session(async () => { analysed++; return {} as never })
    s.input.write(encodeFrame(hello, 1024))
    s.input.write(prefixed(MAX_REQUEST_FRAME_BYTES + 1))
    s.input.write(encodeFrame({ id: 1, op: 'analyze', body: { files: [] } }, 1024))
    expect(await s.done).toBe(3)
    expect(s.frames).toHaveLength(1)
    expect(analysed).toBe(0)
  })

  it('applies the request limit, not the handshake limit, to a request that shares the handshake chunk', async () => {
    const s = session(async (body) => ({ size: JSON.stringify(body).length }) as never)
    const large = { id: 1, op: 'analyze', body: { pad: 'x'.repeat(8192) } }
    s.input.end(Buffer.concat([encodeFrame(hello, 1024), encodeFrame(large, MAX_REQUEST_FRAME_BYTES)]))
    expect(await s.done).toBe(0)
    expect(s.frames[1]).toMatchObject({ id: 1, ok: true })
  })

  it('refuses an oversized handshake frame', async () => {
    const s = session()
    s.input.end(encodeFrame({ ...hello, pad: 'x'.repeat(2048) }, 4096))
    expect(await s.done).toBe(3)
    expect(s.frames).toEqual([])
  })

  it('rejects unknown operations, non-increasing ids and malformed envelopes per request', async () => {
    const s = session(async () => ({ ok: 1 }) as never)
    s.input.write(encodeFrame(hello, 1024))
    s.input.write(encodeFrame({ id: 1, op: 'exec', body: {} }, 1024))
    s.input.write(encodeFrame({ id: 2, op: 'analyze', body: {}, extra: true }, 1024))
    s.input.write(encodeFrame({ id: 3, op: 'analyze', body: {} }, 1024))
    s.input.write(encodeFrame({ id: 3, op: 'analyze', body: {} }, 1024))
    s.input.end()
    expect(await s.done).toBe(3)
    expect(s.frames.slice(1)).toEqual([
      { id: 1, ok: false, error: { status: 400, code: 'UNSUPPORTED_OP' } },
      { id: 2, ok: false, error: { status: 400, code: 'INVALID_ENVELOPE' } },
      { id: 3, ok: true, result: { ok: 1 } },
    ])
  })

  it('reports an unexpected engine failure without its message', async () => {
    const s = session(async () => { throw new Error('/Users/secret/path leaked') })
    s.input.write(encodeFrame(hello, 1024))
    s.input.write(encodeFrame({ id: 1, op: 'analyze', body: { files: [] } }, 1024))
    s.input.end()
    expect(await s.done).toBe(0)
    expect(s.frames[1]).toEqual({ id: 1, ok: false, error: { status: 500, code: 'ANALYZER_FAILURE' } })
  })
})
