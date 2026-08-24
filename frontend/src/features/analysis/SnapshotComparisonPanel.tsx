import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { compareSnapshots, listSnapshots } from '../../api/snapshots'
import type { SnapshotCategoryChanges } from '../../api/types'

export default function SnapshotComparisonPanel({ projectId }: { projectId: number }) {
  const snapshotsQuery = useQuery({
    queryKey: ['snapshots', projectId],
    queryFn: () => listSnapshots(projectId),
  })
  const [baseId, setBaseId] = useState<number | null>(null)
  const [targetId, setTargetId] = useState<number | null>(null)

  const snapshots = snapshotsQuery.data ?? []
  const resolvedTargetId = targetId ?? snapshots[0]?.id ?? null
  const resolvedBaseId = baseId ?? snapshots[1]?.id ?? snapshots[0]?.id ?? null

  const comparisonQuery = useQuery({
    queryKey: ['snapshot-comparison', projectId, resolvedBaseId, resolvedTargetId],
    queryFn: () => compareSnapshots(projectId, resolvedBaseId!, resolvedTargetId!),
    enabled: resolvedBaseId != null && resolvedTargetId != null,
  })

  if (snapshotsQuery.isLoading) return <p className="px-4 py-2 text-[12px] text-ink-muted">Loading snapshots…</p>
  if (!snapshotsQuery.data?.length) return null

  const comparison = comparisonQuery.data
  return (
    <section className="border-b border-line bg-surface-1 px-4 py-3" aria-label="Snapshot comparison">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-[13px] font-semibold text-ink">Snapshot changes</h2>
        <SnapshotSelect label="Before" value={resolvedBaseId} snapshots={snapshotsQuery.data} onChange={setBaseId} />
        <SnapshotSelect label="After" value={resolvedTargetId} snapshots={snapshotsQuery.data} onChange={setTargetId} />
      </div>
      {comparisonQuery.isError && <p role="alert" className="mt-2 text-[12px] text-danger">Snapshot comparison failed.</p>}
      {comparison && (
        <div className="mt-2">
          <div className="grid grid-cols-2 gap-2 text-[12px] md:grid-cols-5">
            <ChangeCount label="Features" value={comparison.features} />
            <ChangeCount label="Flows" value={comparison.flows} />
            <ChangeCount label="Findings" value={comparison.findings} />
            <ChangeCount label="Nodes" value={comparison.structure.nodes} />
            <ChangeCount label="Relations" value={comparison.structure.relationships} />
          </div>
          <p className="mt-2 font-mono text-[11px] text-ink-muted">
            coverage {comparison.coverage.before.fileCoverage.analyzedFiles} →{' '}
            {comparison.coverage.after.fileCoverage.analyzedFiles} analyzed files
          </p>
          {comparison.renameCandidates.length > 0 && (
            <p className="mt-1 text-[11px] text-warn">
              Rename candidates: {comparison.renameCandidates.map((item) => `${item.beforeName} → ${item.afterName}`).join(', ')}
            </p>
          )}
          {comparison.regressionWarnings.map((warning) => (
            <p key={warning} role="alert" className="mt-1 text-[11px] text-danger">{warning}</p>
          ))}
        </div>
      )}
    </section>
  )
}

function SnapshotSelect({
  label,
  value,
  snapshots,
  onChange,
}: {
  label: string
  value: number | null
  snapshots: { id: number; commitSha: string }[]
  onChange: (value: number) => void
}) {
  return (
    <label className="text-[11px] text-ink-muted">
      {label}{' '}
      <select
        aria-label={`${label} snapshot`}
        value={value ?? ''}
        onChange={(event) => onChange(Number(event.target.value))}
        className="rounded border border-line bg-surface-2 px-2 py-1 font-mono text-ink"
      >
        {snapshots.map((snapshot) => (
          <option key={snapshot.id} value={snapshot.id}>#{snapshot.id} {snapshot.commitSha.slice(0, 8)}</option>
        ))}
      </select>
    </label>
  )
}

function ChangeCount({ label, value }: { label: string; value: SnapshotCategoryChanges }) {
  return (
    <div className="rounded border border-line px-2 py-1">
      <strong className="text-ink">{label}</strong>
      <span className="ml-2 font-mono text-ink-muted">+{value.added.length} ~{value.changed.length} -{value.removed.length}</span>
    </div>
  )
}
