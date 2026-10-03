import { ApiError, UnauthorizedError, apiGet, apiSend, desktopApiHeaders, primeCsrf, readApiError, readCookie, resolveApiUrl } from './client'
import type { AiAskBody, AiAskResponse, AiStatus } from './types'

const CSRF_COOKIE = 'XSRF-TOKEN'
const CSRF_HEADER = 'X-XSRF-TOKEN'

export function getAiStatus(): Promise<AiStatus> {
  return apiGet<AiStatus>('/api/ai/status')
}

export function askAi(projectId: number, body: AiAskBody): Promise<AiAskResponse> {
  return apiSend<AiAskResponse>(`/api/projects/${projectId}/ai/ask`, { method: 'POST', body, retryOnCsrfFailure: false })
}

export async function askAiStream(
  projectId: number,
  body: AiAskBody,
  onToken: (token: string) => void,
): Promise<AiAskResponse> {
  await primeCsrf()
  const headers = desktopApiHeaders(new Headers({
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }))
  const csrf = readCookie(CSRF_COOKIE)
  if (csrf) headers.set(CSRF_HEADER, csrf)
  const response = await fetch(resolveApiUrl(`/api/projects/${projectId}/ai/ask/stream`), {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  })
  if (response.status === 401) throw new UnauthorizedError()
  if (!response.ok) throw new ApiError(response.status, await readApiError(response))
  if (!response.body) throw unknownOutcome('AI response stream is missing.')
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
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      const parts = buffer.split(/\r?\n\r?\n/)
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
    if (!result || !Number.isSafeInteger(result.conversationId) || !Number.isSafeInteger(result.messageId)
      || typeof result.explanation !== 'string' || !Array.isArray(result.claims) || !Array.isArray(result.alternatives)) {
      throw unknownOutcome('AI stream ended without a complete result.')
    }
    return result
  } catch {
    // The server may already have dispatched the request. Never replay it through another endpoint.
    throw unknownOutcome('AI stream did not provide a complete result.')
  } finally {
    reader.releaseLock()
  }
}

function unknownOutcome(message: string): ApiError {
  return new ApiError(502, `${message} The request outcome is unknown; it was not resent.`, 'AI_REQUEST_OUTCOME_UNKNOWN')
}

export function parseSseBlock(block: string): { event: string; data: string } {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  return { event, data: dataLines.join('\n') }
}
