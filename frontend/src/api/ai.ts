import { ApiError, UnauthorizedError, apiGet, apiSend, primeCsrf, readApiError, readCookie } from './client'
import type { AiAskBody, AiAskResponse, AiStatus } from './types'

const CSRF_COOKIE = 'XSRF-TOKEN'
const CSRF_HEADER = 'X-XSRF-TOKEN'

export function getAiStatus(): Promise<AiStatus> {
  return apiGet<AiStatus>('/api/ai/status')
}

export function askAi(projectId: number, body: AiAskBody): Promise<AiAskResponse> {
  return apiSend<AiAskResponse>(`/api/projects/${projectId}/ai/ask`, { method: 'POST', body })
}

export async function askAiStream(
  projectId: number,
  body: AiAskBody,
  onToken: (token: string) => void,
): Promise<AiAskResponse> {
  await primeCsrf()
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  })
  const csrf = readCookie(CSRF_COOKIE)
  if (csrf) headers.set(CSRF_HEADER, csrf)
  const response = await fetch(`/api/projects/${projectId}/ai/ask/stream`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  })
  if (response.status === 401) throw new UnauthorizedError()
  if (!response.ok) throw new ApiError(response.status, await readApiError(response))
  if (!response.body) return askAi(projectId, body)
  return readSseResult(response.body, onToken)
}

export function parseEvidenceRef(ref: string): { path: string; line: number | null } | null {
  const match = ref.match(/^file:([^:]+):(\d+)$/)
  if (!match) return null
  return { path: match[1], line: Number(match[2]) }
}

async function readSseResult(
  body: ReadableStream<Uint8Array>,
  onToken: (token: string) => void,
): Promise<AiAskResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: AiAskResponse | null = null
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const block of parts) {
      const parsed = parseSseBlock(block)
      if (parsed.event === 'token' && parsed.data) onToken(parsed.data)
      if (parsed.event === 'result' && parsed.data) {
        result = JSON.parse(parsed.data) as AiAskResponse
      }
    }
    if (done) break
  }
  if (buffer.trim()) {
    const parsed = parseSseBlock(buffer)
    if (parsed.event === 'token' && parsed.data) onToken(parsed.data)
    if (parsed.event === 'result' && parsed.data) {
      result = JSON.parse(parsed.data) as AiAskResponse
    }
  }
  if (!result) throw new ApiError(502, 'AI stream ended without a result.')
  return result
}

export function parseSseBlock(block: string): { event: string; data: string } {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  return { event, data: dataLines.join('\n') }
}
