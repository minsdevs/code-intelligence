import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { getPullReview } from '../../api/review'
import { listPulls } from '../../api/history'
import { parseEvidenceRef } from '../../api/ai'
import { ApiError } from '../../api/client'
import type { PullRequest, ReviewView } from '../../api/types'
import EmptyState from '../../components/EmptyState'
import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../lib/i18n'
import { parseProjectId } from '../../lib/projectId'
import { codeLocationSearch, queryError } from '../code/codeLocation'

export default function ReviewPage() {
  const t = useT()
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const navigate = useNavigate()
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null)

  const pullsQuery = useQuery({
    queryKey: ['pulls', projectId],
    queryFn: () => listPulls(projectId!),
    enabled: projectId != null,
  })
  const pulls = pullsQuery.data ?? []
  const pullNumber =
    selectedNumber != null && pulls.some((pull) => pull.number === selectedNumber)
      ? selectedNumber
      : (pulls[0]?.number ?? null)
  const activePull = pulls.find((pull) => pull.number === pullNumber) ?? null

  const reviewQuery = useQuery({
    queryKey: ['pull-review', projectId, pullNumber],
    queryFn: () => getPullReview(projectId!, pullNumber!),
    enabled: projectId != null && pullNumber != null,
    retry: false,
  })
  const review: ReviewView | null =
    reviewQuery.isError && reviewQuery.error instanceof ApiError && reviewQuery.error.status === 404
      ? null
      : (reviewQuery.data ?? null)


  if (projectId == null) {
    return <EmptyState title="Review" description={t('review.desc')} />
  }

  const pullsError = queryError(pullsQuery.error)
  const reviewError =
    reviewQuery.error instanceof ApiError && reviewQuery.error.status === 404
      ? null
      : queryError(reviewQuery.error)
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold text-ink">Pull requests</h2>
        </div>
        {pullsError && (
          <p role="alert" className="px-4 py-2 text-[12px] text-danger">
            {pullsError}
          </p>
        )}
        {pullsQuery.isLoading && (
          <p className="px-4 py-3 text-[13px] text-ink-muted">{t('review.pullsLoading')}</p>
        )}
        {!pullsQuery.isLoading && pulls.length === 0 && !pullsError && (
          <p className="px-4 py-3 text-[13px] text-ink-muted">{t('review.noPulls')}</p>
        )}
        <ul aria-label={t('review.pullsLabel')} className="min-h-0 flex-1 overflow-auto">
          {pulls.map((pull) => (
            <li key={pull.number}>
              <button
                type="button"
                onClick={() => setSelectedNumber(pull.number)}
                aria-current={pull.number === pullNumber ? 'true' : undefined}
                className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-3 py-1.5 text-left ${
                  pull.number === pullNumber
                    ? 'bg-surface-3 text-ink'
                    : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                }`}
              >
                <span className="text-[13px] text-ink">{pull.title}</span>
                <span className="font-mono text-[11px] text-ink-faint">
                  #{pull.number} · {pull.state}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {activePull == null ? (
          <p className="text-[13px] text-ink-muted">{t('review.select')}</p>
        ) : (
          <ReviewDetail
            pull={activePull}
            review={review}
            loading={reviewQuery.isLoading}
            error={reviewError}
            onOpenAssistant={() => useUiStore.setState({ aiPanelOpen: true, pendingIntent: 'EXPLAIN', focusedNode: null, focusedFindingId: null, focusedNoteId: null, focusedTaskId: null, focusedFile: review?.comments.find((comment) => comment.filePath)?.filePath ?? null, focusedCommitSha: null })}
            onOpenEvidence={(path, line) =>
              navigate(`/projects/${projectId}/code${codeLocationSearch(path, line)}`)
            }
          />
        )}
      </section>
    </div>
  )
}

function ReviewDetail({
  pull,
  review,
  loading,
  error,
  onOpenAssistant,
  onOpenEvidence,
}: {
  pull: PullRequest
  review: ReviewView | null
  loading: boolean
  error: string | null
  onOpenAssistant: () => void
  onOpenEvidence: (path: string, line: number | null) => void
}) {
  const t = useT()
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">{pull.title}</h2>
          <p className="mt-1 font-mono text-[12px] text-ink-faint">
            #{pull.number} · {pull.state} · {pull.author}
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenAssistant}
          className="rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[12px] text-ink hover:bg-surface-3 disabled:opacity-60"
        >
          {t('review.aiCheck')}
        </button>
      </div>
      <p className="mt-3 text-xs text-ink-muted">{t('review.aiNote')}</p>
      {pull.body && (
        <p className="mt-3 whitespace-pre-wrap text-[13px] text-ink-muted">{pull.body}</p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {error}
        </p>
      )}
      {loading && <p className="mt-4 text-[13px] text-ink-muted">{t('review.loading')}</p>}
      {!loading && review == null && (
        <p className="mt-4 text-[13px] text-ink-muted">{t('review.none')}</p>
      )}
      {review && (
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-wide text-ink-faint">
            origin {review.origin}
          </p>
          <p className="mt-2 text-[13px] text-ink">{review.summary}</p>
          <ol aria-label={t('review.commentsLabel')} className="mt-4 space-y-3">
            {review.comments.map((comment) => (
              <li key={comment.id} className="rounded-md border border-line bg-surface-1 px-3 py-2">
                <p className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-[11px] text-warn">{comment.severity}</span>
                  <span className={`font-mono text-[11px] ${confidenceClass(comment.confidence)}`}>
                    {comment.confidence}
                  </span>
                  {comment.filePath && (
                    <span className="font-mono text-[11px] text-ink-faint">
                      {comment.filePath}
                      {comment.line != null ? `:${comment.line}` : ''}
                    </span>
                  )}
                </p>
                <p className="mt-1 text-[13px] text-ink">{comment.body}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {comment.evidence.map((ref) => {
                    const parsed = parseEvidenceRef(ref)
                    if (!parsed) {
                      return (
                        <span key={ref} className="font-mono text-[11px] text-ink-faint">
                          {ref}
                        </span>
                      )
                    }
                    return (
                      <button
                        key={ref}
                        type="button"
                        onClick={() => onOpenEvidence(parsed.path, parsed.line)}
                        className="font-mono text-[11px] text-accent hover:underline"
                      >
                        {parsed.path}:{parsed.line}
                      </button>
                    )
                  })}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

function confidenceClass(value: string): string {
  if (value === 'CONFIRMED') return 'text-ok'
  if (value === 'LIKELY') return 'text-accent'
  if (value === 'POSSIBLE') return 'text-warn'
  return 'text-ink-muted'
}
