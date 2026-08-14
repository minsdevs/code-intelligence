import type { FeatureEvidenceView } from '../api/types'
import { useT } from '../lib/i18n'

export default function EvidenceList({
  evidences,
  onOpen,
}: {
  evidences: FeatureEvidenceView[]
  onOpen: (path: string, line: number | null) => void
}) {
  const t = useT()
  return (
    <>
      <h4 className="mt-5 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">Evidence</h4>
      {evidences.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-muted">{t('evidence.none')}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {evidences.map((evidence, index) => (
            <li key={`${evidence.filePath ?? 'none'}-${index}`}>
              {evidence.filePath ? (
                <button
                  type="button"
                  onClick={() => onOpen(evidence.filePath!, evidence.lineStart)}
                  className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                >
                  <span className="font-mono text-[12px] text-ink">
                    {evidence.filePath}
                    {evidence.lineStart != null ? `:${evidence.lineStart}` : ''}
                  </span>
                  {evidence.excerpt && (
                    <span className="mt-0.5 line-clamp-2 text-[12px] text-ink-muted">{evidence.excerpt}</span>
                  )}
                </button>
              ) : (
                <p className="px-2 py-1.5 text-[13px] text-ink-muted">{evidence.excerpt ?? 'evidence'}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
