import { useQuery } from '@tanstack/react-query'
import { getCoverage } from '../../api/coverage'
import type { CoverageReport, LocalImportSummary } from '../../api/types'
import { useT } from '../../lib/i18n'

type Props = { projectId: number; snapshotId?: number }

// Labels live in translations.ts under coverage.step.* and coverage.exclusion.*.
const stepStatuses = new Set(['done', 'failed', 'running', 'pending', 'skipped'])

const importExclusionReasons = [
  'GENERATED_DIRECTORY',
  'SECRET_PATH',
  'IGNORED',
  'BINARY',
  'OVERSIZED',
  'FILE_LIMIT',
  'SYMLINK',
  'HARD_LINK',
  'SECRET_CONTENT',
]
const importSummaryFields = new Set(['schemaVersion', 'policyVersion', 'acceptedFiles', 'bytesRead', 'excludedEntriesByReason'])

function inventoryCount(t: (key: string) => string, count: number | undefined): number | string {
  return count != null && Number.isSafeInteger(count) && count >= 0 ? count : t('coverage.unknown')
}

function isBoundedCount(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

function validatedLocalImport(value: unknown): LocalImportSummary | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  const summary = value as Record<string, unknown>
  const fields = Object.keys(summary)
  if (fields.length !== importSummaryFields.size || fields.some((field) => !importSummaryFields.has(field))) return null
  if (summary.schemaVersion !== 1 || summary.policyVersion !== 'local-ingest-v1'
    || !isBoundedCount(summary.acceptedFiles, 50_000) || !isBoundedCount(summary.bytesRead, 536_870_912)) return null
  const reasons = summary.excludedEntriesByReason
  if (reasons == null || typeof reasons !== 'object' || Array.isArray(reasons)) return null
  let encounteredEntries = summary.acceptedFiles
  for (const [reason, count] of Object.entries(reasons)) {
    if (!importExclusionReasons.includes(reason) || !isBoundedCount(count, 200_000)) return null
    encounteredEntries += count
    if (encounteredEntries > 200_000) return null
  }
  return value as LocalImportSummary
}

function LocalImportDetails({ summary }: { summary: LocalImportSummary | null }) {
  const t = useT()
  const unit = (count: number) => t('coverage.countUnit').replace('{count}', count.toLocaleString())
  return (
    <section aria-label={t('coverage.localImport')}>
      <h4 className="font-medium mb-1">{t('coverage.localImport')}</h4>
      {summary == null ? (
        <p className="text-xs text-ink-muted">{t('coverage.localImportUnknown')}</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <dt>{t('coverage.importedFiles')}</dt><dd>{unit(summary.acceptedFiles)}</dd>
            <dt>{t('coverage.bytesRead')}</dt><dd>{t('coverage.bytesUnit').replace('{count}', summary.bytesRead.toLocaleString())}</dd>
          </dl>
          <p className="mt-2 text-xs text-ink-muted">{t('coverage.excludedNote')}</p>
          {Object.keys(summary.excludedEntriesByReason).length === 0 ? (
            <p className="mt-1 text-xs text-ink-muted">{t('coverage.noExclusions')}</p>
          ) : (
            <dl className="mt-1 grid grid-cols-2 gap-2 text-xs">
              {importExclusionReasons.map((reason) => {
                const count = (summary.excludedEntriesByReason as Record<string, number | undefined>)[reason]
                return count == null ? null : (
                  <div key={reason} className="contents">
                    <dt>{t(`coverage.exclusion.${reason}`)}</dt><dd>{unit(count)}</dd>
                  </div>
                )
              })}
            </dl>
          )}
        </>
      )}
    </section>
  )
}

