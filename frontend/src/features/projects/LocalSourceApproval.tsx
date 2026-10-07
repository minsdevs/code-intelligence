import { useEffect, useRef, useState } from 'react'
import {
  createLocalProject,
  getLocalPreviewOutcome,
  previewLocalProject,
  previewLocalRefresh,
  reanalyzeLocalProject,
} from '../../api/projects'
import type { LocalImportExclusionReason, LocalSourcePreview } from '../../api/types'
import { useT } from '../../lib/i18n'
import { importExclusionLabels, isLocalSourcePreview } from './localSourcePreview'

type Source = { operation: 'INITIAL'; path: string } | { operation: 'REFRESH'; projectId: number }
type Phase = 'idle' | 'previewing' | 'ready' | 'submitting' | 'checking' | 'uncertain' | 'started'
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

/** Each source gets a separate lifetime, so a late response cannot approve another source. */
export default function LocalSourceApproval(props: Props) {
  const scope = props.source.operation === 'INITIAL' ? props.source.path : props.source.projectId
  return <ApprovalFlow key={`${props.source.operation}:${scope}`} {...props} />
}

function ApprovalFlow({ source, disabled = false, onStarted, onBusyChange }: Props) {
  const t = useT()
  const [phase, setPhase] = useState<Phase>('idle')
  const [preview, setPreview] = useState<LocalSourcePreview | null>(null)
  const [message, setMessage] = useState<string | null>(null)
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

  async function loadPreview() {
    if (locked.current || disabled) return
    locked.current = true
    setMessage(null)
    setPreview(null)
    setPhase('previewing')
    try {
      const next =
        source.operation === 'INITIAL'
          ? await responseDeadline(previewLocalProject(source.path))
          : await responseDeadline(previewLocalRefresh(source.projectId))
      if (!active.current) return
      if (!isLocalSourcePreview(next, source.operation)) throw new Error('Invalid preview')
      if (Date.parse(next.expiresAt) <= Date.now()) throw new Error('Expired preview')
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
          createLocalProject(source.path, preview.previewToken),
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
