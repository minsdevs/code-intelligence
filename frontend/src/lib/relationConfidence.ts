const KNOWN = new Set(['CONFIRMED', 'LIKELY', 'POSSIBLE'])

/** Text verdict for a recorded relation. Colour or line style must never carry it alone. */
export function relationConfidenceLabel(
  t: (key: string) => string,
  confidence: string | null | undefined,
): string {
  const value = (confidence ?? '').toUpperCase()
  return KNOWN.has(value)
    ? t(`relation.confidence.${value}`)
    : t('relation.confidence.unknown').replace('{value}', confidence || '?')
}

export function isConfirmedRelation(confidence: string | null | undefined): boolean {
  return (confidence ?? '').toUpperCase() === 'CONFIRMED'
}
