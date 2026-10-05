import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ApiError, MutationNotSentError, UnauthorizedError } from '../../api/client'
import { getProject, reanalyzeGithubProject } from '../../api/projects'
import type { JobDetail, Project } from '../../api/types'
import { useT } from '../../lib/i18n'
import ProgressStep from '../import/ProgressStep'
import { isActiveJob, projectAnalysisStatus } from './analysisStatus'

const ignoreDone = () => undefined

export default function GithubAnalysisStatus({ project }: { project: Project }) {
  return project.sourceType === 'GITHUB' ? (
    <RemoteAnalysis key={project.id} project={project} />
  ) : null
}

function RemoteAnalysis({ project }: { project: Project }) {
  const t = useT()
  const queryClient = useQueryClient()
  const [startedJobId, setStartedJobId] = useState<number | null>(null)
  const [observedJob, setObservedJob] = useState<JobDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsConnection, setNeedsConnection] = useState(false)
  const [inspectionEpoch, setInspectionEpoch] = useState(0)
  // undefined means no uncertain request; null means it was sent before any job existed.
  const [uncertainFrom, setUncertainFrom] = useState<number | null | undefined>(undefined)
  const requestInFlight = useRef(false)
  const invalidatedTerminal = useRef<string | null>(null)
  const jobId = Math.max(startedJobId ?? 0, project.latestJob?.id ?? 0) || null
  const job =
    observedJob?.id === jobId
      ? observedJob
      : project.latestJob?.id === jobId
        ? project.latestJob
        : null
  const active = isActiveJob(job?.status) || (jobId !== null && job === null)
  const uncertain = uncertainFrom !== undefined
  const serverAttempt = project.latestJob?.id === jobId
    ? `${project.latestJob.status}:${project.latestJob.startedAt ?? ''}`
    : 'unobserved'

  const invalidate = useCallback(() => {
    // Project-scoped caches include snapshot IDs: refresh them without changing the selected snapshot.
    void queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'projects' || query.queryKey[1] === project.id,
    })
  }, [project.id, queryClient])

  const onJobChange = useCallback(
    (next: JobDetail) => {
      if (next.projectId !== project.id) return
      setObservedJob(next)
      if (isActiveJob(next.status)) invalidatedTerminal.current = null
      const terminalKey = `${next.id}:${next.status}`
      if (!isActiveJob(next.status) && invalidatedTerminal.current !== terminalKey) {
        invalidatedTerminal.current = terminalKey
        invalidate()
      }
    },
    [project.id, invalidate],
  )

  const onUnauthorized = useCallback(() => setNeedsConnection(true), [])

  const readCurrent = async (previousId?: number | null) => {
    const current = await getProject(project.id)
    queryClient.setQueryData(['project', project.id], current)
    const latest = current.latestJob
    if (
      latest &&
      (isActiveJob(latest.status) || (previousId !== undefined && latest.id !== previousId))
    ) {
      setStartedJobId(latest.id)
      // Checkpoint retry can reactivate the same job ID in another window.
      setObservedJob(null)
      setInspectionEpoch((epoch) => epoch + 1)
      setUncertainFrom(undefined)
      setError(null)
      invalidate()
    }
    return current
  }

  const start = async () => {
    if (requestInFlight.current || active || uncertain) return
    requestInFlight.current = true
    setBusy(true)
    setError(null)
    setNeedsConnection(false)
    let sent = false
    let previousId: number | null = project.latestJob?.id ?? null
    try {
      // Recheck another window's work before creating anything. The server's project lock remains authoritative.
      const current = await readCurrent()
      if (current.sourceType !== 'GITHUB') throw new Error('Unexpected project source')
      if (isActiveJob(current.latestJob?.status)) return
      previousId = current.latestJob?.id ?? null
      sent = true
      const result = await reanalyzeGithubProject(project.id)
      if (!Number.isSafeInteger(result.jobId) || result.jobId <= 0)
        throw new Error('Missing job result')
      setStartedJobId(result.jobId)
      invalidate()
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        setNeedsConnection(true)
      } else if (cause instanceof MutationNotSentError) {
        setError(t('analysis.startError'))
      } else if (sent && (!(cause instanceof ApiError) || cause.status >= 500)) {
        // A lost response may already have created a job. Reconcile with GET; never replay the POST.
        setUncertainFrom(previousId)
        setError(t('analysis.uncertain'))
        try {
          await readCurrent(previousId)
        } catch {
          /* Keep the uncertain state until a successful read. */
        }
      } else {
        setError(cause instanceof ApiError ? cause.message : t('analysis.startError'))
        if (cause instanceof ApiError && cause.status === 409) {
          try {
            await readCurrent(previousId)
          } catch {
            /* Preserve the original conflict. */
          }
        }
      }
    } finally {
      requestInFlight.current = false
      setBusy(false)
    }
  }

  const checkStatus = async () => {
    if (requestInFlight.current) return
    requestInFlight.current = true
    setBusy(true)
    try {
      await readCurrent(uncertainFrom)
      setInspectionEpoch((epoch) => epoch + 1)
      setNeedsConnection(false)
    } catch (cause) {
      if (cause instanceof UnauthorizedError) setNeedsConnection(true)
      else setError(t('analysis.statusError'))
    } finally {
      requestInFlight.current = false
      setBusy(false)
    }
  }

  const status = job?.status ?? (active ? 'QUEUED' : projectAnalysisStatus(project))
  return (
    <section
      aria-label={t('analysis.githubTitle')}
      className="max-h-[45vh] shrink-0 overflow-y-auto border-b border-line bg-surface-1 px-5 py-3"
    >
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <strong>{t('analysis.githubTitle')}</strong>
        <span className="font-mono text-ink-muted">
          {project.repoOwner}/{project.repoName} · {project.defaultBranch}
        </span>
        <span role="status" className={status === 'FAILED' ? 'text-danger' : 'text-ink-muted'}>
          {t(`analysis.status.${status}`)}
        </span>
        <button
          type="button"
          disabled={busy || active || uncertain}
          onClick={() => void start()}
          className="rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 disabled:opacity-60"
        >
          {busy ? t('analysis.checking') : t('analysis.start')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void checkStatus()}
          className="rounded-md border border-line px-2 py-1 disabled:opacity-60"
        >
          {t('analysis.checkStatus')}
        </button>
      </div>
      <p className="mt-2 text-[12px] text-ink-muted">{t('analysis.preserve')}</p>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      {needsConnection && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {t('analysis.connectRequired')}{' '}
          <Link to="/settings" className="underline">
            {t('analysis.accountSettings')}
          </Link>
        </p>
      )}
      {jobId !== null && (
        <details
          key={`${jobId}:${inspectionEpoch}`}
          open={active || status === 'FAILED'}
          className="mt-2"
        >
          <summary className="cursor-pointer text-[12px] text-ink-muted">
            {t('analysis.details')} · #{jobId}
          </summary>
          <div className="pt-3">
            <ProgressStep
              key={`${jobId}:${serverAttempt}`}
              jobId={jobId}
              onDone={ignoreDone}
              onUnauthorized={onUnauthorized}
              onJobChange={onJobChange}
            />
          </div>
        </details>
      )}
    </section>
  )
}
