import { lazy, Suspense, useDeferredValue, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { getProject } from '../../api/projects'
import { listSnapshots } from '../../api/snapshots'
import { getFileContent, listFiles } from '../../api/files'
import { getGraphNode, getGraphOverview, listGraphNodes } from '../../api/graph'
import type { FileListItem, GraphNodeSummary } from '../../api/types'
import { useUiStore } from '../../stores/uiStore'
import { parseProjectId } from '../../lib/projectId'
import { codeLocationSearch, parseLineParam } from '../code/codeLocation'
import { CoveragePanel } from '../analysis/CoveragePanel'
import { useT } from '../../lib/i18n'

const NeighborhoodPanel = lazy(() => import('./RepositoryNeighborhood'))
const PAGE_SIZE = 40
const SYMBOL_TYPES = new Set([
  'METHOD',
  'FUNCTION',
  'CLASS',
  'INTERFACE',
  'ENUM',
  'ANNOTATION',
  'FIELD',
  'COMPONENT',
  'HOOK',
  'STORE',
  'CONTROLLER',
  'SERVICE',
  'REPOSITORY',
  'ENTITY',
  'DB_ENTITY',
])
const categories = ['files', 'entrypoints', 'symbols', 'dependencies'] as const
type Category = (typeof categories)[number]
// Labels live in translations.ts under overview.status.* and overview.reason.*.
const statuses = [
  'SUCCESS',
  'PARTIAL',
  'FAILED',
  'UNSUPPORTED',
  'UNMEASURED',
  'TARGETED',
  'LEGACY_UNMEASURED',
]
const outcomeReasons = new Set([
  'AMBIGUOUS_SYMBOL_IDENTITY',
  'ANALYZER_DISABLED',
  'ANALYZER_UNAVAILABLE',
  'ANALYZER_OUTCOME_MISSING_OR_INVALID',
  'SOURCE_LANGUAGE_UNSUPPORTED',
  'PARSER_NOT_MEASURED',
  'PROJECT_SYNTAX_REJECTED',
  'SOURCE_READ_FAILED',
])

export default function RepositoryOverviewPage() {
  const t = useT()
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const [params, setParams] = useSearchParams()
  const requestedSnapshot = parseLineParam(params.get('snapshotId'))
  const invalidSnapshot = params.has('snapshotId') && requestedSnapshot == null
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: projectId != null,
  })
  const snapshots = useQuery({
    queryKey: ['snapshots', projectId],
    queryFn: () => listSnapshots(projectId!),
    enabled: projectId != null,
  })
  const snapshotId = invalidSnapshot
    ? null
    : (requestedSnapshot ?? project.data?.currentSnapshot?.id ?? null)
  const snapshot =
    snapshots.data?.find((item) => item.id === snapshotId) ??
    (project.data?.currentSnapshot?.id === snapshotId ? project.data.currentSnapshot : null)
  if (!projectId) return <p className="p-5">{t('overview.selectProject')}</p>
  if (project.isError || invalidSnapshot)
    return (
      <p role="alert" className="p-5">
        {t('overview.unknownProject')}
      </p>
    )
  if (!project.data) return <p className="p-5">{t('overview.loadingProject')}</p>
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4 @min-[800px]:p-6" aria-label={t('overview.title')}>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t('overview.title')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('overview.intro')}</p>
        </div>
        <label className="text-xs">
          {t('overview.snapshotLabel')}{' '}
          <select
            aria-label={t('overview.snapshotSelect')}
            className="rounded border border-line bg-surface-1 p-2"
            value={requestedSnapshot ?? 'current'}
            onChange={(event) => {
              const next = new URLSearchParams()
              if (event.target.value !== 'current') next.set('snapshotId', event.target.value)
              setParams(next)
            }}
          >
            <option value="current">{t('overview.currentResult')}</option>
            {(snapshots.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                #{item.id} · {item.analyzedAt ?? item.status}
              </option>
            ))}
          </select>
        </label>
      </header>
      {snapshotId == null ? (
        <p role="status">{t('overview.noResult')}</p>
      ) : (
        <>
          <p className="mb-4 rounded border border-line bg-surface-1 p-3 text-xs [overflow-wrap:anywhere]">
            {t('overview.snapshotLine')
              .replace('{id}', String(snapshotId))
              .replace('{time}', snapshot?.analyzedAt ?? t('overview.timeUnknown'))
              .replace('{commit}', snapshot?.commitSha || t('overview.unknown'))
              .replace('{status}', snapshot?.status ?? t('overview.statusChecking'))}
            {snapshotId !== project.data.currentSnapshot?.id
              ? t('overview.previousResult')
              : t('overview.currentRegistered')}
          </p>
          <SnapshotOverview
            key={`${projectId}:${snapshotId}`}
            projectId={projectId}
            snapshotId={snapshotId}
            current={snapshotId === project.data.currentSnapshot?.id}
          />
        </>
      )}
    </div>
  )
}

