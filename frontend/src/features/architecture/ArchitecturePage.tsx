import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { getArchitecture } from '../../api/architecture'
import { listAreas } from '../../api/areas'
import type { ArchitectureView, AreaType } from '../../api/types'
import EmptyState from '../../components/EmptyState'
import { parseProjectId } from '../../lib/projectId'
import { codeLocationSearch, queryError } from '../code/codeLocation'
import ArchitectureCanvas from './ArchitectureCanvas'

type ArchArea = 'BACKEND' | 'FRONTEND' | 'SYSTEM'

function selectedTypes(areas: { areaType: AreaType; selected: boolean }[] | undefined): Set<AreaType> {
  return new Set((areas ?? []).filter((area) => area.selected).map((area) => area.areaType))
}

export default function ArchitecturePage() {
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const navigate = useNavigate()
  const [areaOverride, setAreaOverride] = useState<ArchArea | null>(null)

  const areasQuery = useQuery({
    queryKey: ['areas', projectId],
    queryFn: () => listAreas(projectId!),
    enabled: projectId != null,
  })
  const selected = selectedTypes(areasQuery.data)
  const showBackend = selected.has('BACKEND')
  const showFrontend = selected.has('FRONTEND')
  const showSystem = selected.has('INFRASTRUCTURE') || selected.has('DEVOPS')
  const visibleArea: ArchArea | null = useMemo(() => {
    const requested = areaOverride ?? 'BACKEND'
    if (requested === 'BACKEND' && showBackend) return 'BACKEND'
    if (requested === 'FRONTEND' && showFrontend) return 'FRONTEND'
    if (requested === 'SYSTEM' && showSystem) return 'SYSTEM'
    if (showBackend) return 'BACKEND'
    if (showFrontend) return 'FRONTEND'
    if (showSystem) return 'SYSTEM'
    return null
  }, [areaOverride, showBackend, showFrontend, showSystem])

  const graphQuery = useQuery({
    queryKey: ['architecture', projectId, visibleArea],
    queryFn: () => getArchitecture(projectId!, visibleArea!),
    enabled: projectId != null && visibleArea != null,
  })

  if (projectId == null) {
    return (
      <p className="px-5 py-8 text-[13px] text-ink-muted">
        Architecture는 import한 프로젝트에서 사용할 수 있습니다.
      </p>
    )
  }

  function openNode(path: string, line: number | null) {
    navigate(`/projects/${projectId}/code${codeLocationSearch(path, line)}`)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-4 py-2" role="tablist" aria-label="아키텍처 영역">
        {showBackend && (
          <AreaTab
            label="Backend"
            selected={visibleArea === 'BACKEND'}
            onSelect={() => setAreaOverride('BACKEND')}
          />
        )}
        {showFrontend && (
          <AreaTab
            label="Frontend"
            selected={visibleArea === 'FRONTEND'}
            onSelect={() => setAreaOverride('FRONTEND')}
          />
        )}
        {showSystem && (
          <AreaTab
            label="System"
            selected={visibleArea === 'SYSTEM'}
            onSelect={() => setAreaOverride('SYSTEM')}
          />
        )}
      </div>
      <ArchitectureBody
        loading={areasQuery.isLoading || graphQuery.isLoading}
        error={queryError(areasQuery.error) ?? queryError(graphQuery.error)}
        visibleArea={visibleArea}
        view={graphQuery.data}
        onOpenNode={openNode}
      />
    </div>
  )
}

function AreaTab({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`rounded px-2.5 py-1 text-[12px] ${
        selected ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:text-ink'
      }`}
    >
      {label}
    </button>
  )
}

function ArchitectureBody({
  loading,
  error,
  visibleArea,
  view,
  onOpenNode,
}: {
  loading: boolean
  error: string | null
  visibleArea: ArchArea | null
  view: ArchitectureView | undefined
  onOpenNode: (path: string, line: number | null) => void
}) {
  if (loading) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">아키텍처를 불러오는 중…</p>
  }
  if (error) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{error}</p>
  }
  if (visibleArea == null) {
    return (
      <EmptyState
        title="표시할 영역이 없습니다"
        description="사이드바 Areas에서 Frontend, Backend 또는 Infrastructure/DevOps를 선택하면 이 탭에 그래프가 나타납니다."
      />
    )
  }
  if (!view || view.groups.length === 0) {
    return (
      <EmptyState
        title="아키텍처 그래프가 없습니다"
        description="분석이 끝나기 전이거나, 이 영역에 표시할 노드가 없습니다."
      />
    )
  }
  return <ArchitectureCanvas view={view} onOpenNode={onOpenNode} />
}