export function CoveragePanel({ projectId, snapshotId }: Props) {
  const t = useT()
  const { data, isLoading, error } = useQuery<CoverageReport>({
    queryKey: ['coverage', projectId, snapshotId],
    queryFn: () => getCoverage(projectId, snapshotId),
  })

  if (isLoading) return <div className="text-sm text-ink-muted">{t('coverage.loading')}</div>
  if (error || !data) {
    return <p role="alert" className="text-sm text-warn">{t('coverage.error')}</p>
  }

  const { fileCoverage, languageCoverage, analyzerStatuses } = data
  const measured = data.measurementStatus === 'PER_FILE_RECORDED' && data.outcomes != null
  const hasInventoryContract = measured || data.measurementStatus === 'LEGACY_UNMEASURED'
  const countSkips = hasInventoryContract ? fileCoverage.skippedForCount : null
  const sizeSkips = hasInventoryContract ? fileCoverage.skippedForSize : null

  return (
    <section aria-label={t('coverage.title')} className="space-y-4 rounded border p-4 text-sm">
      <h3 className="font-semibold text-base">{t('coverage.title')}</h3>
      {measured ? (
        <section aria-label={t('coverage.perFile')}>
          <p className="mb-2 text-xs text-ink-muted">{t('coverage.perFileNote')}</p>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            {([
              ['discovered', data.outcomes!.discoveredFiles], ['targeted', data.outcomes!.targetedFiles],
              ['successful', data.outcomes!.successfulFiles], ['partial', data.outcomes!.partialFiles],
              ['failed', data.outcomes!.failedFiles], ['excluded', data.outcomes!.excludedFiles],
              ['unsupported', data.outcomes!.unsupportedFiles], ['unmeasured', data.outcomes!.unmeasuredFiles],
              ['pending', data.outcomes!.pendingFiles],
            ] as const).map(([key, count]) => <div key={key} className="contents"><dt>{t(`coverage.outcome.${key}`)}</dt><dd>{inventoryCount(t, count)}</dd></div>)}
          </dl>
          <p className="mt-2 text-xs text-ink-muted">{t('coverage.discoveryNote').replace('{count}', String(data.outcomes!.excludedSubmodules))}</p>
        </section>
      ) : <p className="rounded bg-warn/10 p-2 text-xs text-warn">
        {t('coverage.unmeasured')}
        {t(hasInventoryContract ? 'coverage.unmeasuredLegacy' : 'coverage.unmeasuredMissing')}
      </p>}

      <section>
        <h4 className="font-medium mb-1">{t('coverage.fileList')}</h4>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <span>{t('coverage.inventoried')}</span><span>{inventoryCount(t, fileCoverage.inventoriedFiles)}</span>
          {countSkips != null && Number.isSafeInteger(countSkips) && countSkips > 0 && (
            <><span className="text-warn">{t('coverage.countSkips')}</span><span className="text-warn">{countSkips}</span></>
          )}
          {sizeSkips != null && Number.isSafeInteger(sizeSkips) && sizeSkips > 0 && (
            <><span className="text-warn">{t('coverage.sizeSkips')}</span><span className="text-warn">{sizeSkips}</span></>
          )}
        </div>
      </section>

      <LocalImportDetails summary={validatedLocalImport(data.localImport)} />

      {languageCoverage.length > 0 && (
        <section>
          <h4 className="font-medium mb-1">{t('coverage.languages')}</h4>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-ink-muted">
                <th scope="col">{t('coverage.col.language')}</th><th scope="col">{t('coverage.col.inventoried')}</th>
                <th scope="col">{t('coverage.col.analyzed')}</th><th scope="col">{t('coverage.col.failed')}</th>
              </tr>
            </thead>
            <tbody>
              {languageCoverage.map((language) => (
                <tr key={language.language}>
                  <th scope="row" className="text-left font-normal">{language.language}</th>
                  <td>{inventoryCount(t, language.inventoriedFiles)}</td>
                  <td>{measured ? inventoryCount(t, language.analyzed ?? undefined) : t('coverage.unknown')}</td>
                  <td>{measured ? inventoryCount(t, language.failed ?? undefined) : t('coverage.unknown')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h4 className="font-medium mb-1">{t('coverage.analyzers')}</h4>
        <p className="mb-1 text-xs text-ink-muted">{t('coverage.analyzersNote')}</p>
        {analyzerStatuses.length === 0 && <p className="text-xs text-ink-muted">{t('coverage.unknown')}</p>}
        <ul className="space-y-1 text-xs">
          {analyzerStatuses.map((analyzer) => (
            <li key={analyzer.name} className="flex items-center gap-2">
              <span className={analyzer.status === 'failed' ? 'text-danger' : 'text-ink-muted'} aria-hidden="true">●</span>
              <span>{analyzer.name}</span>
              <span className="text-ink-muted">
                {measured && analyzer.status === 'done'
                  ? t('coverage.stepEnded')
                  : stepStatuses.has(analyzer.status) ? t(`coverage.step.${analyzer.status}`) : t('coverage.unknown')}
              </span>
              {analyzer.status === 'failed' && analyzer.failureReason && <span className="text-danger text-[10px]">({analyzer.failureReason})</span>}
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-ink-muted">{t('coverage.supportNote')}</p>
    </section>
  )
}
