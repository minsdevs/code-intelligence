import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, useMatch } from 'react-router-dom'
import { ApiError } from '../api/client'
import { listAreas, updateAreaSelections } from '../api/areas'
import type { AreaSelectionsRequest, AreaType, ProjectArea } from '../api/types'
import { FolderIcon, HomeIcon, SearchIcon, SlidersIcon } from '../components/icons'
import { areaLabel } from '../features/areas/labels'
import { parseProjectId } from '../lib/projectId'
import { useUiStore } from '../stores/uiStore'

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
  const rawProjectId = projectMatch?.params.projectId
  const projectId = parseProjectId(rawProjectId)
  const setSelectedAreas = useUiStore((state) => state.setSelectedAreas)
  const queryClient = useQueryClient()

  const areasQuery = useQuery({
    queryKey: ['areas', projectId],
    queryFn: () => listAreas(projectId!),
    enabled: projectId != null,
  })

  const areas = areasQuery.data

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
        {rawProjectId ? (
          <div className="flex flex-col">
            <div className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink">
              <FolderIcon className="shrink-0 text-accent" />
              <span className="truncate">{rawProjectId}</span>
            </div>
            <SectionLabel>Areas</SectionLabel>
            <AreasSection
              numeric={projectId != null}
              loading={areasQuery.isLoading}
              error={areasQuery.error}
              areas={areas}
              onToggle={toggleArea}
            />
          </div>
        ) : (
          <p className="px-2.5 text-[12px] leading-relaxed text-ink-faint">
            연결된 프로젝트가 없습니다. Import Wizard에서 GitHub 저장소를 가져올 수 있습니다.
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-4 py-2.5 font-mono text-[10px] tracking-wide text-ink-faint">
        v0.0.0 · Phase 1
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
  if (!numeric) {
    return (
      <p className="px-2.5 text-[12px] leading-relaxed text-ink-faint">
        Analysis Areas는 저장소를 import한 뒤 이곳에 표시됩니다.
      </p>
    )
  }
  if (loading) {
    return <p className="px-2.5 text-[12px] text-ink-muted">영역을 불러오는 중…</p>
  }
  if (error) {
    const notReady = error instanceof ApiError && error.status === 404
    return (
      <p className="px-2.5 text-[12px] leading-relaxed text-ink-faint">
        {notReady ? '분석이 끝나면 영역이 여기에 표시됩니다.' : '영역을 불러오지 못했습니다.'}
      </p>
    )
  }
  if (!areas || areas.length === 0) {
    return <p className="px-2.5 text-[12px] leading-relaxed text-ink-faint">감지된 영역이 없습니다.</p>
  }
  return (
    <ul aria-label="Areas" className="flex flex-col gap-0.5">
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
