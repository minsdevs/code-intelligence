import { apiGet, apiSend } from './client'
import type { JobDetail } from './types'

export function getJob(jobId: number): Promise<JobDetail> {
  return apiGet<JobDetail>(`/api/jobs/${jobId}`)
}

export function retryJob(jobId: number): Promise<void> {
  return apiSend(`/api/jobs/${jobId}/retry`, { method: 'POST' })
}

export function parseJobEventData(data: string): JobDetail {
  let parsed: unknown = JSON.parse(data)
  if (typeof parsed === 'string') {
    parsed = JSON.parse(parsed)
  }
  return parsed as JobDetail
}

export function subscribeJobEvents(
  jobId: number,
  onJob: (job: JobDetail) => void,
  onDisconnect: () => void,
): () => void {
  const source = new EventSource(`/api/jobs/${jobId}/events`, { withCredentials: true })
  const handle = (event: MessageEvent<string>) => {
    onJob(parseJobEventData(event.data))
  }
  source.addEventListener('snapshot', handle)
  source.addEventListener('update', handle)
  source.onerror = () => {
    source.close()
    onDisconnect()
  }
  return () => {
    source.close()
  }
}
