import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listProjects } from '../../api/projects'
import { UnauthorizedError } from '../../api/client'
import type { Project } from '../../api/types'
import EmptyState from '../../components/EmptyState'
import { useT } from '../../lib/i18n'
import { firstLine, formatWhen, shortSha } from '../history/format'
import LocalSourceStatus from '../projects/LocalSourceStatus'
import { isProjectAnalyzing } from '../projects/analysisStatus'

export default function HomePage() {
  const t = useT()
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    refetchInterval: (query) => query.state.data?.some(isProjectAnalyzing) ? 2000 : false,
  })

  const projects = projectsQuery.data ?? []
  const unauthorized = projectsQuery.error instanceof UnauthorizedError

  return (
    <div className="flex flex-1 flex-col px-6 py-5">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[15px] font-semibold text-ink">{t('home.title')}</h1>
          <p className="mt-0.5 text-[13px] text-ink-muted">{t('home.description')}</p>
        </div>
        <Link
          to="/import"
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 transition-opacity hover:opacity-90"
        >
          {t('home.import')}
        </Link>
      </header>

      {projectsQuery.isLoading && <p className="text-[13px] text-ink-muted">{t('home.loading')}</p>}

      {unauthorized && (
        <EmptyState title={t('home.loginPrompt')}>
          <Link
            to="/import"
            className="mt-1 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 transition-opacity hover:opacity-90"
          >
            {t('home.login')}
          </Link>
        </EmptyState>
      )}

      {projectsQuery.isError && !unauthorized && (
        <p role="alert" className="text-[12px] text-danger">
          {t('home.loadError')}
        </p>
      )}

      {!projectsQuery.isLoading && !projectsQuery.isError && projects.length === 0 && (
        <EmptyState title={t('home.emptyTitle')} description={t('home.emptyDesc')}>
          <Link
            to="/import"
            className="mt-1 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 transition-opacity hover:opacity-90"
          >
            {t('home.import')}
          </Link>
        </EmptyState>
      )}

      {projects.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <li key={project.id}>
              <ProjectCard project={project} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ProjectCard({ project }: { project: Project }) {
  const t = useT()
  const analyzing = isProjectAnalyzing(project)
  return (
    <Link
      to={`/projects/${project.id}/overview`}
      className={`block rounded-md border border-line bg-surface-1 p-4 transition-colors hover:border-line-strong hover:bg-surface-2 ${
        analyzing ? 'shadow-[inset_3px_0_0_var(--color-accent)]' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-mono text-[14px] font-semibold text-ink">{project.name}</h2>
          <p
            className="mt-1 truncate font-mono text-[11px] text-ink-faint"
            title={project.sourceAddress}
          >
            {project.sourceAddress}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="rounded border border-line-strong px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-ink-faint">
            {project.sourceType}
          </span>
          {analyzing ? (
            <span
              role="status"
              className="font-mono text-[10px] uppercase tracking-wide text-accent"
            >
              {t('home.analyzing')}
            </span>
          ) : project.sourceType === 'LOCAL' ? (
            <LocalSourceStatus projectId={project.id} />
          ) : null}
        </div>
      </div>
      <dl className="mt-3 flex flex-col gap-2 text-[12px]">
        <div className="flex gap-2">
          <dt className="shrink-0 text-ink-faint">{t('home.status')}</dt>
          <dd className="text-ink-muted">
            {project.latestJob?.status ?? project.currentSnapshot?.status ?? t('home.notAnalyzed')}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-ink-faint">{t('home.analyzedAt')}</dt>
          <dd className="text-ink-muted">
            {formatWhen(project.currentSnapshot?.analyzedAt ?? null)}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-ink-faint">{t('home.tech')}</dt>
          <dd className="text-ink-muted">{project.topTechnologies.join(', ') || '—'}</dd>
        </div>
        {project.currentSnapshot && (
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-faint">{t('home.snapshot')}</dt>
            <dd className="text-ink-muted">
              {project.currentSnapshot.status} · {formatWhen(project.currentSnapshot.analyzedAt)}
            </dd>
          </div>
        )}
        {project.latestCommit && (
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-faint">{t('home.commit')}</dt>
            <dd className="min-w-0 truncate text-ink-muted">
              {shortSha(project.latestCommit.sha)} {firstLine(project.latestCommit.message)}
            </dd>
          </div>
        )}
        {project.latestPull && (
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-faint">{t('home.pr')}</dt>
            <dd className="min-w-0 truncate text-ink-muted">
              #{project.latestPull.number} {project.latestPull.title} ({project.latestPull.state})
            </dd>
          </div>
        )}
      </dl>
    </Link>
  )
}
