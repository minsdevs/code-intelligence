import { useQuery } from '@tanstack/react-query'
import { getGraphRelations, listGraphNodes } from '../../api/graph'
import type { GraphNodeSummary, GraphRelation } from '../../api/types'
import { useT } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import { isFileSymbol, queryError, toFocusedNode } from './codeLocation'

type SymbolPanelProps = {
  projectId: number
  snapshotId: number | null
  path: string | null
  onOpenLocation: (path: string, line: number | null) => void
}

export default function SymbolPanel({
  projectId,
  snapshotId,
  path,
  onOpenLocation,
}: SymbolPanelProps) {
  const t = useT()
  const focusedNode = useUiStore((state) => state.focusedNode)
  const setFocusedNode = useUiStore((state) => state.setFocusedNode)

  const nodesQuery = useQuery({
    queryKey: ['graph-nodes', projectId, snapshotId, path],
    queryFn: () => listGraphNodes(projectId, { path: path!, snapshotId }),
    enabled: snapshotId != null && path != null && path.length > 0,
  })

  const symbols = (nodesQuery.data?.items ?? []).filter(isFileSymbol)
  const selected = symbols.find((node) => node.id === focusedNode?.id) ?? null

  const callersQuery = useQuery({
    queryKey: ['graph-relations', projectId, snapshotId, selected?.id, 'in', 'CALLS'],
    queryFn: () =>
      getGraphRelations(projectId, selected!.id, {
        snapshotId,
        direction: 'in',
        edgeType: 'CALLS',
        depth: 1,
      }),
    enabled: selected != null,
  })

  const calleesQuery = useQuery({
    queryKey: ['graph-relations', projectId, snapshotId, selected?.id, 'out', 'CALLS'],
    queryFn: () =>
      getGraphRelations(projectId, selected!.id, {
        snapshotId,
        direction: 'out',
        edgeType: 'CALLS',
        depth: 1,
      }),
    enabled: selected != null,
  })

  function selectSymbol(node: GraphNodeSummary) {
    setFocusedNode(toFocusedNode(node))
    if (node.filePath) {
      onOpenLocation(node.filePath, node.lineStart)
    }
  }

  function openRelation(node: GraphNodeSummary) {
    if (!node.filePath) return
    setFocusedNode(toFocusedNode(node))
    onOpenLocation(node.filePath, node.lineStart)
  }

  return (
    <aside className="flex w-[18rem] shrink-0 flex-col border-l border-line bg-surface-1">
      <header className="border-b border-line px-3 py-3">
        <h2 className="text-[13px] font-medium text-ink">Symbols</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{t('code.symbolsHint')}</p>
      </header>

      {path == null ? (
        <p className="px-3 py-3 text-[13px] text-ink-muted">{t('code.selectSymbol')}</p>
      ) : (
        <>
          {queryError(nodesQuery.error) && (
            <p role="alert" className="px-3 py-2 text-[12px] text-danger">
              {queryError(nodesQuery.error)}
            </p>
          )}
          {nodesQuery.isLoading && (
            <p className="px-3 py-3 text-[13px] text-ink-muted">{t('code.symbolsLoading')}</p>
          )}
          {!nodesQuery.isLoading && symbols.length === 0 && !nodesQuery.error && (
            <p className="px-3 py-3 text-[13px] text-ink-muted">{t('code.noSymbols')}</p>
          )}
          <ul aria-label="File symbols" className="max-h-[40%] overflow-y-auto px-2 py-2">
            {symbols.map((node) => {
              const active = node.id === selected?.id
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => selectSymbol(node)}
                    aria-current={active ? 'true' : undefined}
                    className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${
                      active
                        ? 'bg-surface-3 text-ink'
                        : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    <span className="truncate text-[13px] text-ink">{node.name}</span>
                    <span className="font-mono text-[11px] text-ink-faint">
                      {node.nodeType}
                      {node.lineStart != null ? ` · L${node.lineStart}` : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>

          <RelationList
            title="Callers"
            relations={callersQuery.data?.relations ?? []}
            loading={Boolean(selected) && callersQuery.isLoading}
            error={queryError(callersQuery.error)}
            empty={selected != null && !callersQuery.isLoading && !callersQuery.error}
            onOpen={openRelation}
          />
          <RelationList
            title="Callees"
            relations={calleesQuery.data?.relations ?? []}
            loading={Boolean(selected) && calleesQuery.isLoading}
            error={queryError(calleesQuery.error)}
            empty={selected != null && !calleesQuery.isLoading && !calleesQuery.error}
            onOpen={openRelation}
          />
        </>
      )}
    </aside>
  )
}

function RelationList({
  title,
  relations,
  loading,
  error,
  empty,
  onOpen,
}: {
  title: 'Callers' | 'Callees'
  relations: GraphRelation[]
  loading: boolean
  error: string | null
  empty: boolean
  onOpen: (node: GraphNodeSummary) => void
}) {
  const t = useT()
  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-line">
      <h3 className="px-3 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {title}
      </h3>
      {loading && (
        <p className="px-3 py-2 text-[12px] text-ink-muted">{t('code.relationsLoading')}</p>
      )}
      {error && (
        <p role="alert" className="px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      {!loading && !error && empty && relations.length === 0 && (
        <p className="px-3 py-2 text-[12px] text-ink-muted">
          {t('code.noRelations').replace('{title}', title)}
        </p>
      )}
      <ul aria-label={title} className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {relations.map((relation) => {
          const node = relation.node
          const disabled = !node.filePath
          return (
            <li key={`${relation.direction}-${relation.depth}-${node.id}-${relation.edgeType}`}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onOpen(node)}
                className="mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-ink-muted hover:bg-surface-2 hover:text-ink disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <span className="truncate text-[13px] text-ink">{node.name}</span>
                <span className="truncate font-mono text-[11px] text-ink-faint">
                  {node.filePath ?? node.naturalKey}
                  {node.lineStart != null ? `:${node.lineStart}` : ''}
                  {relation.confidence === 'POSSIBLE' ? ' · possible' : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
