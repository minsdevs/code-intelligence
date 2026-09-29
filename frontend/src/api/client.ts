const CSRF_COOKIE = 'XSRF-TOKEN'
const CSRF_HEADER = 'X-XSRF-TOKEN'
const desktop = typeof window === 'undefined' ? undefined : window.codeIntelligenceDesktop

export function resolveApiUrl(path: string): string {
  if (!path.startsWith('/')) throw new Error('API paths must be root-relative')
  return desktop ? desktop.apiBaseUrl + path : path
}

export function desktopApiHeaders(headers = new Headers()): Headers {
  if (desktop) headers.set('X-Code-Intelligence-Token', desktop.apiToken)
  return headers
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized') {
    super(401, message)
    this.name = 'UnauthorizedError'
  }
}

export function readCookie(name: string): string | undefined {
  const prefix = `${name}=`
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length))
    }
  }
  return undefined
}

export async function primeCsrf(): Promise<void> {
  await fetch(resolveApiUrl('/api/csrf'), {
    method: 'GET',
    credentials: 'include',
    headers: desktopApiHeaders(),
  })
}

export async function readApiError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object') {
      const problem = body as { detail?: unknown; title?: unknown }
      if (typeof problem.detail === 'string' && problem.detail.length > 0) {
        return problem.detail
      }
      if (typeof problem.title === 'string' && problem.title.length > 0) {
        return problem.title
      }
    }
  } catch {
    // ignore non-JSON error bodies
  }
  return `Request failed (${response.status})`
}

async function request<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
  const headers = desktopApiHeaders()
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  if (init.method !== 'GET' && init.method !== 'HEAD') {
    const csrf = readCookie(CSRF_COOKIE)
    if (csrf) {
      headers.set(CSRF_HEADER, csrf)
    }
  }

  const response = await fetch(resolveApiUrl(path), {
    method: init.method,
    credentials: 'include',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })

  if (response.status === 401) {
    throw new UnauthorizedError()
  }
  if (!response.ok) {
    throw new ApiError(response.status, await readApiError(response))
  }
  if (response.status === 204 || response.status === 202) {
    const text = await response.text()
    return (text ? JSON.parse(text) : undefined) as T
  }
  return (await response.json()) as T
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' })
}

export async function apiSend<T = void>(
  path: string,
  options: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown },
): Promise<T> {
  await primeCsrf()
  try {
    return await request<T>(path, { method: options.method, body: options.body })
  } catch (error) {
    // A browser can retain an old XSRF-TOKEN after the backend restarts. Refresh it once
    // before surfacing a 403; do not disable CSRF or retry other failures indefinitely.
    if (!(error instanceof ApiError) || error.status !== 403) {
      throw error
    }
    await primeCsrf()
    return request<T>(path, { method: options.method, body: options.body })
  }
}
