import { useEffect, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { ApiError } from '../../api/client'
import {
  COMMIT_PAGE_SIZE,
  getCommit,
  getCommitDiff,
  listBranches,
  listCommits,
  listEras,
  listPulls,
} from '../../api/history'
import { parseProjectId } from '../../lib/projectId'
import { useUiStore } from '../../stores/uiStore'
import type { EraView } from '../../api/types'
import CommitDetail from './CommitDetail'
import { firstLine, formatWhen, shortSha } from './format'

type HistoryPane = 'commits' | 'pulls' | 'eras'

export default function HistoryPage() {
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const [pane, setPane] = useState<HistoryPane>('commits')
  const [branch, setBranch] = useState('')
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedPull, setSelectedPull] = useState<number | null>(null)
  const [selectedEra, setSelectedEra] = useState<string | null>(null)

  const commitsQuery = useInfiniteQuery({
    queryKey: ['commits', projectId, branch],
    queryFn: ({ pageParam }) =>
      listCommits(projectId!, { page: pageParam, branch: branch || undefined }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, _pages, lastPageParam) =>
      lastPage.length < COMMIT_PAGE_SIZE ? undefined : lastPageParam + 1,
    enabled: projectId != null,
  })

  const commits = commitsQuery.data?.pages.flat() ?? []
  const resolvedSha =
    selectedSha != null && commits.some((commit) => commit.sha === selectedSha)
      ? selectedSha
      : (commits[0]?.sha ?? null)
  const setFocusedCommitSha = useUiStore((state) => state.setFocusedCommitSha)

  useEffect(() => {
    setFocusedCommitSha(resolvedSha)
    return () => setFocusedCommitSha(null)
  }, [resolvedSha, setFocusedCommitSha])

  const branchesQuery = useQuery({
    queryKey: ['branches', projectId],
    queryFn: () => listBranches(projectId!),
    enabled: projectId != null,
  })

  const pullsQuery = useQuery({
    queryKey: ['pulls', projectId],
    queryFn: () => listPulls(projectId!),
    enabled: projectId != null,
  })

  const erasQuery = useQuery({
    queryKey: ['eras', projectId],
    queryFn: () => listEras(projectId!),
    enabled: projectId != null,
  })

  const pulls = pullsQuery.data ?? []
  const resolvedPull =
    selectedPull != null && pulls.some((pull) => pull.number === selectedPull)
      ? selectedPull
      : (pulls[0]?.number ?? null)

  const eras = erasQuery.data ?? []
  const resolvedEraKey =
    selectedEra != null && eras.some((era) => eraKey(era) === selectedEra)
      ? selectedEra
      : (eras[0] ? eraKey(eras[0]) : null)
  const activeEra = eras.find((era) => eraKey(era) === resolvedEraKey)

  const detailQuery = useQuery({
    queryKey: ['commit', projectId, resolvedSha],
    queryFn: () => getCommit(projectId!, resolvedSha!),
    enabled: projectId != null && resolvedSha != null,
  })

  const diffQuery = useQuery({
    queryKey: ['commit-diff', projectId, resolvedSha, selectedPath],
    queryFn: () => getCommitDiff(projectId!, resolvedSha!, selectedPath!),
    enabled: projectId != null && resolvedSha != null && selectedPath != null,
  })

  if (projectId == null) {
    return (
      <p className="px-5 py-8 text-[13px] text-ink-muted">
        History는 import한 프로젝트에서 사용할 수 있습니다.
      </p>
    )
  }

  const activePull = pulls.find((pull) => pull.number === resolvedPull)
  const commitError = queryError(commitsQuery.error)
  const pullsError = queryError(pullsQuery.error)
  const erasError = queryError(erasQuery.error)

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex w-[22rem] shrink-0 flex-col border-r border-line bg-surface-1">
        <div className="border-b border-line px-3 py-3">
          <div role="tablist" aria-label="History" className="flex gap-1">
            <PaneTab selected={pane === 'commits'} onClick={() => setPane('commits')}>
              Commits
            </PaneTab>
            <PaneTab selected={pane === 'pulls'} onClick={() => setPane('pulls')}>
              Pull requests
            </PaneTab>
            <PaneTab selected={pane === 'eras'} onClick={() => setPane('eras')}>
              Eras
            </PaneTab>
          </div>
        </div>

        {pane === 'commits' ? (
          <>
            <label className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] text-ink-muted">
              Branch
              <select
                value={branch}
                onChange={(event) => {
                  setBranch(event.target.value)
                  setSelectedSha(null)
                  setSelectedPath(null)
                }}
                className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-[12px] text-ink"
              >
                <option value="">전체</option>
                {(branchesQuery.data ?? []).map((ref) => (
                  <option key={ref.name} value={ref.name}>
                    {ref.name}
                  </option>
                ))}
              </select>
            </label>
            {commitError && (
              <p role="alert" className="px-3 py-2 text-[12px] text-danger">
                {commitError}
              </p>
            )}
            {commitsQuery.isLoading && <p className="px-3 py-3 text-[13px] text-ink-muted">커밋을 불러오는 중…</p>}
            {!commitsQuery.isLoading && commits.length === 0 && !commitError && (
              <p className="px-3 py-3 text-[13px] text-ink-muted">커밋이 없습니다.</p>
            )}
            <ol aria-label="커밋 타임라인" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {commits.map((commit) => {
                const active = commit.sha === resolvedSha
                return (
                  <li key={commit.sha} className="relative pl-3">
                    <span
                      aria-hidden="true"
                      className={`absolute left-0 top-3 size-1.5 rounded-full ${active ? 'bg-accent' : 'bg-line-strong'}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSha(commit.sha)
                        setSelectedPath(null)
                      }}
                      aria-current={active ? 'true' : undefined}
                      className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${
                        active ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                      }`}
                    >
                      <span className="line-clamp-2 text-[13px] text-ink">{firstLine(commit.message)}</span>
                      <span className="flex flex-wrap gap-x-2 font-mono text-[11px] text-ink-faint">
                        <span>{shortSha(commit.sha)}</span>
                        <span>{commit.author}</span>
                        <span>
                          <span className="text-ok">+{commit.additions}</span>{' '}
                          <span className="text-danger">−{commit.deletions}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
            {commitsQuery.hasNextPage && (
              <div className="border-t border-line p-2">
                <button
                  type="button"
                  onClick={() => void commitsQuery.fetchNextPage()}
                  disabled={commitsQuery.isFetchingNextPage}
                  className="w-full rounded-md bg-surface-2 px-3 py-1.5 text-[12px] text-ink hover:bg-surface-3 disabled:opacity-60"
                >
                  {commitsQuery.isFetchingNextPage ? '불러오는 중…' : '이전 커밋 더 보기'}
                </button>
              </div>
            )}
          </>
        ) : pane === 'pulls' ? (
          <>
            {pullsError && (
              <p role="alert" className="px-3 py-2 text-[12px] text-danger">
                {pullsError}
              </p>
            )}
            {pullsQuery.isLoading && <p className="px-3 py-3 text-[13px] text-ink-muted">PR을 불러오는 중…</p>}
            {!pullsQuery.isLoading && (pullsQuery.data?.length ?? 0) === 0 && !pullsError && (
              <p className="px-3 py-3 text-[13px] text-ink-muted">Pull request가 없습니다.</p>
            )}
            <ul aria-label="Pull request 목록" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {(pullsQuery.data ?? []).map((pull) => {
                const active = pull.number === resolvedPull
                return (
                  <li key={pull.number}>
                    <button
                      type="button"
                      onClick={() => setSelectedPull(pull.number)}
                      aria-current={active ? 'true' : undefined}
                      className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${
                        active ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                      }`}
                    >
                      <span className="text-[13px] text-ink">{pull.title}</span>
                      <span className="flex flex-wrap gap-x-2 font-mono text-[11px] text-ink-faint">
                        <span>#{pull.number}</span>
                        <span>{pull.state}</span>
                        <span>{pull.author}</span>
                        {pull.mergedAt && <span>{formatWhen(pull.mergedAt)}</span>}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        ) : (
          <>
            {erasError && (
              <p role="alert" className="px-3 py-2 text-[12px] text-danger">
                {erasError}
              </p>
            )}
            {erasQuery.isLoading && <p className="px-3 py-3 text-[13px] text-ink-muted">Era를 불러오는 중…</p>}
            {!erasQuery.isLoading && eras.length === 0 && !erasError && (
              <p className="px-3 py-3 text-[13px] text-ink-muted">구조 변천(era)이 없습니다.</p>
            )}
            <ol aria-label="Era 타임라인" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {eras.map((era) => {
                const key = eraKey(era)
                const active = key === resolvedEraKey
                return (
                  <li key={key} className="relative pl-3">
                    <span
                      aria-hidden="true"
                      className={`absolute left-0 top-3 size-1.5 rounded-full ${active ? 'bg-accent' : 'bg-line-strong'}`}
                    />
                    <button
                      type="button"
                      onClick={() => setSelectedEra(key)}
                      aria-current={active ? 'true' : undefined}
                      className={`mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${
                        active ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                      }`}
                    >
                      <span className="text-[13px] text-ink">{era.label}</span>
                      <span className="flex flex-wrap gap-x-2 font-mono text-[11px] text-ink-faint">
                        <span>{era.path}</span>
                        <span>{shortSha(era.sha)}</span>
                        <span>{formatWhen(era.committedAt)}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </>
        )}
      </section>

      {pane === 'commits' ? (
        detailQuery.data ? (
          <CommitDetail
            detail={detailQuery.data}
            selectedPath={selectedPath}
            onSelectPath={setSelectedPath}
            diff={diffQuery.data}
            diffLoading={diffQuery.isLoading}
            diffError={queryError(diffQuery.error)}
          />
        ) : (
          <p className="px-5 py-8 text-[13px] text-ink-muted">
            {detailQuery.isLoading ? '커밋 상세를 불러오는 중…' : '왼쪽에서 커밋을 선택하세요.'}
          </p>
        )
      ) : pane === 'pulls' ? (
        activePull ? (
          <article className="min-h-0 flex-1 overflow-y-auto px-5 py-4" aria-label="Pull request 상세">
            <h2 className="text-[15px] font-semibold text-ink">{activePull.title}</h2>
            <p className="mt-2 flex flex-wrap gap-x-3 font-mono text-[12px] text-ink-faint">
              <span>#{activePull.number}</span>
              <span>{activePull.state}</span>
              <span>{activePull.author}</span>
              {activePull.mergedAt && <span>merged {formatWhen(activePull.mergedAt)}</span>}
            </p>
            <pre className="mt-4 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink-muted">
              {activePull.body?.trim() ? activePull.body : '본문이 없습니다.'}
            </pre>
          </article>
        ) : (
          <p className="px-5 py-8 text-[13px] text-ink-muted">왼쪽에서 Pull request를 선택하세요.</p>
        )
      ) : activeEra ? (
        <article className="min-h-0 flex-1 overflow-y-auto px-5 py-4" aria-label="Era 상세">
          <h2 className="text-[15px] font-semibold text-ink">{activeEra.label}</h2>
          <p className="mt-2 flex flex-wrap gap-x-3 font-mono text-[12px] text-ink-faint">
            <span>{activeEra.path}</span>
            <span>{shortSha(activeEra.sha)}</span>
            <span>{activeEra.changeType}</span>
            <span>{formatWhen(activeEra.committedAt)}</span>
          </p>
        </article>
      ) : (
        <p className="px-5 py-8 text-[13px] text-ink-muted">왼쪽에서 era를 선택하세요.</p>
      )}
    </div>
  )
}

function PaneTab({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-[12px] ${
        selected ? 'bg-surface-3 font-medium text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

function eraKey(era: EraView): string {
  return `${era.sha}:${era.path}`
}

function queryError(error: unknown): string | null {
  if (!error) return null
  if (error instanceof ApiError) return error.message
  return '요청에 실패했습니다.'
}
