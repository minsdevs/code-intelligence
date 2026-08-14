export function parseProjectId(raw: string | undefined): number | null {
  if (raw == null || raw === '') return null
  if (!/^[0-9]+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function projectIdFromPath(pathname: string): number | null {
  const match = pathname.match(/^\/projects\/(\d+)(?:\/|$)/)
  return match ? parseProjectId(match[1]) : null
}

export function workspaceViewFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/\d+\/([a-z]+)/)
  return match ? match[1] : null
}