function SnapshotOverview({
  projectId,
  snapshotId,
  current,
}: {
  projectId: number
  snapshotId: number
  current: boolean
}) {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const [category, setCategory] = useState<Category>('entrypoints')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search.trim())
  const [sort, setSort] = useState<'name' | 'path' | 'type'>('path')
  const [status, setStatus] = useState('')
  const [nodeType, setNodeType] = useState('')
  const [pageState, setPageState] = useState({ key: '', page: 0 })
  const filterKey = `${category}:${deferredSearch}:${sort}:${status}:${nodeType}`
  const page = pageState.key === filterKey ? pageState.page : 0
  const selectedId = parseLineParam(params.get('nodeId'))
  const files = useQuery({
    queryKey: ['files', projectId, snapshotId],
    queryFn: () => listFiles(projectId, snapshotId),
  })
  const overview = useQuery({
    queryKey: ['graph-overview', projectId, snapshotId],
    queryFn: () => getGraphOverview(projectId, snapshotId),
  })
  const nodes = useQuery({
    queryKey: [
      'investigation-nodes',
      projectId,
      snapshotId,
      category,
      deferredSearch,
      sort,
      page,
      nodeType,
    ],
    queryFn: () =>
      listGraphNodes(projectId, {
        snapshotId,
        category: category === 'files' ? undefined : category,
        q: deferredSearch,
        type: category === 'symbols' ? nodeType : undefined,
        sort,
        page: page + 1,
        size: PAGE_SIZE,
      }),
    enabled: category !== 'files',
  })
  const detail = useQuery({
    queryKey: ['graph-node', projectId, snapshotId, selectedId],
    queryFn: () => getGraphNode(projectId, selectedId!, snapshotId),
    enabled: selectedId != null,
  })
  const readmePath = files.data?.find((file) =>
    /^readme(?:\.(?:md|txt|rst))?$/i.test(file.path),
  )?.path
  const readme = useQuery({
    queryKey: ['overview-readme', projectId, snapshotId, readmePath],
    queryFn: () => getFileContent(projectId, readmePath!, snapshotId),
    enabled: !!readmePath,
  })
  const filteredFiles = useMemo(
    () =>
      (files.data ?? [])
        .filter(
          (file) =>
            (!deferredSearch ||
              file.path.toLowerCase().includes(deferredSearch.toLowerCase()) ||
              file.language?.toLowerCase().includes(deferredSearch.toLowerCase())) &&
            (!status || (file.analysisStatus ?? 'LEGACY_UNMEASURED') === status),
        )
        .sort((a, b) =>
          sort === 'type'
            ? (a.language ?? '').localeCompare(b.language ?? '') || a.path.localeCompare(b.path)
            : a.path.localeCompare(b.path),
        ),
    [files.data, deferredSearch, status, sort],
  )
  const total = category === 'files' ? filteredFiles.length : (nodes.data?.total ?? 0)
  const visibleFiles = filteredFiles.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const components = Object.entries(overview.data?.nodeCounts ?? {}).filter(
    ([type]) => SYMBOL_TYPES.has(type) && !['METHOD', 'FIELD', 'FUNCTION'].includes(type),
  )
  const languages = useMemo(
    () => [...new Set((files.data ?? []).map((file) => file.language).filter(Boolean))].sort(),
    [files.data],
  )
  const directories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const file of files.data ?? []) {
      const folder = file.path.includes('/') ? file.path.split('/')[0] + '/' : ''
      counts.set(folder, (counts.get(folder) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [files.data])
  const sourceLink = (path: string, line?: number | null, versioned = false) =>
    `/projects/${projectId}/code${codeLocationSearch(path, line, { snapshotId, versioned })}`
  function selectNode(node: GraphNodeSummary) {
    const next = new URLSearchParams(params)
    next.set('snapshotId', String(snapshotId))
    next.set('nodeId', String(node.id))
    setParams(next)
  }
  return (
    <div className="space-y-5">
      <section className="grid gap-4 @min-[800px]:grid-cols-2">
        <article className="rounded-lg border border-line bg-surface-1 p-4">
          <h3 className="font-semibold">{t('overview.whatTitle')}</h3>
          <p className="mt-2 text-xs text-ink-muted">{t('overview.readmeNote')}</p>
          {readme.data ? (
            <>
              <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap font-sans text-sm [overflow-wrap:anywhere]">
                {readme.data.content.slice(0, 1000)}
              </pre>
              <Link className="mt-2 inline-block text-xs text-accent" to={sourceLink(readmePath!)}>
                {t('overview.readmeFull')}
              </Link>
            </>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">
              {files.isError
                ? t('overview.readmeFilesError')
                : readme.isLoading
                  ? t('overview.readmeLoading')
                  : readme.isError
                    ? t('overview.readmeError')
                    : t('overview.readmeMissing')}
            </p>
          )}
        </article>
        <article className="rounded-lg border border-line bg-surface-1 p-4">
          <h3 className="font-semibold">{t('overview.structureTitle')}</h3>
          <ul aria-label={t('overview.folders')} className="mt-2 flex flex-wrap gap-2">
            {directories.map(([folder, count]) => (
              <li key={folder}>
                <button
                  className="rounded border border-line px-2 py-1 text-xs"
                  onClick={() => {
                    setCategory('files')
                    setStatus('')
                    setSearch(folder)
                  }}
                >
                  {t('overview.folderCount')
                    .replace('{folder}', folder || t('overview.root'))
                    .replace('{count}', String(count))}
                </button>
              </li>
            ))}
          </ul>

          {overview.isError ? (
            <p role="alert">{t('overview.countsError')}</p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {components.map(([type, count]) => (
                <li key={type}>
                  <button
                    className="rounded border border-line px-2 py-1 text-xs"
                    onClick={() => {
                      setCategory('symbols')
                      setNodeType(type)
                      setSearch('')
                    }}
                  >
                    {type} {count}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-ink-muted">
            {t('overview.languages').replace(
              '{languages}',
              languages.join(', ') || t('overview.unknown'),
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <Link
              className="text-accent"
              to={`/projects/${projectId}/features?snapshotId=${snapshotId}`}
            >
              {t('overview.findFeatures')}
            </Link>
            <Link
              className="text-accent"
              to={`/projects/${projectId}/flows?snapshotId=${snapshotId}`}
            >
              {t('overview.followFlows')}
            </Link>
          </div>
        </article>
      </section>
      <section
        className="rounded-lg border border-line bg-surface-1 p-4"
        aria-label={t('overview.explore')}
      >
        <h3 className="font-semibold">{t('overview.whereTitle')}</h3>
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={t('overview.kinds')}>
          {categories.map((key) => (
            <button
              key={key}
              aria-pressed={category === key}
              className={`rounded px-3 py-2 text-xs ${category === key ? 'bg-surface-3 text-ink' : 'border border-line text-ink-muted'}`}
              onClick={() => setCategory(key)}
            >
              {t(`overview.category.${key}`)}
            </button>
          ))}
        </div>
        <div className="my-3 flex flex-wrap items-center gap-3 text-xs">
          <label className="min-w-48 flex-1">
            {t('overview.search')}{' '}
            <input
              aria-label={t('overview.searchLabel')}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('overview.searchPlaceholder')}
              className="ml-2 w-3/4 rounded border border-line bg-surface-2 p-2"
            />
          </label>
          <label>
            {t('overview.sort')}{' '}
            <select
              aria-label={t('overview.sortLabel')}
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
              className="rounded border border-line bg-surface-2 p-2"
            >
              <option value="path">{t('overview.sort.path')}</option>
              <option value="name">{t('overview.sort.name')}</option>
              <option value="type">{t('overview.sort.type')}</option>
            </select>
          </label>
          {category === 'symbols' && (
            <label>
              {t('overview.kind')}{' '}
              <select
                aria-label={t('overview.symbolKind')}
                value={nodeType}
                onChange={(event) => setNodeType(event.target.value)}
                className="rounded border border-line bg-surface-2 p-2"
              >
                <option value="">{t('overview.all')}</option>
                {Object.keys(overview.data?.nodeCounts ?? {})
                  .filter((type) => SYMBOL_TYPES.has(type))
                  .map((type) => (
                    <option key={type}>{type}</option>
                  ))}
              </select>
            </label>
          )}
          {category === 'files' && (
            <label>
              {t('overview.status')}{' '}
              <select
                aria-label={t('overview.fileStatus')}
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                className="rounded border border-line bg-surface-2 p-2"
              >
                <option value="">{t('overview.all')}</option>
                {statuses.map((value) => (
                  <option key={value} value={value}>
                    {t(`overview.status.${value}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {category === 'dependencies' && (
          <p className="mb-3 text-xs text-ink-muted">{t('overview.dependenciesNote')}</p>
        )}
        {category === 'entrypoints' && (
          <p className="mb-3 text-xs text-ink-muted">{t('overview.entrypointsNote')}</p>
        )}
        {(category === 'files' ? files.isError : nodes.isError) ? (
          <p role="alert">{t('overview.resultsError')}</p>
        ) : (category === 'files' ? files.isLoading : nodes.isLoading) ? (
          <p role="status">{t('overview.resultsLoading')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" aria-label={t('overview.table')}>
                <thead>
                  <tr className="border-b border-line text-ink-muted">
                    <th className="p-2">{t('overview.col.name')}</th>
                    <th className="p-2">{t('overview.col.kind')}</th>
                    <th className="p-2">{t('overview.col.evidence')}</th>
                    <th className="p-2">{t('overview.col.explore')}</th>
                  </tr>
                </thead>
                <tbody>
                  {category === 'files'
                    ? visibleFiles.map((file) => (
                        <FileRow
                          key={file.path}
                          file={file}
                          href={sourceLink(file.path)}
                          onSymbols={() => {
                            setCategory('symbols')
                            setNodeType('')
                            setSearch(file.path)
                          }}
                        />
                      ))
                    : (nodes.data?.items ?? []).map((node) => (
                        <tr key={node.id} className="border-b border-line/50">
                          <td className="max-w-64 p-2 [overflow-wrap:anywhere]">
                            {node.name}
                            <span className="block text-ink-muted">
                              {node.filePath ?? node.naturalKey}
                            </span>
                          </td>
                          <td className="p-2">{node.nodeType}</td>
                          <td className="p-2">
                            {node.filePath ? (
                              <Link
                                className="text-accent"
                                to={sourceLink(node.filePath, node.lineStart, true)}
                              >
                                {t('overview.storedSource')}
                                {node.lineStart ? `:${node.lineStart}` : ''}
                              </Link>
                            ) : (
                              t('overview.noFileEvidence')
                            )}
                          </td>
                          <td className="p-2">
                            <button className="text-accent" onClick={() => selectNode(node)}>
                              {t('overview.relations')}
                            </button>
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
            {total === 0 && (
              <p className="py-4 text-sm text-ink-muted">{t('overview.empty')}</p>
            )}
            <div className="mt-3 flex items-center justify-between gap-3 text-xs">
              <span>
                {t('overview.pageSummary')
                  .replace('{total}', total.toLocaleString())
                  .replace('{size}', String(PAGE_SIZE))}
              </span>
              <div className="flex items-center gap-3">
                <button
                  disabled={page === 0}
                  onClick={() => setPageState({ key: filterKey, page: page - 1 })}
                >
                  {t('overview.previous')}
                </button>
                <span>
                  {page + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}
                </span>
                <button
                  disabled={(page + 1) * PAGE_SIZE >= total}
                  onClick={() => setPageState({ key: filterKey, page: page + 1 })}
                >
                  {t('overview.next')}
                </button>
              </div>
            </div>
          </>
        )}
      </section>
      {selectedId != null && (
        <section
          className="rounded-lg border border-line bg-surface-1 p-4"
          aria-label={t('overview.selectedRegion')}
        >
          {detail.isError ? (
            <p role="alert">{t('overview.selectedUnknown')}</p>
          ) : !detail.data ? (
            <p>{t('overview.itemLoading')}</p>
          ) : (
            <>
              <h3 className="font-semibold">
                {t('overview.selectedTitle').replace('{name}', detail.data.name)}
              </h3>
              <p className="mt-1 text-xs text-ink-muted [overflow-wrap:anywhere]">
                {detail.data.filePath ?? detail.data.naturalKey} ·{' '}
                {t('overview.analysisNumber').replace('{id}', String(snapshotId))}
              </p>
              {category === 'dependencies' && (
                <p className="mt-2 text-xs">
                  {t('overview.declaration')}
                  {['group', 'artifact', 'version', 'configuration']
                    .map((key) =>
                      typeof detail.data?.metadata[key] === 'string'
                        ? `${key}: ${detail.data.metadata[key]}`
                        : null,
                    )
                    .filter(Boolean)
                    .join(' · ') || t('overview.noMetadata')}
                </p>
              )}
              {current ? (
                <button
                  className="mt-3 rounded border border-line px-3 py-2 text-xs text-accent"
                  onClick={() => {
                    useUiStore.setState({
                      focusedFile: detail.data!.filePath,
                      focusedNode: {
                        id: detail.data!.id,
                        name: detail.data!.name,
                        nodeType: detail.data!.nodeType,
                        filePath: detail.data!.filePath,
                        lineStart: detail.data!.lineStart,
                      },
                      focusedFindingId: null,
                      focusedTaskId: null,
                      focusedNoteId: null,
                      focusedCommitSha: null,
                      pendingIntent: 'EXPLAIN',
                      aiPanelOpen: true,
                    })
                  }}
                >
                  {t('overview.aiExplain')}
                </button>
              ) : (
                <p className="mt-3 text-xs text-ink-muted">{t('overview.aiPastUnsupported')}</p>
              )}
              <Suspense fallback={<p className="mt-3">{t('overview.relationsLoading')}</p>}>
                <NeighborhoodPanel
                  key={`${snapshotId}:${selectedId}`}
                  projectId={projectId}
                  snapshotId={snapshotId}
                  selected={detail.data}
                  edgeTypes={Object.keys(overview.data?.edgeCounts ?? {}).sort()}
                  onSelect={selectNode}
                />
              </Suspense>
            </>
          )}
        </section>
      )}
      <details className="rounded-lg border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t('overview.coverageSummary')}
        </summary>
        <div className="mt-3">
          <CoveragePanel projectId={projectId} snapshotId={snapshotId} />
        </div>
      </details>
    </div>
  )
}

function FileRow({
  file,
  href,
  onSymbols,
}: {
  file: FileListItem
  href: string
  onSymbols: () => void
}) {
  const t = useT()
  const status = file.analysisStatus ?? 'LEGACY_UNMEASURED'
  return (
    <tr className="border-b border-line/50">
      <td className="max-w-72 p-2 [overflow-wrap:anywhere]">
        <Link className="text-accent" to={href}>
          {file.path}
        </Link>
      </td>
      <td className="p-2">{file.language ?? t('overview.unknown')}</td>
      <td className="p-2">
        {statuses.includes(status) ? t(`overview.status.${status}`) : t('overview.status.UNMEASURED')}
        {file.analysisReason && (
          <span className="block text-ink-muted">
            {outcomeReasons.has(file.analysisReason)
              ? t(`overview.reason.${file.analysisReason}`)
              : file.analysisReason}
          </span>
        )}
      </td>
      <td className="p-2">
        <button className="text-accent" onClick={onSymbols}>
          {t('overview.relatedSymbols')}
        </button>
      </td>
    </tr>
  )
}
