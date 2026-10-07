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
const categories = [
  ['files', '파일 · 분석 상태'],
  ['entrypoints', '요청 · 화면 진입점'],
  ['symbols', '심볼 · 함수 · 클래스'],
  ['dependencies', '선언된 외부 패키지'],
] as const
type Category = (typeof categories)[number][0]
const statuses: Record<string, string> = {
  SUCCESS: '구문 분석 성공',
  PARTIAL: '부분 성공',
  FAILED: '분석 실패',
  UNSUPPORTED: '미지원',
  UNMEASURED: '미측정',
  TARGETED: '분석 대상 · 결과 대기',
  LEGACY_UNMEASURED: '과거 미측정',
}

const outcomeReasons: Record<string, string> = {
  AMBIGUOUS_SYMBOL_IDENTITY: '다른 파일의 동명 선언을 구분할 수 없어 관련 연결을 생략했습니다.',
  ANALYZER_DISABLED: '이 분석에는 해당 분석기가 연결되지 않았습니다.',
  ANALYZER_UNAVAILABLE: '분석기에 연결하지 못했습니다.',
  ANALYZER_OUTCOME_MISSING_OR_INVALID:
    '분석기가 파일별 결과를 제공하지 않았거나 응답이 모호합니다.',
  SOURCE_LANGUAGE_UNSUPPORTED: '이 언어의 소스 분석은 지원하지 않습니다.',
  PARSER_NOT_MEASURED: '이 파일의 파서 결과는 측정되지 않았습니다.',
  PROJECT_SYNTAX_REJECTED: '입력 프로젝트의 구문 오류로 분석 요청이 거부됐습니다.',
  SOURCE_READ_FAILED: '보관된 분석 입력을 읽지 못했습니다.',
}

