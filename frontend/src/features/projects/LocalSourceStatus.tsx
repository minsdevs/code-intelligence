import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getLocalSourceStatus, reanalyzeLocalProject } from '../../api/projects'

export default function LocalSourceStatus({
  projectId,
  details = false,
}: {
  projectId: number
  details?: boolean
}) {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    queryKey: ['local-source-status', projectId],
    queryFn: () => getLocalSourceStatus(projectId),
    refetchOnWindowFocus: false,
  })
  const refreshMutation = useMutation({
    mutationFn: () => reanalyzeLocalProject(projectId, statusQuery.data!),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['local-source-status', projectId] }),
      ])
    },
  })

  if (statusQuery.isLoading) {
    return <span className="font-mono text-[10px] text-ink-faint">checking source…</span>
  }
  if (statusQuery.isError || !statusQuery.data) {
    return <span className="font-mono text-[10px] text-danger">source check failed</span>
  }

  const status = statusQuery.data
  const labels: Record<typeof status.state, string> = {
    UP_TO_DATE: '최신',
    CHANGED: '변경됨',
    PATH_MISSING: '경로 없음',
    REAUTHORIZATION_REQUIRED: '권한 재확인 필요',
    NOT_LOCAL: '원격',
    NO_SNAPSHOT: '분석 대기',
  }
  const tone =
    status.state === 'UP_TO_DATE'
      ? 'text-ok'
      : status.state === 'CHANGED'
        ? 'text-warn'
        : 'text-danger'

  if (!details) {
    return (
      <span role="status" className={`font-mono text-[10px] uppercase tracking-wide ${tone}`}>
        {labels[status.state]}
        {status.state === 'CHANGED' ? ` · ${status.changes.total}` : ''}
      </span>
    )
  }

  return (
    <section className="border-b border-line bg-surface-1 px-5 py-2" aria-label="Local source status">
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <strong className={tone}>{labels[status.state]}</strong>
        {status.state === 'CHANGED' && (
          <span className="font-mono text-ink-muted">
            +{status.changes.added} ~{status.changes.modified} -{status.changes.deleted}
          </span>
        )}
        <span className="text-ink-faint">{status.message}</span>
        {status.state === 'CHANGED' && (
          <button
            type="button"
            disabled={refreshMutation.isPending}
            onClick={() => refreshMutation.mutate()}
            className="ml-auto rounded-md border border-line-strong bg-surface-2 px-2.5 py-1 text-ink hover:bg-surface-3 disabled:opacity-60"
          >
            {refreshMutation.isPending ? 'Starting…' : '변경 확인 후 전체 재분석'}
          </button>
        )}
      </div>
      {details && status.changedPaths.length > 0 && (
        <details className="mt-1 text-[11px] text-ink-muted">
          <summary className="cursor-pointer">변경 파일 보기</summary>
          <ul className="mt-1 max-h-28 overflow-auto font-mono">
            {status.changedPaths.map((path) => <li key={path}>{path}</li>)}
          </ul>
        </details>
      )}
      {refreshMutation.isError && (
        <p role="alert" className="mt-1 text-[11px] text-danger">
          소스가 미리보기 이후 변경되었거나 재분석을 시작할 수 없습니다. 상태를 다시 확인하세요.
        </p>
      )}
    </section>
  )
}
