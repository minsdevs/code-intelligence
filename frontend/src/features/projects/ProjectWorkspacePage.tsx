import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { NavLink, Outlet, useLocation, useParams } from 'react-router-dom'
import { getProject } from '../../api/projects'
import { parseProjectId } from '../../lib/projectId'
import { workspaceTabs } from './workspaceTabs'
import LocalSourceStatus from './LocalSourceStatus'
import GithubAnalysisStatus from './GithubAnalysisStatus'
import { useT } from '../../lib/i18n'

export default function ProjectWorkspacePage() {
  const t = useT()
  const location = useLocation()
  const [toolsOpenedAt, setToolsOpenedAt] = useState<string | null>(null)
  const toolsOpen = toolsOpenedAt === location.key
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: projectId != null,
  })
  const projectName = projectQuery.data?.name ?? rawId ?? ''
  const workspaceBasePath = projectId != null ? `/projects/${projectId}` : null
  const requestedSnapshot = new URLSearchParams(location.search).get('snapshotId')
  const snapshotId = requestedSnapshot && /^[1-9]\d*$/.test(requestedSnapshot)
    && Number.isSafeInteger(Number(requestedSnapshot)) ? requestedSnapshot : null
  const tabTarget = (path: string) => {
    const base = workspaceBasePath ? `${workspaceBasePath}/${path}` : path
    return snapshotId && ['overview', 'features', 'flows', 'code'].includes(path)
      ? `${base}?snapshotId=${snapshotId}` : base
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="sticky top-0 z-10 shrink-0 border-b border-line bg-surface-0/95 px-5 pt-4 backdrop-blur">
        <div className="flex min-w-0 items-baseline gap-1.5 pb-3">
          <span className="shrink-0 text-[12px] text-ink-faint">Projects /</span>
          <h1 title={projectName} className="min-w-0 truncate font-mono text-[15px] font-semibold text-ink">{projectName}</h1>
        </div>
        <nav aria-label="Workspace tabs" className="flex items-start gap-0.5">
          <div role="group" aria-label="Primary questions" className="flex min-w-0 flex-1 overflow-x-auto">
            {workspaceTabs.filter((tab) => !tab.secondary).map((tab) => (
              <NavLink
                key={tab.path}
                to={tabTarget(tab.path)}
                title={t(`workspace.question.${tab.path}`)}
                className={({ isActive }) =>
                  `whitespace-nowrap border-b-2 px-2.5 pb-2 pt-1 transition-colors ${
                    isActive ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-muted hover:text-ink'
                  }`
                }
              >
                {t(`workspace.nav.${tab.path}`)}
              </NavLink>
            ))}
          </div>
          <details className="relative shrink-0" open={toolsOpen}>
            <summary
              className="cursor-pointer px-2.5 pb-2 pt-1 text-ink-muted"
              onClick={(event) => {
                event.preventDefault()
                setToolsOpenedAt(toolsOpen ? null : location.key)
              }}
            >{t('workspace.tools')}</summary>
            <div className="absolute right-0 top-full z-20 min-w-44 rounded-md border border-line bg-surface-1 p-1 shadow-lg">
              {workspaceTabs.filter((tab) => tab.secondary).map((tab) => (
                <NavLink
                  key={tab.path}
                  to={tabTarget(tab.path)}
                  className={({ isActive }) => `block whitespace-nowrap rounded px-3 py-2 text-[13px] ${isActive ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2'}`}
                >
                  {tab.label}
                </NavLink>
              ))}
            </div>
          </details>
        </nav>
      </header>
      {projectQuery.data?.sourceType === 'LOCAL' && (
        <LocalSourceStatus key={projectQuery.data.id} projectId={projectQuery.data.id} details />
      )}
      {projectQuery.data?.sourceType === 'GITHUB' && (
        <GithubAnalysisStatus key={projectQuery.data.id} project={projectQuery.data} />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  )
}
