import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { getArchitecture } from '../../api/architecture'
import { listAreas } from '../../api/areas'
import type { ArchitectureView, AreaType } from '../../api/types'
import EmptyState from '../../components/EmptyState'
import { tt } from '../../lib/i18n-core'
import { useT } from '../../lib/i18n'
import { parseProjectId } from '../../lib/projectId'
import { codeLocationSearch, queryError } from '../code/codeLocation'
import ArchitectureCanvas from './ArchitectureCanvas'

type ArchArea = 'BACKEND' | 'FRONTEND' | 'SYSTEM'

function selectedTypes(areas: { areaType: AreaType; selected: boolean }[] | undefined): Set<AreaType> {
  return new Set((areas ?? []).filter((area) => area.selected).map((area) => area.areaType))
}

export default function ArchitecturePage() {
  const t = useT()
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
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{t('arch.noProject')}</p>
  }

  function openNode(path: string, line: number | null) {
    navigate(`/projects/${projectId}/code${codeLocationSearch(path, line)}`)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-4 py-2" role="tablist" aria-label={t('arch.tablist')}>
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
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{tt('arch.loading')}</p>
  }
  if (error) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{error}</p>
  }
  if (visibleArea == null) {
    return (
      <EmptyState title={tt('arch.noAreaTitle')} description={tt('arch.noAreaDesc')} />
    )
  }
  if (!view || view.groups.length === 0) {
    return (
      <EmptyState title={tt('arch.noGraphTitle')} description={tt('arch.noGraphDesc')} />
    )
  }
  return <ArchitectureCanvas view={view} onOpenNode={onOpenNode} />
}
