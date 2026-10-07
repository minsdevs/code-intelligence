import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, UnauthorizedError } from '../../api/client'
import {
  listBranches,
  listRepos,
  listInstallations,
  listInstallationRepos,
  type GithubInstallationList,
} from '../../api/github'
import { createProject, listProjects } from '../../api/projects'
import type { CredentialKind, GithubBranch, GithubRepo, GithubRepoList } from '../../api/types'
import { useT } from '../../lib/i18n'

type RepoStepProps = {
  onImported: (projectId: number, jobId: number) => void
  onUnauthorized: () => void
  credentialKind?: CredentialKind | null
}

export default function RepoStep(props: RepoStepProps) {
  return window.codeIntelligenceDesktop && props.credentialKind === 'OAUTH' ? (
    <InstallationRepoStep {...props} />
  ) : (
    <RepoListStep {...props} />
  )
}

function installationError(t: (key: string) => string, error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return t('installations.rateLimited')
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    return t('installations.forbidden')
  }
  return error instanceof ApiError ? error.message : t('installations.failed')
}

function InstallationRepoStep(props: RepoStepProps) {
  const t = useT()
  const [page, setPage] = useState(1)
  const [epoch, setEpoch] = useState(0)
  const [result, setResult] = useState<GithubInstallationList | null>(null)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // The failure is kept as-is and worded at render time, so the language can change.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null)
  const error = failure && installationError(t, failure.error)
  const key = `${page}:${epoch}`
  const loading = key !== loaded
  const { onUnauthorized } = props
  useEffect(() => {
    let cancelled = false
    void listInstallations(page)
      .then((data) => {
        if (cancelled) return
        setResult(data)
        setSelectedId((current) =>
          data.items.some((item) => item.id === current && !item.suspended) ? current : null,
        )
        setFailure(null)
        setLoaded(key)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof UnauthorizedError) {
          onUnauthorized()
          return
        }
        setFailure({ error })
        setLoaded(key)
      })
    return () => {
      cancelled = true
    }
  }, [page, key, onUnauthorized])
  const changePage = (next: number) => {
    setSelectedId(null)
    setPage(next)
  }
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h2 className="text-[15px] font-semibold text-ink">{t('installations.title')}</h2>
      <p className="text-[13px] text-ink-muted">{t('installations.description')}</p>
      {loading && <p role="status">{t('installations.loading')}</p>}
      {error && (
        <div role="alert">
          {error}{' '}
          <button type="button" onClick={() => setEpoch((value) => value + 1)}>
            {t('installations.retry')}
          </button>
        </div>
      )}
      {!loading && !error && result && (
        <>
          {result.items.length === 0 ? (
            <p>{t('installations.empty')}</p>
          ) : (
            <label className="flex flex-col gap-1.5">
              {t('installations.label')}
              <select
                value={selectedId ?? ''}
                onChange={(event) =>
                  setSelectedId(event.target.value ? Number(event.target.value) : null)
                }
                className="rounded-md border border-line bg-surface-2 px-3 py-1.5 text-ink"
              >
                <option value="">{t('installations.choose')}</option>
                {result.items.map((item) => (
                  <option key={item.id} value={item.id} disabled={item.suspended}>
                    {item.accountLogin ??
                      t('installations.fallbackName').replace('{id}', String(item.id))}{' '}
                    · {item.appSlug ?? 'GitHub App'}
                    {item.suspended ? t('installations.suspended') : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex gap-3">
            <button type="button" disabled={page <= 1} onClick={() => changePage(page - 1)}>
              {t('installations.previous')}
            </button>
            <span>{t('installations.page').replace('{page}', String(page))}</span>
            <button type="button" disabled={!result.hasNext} onClick={() => changePage(page + 1)}>
              {t('installations.next')}
            </button>
          </div>
        </>
      )}
      {selectedId !== null && !error && !loading && (
        <RepoListStep key={selectedId} {...props} installationId={selectedId} />
      )}
    </div>
  )
}

function RepoListStep({
  onImported,
  onUnauthorized,
  installationId,
}: RepoStepProps & { installationId?: number }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [reloadEpoch, setReloadEpoch] = useState(0)
  const [list, setList] = useState<GithubRepoList | null>(null)
  const [selected, setSelected] = useState<GithubRepo | null>(null)
  const [branches, setBranches] = useState<GithubBranch[]>([])
  const [branch, setBranch] = useState('')
  const [branchLoading, setBranchLoading] = useState(false)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [existingProject, setExistingProject] = useState<{ id: number; fullName: string } | null>(null)
  const importingRef = useRef(false)
  const selectionVersion = useRef(0)

  useEffect(() => () => { selectionVersion.current += 1 }, [])

  const requestKey = `${page}:${debouncedQuery}:${reloadEpoch}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    let cancelled = false
    void (
      installationId === undefined
        ? listRepos({ page, q: debouncedQuery || undefined })
        : listInstallationRepos(installationId, { page, q: debouncedQuery || undefined })
    )
      .then((data) => {
        if (cancelled) return
        setList(data)
        setError(null)
        setLoadedKey(requestKey)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof UnauthorizedError) {
          onUnauthorized()
          return
        }
        setError(
          installationId === undefined
            ? err instanceof ApiError
              ? err.message
              : t('repo.listError')
            : installationError(t, err),
        )
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [page, debouncedQuery, requestKey, onUnauthorized, t, installationId])

  const handleSelectRepo = (repo: GithubRepo) => {
    if (importingRef.current) return
    selectionVersion.current += 1
    setExistingProject(null)
    setSelected(repo)
    setBranches([])
    setBranch(repo.defaultBranch)
    setBranchLoading(true)
    setError(null)
  }

  useEffect(() => {
    let cancelled = false
    if (!selected) return
    void listBranches(selected.owner, selected.name)
      .then((data) => {
        if (cancelled) return
        setBranches(data.items)
        if (!data.items.some((item) => item.name === selected.defaultBranch) && data.items[0]) {
          setBranch(data.items[0].name)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof UnauthorizedError) {
          onUnauthorized()
          return
        }
        setBranches([])
        setError(err instanceof ApiError ? err.message : 'Could not load repository branches.')
      })
      .finally(() => {
        if (!cancelled) setBranchLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected, onUnauthorized])

  const handleImport = async () => {
    if (!selected || !branch || importingRef.current || existingProject) return
    importingRef.current = true
    const version = selectionVersion.current
    setImporting(true)
    setError(null)
    try {
      const created = await createProject(selected.owner, selected.name, branch)
      if (selectionVersion.current !== version) return
      onImported(created.project.id, created.jobId)
    } catch (err) {
      if (selectionVersion.current !== version) return
      if (err instanceof UnauthorizedError) {
        onUnauthorized()
        return
      }
      setError(err instanceof ApiError ? err.message : t('repo.importError'))
      if (err instanceof ApiError && err.status === 409) {
        try {
          const projects = await listProjects()
          if (selectionVersion.current !== version) return
          const existing = projects.find((project) => project.sourceType === 'GITHUB'
            && project.repoOwner.toLowerCase() === selected.owner.toLowerCase()
            && project.repoName.toLowerCase() === selected.name.toLowerCase())
          if (existing) {
            setExistingProject({ id: existing.id, fullName: selected.fullName })
            setError(t('analysis.duplicate'))
          }
        } catch (lookupError) {
          if (selectionVersion.current === version && lookupError instanceof UnauthorizedError) onUnauthorized()
          // Retain the conflict; a failed lookup must never trigger another import or project deletion.
        }
      }
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{t('repo.title')}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{t('repo.description')}</p>
        <p className="mt-1 text-[12px] text-ink-muted">{t('repo.searchScope')}</p>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] text-ink-muted">{t('repo.search')}</span>
        <input
          type="search"
          disabled={importing}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(1)
          }}
          placeholder={t('repo.placeholder')}
          className="rounded-md border border-line bg-surface-2 px-3 py-1.5 font-mono text-[13px] text-ink placeholder:text-ink-faint"
        />
      </label>

      {error && !(existingProject && existingProject.fullName === selected?.fullName) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger"
        >
          <span>{error}</span>
          <button
            type="button"
            disabled={importing}
            onClick={() => setReloadEpoch((value) => value + 1)}
            className="underline"
          >
            Retry
          </button>
        </div>
      )}

      {existingProject && existingProject.fullName === selected?.fullName && (
        <div role="status" className="rounded-md border border-line px-3 py-2 text-[12px] text-ink-muted">
          <p>{t('analysis.duplicate')}</p>
          <Link to={`/projects/${existingProject.id}`} className="mt-1 block underline">
            {t('analysis.openExisting')}
          </Link>
        </div>
      )}

      <div className="max-h-[36vh] overflow-y-auto rounded-md border border-line">
        {loading && <p className="px-3 py-4 text-[13px] text-ink-muted">{t('repo.loading')}</p>}
        {!loading && list && list.items.length === 0 && (
          <p className="px-3 py-4 text-[13px] text-ink-muted">{t('repo.empty')}</p>
        )}
        {!loading && list && list.items.length > 0 && (
          <ul role="listbox" aria-label={t('repo.listLabel')} className="divide-y divide-line">
            {list.items.map((repo) => {
              const isSelected = selected?.fullName === repo.fullName
              return (
                <li key={repo.fullName}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={importing}
                    onClick={() => handleSelectRepo(repo)}
                    className={`flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left transition-colors ${
                      isSelected ? 'bg-surface-3' : 'hover:bg-surface-2'
                    }`}
                  >
                    <span className="flex items-center gap-2 font-mono text-[13px] text-ink">
                      {repo.fullName}
                      {repo.private && (
                        <span className="rounded border border-line-strong px-1.5 py-px font-sans text-[10px] uppercase tracking-wide text-ink-faint">
                          {t('repo.private')}
                        </span>
                      )}
                    </span>
                    {repo.description && (
                      <span className="line-clamp-1 text-[12px] text-ink-muted">
                        {repo.description}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {selected && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-muted">Branch</span>
          <select
            value={branch}
            disabled={importing || branchLoading || branches.length === 0}
            onChange={(event) => setBranch(event.target.value)}
            className="rounded-md border border-line bg-surface-2 px-3 py-1.5 font-mono text-[13px] text-ink disabled:opacity-60"
          >
            {branchLoading && <option>Loading branches…</option>}
            {!branchLoading && branches.length === 0 && (
              <option value="">No accessible branches</option>
            )}
            {branches.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
                {item.protected ? ' · protected' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1 || loading || importing}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-muted disabled:opacity-40"
          >
            {t('repo.prev')}
          </button>
          <button
            type="button"
            disabled={!list?.hasNext || loading || importing}
            onClick={() => setPage((current) => current + 1)}
            className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-muted disabled:opacity-40"
          >
            {t('repo.next')}
          </button>
        </div>
        <button
          type="button"
          disabled={
            !selected ||
            !branch ||
            !branches.some((item) => item.name === branch) ||
            branchLoading ||
            importing ||
            existingProject !== null
          }
          onClick={() => void handleImport()}
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 disabled:opacity-60"
        >
          {importing ? t('repo.importing') : t('repo.import')}
        </button>
      </div>
    </div>
  )
}
