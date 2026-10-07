import { useEffect, useRef, useState } from 'react'
import {
  createLocalProject,
  getLocalPreviewOutcome,
  previewLocalProject,
  previewLocalRefresh,
  reanalyzeLocalProject,
} from '../../api/projects'
import type {
  LocalDirectoryCount,
  LocalImportExclusionReason,
  LocalImportScope,
  LocalLanguageCount,
  LocalSourcePreview,
} from '../../api/types'
import { useT } from '../../lib/i18n'
import { expectedDepthLabels, importExclusionLabels, isLocalSourcePreview } from './localSourcePreview'

type Source =
  | { operation: 'INITIAL'; path: string; grant?: string }
  | { operation: 'REFRESH'; projectId: number }
type Phase = 'idle' | 'previewing' | 'ready' | 'submitting' | 'checking' | 'uncertain' | 'started'
type ScopeOptions = { languages: LocalLanguageCount[]; directories: LocalDirectoryCount[] }
type Props = {
  source: Source
  disabled?: boolean
  onStarted: (projectId: number, jobId: number) => void
  onBusyChange?: (busy: boolean) => void
}

// A stalled HTTP body is an unknown outcome too. The original mutation is never resent.
async function responseDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Response deadline exceeded')), 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// A picked folder's grant is sent with every preview and spent by the confirmation.
function selection(source: Extract<Source, { operation: 'INITIAL' }>) {
  return source.grant ? { grant: source.grant } : {}
}

/** Each source gets a separate lifetime, so a late response cannot approve another source. */
export default function LocalSourceApproval(props: Props) {
  const scope =
    props.source.operation === 'INITIAL'
      ? `${props.source.path}:${props.source.grant ?? ''}`
      : props.source.projectId
  return <ApprovalFlow key={`${props.source.operation}:${scope}`} {...props} />
}

