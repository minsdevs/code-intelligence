import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { getGrowth } from '../../api/growth'
import EmptyState from '../../components/EmptyState'
import { useT } from '../../lib/i18n'
import { parseProjectId } from '../../lib/projectId'
import { queryError } from '../code/codeLocation'

export default function GrowthPage() {
  const t = useT()
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const navigate = useNavigate()

  const growthQuery = useQuery({
    queryKey: ['growth', projectId],
    queryFn: () => getGrowth(projectId!),
    enabled: projectId != null,
  })

  if (projectId == null) {
    return <EmptyState title="Growth" description={t('growth.desc')} />
  }

  const error = queryError(growthQuery.error)
  const data = growthQuery.data

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <h2 className="text-[15px] font-semibold text-ink">Growth</h2>
      <p className="mt-1 text-[13px] text-ink-muted">{t('growth.subtitle')}</p>
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {error}
        </p>
      )}
      {growthQuery.isLoading && (
        <p className="mt-4 text-[13px] text-ink-muted">{t('growth.loading')}</p>
      )}
      {data && (
        <>
          <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Notes" value={data.notesCount} />
            <Stat label={t('growth.learningRecords')} value={data.learningRecords} />
            <Stat label="Findings open" value={data.findingsOpen} />
            <Stat label="Findings dismissed" value={data.findingsDismissed} />
          </dl>
          <h3 className="mt-8 text-[13px] font-semibold text-ink">Tasks by type</h3>
          <table className="mt-2 w-full text-left text-[12px]">
            <thead>
              <tr className="text-ink-faint">
                <th className="py-1 font-medium">Type</th>
                <th className="py-1 font-medium">Open</th>
                <th className="py-1 font-medium">Done</th>
                <th className="py-1 font-medium">Draft</th>
              </tr>
            </thead>
            <tbody>
              {data.tasksByType.map((row) => (
                <tr key={row.type} className="border-t border-line">
                  <td className="py-1.5 font-mono text-ink">{row.type}</td>
                  <td className="py-1.5 text-ink-muted">{row.open}</td>
                  <td className="py-1.5 text-ink-muted">{row.done}</td>
                  <td className="py-1.5 text-ink-muted">{row.draft}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="mt-8 text-[13px] font-semibold text-ink">{t('growth.weeklyLabel')}</h3>
          {data.weekly.length === 0 ? (
            <p className="mt-2 text-[13px] text-ink-muted">{t('growth.noWeekly')}</p>
          ) : (
            <ul aria-label="Weekly learning" className="mt-2 space-y-1">
              {data.weekly.map((week) => (
                <li
                  key={week.weekStart}
                  className="flex gap-3 font-mono text-[12px] text-ink-muted"
                >
                  <span className="text-ink">{week.weekStart}</span>
                  <span>records {week.learningRecords}</span>
                  <span>done {week.tasksDone}</span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-8 text-[13px] font-semibold text-ink">{t('growth.recentLabel')}</h3>
          {data.recentRecords.length === 0 ? (
            <p className="mt-2 text-[13px] text-ink-muted">{t('growth.noRecent')}</p>
          ) : (
            <ul aria-label="Recent learning records" className="mt-2 space-y-2">
              {data.recentRecords.map((record) => (
                <li key={`${record.taskId}-${record.createdAt}`}>
                  <button
                    type="button"
                    onClick={() => navigate(`/projects/${projectId}/tasks`)}
                    className="text-left"
                  >
                    <span className="text-[13px] text-ink">{record.taskTitle}</span>
                    <span className="ml-2 font-mono text-[11px] text-ink-faint">
                      {record.createdAt}
                    </span>
                    <p className="text-[12px] text-ink-muted">{record.note}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line bg-surface-1 px-3 py-2">
      <dt className="text-[11px] text-ink-faint">{label}</dt>
      <dd className="mt-1 font-mono text-[18px] text-ink">{value}</dd>
    </div>
  )
}
