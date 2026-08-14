import { Suspense, lazy } from 'react'
import type { CommitDetail as CommitDetailData, CommitDiff } from '../../api/types'
import { useT } from '../../lib/i18n'
import { firstLine, formatWhen, shortSha } from './format'

const DiffViewer = lazy(() => import('./DiffViewer'))

type CommitDetailProps = {
  detail: CommitDetailData
  selectedPath: string | null
  onSelectPath: (path: string) => void
  diff: CommitDiff | undefined
  diffLoading: boolean
  diffError: string | null
}

export default function CommitDetail({
  detail,
  selectedPath,
  onSelectPath,
  diff,
  diffLoading,
  diffError,
}: CommitDetailProps) {
  const t = useT()
  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-y-auto" aria-label="Commit detail">
      <header className="border-b border-line px-5 py-4">
        <h2 className="text-[15px] font-semibold text-ink">{firstLine(detail.message)}</h2>
        {detail.message.includes('\n') && (
          <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink-muted">
            {detail.message.trim()}
          </pre>
        )}
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px] text-ink-faint">
          <span>{detail.author}</span>
          <span title={detail.sha}>{shortSha(detail.sha)}</span>
          <span>{formatWhen(detail.committedAt)}</span>
          <span>
            <span className="text-ok">+{detail.additions}</span>{' '}
            <span className="text-danger">−{detail.deletions}</span>
          </span>
        </p>
      </header>

      <section className="px-5 py-3">
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{t('history.changedFiles')}</h3>
        {detail.files.length === 0 ? (
          <p className="text-[13px] text-ink-muted">{t('history.noChangedFiles')}</p>
        ) : (
          <ul className="flex flex-col">
            {detail.files.map((file) => {
              const active = file.path === selectedPath
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => onSelectPath(file.path)}
                    aria-current={active ? 'true' : undefined}
                    className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12px] ${
                      active ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    <span className="shrink-0 text-[10px] uppercase text-ink-faint">{file.changeType}</span>
                    <span className="truncate">{file.path}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {selectedPath && (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={`${selectedPath} diff`}>
          {diffLoading && <p className="px-5 py-3 text-[13px] text-ink-muted">{t('history.loadingDiff')}</p>}
          {diffError && (
            <p role="alert" className="px-5 py-3 text-[12px] text-danger">
              {diffError}
            </p>
          )}
          {diff && (
            <Suspense fallback={<p className="px-5 py-3 text-[13px] text-ink-muted">{t('code.loadingEditor')}</p>}>
              <DiffViewer path={selectedPath} original={diff.oldContent} modified={diff.newContent} />
            </Suspense>
          )}
        </section>
      )}
    </article>
  )
}
