import { useEffect, useRef, useState } from 'react'
import { ApiError, UnauthorizedError } from '../../api/client'
import { getJob, retryJob, subscribeJobEvents } from '../../api/jobs'
import { useT } from '../../lib/i18n'
import type { JobDetail, JobStep, StepStatus } from '../../api/types'
import { PIPELINE_STEPS, pipelineLabel } from './wizard'

type ProgressStepProps = {
  jobId: number
  onDone: () => void
  onUnauthorized: () => void
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

export default function ProgressStep({ jobId, onDone, onUnauthorized }: ProgressStepProps) {
  const t = useT()
  const [job, setJob] = useState<JobDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [streamEpoch, setStreamEpoch] = useState(0)
  const onDoneRef = useRef(onDone)

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    const apply = (next: JobDetail) => {
      setJob(next)
      setError(next.status === 'FAILED' ? (next.error ?? t('progress.failed')) : null)
      if (next.status === 'DONE') {
        onDoneRef.current()
      }
    }

    const recover = () => {
      void getJob(jobId)
        .then((next) => {
          if (cancelled) return
          apply(next)
          if (!isTerminal(next.status)) {
            setStreamEpoch((epoch) => epoch + 1)
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return
          if (err instanceof UnauthorizedError) {
            onUnauthorized()
            return
          }
          setError(err instanceof ApiError ? err.message : t('progress.recoverError'))
        })
    }

    const start = async () => {
      try {
        const initial = await getJob(jobId)
        if (cancelled) return
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
        if (cancelled) return
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
  }, [jobId, streamEpoch, onUnauthorized, t])

  const handleRetry = async () => {
    setRetrying(true)
    setError(null)
    try {
      await retryJob(jobId)
      const next = await getJob(jobId)
      setJob(next)
      if (!isTerminal(next.status)) {
        setStreamEpoch((epoch) => epoch + 1)
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized()
        return
      }
      setError(err instanceof ApiError ? err.message : t('progress.retryError'))
    } finally {
      setRetrying(false)
    }
  }

  const steps = displaySteps(job)

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{t('progress.title')}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{t('progress.description')}</p>
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

      {(error || job?.status === 'FAILED') && (
        <div role="alert" className="rounded-md border border-danger/40 bg-surface-1 px-3 py-2.5">
          <p className="text-[13px] text-danger">{error ?? job?.error ?? t('progress.failed')}</p>
          {job?.status === 'FAILED' && (
            <button
              type="button"
              onClick={() => void handleRetry()}
              disabled={retrying}
              className="mt-2 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[13px] text-ink disabled:opacity-60"
            >
              {retrying ? t('progress.retrying') : t('progress.retry')}
            </button>
          )}
        </div>
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
