import { useEffect, useState } from 'react'
import { ApiError, UnauthorizedError } from '../../api/client'
import { listBranches, listRepos } from '../../api/github'
import { createProject } from '../../api/projects'
import type { GithubBranch, GithubRepo, GithubRepoList } from '../../api/types'
import { useT } from '../../lib/i18n'

type RepoStepProps = {
  onImported: (projectId: number, jobId: number) => void
  onUnauthorized: () => void
}

export default function RepoStep({ onImported, onUnauthorized }: RepoStepProps) {
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

  const requestKey = `${page}:${debouncedQuery}:${reloadEpoch}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    let cancelled = false
    void listRepos({ page, q: debouncedQuery || undefined })
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
        setError(err instanceof ApiError ? err.message : t('repo.listError'))
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [page, debouncedQuery, requestKey, onUnauthorized, t])

  const handleSelectRepo = (repo: GithubRepo) => {
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
    if (!selected || !branch) return
    setImporting(true)
    setError(null)
    try {
      const created = await createProject(selected.owner, selected.name, branch)
      onImported(created.project.id, created.jobId)
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized()
        return
      }
      setError(err instanceof ApiError ? err.message : t('repo.importError'))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{t('repo.title')}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{t('repo.description')}</p>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] text-ink-muted">{t('repo.search')}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(1)
          }}
          placeholder={t('repo.placeholder')}
          className="rounded-md border border-line bg-surface-2 px-3 py-1.5 font-mono text-[13px] text-ink placeholder:text-ink-faint"
        />
      </label>

      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setReloadEpoch((value) => value + 1)}
            className="underline"
          >
            Retry
          </button>
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
            disabled={branchLoading || branches.length === 0}
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
            disabled={page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-muted disabled:opacity-40"
          >
            {t('repo.prev')}
          </button>
          <button
            type="button"
            disabled={!list?.hasNext || loading}
            onClick={() => setPage((current) => current + 1)}
            className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-muted disabled:opacity-40"
          >
            {t('repo.next')}
          </button>
        </div>
        <button
          type="button"
          disabled={!selected || !branch || branchLoading || importing}
          onClick={() => void handleImport()}
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 disabled:opacity-60"
        >
          {importing ? t('repo.importing') : t('repo.import')}
        </button>
      </div>
    </div>
  )
}
