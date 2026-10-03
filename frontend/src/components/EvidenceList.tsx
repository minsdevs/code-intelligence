import type { FeatureEvidenceView } from '../api/types'
import { useT } from '../lib/i18n'

export default function EvidenceList({
  evidences,
  onOpen,
}: {
  evidences: FeatureEvidenceView[]
  projectId?: number | null
  onOpen: (path: string, line: number | null, evidence: FeatureEvidenceView) => void
}) {
  const t = useT()
  return (
    <>
      <h4 className="mt-5 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">
        Evidence
      </h4>
      {evidences.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-muted">{t('evidence.none')}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {evidences.map((evidence, index) => (
            <li key={`${evidence.filePath ?? 'none'}-${index}`}>
              {evidence.filePath ? (
                <div className="flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-surface-2">
                  <button
                    type="button"
                    onClick={() => onOpen(evidence.filePath!, evidence.lineStart, evidence)}
                    className="flex min-w-0 flex-1 flex-col text-left"
                  >
                    <span className="font-mono text-[12px] text-ink">
                      {evidence.filePath}
                      {evidence.lineStart != null ? `:${evidence.lineStart}` : ''}
                    </span>
                    {evidence.excerpt && (
                      <span className="mt-0.5 line-clamp-2 text-[12px] text-ink-muted">
                        {evidence.excerpt}
                      </span>
                    )}
                  </button>
                </div>
              ) : (
                <p className="px-2 py-1.5 text-[13px] text-ink-muted">
                  {evidence.excerpt ?? 'evidence'}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
