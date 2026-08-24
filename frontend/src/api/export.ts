import { primeCsrf, readCookie, UnauthorizedError } from './client'

const CSRF_COOKIE = 'XSRF-TOKEN'
const CSRF_HEADER = 'X-XSRF-TOKEN'

export async function exportSummary(projectId: number, format: 'markdown' | 'json' = 'markdown'): Promise<void> {
  await primeCsrf()
  const headers = new Headers({ Accept: '*/*' })
  const csrf = readCookie(CSRF_COOKIE)
  if (csrf) headers.set(CSRF_HEADER, csrf)

  const response = await fetch(`/api/projects/${projectId}/export?format=${format}`, {
    method: 'GET',
    credentials: 'include',
    headers,
  })
  if (response.status === 401) throw new UnauthorizedError()
  if (!response.ok) throw new Error(`Export failed: ${response.status}`)

  const blob = await response.blob()
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename="?([^"]+)"?/)
  const filename = match ? match[1] : `project-summary.${format === 'json' ? 'json' : 'md'}`

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
