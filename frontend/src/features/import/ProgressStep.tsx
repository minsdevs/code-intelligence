import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, UnauthorizedError } from '../../api/client'
import { cancelJob, getJob, retryJob, subscribeJobEvents } from '../../api/jobs'
import { useT } from '../../lib/i18n'
import type { JobDetail, JobStep, StepStatus } from '../../api/types'
import { PIPELINE_STEPS, pipelineLabel } from './wizard'

type ProgressStepProps = {
  jobId: number
  onDone: () => void
  onUnauthorized: () => void
  onSourcePreviewRequired?: (projectId: number) => void
  onJobChange?: (job: JobDetail) => void
}

function isTerminal(status: JobDetail['status']): boolean {
  return status === 'DONE' || status === 'FAILED' || status === 'CANCELLED'
}

function displaySteps(job: JobDetail | null): JobStep[] {
  if (job && job.steps.length > 0) {
    return [...job.steps].sort((a, b) => a.seq - b.seq)
  }
  return PIPELINE_STEPS.map((step, index) => ({
    stepKey: step.key,
    seq: index + 1,
    status: 'PENDING' as const,
    progressPct: null,
    attempt: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
  }))
}

function statusLabel(status: StepStatus, t: (key: string) => string): string {
  switch (status) {
    case 'DONE':
      return t('progress.status.done')
    case 'RUNNING':
      return t('progress.status.running')
    case 'FAILED':
      return t('progress.status.failed')
    case 'SKIPPED':
      return t('progress.status.skipped')
    default:
      return t('progress.status.pending')
  }
}

export default function ProgressStep(props: ProgressStepProps) {
  return <JobProgress key={props.jobId} {...props} />
}

