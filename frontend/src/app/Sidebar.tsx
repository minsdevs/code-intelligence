import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, useMatch } from 'react-router-dom'
import { getGithubConnection } from '../api/desktopAuth'
import { ApiError } from '../api/client'
import { listProjects } from '../api/projects'
import { listAreas, updateAreaSelections } from '../api/areas'
import type { AreaSelectionsRequest, AreaType, ProjectArea } from '../api/types'
import { FolderIcon, HomeIcon, PanelRightIcon, SearchIcon, SlidersIcon } from '../components/icons'
import { areaLabel } from '../features/areas/labels'
import { useT } from '../lib/i18n'
import { parseProjectId } from '../lib/projectId'
import { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH, useUiStore } from '../stores/uiStore'

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
  const t = useT()
  const collapsed = useUiStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const versionLabel = window.codeIntelligenceDesktop
    ? `v${window.codeIntelligenceDesktop.appVersion}`
    : import.meta.env.DEV ? 'Browser development' : 'Browser build'
  const projectMatch = useMatch('/projects/:projectId/*')
  const rawProjectId = projectMatch?.params.projectId
  const projectId = parseProjectId(rawProjectId)
  const setSelectedAreas = useUiStore((state) => state.setSelectedAreas)
  const queryClient = useQueryClient()

  const areasQuery = useQuery({
    queryKey: ['areas', projectId],
    queryFn: () => listAreas(projectId!),
    enabled: projectId != null,
  })

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  })

  const accountQuery = useQuery({ queryKey: ['github-connection'], queryFn: getGithubConnection, retry: false })
  const accountLabel = accountQuery.isPending ? t('sidebar.accountChecking')
    : accountQuery.isError ? t('sidebar.accountCheckNeeded')
      : accountQuery.data.reauthenticationReason === 'REFRESH_IN_PROGRESS' ? t('settings.githubRefreshing')
      : accountQuery.data.reauthenticationReason ? t('settings.githubReauthNeeded')
      : accountQuery.data.connected ? t('sidebar.githubConnected').replace('{id}', String(accountQuery.data.githubId))
      : t('sidebar.localMode')

  const areas = areasQuery.data
  const projects = projectsQuery.data ?? []

  const mutation = useMutation({
    mutationFn: (body: AreaSelectionsRequest) => updateAreaSelections(projectId!, body),
  })

  const toggleArea = (areaType: AreaType) => {
    if (!projectId || !areas) return
    const previous = areas
    const next = areas.map((area) => ({
      ...area,
      selected: area.areaType === areaType ? !area.selected : area.selected,
    }))
    queryClient.setQueryData(['areas', projectId], next)
    setSelectedAreas(next.filter((area) => area.selected).map((area) => area.areaType))
    mutation.mutate(
      {
        selections: next.map((area) => ({ areaType: area.areaType, selected: area.selected })),
      },
      {
        onError: () => {
          queryClient.setQueryData(['areas', projectId], previous)
          setSelectedAreas(previous.filter((area) => area.selected).map((area) => area.areaType))
        },
      },
    )
  }

  useEffect(() => {
    if (!areas) return
    setSelectedAreas(areas.filter((area) => area.selected).map((area) => area.areaType))
  }, [areas, setSelectedAreas])

  return (
    <aside
      aria-label={t('sidebar.label')}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
      className="flex min-w-0 shrink-0 flex-col border-r border-line bg-surface-1"
    >
      <NavLink
        to="/"
        end
        aria-label="Code Intelligence home"
        title="Code Intelligence home"
        className="flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b border-line px-4 transition-colors hover:bg-surface-2"
      >
        <span aria-hidden="true" className="font-mono text-[13px] font-bold text-accent">
          {'{}'}
        </span>
        <span className={`${collapsed ? 'sr-only' : 'truncate'} font-mono text-[13px] font-semibold tracking-tight text-ink`}>
          Code Intelligence
        </span>
      </NavLink>

      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
        aria-controls="sidebar-projects"
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="mx-2 mt-2 flex shrink-0 items-center justify-center gap-2 rounded-md p-2 text-ink-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        <PanelRightIcon className="rotate-180" />
        {!collapsed && <span>Collapse sidebar</span>}
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <nav aria-label="Main menu" className="flex flex-col gap-0.5 pt-2">
          {navItems.map(({ to, label, icon: NavIcon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              aria-label={label}
              title={label}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors ${
                  isActive
                    ? 'bg-surface-3 text-ink shadow-[inset_2px_0_0_var(--color-accent)]'
                    : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                }`
              }
            >
              <NavIcon className="shrink-0" />
              <span className={collapsed ? 'sr-only' : undefined}>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div id="sidebar-projects" hidden={collapsed}>
          <SectionLabel>{t('sidebar.projects')}</SectionLabel>
          {projectsQuery.isLoading ? (
            <p className="px-2.5 text-[12px] text-ink-muted">{t('sidebar.projectsLoading')}</p>
          ) : projects.length === 0 ? (
            <p className="px-2.5 text-[12px] leading-relaxed text-ink-faint">{t('sidebar.noProject')}</p>
          ) : (
            <ul aria-label={t('sidebar.projects')} className="flex flex-col gap-0.5">
              {projects.map((project) => (
                <li key={project.id}>
                  <NavLink
                    to={`/projects/${project.id}`}
                    title={project.name}
                    className={({ isActive }) =>
                      `flex items-center gap-2 rounded-md px-2.5 py-1.5 font-mono text-[12px] transition-colors ${
                        isActive
                          ? 'bg-surface-3 text-ink shadow-[inset_2px_0_0_var(--color-accent)]'
                          : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                      }`
                    }
                  >
                    <FolderIcon className="shrink-0 text-accent" />
                    <span className="truncate">{project.name}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
          {rawProjectId && (
            <div className="flex flex-col">
              <SectionLabel>{t('sidebar.areas')}</SectionLabel>
              <AreasSection
                numeric={projectId != null}
                loading={areasQuery.isLoading}
                error={areasQuery.error}
                areas={areas}
                onToggle={toggleArea}
              />
            </div>
          )}
        </div>
      </div>

      <NavLink to="/settings#github-account" aria-label={t('analysis.accountSettings')} title={accountLabel} className="mx-2 mb-2 flex shrink-0 items-center gap-2 rounded-md border border-line px-2.5 py-2 text-[12px] text-ink-muted hover:bg-surface-2">
        <SlidersIcon className="shrink-0" />
        <span className={collapsed ? 'sr-only' : 'truncate'}>{accountLabel}</span>
      </NavLink>
      <div className={`${collapsed ? 'sr-only' : 'shrink-0 border-t border-line px-4 py-2.5'} font-mono text-[10px] tracking-wide text-ink-faint`}>
        {versionLabel}
      </div>
    </aside>
  )
}

function AreasSection({
  numeric,
  loading,
  error,
  areas,
  onToggle,
}: {
  numeric: boolean
  loading: boolean
  error: unknown
  areas: ProjectArea[] | undefined
  onToggle: (areaType: AreaType) => void
}) {
  const t = useT()
  if (!numeric) {
    return (
      <p className="px-2.5 text-[12px] leading-relaxed text-ink-faint">{t('sidebar.areasHint')}</p>
    )
  }
  if (loading) {
    return <p className="px-2.5 text-[12px] text-ink-muted">{t('sidebar.areasLoading')}</p>
  }
  if (error) {
    const notReady = error instanceof ApiError && error.status === 404
    return (
      <p className="px-2.5 text-[12px] leading-relaxed text-ink-faint">
        {notReady ? t('sidebar.areasNotReady') : t('sidebar.areasError')}
      </p>
    )
  }
  if (!areas || areas.length === 0) {
    return <p className="px-2.5 text-[12px] leading-relaxed text-ink-faint">{t('sidebar.areasEmpty')}</p>
  }
  return (
    <ul aria-label={t('sidebar.areas')} className="flex flex-col gap-0.5">
      {areas.map((area) => {
        const label = areaLabel(area.areaType)
        return (
          <li key={area.areaType}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink">
              <input
                type="checkbox"
                checked={area.selected}
                onChange={() => onToggle(area.areaType)}
                aria-label={label}
                className="size-3.5 accent-accent"
              />
              <span className="truncate">{label}</span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}