export default function RepositoryOverviewPage() {
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
  if (!projectId) return <p className="p-5">프로젝트를 선택하세요.</p>
  if (project.isError || invalidSnapshot)
    return (
      <p role="alert" className="p-5">
        프로젝트 또는 분석 시점을 확인할 수 없습니다.
      </p>
    )
  if (!project.data) return <p className="p-5">프로젝트를 불러오는 중…</p>
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4 @min-[800px]:p-6" aria-label="레포 개요">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">레포 개요</h2>
          <p className="mt-1 text-sm text-ink-muted">
            구성과 진입점을 찾고, 변경 전에 함께 확인할 코드를 살펴보세요.
          </p>
        </div>
        <label className="text-xs">
          분석 시점{' '}
          <select
            aria-label="개요 분석 시점"
            className="rounded border border-line bg-surface-1 p-2"
            value={requestedSnapshot ?? 'current'}
            onChange={(event) => {
              const next = new URLSearchParams()
              if (event.target.value !== 'current') next.set('snapshotId', event.target.value)
              setParams(next)
            }}
          >
            <option value="current">현재 결과</option>
            {(snapshots.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                #{item.id} · {item.analyzedAt ?? item.status}
              </option>
            ))}
          </select>
        </label>
      </header>
      {snapshotId == null ? (
        <p role="status">
          완료된 분석 결과가 없습니다. 가져오기 또는 분석을 완료하면 이곳에서 탐색할 수 있습니다.
        </p>
      ) : (
        <>
          <p className="mb-4 rounded border border-line bg-surface-1 p-3 text-xs [overflow-wrap:anywhere]">
            분석 #{snapshotId} · {snapshot?.analyzedAt ?? '시점 미확인'} · 소스 상태{' '}
            {snapshot?.commitSha || '미확인'} · {snapshot?.status ?? '상태 확인 중'}
            {snapshotId !== project.data.currentSnapshot?.id
              ? ' · 이전 결과'
              : ' · 현재 등록된 결과 (원본의 최신 상태와 다를 수 있음)'}
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
          <h3 className="font-semibold">이 프로젝트는 무엇을 하나요?</h3>
          <p className="mt-2 text-xs text-ink-muted">
            README의 선언 · 실행 명령도 문서에 적힌 정보이며, 이 앱에서 실행하거나 성공을 확인한
            것은 아닙니다.
          </p>
          {readme.data ? (
            <>
              <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap font-sans text-sm [overflow-wrap:anywhere]">
                {readme.data.content.slice(0, 1000)}
              </pre>
              <Link className="mt-2 inline-block text-xs text-accent" to={sourceLink(readmePath!)}>
                해당 시점 README 전체 보기
              </Link>
            </>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">
              {files.isError
                ? '파일 목록을 불러올 수 없어 README를 확인하지 못했습니다.'
                : readme.isLoading
                  ? 'README를 불러오는 중…'
                  : readme.isError
                    ? '보관된 README를 열 수 없습니다.'
                    : '루트 README가 없습니다. 아래 진입점과 기능의 코드 근거로 확인하세요.'}
            </p>
          )}
        </article>
        <article className="rounded-lg border border-line bg-surface-1 p-4">
          <h3 className="font-semibold">코드에서 확인한 구성</h3>
          <ul aria-label="주요 폴더" className="mt-2 flex flex-wrap gap-2">
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
                  {folder || '루트'} · 목록 {count}개
                </button>
              </li>
            ))}
          </ul>

          {overview.isError ? (
            <p role="alert">구성 집계를 불러올 수 없습니다.</p>
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
            파일 목록의 언어: {languages.join(', ') || '미확인'}. 언어 감지는 심볼·호출·프레임워크
            지원 보장이 아닙니다.
          </p>
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <Link
              className="text-accent"
              to={`/projects/${projectId}/features?snapshotId=${snapshotId}`}
            >
              주요 기능 찾기 →
            </Link>
            <Link
              className="text-accent"
              to={`/projects/${projectId}/flows?snapshotId=${snapshotId}`}
            >
              기록된 정적 흐름 따라가기 →
            </Link>
          </div>
        </article>
      </section>
      <section
        className="rounded-lg border border-line bg-surface-1 p-4"
        aria-label="분석 결과 탐색"
      >
        <h3 className="font-semibold">어디에 구현되어 있나요?</h3>
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="분석 결과 종류">
          {categories.map(([key, label]) => (
            <button
              key={key}
              aria-pressed={category === key}
              className={`rounded px-3 py-2 text-xs ${category === key ? 'bg-surface-3 text-ink' : 'border border-line text-ink-muted'}`}
              onClick={() => setCategory(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="my-3 flex flex-wrap items-center gap-3 text-xs">
          <label className="min-w-48 flex-1">
            검색{' '}
            <input
              aria-label="분석 결과 검색"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="이름 또는 파일 경로"
              className="ml-2 w-3/4 rounded border border-line bg-surface-2 p-2"
            />
          </label>
          <label>
            정렬{' '}
            <select
              aria-label="분석 결과 정렬"
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
              className="rounded border border-line bg-surface-2 p-2"
            >
              <option value="path">파일 경로</option>
              <option value="name">이름</option>
              <option value="type">종류</option>
            </select>
          </label>
          {category === 'symbols' && (
            <label>
              종류{' '}
              <select
                aria-label="심볼 종류"
                value={nodeType}
                onChange={(event) => setNodeType(event.target.value)}
                className="rounded border border-line bg-surface-2 p-2"
              >
                <option value="">전체</option>
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
              상태{' '}
              <select
                aria-label="파일 분석 상태"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                className="rounded border border-line bg-surface-2 p-2"
              >
                <option value="">전체</option>
                {Object.entries(statuses).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {category === 'dependencies' && (
          <p className="mb-3 text-xs text-ink-muted">
            manifest에 선언된 외부 패키지입니다. 실제 실행 중 사용 여부나 설치 성공은 확인하지
            않았습니다. PACKAGE 심볼은 내부 namespace이므로 여기에 포함하지 않습니다.
          </p>
        )}
        {category === 'entrypoints' && (
          <p className="mb-3 text-xs text-ink-muted">
            분석기가 기록한 요청·화면 진입점입니다. 실행 명령이나 런타임 도달 가능성을 확인한 목록은
            아닙니다.
          </p>
        )}
        {(category === 'files' ? files.isError : nodes.isError) ? (
          <p role="alert">결과를 불러올 수 없습니다. 빈 결과로 해석하지 마세요.</p>
        ) : (category === 'files' ? files.isLoading : nodes.isLoading) ? (
          <p role="status">결과를 불러오는 중…</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" aria-label="분석 결과 표">
                <thead>
                  <tr className="border-b border-line text-ink-muted">
                    <th className="p-2">이름 / 파일</th>
                    <th className="p-2">종류</th>
                    <th className="p-2">근거 / 분석 상태</th>
                    <th className="p-2">탐색</th>
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
                                보관된 소스{node.lineStart ? `:${node.lineStart}` : ''}
                              </Link>
                            ) : (
                              '파일 근거 미확인'
                            )}
                          </td>
                          <td className="p-2">
                            <button className="text-accent" onClick={() => selectNode(node)}>
                              관계 · 함께 확인할 곳
                            </button>
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
            {total === 0 && (
              <p className="py-4 text-sm text-ink-muted">
                기록된 결과가 없습니다. 미지원·미해결 구간이 있을 수 있으며 기능이나 영향이 없다는
                뜻은 아닙니다.
              </p>
            )}
            <div className="mt-3 flex items-center justify-between gap-3 text-xs">
              <span>
                {total.toLocaleString()}개 · {PAGE_SIZE}개씩 표시
              </span>
              <div className="flex items-center gap-3">
                <button
                  disabled={page === 0}
                  onClick={() => setPageState({ key: filterKey, page: page - 1 })}
                >
                  이전
                </button>
                <span>
                  {page + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}
                </span>
                <button
                  disabled={(page + 1) * PAGE_SIZE >= total}
                  onClick={() => setPageState({ key: filterKey, page: page + 1 })}
                >
                  다음
                </button>
              </div>
            </div>
          </>
        )}
      </section>
      {selectedId != null && (
        <section
          className="rounded-lg border border-line bg-surface-1 p-4"
          aria-label="선택한 코드 주변 관계"
        >
          {detail.isError ? (
            <p role="alert">선택한 항목이 이 분석 시점에 속하는지 확인할 수 없습니다.</p>
          ) : !detail.data ? (
            <p>항목을 불러오는 중…</p>
          ) : (
            <>
              <h3 className="font-semibold">{detail.data.name} · 변경 전에 함께 확인할 곳</h3>
              <p className="mt-1 text-xs text-ink-muted [overflow-wrap:anywhere]">
                {detail.data.filePath ?? detail.data.naturalKey} · 분석 #{snapshotId}
              </p>
              {category === 'dependencies' && (
                <p className="mt-2 text-xs">
                  선언 정보:{' '}
                  {['group', 'artifact', 'version', 'configuration']
                    .map((key) =>
                      typeof detail.data?.metadata[key] === 'string'
                        ? `${key}: ${detail.data.metadata[key]}`
                        : null,
                    )
                    .filter(Boolean)
                    .join(' · ') || '추가 metadata 없음'}
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
                  AI 설명 준비 · 전송 전 확인
                </button>
              ) : (
                <p className="mt-3 text-xs text-ink-muted">
                  이전 분석의 AI 설명은 아직 지원하지 않습니다. 이 시점의 표·관계·소스는 AI 없이
                  탐색할 수 있습니다.
                </p>
              )}
              <Suspense fallback={<p className="mt-3">관계를 불러오는 중…</p>}>
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
        <summary className="cursor-pointer text-sm font-medium">분석 범위와 미확인 사항</summary>
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
  return (
    <tr className="border-b border-line/50">
      <td className="max-w-72 p-2 [overflow-wrap:anywhere]">
        <Link className="text-accent" to={href}>
          {file.path}
        </Link>
      </td>
      <td className="p-2">{file.language ?? '미확인'}</td>
      <td className="p-2">
        {statuses[file.analysisStatus ?? 'LEGACY_UNMEASURED'] ?? '미측정'}
        {file.analysisReason && (
          <span className="block text-ink-muted">
            {outcomeReasons[file.analysisReason] ?? file.analysisReason}
          </span>
        )}
      </td>
      <td className="p-2">
        <button className="text-accent" onClick={onSymbols}>
          관련 심볼
        </button>
      </td>
    </tr>
  )
}
