import { apiGet, apiSend } from './client'
import type { JobDetail } from './types'

export function getJob(jobId: number): Promise<JobDetail> {
  return apiGet<JobDetail>(`/api/jobs/${jobId}`)
}

export function retryJob(jobId: number): Promise<void> {
  return apiSend(`/api/jobs/${jobId}/retry`, { method: 'POST' })
}

export function cancelJob(jobId: number): Promise<void> {
  return apiSend(`/api/jobs/${jobId}/cancel`, { method: 'POST' })
}

export function parseJobEventData(data: string): JobDetail {
  let parsed: unknown = JSON.parse(data)
  if (typeof parsed === 'string') {
    parsed = JSON.parse(parsed)
  }
  return parsed as JobDetail
}

function emitEventBlock(block: string, onJob: (job: JobDetail) => void): void {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (data) onJob(parseJobEventData(data))
}

export function subscribeJobEvents(
  jobId: number,
  onJob: (job: JobDetail) => void,
  onDisconnect: () => void,
): () => void {
  const controller = new AbortController()
  void fetch(`/api/jobs/${jobId}/events`, {
    method: 'GET',
    credentials: 'include',
    headers: new Headers({ Accept: 'text/event-stream' }),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok || !response.body) {
        throw new Error(`Event stream failed (${response.status})`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() ?? ''
        for (const block of blocks) emitEventBlock(block, onJob)
        if (done) {
          if (buffer.trim()) emitEventBlock(buffer, onJob)
          return
        }
      }
    })
    .catch(() => {
      if (!controller.signal.aborted) onDisconnect()
    })
  return () => controller.abort()
}
