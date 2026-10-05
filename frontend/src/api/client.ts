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
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized', code?: string) {
    super(401, message, code)
    this.name = 'UnauthorizedError'
  }
}

/** Mutation preparation failed before the request could reach the server. */
export class MutationNotSentError extends Error {
  constructor(cause: unknown) {
    super('The request was not sent.', { cause })
    this.name = 'MutationNotSentError'
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
  const response = await fetch(resolveApiUrl('/api/csrf'), {
    method: 'GET',
    credentials: 'include',
    headers: desktopApiHeaders(),
  })
  if (!response.ok) throw await responseError(response)
}

async function readApiProblem(response: Response): Promise<{ message: string; code?: string }> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const problem = body as { detail?: unknown; title?: unknown; code?: unknown }
      const code = typeof problem.code === 'string' ? problem.code : undefined
      if (typeof problem.detail === 'string' && problem.detail)
        return { message: problem.detail, code }
      if (typeof problem.title === 'string' && problem.title)
        return { message: problem.title, code }
      return { message: `Request failed (${response.status})`, code }
    }
  } catch {
    /* non-JSON error */
  }
  return { message: `Request failed (${response.status})` }
}

async function responseError(response: Response): Promise<ApiError> {
  const problem = await readApiProblem(response)
  return response.status === 401
    ? new UnauthorizedError(problem.message, problem.code)
    : new ApiError(response.status, problem.message, problem.code)
}

export async function readApiError(response: Response): Promise<string> {
  return (await readApiProblem(response)).message
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

  if (!response.ok) {
    throw await responseError(response)
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
  options: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    body?: unknown
    /** One-use approvals must reconcile their outcome instead of resending a mutation. */
    retryOnCsrfFailure?: boolean
  },
): Promise<T> {
  try {
    await primeCsrf()
  } catch (cause) {
    throw new MutationNotSentError(cause)
  }
  try {
    return await request<T>(path, { method: options.method, body: options.body })
  } catch (error) {
    // Only the server's explicit CSRF rejection authorizes one refresh and resend.
    // Permission errors and upstream messages cannot establish that a mutation was rejected by CSRF.
    if (
      options.retryOnCsrfFailure === false ||
      !(error instanceof ApiError) ||
      error.status !== 403 ||
      error.code !== 'CSRF_INVALID'
    ) {
      throw error
    }
    await primeCsrf()
    return request<T>(path, { method: options.method, body: options.body })
  }
}