function ApprovalFlow({ source, disabled = false, onStarted, onBusyChange }: Props) {
  const t = useT()
  const [phase, setPhase] = useState<Phase>('idle')
  const [preview, setPreview] = useState<LocalSourcePreview | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Scope choices come from the whole-folder preview, so a narrowed preview can still widen again.
  const [scopeOptions, setScopeOptions] = useState<ScopeOptions | null>(null)
  const [chosen, setChosen] = useState<LocalImportScope>({ directories: [], languages: [] })
  const active = useRef(true)
  const locked = useRef(false)
  const outcomeToken = useRef<string | null>(null)
  const previewHeading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const busy = phase === 'submitting' || phase === 'checking' || phase === 'uncertain'
  // The request button disappears when the preview renders; keep keyboard focus on its heading.
  useEffect(() => {
    if (preview) previewHeading.current?.focus()
  }, [preview])
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    if (!preview) return
    const expire = () => {
      if (locked.current) return
      setPreview(null)
      setPhase('idle')
      setMessage('preview.expired')
    }
    const remaining = Date.parse(preview.expiresAt) - Date.now()
    if (remaining <= 0) {
      const timer = window.setTimeout(expire, 0)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(expire, Math.min(remaining, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [preview])

  async function loadPreview(scope?: LocalImportScope) {
    if (locked.current || disabled) return
    locked.current = true
    setMessage(null)
    setPreview(null)
    setPhase('previewing')
    try {
      const next =
        source.operation === 'INITIAL'
          ? await responseDeadline(
              previewLocalProject(source.path, { ...selection(source), ...(scope ? { scope } : {}) }),
            )
          : await responseDeadline(previewLocalRefresh(source.projectId))
      if (!active.current) return
      if (!isLocalSourcePreview(next, source.operation)) throw new Error('Invalid preview')
      if (Date.parse(next.expiresAt) <= Date.now()) throw new Error('Expired preview')
      if (!next.scope) setScopeOptions({ languages: next.languages ?? [], directories: next.directories ?? [] })
      setPreview(next)
      setPhase('ready')
    } catch {
      if (!active.current) return
      setPhase('idle')
      setMessage('preview.failed')
    } finally {
      if (active.current) locked.current = false
    }
  }

  async function reconcile() {
    const token = outcomeToken.current
    if (!token) return
    setPhase('checking')
    try {
      const outcome = await responseDeadline(getLocalPreviewOutcome(token))
      if (!active.current) return
      if (
        outcome.state === 'CONSUMED' &&
        Number.isSafeInteger(outcome.projectId) &&
        outcome.projectId > 0 &&
        Number.isSafeInteger(outcome.jobId) &&
        outcome.jobId > 0 &&
        (source.operation === 'INITIAL' || outcome.projectId === source.projectId)
      ) {
        outcomeToken.current = null
        setPhase('started')
        setMessage(null)
        onStarted(outcome.projectId, outcome.jobId)
      } else if (
        outcome.state === 'ABANDONED' &&
        outcome.projectId === null &&
        outcome.jobId === null
      ) {
        outcomeToken.current = null
        setPhase('idle')
        setMessage('preview.abandoned')
      } else {
        throw new Error('Invalid outcome')
      }
    } catch {
      if (!active.current) return
      setPhase('uncertain')
      setMessage('preview.uncertain')
    } finally {
      if (active.current) locked.current = false
    }
  }

  async function confirm() {
    if (locked.current || disabled || !preview) return
    if (Date.parse(preview.expiresAt) <= Date.now()) {
      setPreview(null)
      setPhase('idle')
      setMessage('preview.expired')
      return
    }
    locked.current = true
    outcomeToken.current = preview.previewToken
    setPreview(null)
    setPhase('submitting')
    setMessage(null)
    try {
      let projectId: number
      let jobId: number
      if (source.operation === 'INITIAL') {
        const created = await responseDeadline(
          createLocalProject(source.path, preview.previewToken, selection(source)),
        )
        projectId = created.project.id
        jobId = created.jobId
      } else {
        projectId = source.projectId
        jobId = (await responseDeadline(reanalyzeLocalProject(projectId, preview.previewToken)))
          .jobId
      }
      if (!active.current) return
      if (
        typeof projectId !== 'number' ||
        !Number.isSafeInteger(projectId) ||
        projectId <= 0 ||
        !Number.isSafeInteger(jobId) ||
        jobId <= 0
      )
        throw new Error('Invalid result')
      outcomeToken.current = null
      setPhase('started')
      locked.current = false
      onStarted(projectId, jobId)
    } catch {
      if (active.current) await reconcile()
    }
  }

  return (
    <div className="mt-3 space-y-3 text-[12px]" aria-label={t('preview.approvalRegion')}>
      {preview && (
        <section
          aria-label={t('preview.region')}
          className="space-y-2 rounded-md border border-line bg-surface-2 p-3"
        >
          <h3 ref={previewHeading} tabIndex={-1} className="font-semibold text-ink">
            {t('preview.title').replace('{name}', preview.sourceName)}
          </h3>
          <p className="text-ink-muted">
            {t('preview.baseSnapshot')}
            {preview.snapshotId == null ? t('preview.firstAnalysis') : `#${preview.snapshotId}`}
          </p>
          <p className="font-mono text-ink">
            {t('preview.changes')
              .replace('{added}', String(preview.changes.added))
              .replace('{modified}', String(preview.changes.modified))
              .replace('{deleted}', String(preview.changes.deleted))}
          </p>
          <p>
            {t('preview.accepted').replace(
              '{count}',
              preview.localImport.acceptedFiles.toLocaleString(),
            )}
          </p>
          <p>
            {t('preview.bytes').replace('{count}', preview.localImport.bytesRead.toLocaleString())}
          </p>
          <p className="text-ink-muted">{t('preview.notSuccess')}</p>
          <dl aria-label={t('preview.exclusions')} className="text-ink-muted">
            {Object.entries(importExclusionLabels).map(([reason, label]) => {
              const count =
                preview.localImport.excludedEntriesByReason[reason as LocalImportExclusionReason] ??
                0
              return count > 0 ? (
                <div key={reason} className="flex gap-2">
                  <dt>{t(label)}</dt>
                  <dd>{t('preview.entries').replace('{count}', count.toLocaleString())}</dd>
                </div>
              ) : null
            })}
          </dl>
          <p className="text-ink-faint">{t('preview.folderNote')}</p>
          {preview.languages && preview.languages.length > 0 && (
            <>
              <table className="w-full text-left">
                <caption className="text-left font-medium text-ink">{t('preview.languages')}</caption>
                <thead className="text-ink-muted">
                  <tr>
                    <th scope="col">{t('preview.language')}</th>
                    <th scope="col">{t('preview.files')}</th>
                    <th scope="col">{t('preview.expectedDepth')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.languages.map((entry) => (
                    <tr key={entry.language}>
                      <td className="font-mono">{entry.language}</td>
                      <td>{entry.files.toLocaleString()}</td>
                      <td>{t(expectedDepthLabels[entry.expectedDepth])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-ink-muted">{t('preview.depthNote')}</p>
            </>
          )}
          {preview.scope && (
            <p className="text-ink">
              {t('preview.appliedScope')
                .replace('{directories}', scopeText(preview.scope.directories, t))
                .replace('{languages}', scopeText(preview.scope.languages, t))}
            </p>
          )}
          {source.operation === 'INITIAL' && scopeOptions && (
            <fieldset className="space-y-2 rounded-md border border-line p-2">
              <legend className="px-1 font-medium text-ink">{t('preview.scope')}</legend>
              <p className="text-ink-muted">{t('preview.scopeNote')}</p>
              <ScopeGroup
                legend={t('preview.scopeDirectories')}
                entries={scopeOptions.directories.map((entry) => ({
                  value: entry.name,
                  label: entry.name === '.' ? t('preview.rootFiles') : entry.name,
                  files: entry.files,
                }))}
                selected={chosen.directories}
                onChange={(directories) => setChosen((current) => ({ ...current, directories }))}
              />
              <ScopeGroup
                legend={t('preview.scopeLanguages')}
                entries={scopeOptions.languages.map((entry) => ({
                  value: entry.language,
                  label: entry.language,
                  files: entry.files,
                }))}
                selected={chosen.languages}
                onChange={(languages) => setChosen((current) => ({ ...current, languages }))}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void loadPreview(
                    chosen.directories.length > 0 || chosen.languages.length > 0 ? chosen : undefined,
                  )
                }
                className="rounded-md border border-line-strong px-3 py-1.5"
              >
                {t('preview.applyScope')}
              </button>
            </fieldset>
          )}
          {preview.changedPaths.length > 0 && (
            <details>
              <summary className="cursor-pointer">{t('preview.changedPaths')}</summary>
              <ul className="max-h-28 overflow-auto font-mono">
                {preview.changedPaths.slice(0, 20).map((path, index) => (
                  <li key={`${index}:${path}`}>{path}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-ink-faint">{t('preview.tokenNote')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => void confirm()}
              className="rounded-md bg-accent px-3 py-1.5 font-medium text-surface-0 disabled:opacity-60"
            >
              {t(source.operation === 'INITIAL' ? 'preview.approveInitial' : 'preview.approveRefresh')}
            </button>
            <button
              type="button"
              onClick={() => {
                setPreview(null)
                setPhase('idle')
              }}
              className="rounded-md border border-line px-3 py-1.5"
            >
              {t('preview.cancel')}
            </button>
          </div>
        </section>
      )}
      {(phase === 'idle' || phase === 'previewing') && (
        <button
          type="button"
          disabled={disabled || phase === 'previewing'}
          onClick={() => void loadPreview()}
          className="rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-ink disabled:opacity-60"
        >
          {t(
            phase === 'previewing'
              ? 'preview.inspecting'
              : source.operation === 'INITIAL'
                ? 'preview.requestInitial'
                : 'preview.requestRefresh',
          )}
        </button>
      )}
      {/* Kept mounted so the ready announcement is read; ready text is for screen readers only. */}
      <p role="status" className={phase === 'ready' ? 'sr-only' : 'text-ink-muted empty:hidden'}>
        {phase === 'ready' && preview
          ? t('preview.ready').replace('{count}', preview.localImport.acceptedFiles.toLocaleString())
          : phase === 'submitting' || phase === 'checking' || phase === 'started'
            ? t(
                phase === 'submitting'
                  ? 'preview.submitting'
                  : phase === 'checking'
                    ? 'preview.checking'
                    : 'preview.started',
              )
            : ''}
      </p>
      {message && (
        <p role="alert" className="text-danger">
          {t(message)}
        </p>
      )}
      {phase === 'uncertain' && (
        <button
          type="button"
          onClick={() => {
            if (!locked.current) {
              locked.current = true
              void reconcile()
            }
          }}
          className="rounded-md border border-line px-3 py-1.5"
        >
          {t('preview.recheck')}
        </button>
      )}
    </div>
  )
}

function scopeText(values: string[], t: (key: string) => string): string {
  if (values.length === 0) return t('preview.scopeAll')
  return values.map((value) => (value === '.' ? t('preview.rootFiles') : value)).join(', ')
}

function ScopeGroup({
  legend,
  entries,
  selected,
  onChange,
}: {
  legend: string
  entries: { value: string; label: string; files: number }[]
  selected: string[]
  onChange: (selected: string[]) => void
}) {
  if (entries.length === 0) return null
  return (
    <fieldset>
      <legend className="text-ink-muted">{legend}</legend>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {entries.map((entry) => (
          <label key={entry.value} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={selected.includes(entry.value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, entry.value]
                    : selected.filter((value) => value !== entry.value),
                )
              }
            />
            {`${entry.label} (${entry.files.toLocaleString()})`}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
