import { NavLink, Outlet, useParams } from 'react-router-dom'
import { workspaceTabs } from './workspaceTabs'

export default function ProjectWorkspacePage() {
  const { projectId } = useParams()

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="sticky top-0 z-10 shrink-0 border-b border-line bg-surface-0/95 px-5 pt-4 backdrop-blur">
        <div className="flex items-baseline gap-1.5 pb-3">
          <span className="text-[12px] text-ink-faint">Projects /</span>
          <h1 className="font-mono text-[15px] font-semibold text-ink">{projectId}</h1>
        </div>
        <nav aria-label="워크스페이스 탭" className="flex gap-0.5 overflow-x-auto">
          {workspaceTabs.map((tab) => (
            <NavLink
              key={tab.path}
              to={tab.path}
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  )
}
