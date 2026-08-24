import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { judgeFinding } from '../../api/analysis'
import type { FindingJudgmentStatus, FindingView } from '../../api/types'

export default function FindingJudgmentEditor({
  projectId,
  finding,
  onSaved,
}: {
  projectId: number
  finding: FindingView
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<FindingJudgmentStatus>(finding.judgment.status)
  const [reason, setReason] = useState(finding.judgment.reason)
  const mutation = useMutation({
    mutationFn: () => judgeFinding(projectId, finding.id, status, reason),
    onSuccess: async () => {
      onSaved()
      await queryClient.invalidateQueries({ queryKey: ['findings', projectId] })
    },
  })

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <label className="text-[11px] text-ink-muted">
          판정{' '}
          <select
            aria-label="Finding judgment"
            value={status}
            onChange={(event) => setStatus(event.target.value as FindingJudgmentStatus)}
            className="rounded border border-line bg-surface-2 px-2 py-1 text-ink"
          >
            <option value="NEEDS_REVIEW">확인 필요</option>
            <option value="ACCEPTED">수용</option>
            <option value="FALSE_POSITIVE">오탐</option>
            <option value="RESOLVED">해결됨</option>
          </select>
        </label>
        <input
          aria-label="Judgment reason"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          placeholder="짧은 사유"
          className="min-w-48 flex-1 rounded border border-line bg-surface-2 px-2 py-1 text-[11px] text-ink"
        />
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
          className="rounded border border-line-strong bg-surface-2 px-2 py-1 text-[11px] text-ink"
        >
          판정 저장
        </button>
        {finding.judgment.needsReview && (
          <span className="text-[10px] text-warn">근거/rule 변경 시 재검토 대상</span>
        )}
      </div>
      {mutation.isError && (
        <p role="alert" className="mt-1 text-[11px] text-danger">판정을 저장하지 못했습니다.</p>
      )}
    </>
  )
}
