import { useEffect, useRef, useState } from 'react'
import {
  createLocalProject,
  getLocalPreviewOutcome,
  previewLocalProject,
  previewLocalRefresh,
  reanalyzeLocalProject,
} from '../../api/projects'
import type { LocalImportExclusionReason, LocalSourcePreview } from '../../api/types'
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
  const [phase, setPhase] = useState<Phase>('idle')
  const [preview, setPreview] = useState<LocalSourcePreview | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const active = useRef(true)
  const locked = useRef(false)
  const outcomeToken = useRef<string | null>(null)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const busy = phase === 'submitting' || phase === 'checking' || phase === 'uncertain'
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    if (!preview) return
    const expire = () => {
      if (locked.current) return
      setPreview(null)
      setPhase('idle')
      setMessage('미리보기가 만료되었습니다. 새 미리보기를 확인한 뒤 다시 승인하세요.')
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
      setMessage('미리보기를 만들 수 없습니다. 원본 폴더와 연결 상태를 확인한 뒤 다시 시도하세요.')
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
        setMessage('이 승인으로 시작된 작업이 없습니다. 새 미리보기를 확인한 뒤 다시 승인하세요.')
      } else {
        throw new Error('Invalid outcome')
      }
    } catch {
      if (!active.current) return
      setPhase('uncertain')
      setMessage(
        '요청 결과를 확인할 수 없습니다. 중복 실행을 막기 위해 새 승인을 잠시 중단했습니다. 작업 상태 확인을 다시 시도하세요.',
      )
    } finally {
      if (active.current) locked.current = false
    }
  }

  async function confirm() {
    if (locked.current || disabled || !preview) return
    if (Date.parse(preview.expiresAt) <= Date.now()) {
      setPreview(null)
      setPhase('idle')
      setMessage('미리보기가 만료되었습니다. 새 미리보기를 확인한 뒤 다시 승인하세요.')
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
    <div className="mt-3 space-y-3 text-[12px]" aria-label="Local source approval">
      {preview && (
        <section
          aria-label="확인할 가져오기 미리보기"
          className="space-y-2 rounded-md border border-line bg-surface-2 p-3"
        >
          <h3 className="font-semibold text-ink">{preview.sourceName} · 가져오기 미리보기</h3>
          <p className="text-ink-muted">
            기준 스냅샷:{' '}
            {preview.snapshotId == null ? '없음 (처음 분석)' : `#${preview.snapshotId}`}
          </p>
          <p className="font-mono text-ink">
            추가 {preview.changes.added} · 수정 {preview.changes.modified} · 삭제{' '}
            {preview.changes.deleted}
          </p>
          <p>미리보기에서 선택한 파일: {preview.localImport.acceptedFiles.toLocaleString()}개</p>
          <p>검사 중 읽은 바이트: {preview.localImport.bytesRead.toLocaleString()}</p>
          <p className="text-ink-muted">가져오기 선택 결과이며 분석 성공·완료를 뜻하지 않습니다.</p>
          <dl aria-label="가져오기 제외 항목" className="text-ink-muted">
            {Object.entries(importExclusionLabels).map(([reason, label]) => {
              const count =
                preview.localImport.excludedEntriesByReason[reason as LocalImportExclusionReason] ??
                0
              return count > 0 ? (
                <div key={reason} className="flex gap-2">
                  <dt>{label}</dt>
                  <dd>{count.toLocaleString()}개 항목</dd>
                </div>
              ) : null
            })}
          </dl>
          <p className="text-ink-faint">
            폴더 단위 제외는 1개 항목으로 셉니다. 하위 항목 수는 측정하지 않았습니다.
          </p>
          {preview.changedPaths.length > 0 && (
            <details>
              <summary className="cursor-pointer">미리보기의 변경 경로 (최대 20개)</summary>
              <ul className="max-h-28 overflow-auto font-mono">
                {preview.changedPaths.slice(0, 20).map((path, index) => (
                  <li key={`${index}:${path}`}>{path}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-ink-faint">
            승인은 발급 후 10분 동안 한 번만 사용할 수 있습니다. 원본이 바뀌면 새 확인이 필요합니다.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => void confirm()}
              className="rounded-md bg-accent px-3 py-1.5 font-medium text-surface-0 disabled:opacity-60"
            >
              {source.operation === 'INITIAL'
                ? '확인한 파일 가져오기 및 분석'
                : '변경 확인 후 전체 재분석'}
            </button>
            <button
              type="button"
              onClick={() => {
                setPreview(null)
                setPhase('idle')
              }}
              className="rounded-md border border-line px-3 py-1.5"
            >
              미리보기 취소
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
          {phase === 'previewing'
            ? '검사 중…'
            : source.operation === 'INITIAL'
              ? '가져올 파일 미리보기'
              : '변경 사항 미리보기'}
        </button>
      )}
      {(phase === 'submitting' || phase === 'checking' || phase === 'started') && (
        <p role="status" className="text-ink-muted">
          {phase === 'submitting'
            ? '분석 시작 요청 중…'
            : phase === 'checking'
              ? '기존 작업 확인 중…'
              : '분석 작업을 시작했습니다.'}
        </p>
      )}
      {message && (
        <p role="alert" className="text-danger">
          {message}
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
          작업 상태 다시 확인
        </button>
      )}
    </div>
  )
}
