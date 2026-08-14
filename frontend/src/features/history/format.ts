export function firstLine(message: string): string {
  const line = message.split('\n')[0]?.trim()
  return line && line.length > 0 ? line : '(no message)'
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}
