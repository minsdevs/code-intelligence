import type { ReactNode } from 'react'
import { NavLink, useMatch } from 'react-router-dom'
import { FolderIcon, HomeIcon, SearchIcon, SlidersIcon } from '../components/icons'

const navItems = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/projects', label: 'Projects', icon: FolderIcon, end: false },
  { to: '/search', label: 'Search', icon: SearchIcon, end: false },
  { to: '/settings', label: 'Settings', icon: SlidersIcon, end: false },
]

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1.5 pt-5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
      {children}
    </p>
  )
}

export default function Sidebar() {
  const projectMatch = useMatch('/projects/:projectId/*')
  const projectId = projectMatch?.params.projectId

  return (
    <aside
      aria-label="사이드바"
      className="flex w-60 shrink-0 flex-col border-r border-line bg-surface-1"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <span aria-hidden="true" className="font-mono text-[13px] font-bold text-accent">
          {'{}'}
        </span>
        <span className="font-mono text-[13px] font-semibold tracking-tight text-ink">
          Code Intelligence
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <nav aria-label="주 메뉴" className="flex flex-col gap-0.5 pt-2">
          {navItems.map(({ to, label, icon: NavIcon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors ${
                  isActive
                    ? 'bg-surface-3 text-ink shadow-[inset_2px_0_0_var(--color-accent)]'
                    : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                }`
              }
            >
              <NavIcon className="shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        <SectionLabel>Projects</SectionLabel>
        {projectId ? (
          <div className="flex flex-col">
            <div className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink">
              <FolderIcon className="shrink-0 text-accent" />
              <span className="truncate">{projectId}</span>
            </div>
            <SectionLabel>Areas</SectionLabel>
            <p className="px-2.5 text-[12px] leading-relaxed text-ink-faint">
              Analysis Areas는 Phase 1의 영역 감지 후 이곳에 표시됩니다.
            </p>
          </div>
        ) : (
          <p className="px-2.5 text-[12px] leading-relaxed text-ink-faint">
            연결된 프로젝트가 없습니다. Phase 1에서 GitHub 저장소를 가져올 수 있습니다.
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-4 py-2.5 font-mono text-[10px] tracking-wide text-ink-faint">
        v0.0.0 · Phase 1
      </div>
    </aside>
  )
}