function JobProgress({
  jobId,
  onDone,
  onUnauthorized,
  onSourcePreviewRequired,
  onJobChange,
}: ProgressStepProps) {
  const t = useT()
  const [job, setJob] = useState<JobDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [streamEpoch, setStreamEpoch] = useState(0)
  const [retryNeedsPreview, setRetryNeedsPreview] = useState(false)
  const [retryNeedsSourceFix, setRetryNeedsSourceFix] = useState(false)
  const [retryNeedsNewAnalysis, setRetryNeedsNewAnalysis] = useState(false)
  const onDoneRef = useRef(onDone)
  const onJobChangeRef = useRef(onJobChange)
  const lifetime = useRef(0)
  // Requests alone must not invalidate an in-flight stream recovery; accepted observations do.
  const observationRevision = useRef(0)
  const mutationInFlight = useRef(false)

  useEffect(() => () => { lifetime.current += 1 }, [])

  useEffect(() => {
    onDoneRef.current = onDone
    onJobChangeRef.current = onJobChange
  }, [onDone, onJobChange])

  const apply = useCallback((next: JobDetail) => {
    observationRevision.current += 1
    setJob(next)
    onJobChangeRef.current?.(next)
    setError(next.status === 'FAILED' ? (next.error ?? t('progress.failed')) : null)
    if (next.status === 'DONE') onDoneRef.current()
  }, [t])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    const recover = () => {
      const revision = observationRevision.current
      void getJob(jobId)
        .then((next) => {
          if (cancelled || revision !== observationRevision.current) return
          apply(next)
          if (!isTerminal(next.status)) {
            setStreamEpoch((epoch) => epoch + 1)
          }
        })
        .catch((err: unknown) => {
          if (cancelled || revision !== observationRevision.current) return
          if (err instanceof UnauthorizedError) {
            onUnauthorized()
            return
          }
          setError(err instanceof ApiError ? err.message : t('progress.recoverError'))
        })
    }

    const start = async () => {
      const revision = observationRevision.current
      try {
        const initial = await getJob(jobId)
        if (cancelled || revision !== observationRevision.current) return
        apply(initial)
        if (isTerminal(initial.status)) {
          return
        }
        unsubscribe = subscribeJobEvents(
          jobId,
          (next) => {
            if (cancelled) return
            apply(next)
            if (isTerminal(next.status)) {
              unsubscribe?.()
            }
          },
          () => {
            if (!cancelled) recover()
          },
        )
      } catch (err) {
        if (cancelled || revision !== observationRevision.current) return
        if (err instanceof UnauthorizedError) {
          onUnauthorized()
          return
        }
        setError(err instanceof ApiError ? err.message : t('progress.loadError'))
      }
    }

    void start()
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [jobId, streamEpoch, onUnauthorized, t, apply])

  const handleRetry = async () => {
    if (
      mutationInFlight.current
      || retryNeedsPreview || job?.failureCode === 'LOCAL_PREVIEW_REQUIRED'
      || retryNeedsSourceFix || job?.failureCode === 'TS_SYNTAX_ERROR'
      || retryNeedsNewAnalysis || job?.failureCode === 'RETRY_SOURCE_UNVERIFIED'
      || job?.failureCode === 'GITHUB_REAUTHENTICATION_REQUIRED'
    ) return
    mutationInFlight.current = true
    const operationLifetime = lifetime.current
    let revision = observationRevision.current
    setRetrying(true)
    setError(null)
    try {
      await retryJob(jobId)
      if (operationLifetime !== lifetime.current) return
      revision = observationRevision.current
      const next = await getJob(jobId)
      // A newer stream observation or remounted attempt owns the state and callbacks.
      if (operationLifetime !== lifetime.current || revision !== observationRevision.current) return
      apply(next)
      if (!isTerminal(next.status)) {
        setStreamEpoch((epoch) => epoch + 1)
      }
    } catch (err) {
      if (operationLifetime !== lifetime.current || revision !== observationRevision.current) return
      if (err instanceof UnauthorizedError) {
        onUnauthorized()
        return
      }
      if (err instanceof ApiError && err.code === 'LOCAL_PREVIEW_REQUIRED')
        setRetryNeedsPreview(true)
      if (err instanceof ApiError && err.code === 'TS_SYNTAX_ERROR')
        setRetryNeedsSourceFix(true)
      if (err instanceof ApiError && err.code === 'RETRY_SOURCE_UNVERIFIED')
        setRetryNeedsNewAnalysis(true)
      setError(err instanceof ApiError ? err.message : t('progress.retryError'))
    } finally {
      if (operationLifetime === lifetime.current) {
        mutationInFlight.current = false
        setRetrying(false)
      }
    }
  }
  const handleCancel = async () => {
    if (mutationInFlight.current) return
    mutationInFlight.current = true
    const operationLifetime = lifetime.current
    let revision = observationRevision.current
    setCancelling(true)
    setError(null)
    try {
      await cancelJob(jobId)
      if (operationLifetime !== lifetime.current) return
      revision = observationRevision.current
      const next = await getJob(jobId)
      if (operationLifetime !== lifetime.current || revision !== observationRevision.current) return
      apply(next)
    } catch (err) {
      if (operationLifetime !== lifetime.current || revision !== observationRevision.current) return
      if (err instanceof UnauthorizedError) {
        onUnauthorized()
        return
      }
      setError(err instanceof ApiError ? err.message : 'Could not cancel analysis.')
    } finally {
      if (operationLifetime === lifetime.current) {
        mutationInFlight.current = false
        setCancelling(false)
      }
    }
  }

  const steps = displaySteps(job)
  const needsPreview = retryNeedsPreview || job?.failureCode === 'LOCAL_PREVIEW_REQUIRED'
  const needsSourceFix = retryNeedsSourceFix || job?.failureCode === 'TS_SYNTAX_ERROR'
  const needsNewAnalysis = retryNeedsNewAnalysis || job?.failureCode === 'RETRY_SOURCE_UNVERIFIED'
  const needsGithubLogin = job?.failureCode === 'GITHUB_REAUTHENTICATION_REQUIRED'

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{t('progress.title')}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
          {t('progress.description')}
        </p>
      </div>

      <ol aria-label={t('progress.pipelineLabel')} className="flex flex-col gap-1.5">
        {steps.map((step) => (
          <li
            key={step.stepKey}
            className="flex items-center gap-3 rounded-md border border-line bg-surface-1 px-3 py-2"
          >
            <StatusMark status={step.status} />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[12px] text-ink">{pipelineLabel(step.stepKey)}</p>
              <p className="text-[11px] text-ink-faint">
                {step.stepKey}
                {step.progressPct != null ? ` · ${step.progressPct}%` : ''}
              </p>
            </div>
            <span className="text-[11px] text-ink-muted">{statusLabel(step.status, t)}</span>
          </li>
        ))}
      </ol>
      {job && !isTerminal(job.status) && (
        <button
          type="button"
          disabled={retrying || cancelling || job.status === 'CANCELLING'}
          onClick={() => void handleCancel()}
          className="w-fit rounded-md border border-line-strong px-3 py-1.5 text-[13px] text-ink-muted disabled:opacity-60"
        >
          {cancelling || job.status === 'CANCELLING' ? 'Cancelling…' : 'Cancel analysis'}
        </button>
      )}

      {(error || job?.status === 'FAILED') && (
        <div role="alert" className="rounded-md border border-danger/40 bg-surface-1 px-3 py-2.5">
          <p className="text-[13px] text-danger">
            {needsPreview
              ? '승인한 원본을 사용할 수 없어 분석을 중단했습니다. 기존 프로젝트에서 새 미리보기를 확인한 뒤 다시 승인하세요.'
              : (error ?? job?.error ?? t('progress.failed'))}
          </p>
          {job?.status === 'FAILED' &&
            needsPreview &&
            (onSourcePreviewRequired ? (
              <button
                type="button"
                className="mt-2 rounded-md border border-line-strong px-3 py-1.5 text-[13px]"
                onClick={() => onSourcePreviewRequired(job.projectId)}
              >
                기존 프로젝트에서 새 미리보기
              </button>
            ) : (
              <Link
                className="mt-2 inline-block text-[13px] underline"
                to={`/projects/${job.projectId}`}
              >
                기존 프로젝트에서 새 미리보기
              </Link>
            ))}
          {job?.status === 'FAILED' && needsSourceFix && (
            <>
              <p className="mt-2 text-[13px] text-ink-muted">{t('progress.syntaxFix')}</p>
              <Link
                className="mt-2 inline-block text-[13px] underline"
                to={`/projects/${job.projectId}`}
              >
                {t('progress.backToProject')}
              </Link>
            </>
          )}
          {job?.status === 'FAILED' && needsNewAnalysis && (
            <p className="mt-2 text-[13px] text-ink-muted">{t('analysis.checkpointChanged')}</p>
          )}
          {job?.status === 'FAILED' && needsGithubLogin && <>
            <p className="mt-2 text-[13px] text-ink-muted">{t('progress.githubReconnect')}</p>
            <Link className="mt-2 inline-block text-[13px] underline" to="/settings#github-account">{t('settings.github')}</Link>
          </>}
          {job?.status === 'FAILED' && !needsPreview && !needsSourceFix && !needsNewAnalysis && !needsGithubLogin && (
            <button
              type="button"
              onClick={() => void handleRetry()}
              disabled={retrying || cancelling}
              className="mt-2 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[13px] text-ink disabled:opacity-60"
            >
              {retrying ? t('progress.retrying') : t('progress.retry')}
            </button>
          )}
          {job?.status === 'FAILED' && !needsPreview && !needsSourceFix && (
            <Link to={`/projects/${job.projectId}`} className="mt-2 block text-[13px] underline">
              {t('analysis.openExisting')}
            </Link>
          )}
        </div>
      )}
      {job?.status === 'CANCELLED' && (
        <p role="status" className="text-[13px] text-ink-muted">
          {t('analysis.status.CANCELLED')}{' '}
          <Link to={`/projects/${job.projectId}`} className="underline">{t('analysis.openExisting')}</Link>
        </p>
      )}
    </div>
  )
}

function StatusMark({ status }: { status: StepStatus }) {
  const className =
    status === 'DONE'
      ? 'border-ok bg-ok'
      : status === 'RUNNING'
        ? 'border-accent bg-accent/30'
        : status === 'FAILED'
          ? 'border-danger bg-danger'
          : 'border-line-strong bg-transparent'
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2.5 shrink-0 rounded-full border ${className}`}
    />
  )
}
