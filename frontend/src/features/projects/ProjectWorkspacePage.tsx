import { useQuery } from '@tanstack/react-query'
import { NavLink, Outlet, useParams } from 'react-router-dom'
import { getProject } from '../../api/projects'
import { parseProjectId } from '../../lib/projectId'
import { workspaceTabs } from './workspaceTabs'
import LocalSourceStatus from './LocalSourceStatus'

export default function ProjectWorkspacePage() {
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: projectId != null,
  })
  const projectName = projectQuery.data?.name ?? rawId ?? ''
  const workspaceBasePath = projectId != null ? `/projects/${projectId}` : null

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="sticky top-0 z-10 shrink-0 border-b border-line bg-surface-0/95 px-5 pt-4 backdrop-blur">
        <div className="flex min-w-0 items-baseline gap-1.5 pb-3">
          <span className="shrink-0 text-[12px] text-ink-faint">Projects /</span>
          <h1 title={projectName} className="min-w-0 truncate font-mono text-[15px] font-semibold text-ink">{projectName}</h1>
        </div>
        <nav aria-label="Workspace tabs" className="flex gap-0.5 overflow-x-auto">
          {workspaceTabs.map((tab) => (
            <NavLink
              key={tab.path}
              to={workspaceBasePath ? `${workspaceBasePath}/${tab.path}` : tab.path}
              className={({ isActive }) =>
                `whitespace-nowrap border-b-2 px-2.5 pb-2 pt-1 transition-colors ${
                  isActive
                    ? 'border-accent font-medium text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink'
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </header>
      {projectQuery.data?.sourceType === 'LOCAL' && (
        <LocalSourceStatus key={projectQuery.data.id} projectId={projectQuery.data.id} details />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  )
}
