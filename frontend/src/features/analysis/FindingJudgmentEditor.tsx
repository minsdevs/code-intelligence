import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { judgeFinding } from '../../api/analysis'
import type { FindingJudgmentStatus, FindingView } from '../../api/types'
import { useT } from '../../lib/i18n'

export default function FindingJudgmentEditor({
  projectId,
  finding,
  onSaved,
}: {
  projectId: number
  finding: FindingView
  onSaved: () => void
}) {
  const t = useT()
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
          {t('judgment.label')}{' '}
          <select
            aria-label="Finding judgment"
            value={status}
            onChange={(event) => setStatus(event.target.value as FindingJudgmentStatus)}
            className="rounded border border-line bg-surface-2 px-2 py-1 text-ink"
          >
            <option value="NEEDS_REVIEW">{t('judgment.NEEDS_REVIEW')}</option>
            <option value="ACCEPTED">{t('judgment.ACCEPTED')}</option>
            <option value="FALSE_POSITIVE">{t('judgment.FALSE_POSITIVE')}</option>
            <option value="RESOLVED">{t('judgment.RESOLVED')}</option>
          </select>
        </label>
        <input
          aria-label="Judgment reason"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('judgment.reasonPlaceholder')}
          className="min-w-48 flex-1 rounded border border-line bg-surface-2 px-2 py-1 text-[11px] text-ink"
        />
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
          className="rounded border border-line-strong bg-surface-2 px-2 py-1 text-[11px] text-ink"
        >
          {t('judgment.save')}
        </button>
        {finding.judgment.needsReview && (
          <span className="text-[10px] text-warn">{t('judgment.needsReview')}</span>
        )}
      </div>
      {mutation.isError && (
        <p role="alert" className="mt-1 text-[11px] text-danger">{t('judgment.saveFailed')}</p>
      )}
    </>
  )
}
