import { useId } from 'react'
import type { ImpactNodeView, ImpactOutsideAnalysis } from '../../api/types'
import { useT } from '../../lib/i18n'
import { isConfirmedRelation, relationConfidenceLabel } from '../../lib/relationConfidence'

type OpenDependent = (dependent: ImpactNodeView) => void

/** Confirmed reverse dependencies first, then candidates. A row without a verdict is never confirmed. */
export function ImpactDependentGroups({ dependents, onOpen }: { dependents: ImpactNodeView[]; onOpen: OpenDependent }) {
  const t = useT()
  const confirmed = dependents.filter((dependent) => isConfirmedRelation(dependent.confidence))
  const candidates = dependents.filter((dependent) => !isConfirmedRelation(dependent.confidence))
  return (
    <>
      <ImpactGroup title={t('analysis.impact.confirmedGroup')} rows={confirmed} onOpen={onOpen} />
      <ImpactGroup title={t('analysis.impact.candidateGroup')} rows={candidates} onOpen={onOpen} />
    </>
  )
}

function ImpactGroup({ title, rows, onOpen }: { title: string; rows: ImpactNodeView[]; onOpen: OpenDependent }) {
  const t = useT()
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="mt-4">
      <h3 id={headingId} className="text-[12px] font-semibold text-ink">
        {title} <span className="font-normal text-ink-faint">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-[12px] text-ink-muted">{t('analysis.impact.groupEmpty')}</p>
      ) : (
        <ol aria-label={title} className="mt-1 space-y-1">
          {rows.map((dependent) => (
            <li key={dependent.nodeId}>
              {dependent.filePath ? (
                <button
                  type="button"
                  onClick={() => onOpen(dependent)}
                  className="w-full rounded-md px-1 py-1 text-left hover:bg-surface-2"
                >
                  <DependentText dependent={dependent} />
                </button>
              ) : (
                <div className="px-1 py-1">
                  <DependentText dependent={dependent} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function DependentText({ dependent }: { dependent: ImpactNodeView }) {
  const t = useT()
  const paths =
    dependent.pathCount != null && dependent.pathCount > 1
      ? ` · ${t('analysis.impact.paths').replace('{count}', String(dependent.pathCount))}`
      : ''
  return (
    <>
      <span className="block text-[13px] text-ink">{dependent.name}</span>
      <span
        className={`block text-[11px] ${isConfirmedRelation(dependent.confidence) ? 'text-ink-muted' : 'text-warn'}`}
      >
        {relationConfidenceLabel(t, dependent.confidence)}
        {paths}
      </span>
      <span className="font-mono text-[11px] text-ink-faint">
        d{dependent.depth} · {dependent.edgeType}
        {dependent.filePath ? ` · ${dependent.filePath}` : ''}
        {dependent.filePath && dependent.line != null ? `:${dependent.line}` : ''}
      </span>
    </>
  )
}

const count = (value: number | null | undefined) => (value == null ? '?' : String(value))

/** Recorded areas whose impact the lists cannot show. Missing data reads as unknown, never as none. */
export function ImpactOutsideAnalysisSection({ outside }: { outside: ImpactOutsideAnalysis | null | undefined }) {
  const t = useT()
  const title = t('analysis.impact.outsideGroup')
  const measured = outside?.measurementStatus === 'PER_FILE_RECORDED'
  return (
    <section aria-label={title} className="mt-4 border-t border-line pt-3">
      <h3 className="text-[12px] font-semibold text-ink">{title}</h3>
      {measured ? (
        <>
          <p className="mt-1 text-[12px] text-ink-muted">
            {t('analysis.impact.outsideSummary')
              .replace('{unsupported}', count(outside.unsupportedFiles))
              .replace('{failed}', count(outside.failedFiles))
              .replace('{partial}', count(outside.partialFiles))
              .replace('{pending}', count(outside.pendingFiles))
              .replace('{unmeasured}', count(outside.unmeasuredFiles))
              .replace('{excluded}', count(outside.excludedFiles))}
          </p>
          {outside.areas.length > 0 && (
            <ul aria-label={title} className="mt-1 space-y-1">
              {outside.areas.map((area) => (
                <li key={`${area.status}-${area.language ?? ''}`} className="px-1 py-0.5 text-[12px] text-ink">
                  {t(`analysis.impact.outsideStatus.${area.status}`)} ·{' '}
                  {area.language || t('analysis.impact.unknownLanguage')} ·{' '}
                  {t('analysis.impact.areaFiles').replace('{count}', String(area.files))}
                  {area.samplePath && (
                    <span className="block font-mono text-[11px] text-ink-faint">{area.samplePath}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="mt-1 text-[12px] text-ink-muted">{t('analysis.impact.outsideLegacy')}</p>
      )}
      <p className="mt-1 text-[12px] text-ink-muted">{t('analysis.impact.outsideAlways')}</p>
    </section>
  )
}
