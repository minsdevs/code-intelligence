import { useEffect, useState } from 'react'
import { getJob } from '../../api/jobs'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getLocalSourceStatus, relinkLocalProject } from '../../api/projects'
import type { JobStatus } from '../../api/types'
import LocalSourceApproval from './LocalSourceApproval'
import { useT } from '../../lib/i18n'

function terminal(status: JobStatus | undefined): boolean {
  return status === 'DONE' || status === 'FAILED' || status === 'CANCELLED'
}

export default function LocalSourceStatus({
  projectId,
  details = false,
}: {
  projectId: number
  details?: boolean
}) {
  return <SourceStatus key={projectId} projectId={projectId} details={details} />
}

function SourceStatus({ projectId, details }: { projectId: number; details: boolean }) {
  const t = useT()
  const queryClient = useQueryClient()
  const [refreshJobId, setRefreshJobId] = useState<number | null>(null)
  const [approvalEpoch, setApprovalEpoch] = useState(0)
  const [approvalBusy, setApprovalBusy] = useState(false)
  const [previewRequired, setPreviewRequired] = useState(false)
  const statusQuery = useQuery({
    queryKey: ['local-source-status', projectId],
    queryFn: () => getLocalSourceStatus(projectId),
    refetchOnWindowFocus: false,
  })
  const refreshJob = useQuery({
    queryKey: ['job', refreshJobId],
    queryFn: () => getJob(refreshJobId!),
    enabled: refreshJobId != null,
    refetchInterval: (query) => (terminal(query.state.data?.status) ? false : 1000),
  })
  useEffect(() => {
    if (!refreshJobId || !terminal(refreshJob.data?.status)) return
    // Local refresh replaces the managed object store; even old snapshot cache entries may now be unavailable.
    void Promise.all(
      [
        'project',
        'projects',
        'local-source-status',
        'snapshots',
        'files',
        'file-content',
        'graph-nodes',
        'graph-relations',
        'features',
        'feature',
      ].map((key) =>
        queryClient.invalidateQueries({ queryKey: key === 'projects' ? [key] : [key, projectId] }),
      ),
    ).then(() => {
      setPreviewRequired(refreshJob.data?.failureCode === 'LOCAL_PREVIEW_REQUIRED')
      setApprovalEpoch((epoch) => epoch + 1)
      setRefreshJobId((current) => (current === refreshJobId ? null : current))
    })
  }, [projectId, queryClient, refreshJobId, refreshJob.data?.status, refreshJob.data?.failureCode])

  const relinkMutation = useMutation({
    mutationFn: async () => {
      setApprovalEpoch((epoch) => epoch + 1)
      const path = await window.codeIntelligenceDesktop?.pickFolder()
      if (!path) return null
      return relinkLocalProject(projectId, path)
    },
    onSuccess: async (project) => {
      if (!project) return
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
  const label = t(`localSource.state.${status.state}`)
  const tone =
    status.state === 'UP_TO_DATE'
      ? 'text-ok'
      : status.state === 'CHANGED'
        ? 'text-warn'
        : 'text-danger'

  if (!details) {
    return (
      <span role="status" className={`font-mono text-[10px] uppercase tracking-wide ${tone}`}>
        {label}
        {status.state === 'CHANGED' ? ` · ${status.changes.total}` : ''}
      </span>
    )
  }

  return (
    <section
      className="border-b border-line bg-surface-1 px-5 py-2"
      aria-label="Local source status"
    >
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <strong className={tone}>{label}</strong>
        {status.state === 'CHANGED' && (
          <span className="font-mono text-ink-muted">
            +{status.changes.added} ~{status.changes.modified} -{status.changes.deleted}
          </span>
        )}
        <span className="text-ink-faint">
          {status.state === 'INSPECTION_FAILED'
            ? t('localSource.inspectionFailed')
            : status.message}
        </span>
        <button
          type="button"
          onClick={() => {
            setApprovalEpoch((epoch) => epoch + 1)
            void statusQuery.refetch()
          }}
          disabled={statusQuery.isFetching || approvalBusy}
          className="rounded-md border border-line px-2 py-1"
        >
          {t('localSource.refresh')}
        </button>
        {refreshJobId != null && <span role="status">Analyzing…</span>}
        {(status.state === 'PATH_MISSING' || status.state === 'REAUTHORIZATION_REQUIRED') &&
          window.codeIntelligenceDesktop && (
            <button
              type="button"
              disabled={relinkMutation.isPending || approvalBusy || refreshJobId != null}
              onClick={() => relinkMutation.mutate()}
              className="ml-auto rounded-md border border-line-strong bg-surface-2 px-2.5 py-1 text-ink hover:bg-surface-3 disabled:opacity-60"
            >
              {relinkMutation.isPending ? 'Choosing…' : t('localSource.relink')}
            </button>
          )}
        {relinkMutation.isError && (
          <span role="alert" className="text-[11px] text-danger">
            {t('localSource.relinkFailed')}
          </span>
        )}
      </div>
      {status.state === 'CHANGED' && status.changedPaths.length > 0 && (
        <details className="mt-1 text-[11px] text-ink-muted">
          <summary className="cursor-pointer">{t('localSource.changedFiles')}</summary>
          <ul className="mt-1 max-h-28 overflow-auto font-mono">
            {status.changedPaths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </details>
      )}
      {previewRequired && (
        <p role="alert" className="mt-1 text-[11px] text-danger">
          {t('localSource.previewRequired')}
        </p>
      )}
      {refreshJobId == null && ['UP_TO_DATE', 'CHANGED', 'NO_SNAPSHOT'].includes(status.state) && (
        <LocalSourceApproval
          key={approvalEpoch}
          source={{ operation: 'REFRESH', projectId }}
          disabled={statusQuery.isFetching || relinkMutation.isPending}
          onBusyChange={setApprovalBusy}
          onStarted={(_, jobId) => {
            setApprovalBusy(false)
            setPreviewRequired(false)
            setRefreshJobId(jobId)
            void Promise.all([
              queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
              queryClient.invalidateQueries({ queryKey: ['projects'] }),
              queryClient.invalidateQueries({ queryKey: ['local-source-status', projectId] }),
            ])
          }}
        />
      )}
    </section>
  )
}
