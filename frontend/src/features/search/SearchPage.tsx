import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { searchWorkspace } from '../../api/search'
import { useT } from '../../lib/i18n'
import type { SearchHit } from '../../api/types'
import { codeLocationSearch, queryError } from '../code/codeLocation'

export default function SearchPage() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const qParam = params.get('q') ?? ''
  const [draft, setDraft] = useState(qParam)

  const searchQuery = useQuery({
    queryKey: ['search', qParam],
    queryFn: () => searchWorkspace(qParam),
    enabled: qParam.trim().length > 0,
  })
  const error = queryError(searchQuery.error)
  const groups = searchQuery.data?.groups ?? []

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const next = draft.trim()
    setParams(next ? { q: next } : {})
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-8">
      <h1 className="text-[16px] font-semibold text-ink">{t('search.title')}</h1>
      <p className="mt-1 text-[13px] text-ink-muted">{t('search.description')}</p>
      <form onSubmit={onSubmit} className="mt-4 flex gap-2">
        <input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={t('search.label')}
          placeholder={t('search.placeholder')}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-3 py-1.5 text-ink placeholder:text-ink-faint"
        />
        <button
          type="submit"
          disabled={draft.trim().length === 0}
          className="rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[13px] text-ink disabled:opacity-60"
        >
          {t('search.submit')}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {error}
        </p>
      )}
      {searchQuery.isFetching && <p className="mt-4 text-[13px] text-ink-muted">{t('search.searching')}</p>}
      {qParam && !searchQuery.isFetching && groups.length === 0 && !error && (
        <p className="mt-4 text-[13px] text-ink-muted">{t('search.noResults')}</p>
      )}
      <div className="mt-6 space-y-5">
        {groups.map((group) => (
          <section key={group.type} aria-label={t('search.groupLabel').replace('{type}', group.type)}>
            <h2 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
              {group.type}
            </h2>
            <ul className="mt-1">
              {group.hits.map((hit) => (
                <li key={`${hit.type}-${hit.projectId}-${hit.id}`}>
                  <button
                    type="button"
                    onClick={() => navigate(hitHref(hit))}
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                  >
                    <span className="block text-[13px] text-ink">{hit.title}</span>
                    <span className="font-mono text-[11px] text-ink-faint">
                      {t('search.project')} {hit.projectId}
                      {hit.path ? ` · ${hit.path}` : ''}
                      {hit.snippet ? ` · ${hit.snippet}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

function hitHref(hit: SearchHit): string {
  const id = hit.projectId
  switch (hit.type) {
    case 'FILE':
    case 'SYMBOL':
    case 'EVIDENCE':
      return hit.path
        ? `/projects/${id}/code${codeLocationSearch(hit.path, null)}`
        : `/projects/${id}/code`
    case 'FEATURE':
      return `/projects/${id}/features`
    case 'FLOW':
      return `/projects/${id}/flows`
    case 'COMMIT':
    case 'PR':
      return `/projects/${id}/history`
    case 'FINDING':
      return `/projects/${id}/analysis`
    case 'NOTE':
      return `/projects/${id}/notes`
    case 'TASK':
      return `/projects/${id}/tasks`
    default:
      return `/projects/${id}/architecture`
  }
}
