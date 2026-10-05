import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useState } from 'react'
import { deleteProject, listProjects } from '../../api/projects'
import EmptyState from '../../components/EmptyState'
import { FolderIcon, GithubIcon } from '../../components/icons'
import { useT } from '../../lib/i18n'
import { formatWhen } from '../history/format'
import { areaLabel } from '../areas/labels'
import { isProjectAnalyzing, projectAnalysisStatus } from './analysisStatus'

export default function ProjectsPage() {
  const t = useT()
  const queryClient = useQueryClient()
  const [removeProjectId, setRemoveProjectId] = useState<number | null>(null)
  const removeMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: async () => {
      setRemoveProjectId(null)
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const query = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    refetchInterval: (query) => query.state.data?.some(isProjectAnalyzing) ? 2000 : false,
  })

  const projects = query.data ?? []

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-ink">{t('projects.title')}</h2>
        <Link
          to="/import"
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 transition-opacity hover:opacity-90"
        >
          {t('projects.import')}
        </Link>
      </div>

      {query.isLoading && (
        <p className="py-8 text-center text-[13px] text-ink-muted">{t('projects.loading')}</p>
      )}

      {!query.isLoading && query.error && (
        <p role="alert" className="py-8 text-center text-[13px] text-danger">
          {t('projects.loadError')}
        </p>
      )}

      {!query.isLoading && !query.error && projects.length === 0 && (
        <EmptyState title={t('projects.emptyTitle')} description={t('projects.emptyDesc')}>
          <Link
            to="/import"
            className="mt-1 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 transition-opacity hover:opacity-90"
          >
            {t('projects.import')}
          </Link>
        </EmptyState>
      )}

      {!query.isLoading && projects.length > 0 && (
        <ul aria-label={t('projects.listLabel')} className="grid gap-3 lg:grid-cols-2">
          {projects.map((project) => {
            const status = projectAnalysisStatus(project)
            const ready = status === 'READY'
            return (
              <li key={project.id} className="flex flex-col gap-1">
                <Link
                  to={`/projects/${project.id}`}
                  className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface-1 px-4 py-3.5 transition-colors hover:border-line-strong hover:bg-surface-2"
                >
                  <div className="flex items-center gap-2">
                    <FolderIcon className="shrink-0 text-accent" />
                    <span className="min-w-0 truncate text-[14px] font-semibold text-ink">
                      {project.name}
                    </span>
                    <span
                      className={`ml-auto shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
                        ready ? 'border-line-strong text-ok' : 'text-warn'
                      }`}
                    >
                      {t(`analysis.status.${status}`)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 font-mono text-[12px] text-ink-muted">
                    <GithubIcon className="shrink-0" />
                    <span className="truncate">
                      {project.repoOwner}/{project.repoName}
                    </span>
                  </div>
                  {project.topTechnologies.length > 0 && (
                    <p className="flex flex-wrap gap-1.5">
                      {project.topTechnologies.map((tech) => (
                        <span
                          key={tech}
                          className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-ink-faint"
                        >
                          {tech}
                        </span>
                      ))}
                    </p>
                  )}
                  <p className="text-[12px] text-ink-faint">
                    {t('projects.analyzedAt')}:{' '}
                    {formatWhen(project.currentSnapshot?.analyzedAt ?? null)}
                  </p>
                  {project.selectedAreas.length > 0 && (
                    <p className="text-[12px] text-ink-faint">
                      {t('projects.areas')}: {project.selectedAreas.map(areaLabel).join(', ')}
                    </p>
                  )}
                </Link>
                {removeProjectId === project.id ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px]">
                    <span className="text-danger">
                      Remove {project.name} and its stored analysis?
                    </span>
                    <span className="flex gap-2">
                      <button
                        type="button"
                        disabled={removeMutation.isPending}
                        onClick={() => removeMutation.mutate(project.id)}
                        className="text-danger underline disabled:opacity-60"
                      >
                        Confirm removal
                      </button>
                      <button
                        type="button"
                        onClick={() => setRemoveProjectId(null)}
                        className="text-ink-muted underline"
                      >
                        Cancel
                      </button>
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setRemoveProjectId(project.id)}
                    className="self-end px-2 py-1 text-[11px] text-ink-faint hover:text-danger"
                  >
                    Remove project…
                  </button>
                )}
                {removeMutation.isError && removeProjectId === project.id && (
                  <p role="alert" className="text-[11px] text-danger">
                    Could not remove this project. Cancel active analysis first.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
