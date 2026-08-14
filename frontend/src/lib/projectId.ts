export function parseProjectId(raw: string | undefined): number | null {
  if (raw == null || raw === '') return null
  if (!/^[0-9]+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
