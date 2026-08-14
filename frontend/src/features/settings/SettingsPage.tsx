import { useQuery } from '@tanstack/react-query'
import { getAiStatus } from '../../api/ai'
import { queryError } from '../code/codeLocation'

export default function SettingsPage() {
  const statusQuery = useQuery({
    queryKey: ['ai-status'],
    queryFn: getAiStatus,
    retry: false,
  })
  const error = queryError(statusQuery.error)
  const status = statusQuery.data

  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-[16px] font-semibold text-ink">Settings</h1>
      <section className="mt-6 rounded-md border border-line bg-surface-1 px-4 py-3" aria-label="AI Provider">
        <h2 className="text-[13px] font-semibold text-ink">AI Provider</h2>
        <p className="mt-1 text-[12px] text-ink-muted">
          API 키는 환경 변수로만 설정합니다. 이 화면에서는 키를 입력하거나 저장하지 않습니다.
        </p>
        {error && (
          <p role="alert" className="mt-2 text-[12px] text-danger">
            {error}
          </p>
        )}
        {statusQuery.isLoading && <p className="mt-2 text-[13px] text-ink-muted">상태를 불러오는 중…</p>}
        {status && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-ink-muted">상태</dt>
            <dd className="text-ink">{status.configured ? '사용 가능' : '비활성화'}</dd>
            <dt className="text-ink-muted">Provider</dt>
            <dd className="font-mono text-ink">{status.provider ?? '—'}</dd>
          </dl>
        )}
      </section>
    </div>
  )
}
