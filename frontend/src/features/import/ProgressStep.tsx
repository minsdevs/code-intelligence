import { useEffect, useRef, useState } from 'react'
import { ApiError, UnauthorizedError } from '../../api/client'
import { getJob, retryJob, subscribeJobEvents } from '../../api/jobs'
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
    status: 'PENDING',
    progressPct: null,
    attempt: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
  }))
}

function statusLabel(status: StepStatus): string {
  switch (status) {
    case 'DONE':
      return '완료'
    case 'RUNNING':
      return '진행 중'
    case 'FAILED':
      return '실패'
    case 'SKIPPED':
      return '건너뜀'
    default:
      return '대기'
  }
}

export default function ProgressStep({ jobId, onDone, onUnauthorized }: ProgressStepProps) {
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
      setError(next.status === 'FAILED' ? (next.error ?? '분석 작업이 실패했습니다.') : null)
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
          setError(err instanceof ApiError ? err.message : '작업 상태를 복구하지 못했습니다.')
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
        setError(err instanceof ApiError ? err.message : '작업 상태를 불러오지 못했습니다.')
      }
    }

    void start()
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [jobId, streamEpoch, onUnauthorized])

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
      setError(err instanceof ApiError ? err.message : '재시도에 실패했습니다.')
    } finally {
      setRetrying(false)
    }
  }

  const steps = displaySteps(job)

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">분석 진행</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
          clone부터 영역 감지까지 파이프라인 단계를 순서대로 실행합니다.
        </p>
      </div>

      <ol aria-label="분석 파이프라인" className="flex flex-col gap-1.5">
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
            <span className="text-[11px] text-ink-muted">{statusLabel(step.status)}</span>
          </li>
        ))}
      </ol>

      {(error || job?.status === 'FAILED') && (
        <div role="alert" className="rounded-md border border-danger/40 bg-surface-1 px-3 py-2.5">
          <p className="text-[13px] text-danger">{error ?? job?.error ?? '분석 작업이 실패했습니다.'}</p>
          {job?.status === 'FAILED' && (
            <button
              type="button"
              onClick={() => void handleRetry()}
              disabled={retrying}
              className="mt-2 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[13px] text-ink disabled:opacity-60"
            >
              {retrying ? '재시도 중…' : '다시 시도'}
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
