import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { parseAnalyzeRequest } from './request'
import {
  ADAPTER_STDIO_PROTOCOL,
  ADAPTER_STDIO_VERSION,
  FrameDecoder,
  FrameError,
  MAX_REQUEST_FRAME_BYTES,
  encodeFrame,
  serveStdio,
} from './stdio-transport'
import { extract } from './tree'

const TOKEN = 'c'.repeat(64)
const hello = { protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, runToken: TOKEN }

function prefixed(length: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(length)
  return Buffer.concat([prefix, body])
}

function session(analyze: (body: unknown) => Promise<unknown> = async (body) => extract(parseAnalyzeRequest(body))) {
  const input = new PassThrough()
  const output = new PassThrough()
  const frames: unknown[] = []
  const decoder = new FrameDecoder(64 * 1024 * 1024)
  output.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)))
  return { input, frames, done: serveStdio({ input, output, runToken: TOKEN, analyze }) }
}

describe('tree analyzer ADR-01 stdio transport', () => {
  it('uses the same framing limits as the TS analyzer', () => {
    expect(MAX_REQUEST_FRAME_BYTES).toBe(10 * 1024 * 1024 + 4096)
    const decoder = new FrameDecoder(8)
    let failure: unknown
    try { decoder.push(prefixed(9)) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(FrameError)
    expect((failure as FrameError).code).toBe('FRAME_TOO_LARGE')
  })

  it('runs tree-sitter extraction over stdio and maps request errors to 400 like HTTP', async () => {
    const s = session()
    s.input.write(encodeFrame(hello, 1024))
    s.input.write(encodeFrame({ id: 1, op: 'analyze', body: { files: [{ path: 'app/main.py', content: 'def helper():\n    return 1\n' }] } }, MAX_REQUEST_FRAME_BYTES))
    s.input.write(encodeFrame({ id: 2, op: 'analyze', body: { files: [{ path: '../escape.py', content: '' }] } }, MAX_REQUEST_FRAME_BYTES))
    s.input.write(encodeFrame({ id: 3, op: 'analyze', body: { files: Array.from({ length: 501 }, (_, i) => ({ path: `f${i}.py`, content: '' })) } }, MAX_REQUEST_FRAME_BYTES))
    s.input.end()
    expect(await s.done).toBe(0)
    expect(s.frames[0]).toEqual({ protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, ready: true })
    expect(s.frames[1]).toMatchObject({ id: 1, ok: true, result: { symbols: [expect.objectContaining({ name: 'helper' })] } })
    expect(s.frames[2]).toEqual({ id: 2, ok: false, error: { status: 400, response: { error: 'file path must not contain ..' } } })
    expect(s.frames[3]).toEqual({ id: 3, ok: false, error: { status: 400, response: { error: 'at most 500 files per request' } } })
  })

  it('refuses a wrong run token and stops on a framing violation', async () => {
    const refused = session()
    refused.input.end(encodeFrame({ ...hello, runToken: 'd'.repeat(64) }, 1024))
    expect(await refused.done).toBe(2)
    expect(refused.frames).toEqual([{ protocol: ADAPTER_STDIO_PROTOCOL, version: ADAPTER_STDIO_VERSION, error: 'PROTOCOL_MISMATCH' }])
    let analysed = 0
    const corrupt = session(async () => { analysed++; return {} })
    corrupt.input.write(encodeFrame(hello, 1024))
    corrupt.input.write(prefixed(MAX_REQUEST_FRAME_BYTES + 1))
    corrupt.input.end(encodeFrame({ id: 1, op: 'analyze', body: { files: [] } }, 1024))
    expect(await corrupt.done).toBe(3)
    expect(corrupt.frames).toHaveLength(1)
    expect(analysed).toBe(0)
  })

  it('does not echo unexpected engine failures', async () => {
    const s = session(async () => { throw new Error('/Users/secret/path') })
    s.input.write(encodeFrame(hello, 1024))
    s.input.end(encodeFrame({ id: 1, op: 'analyze', body: { files: [] } }, 1024))
    expect(await s.done).toBe(0)
    expect(s.frames[1]).toEqual({ id: 1, ok: false, error: { status: 500, code: 'ANALYZER_FAILURE' } })
  })
})
