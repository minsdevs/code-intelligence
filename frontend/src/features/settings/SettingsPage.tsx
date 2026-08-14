import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getAiStatus } from '../../api/ai'
import { clearAiSettings, getAiModels, getAiSettings, saveAiSettings } from '../../api/aiSettings'
import { LANGS } from '../../lib/i18n-core'
import { useI18n } from '../../lib/i18n'
import { queryError } from '../code/codeLocation'

const PROVIDERS = ['openai', 'gemini'] as const

export default function SettingsPage() {
  const t = useI18n().t
  const lang = useI18n().lang
  const setLang = useI18n().setLang
  const queryClient = useQueryClient()

  const [providerOverride, setProviderOverride] = useState<'openai' | 'gemini' | null>(null)
  const [modelOverride, setModelOverride] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')

  const statusQuery = useQuery({
    queryKey: ['ai-status'],
    queryFn: getAiStatus,
    retry: false,
  })
  const settingsQuery = useQuery({
    queryKey: ['ai-settings'],
    queryFn: getAiSettings,
    retry: false,
  })
  const saved = settingsQuery.data
  const provider = providerOverride ?? saved?.provider ?? 'openai'
  const modelsQuery = useQuery({
    queryKey: ['ai-models', provider],
    queryFn: () => getAiModels(provider),
    retry: false,
  })
  const error = queryError(statusQuery.error)
  const modelsError = queryError(modelsQuery.error)
  const status = statusQuery.data
  const model =
    modelOverride ??
    (saved?.provider === provider ? saved.model : undefined) ??
    modelsQuery.data?.[0]?.id ??
    ''

  const saveMutation = useMutation({
    mutationFn: () => saveAiSettings(provider, model, apiKey),
    onSuccess: async (view) => {
      setApiKey('')
      setProviderOverride(view.provider)
      setModelOverride(view.model)
      await queryClient.invalidateQueries({ queryKey: ['ai-settings'] })
      await queryClient.invalidateQueries({ queryKey: ['ai-status'] })
    },
  })
  const clearMutation = useMutation({
    mutationFn: clearAiSettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ai-settings'] })
      await queryClient.invalidateQueries({ queryKey: ['ai-status'] })
    },
  })

  const saveError =
    queryError(saveMutation.error) ??
    queryError(clearMutation.error) ??
    queryError(settingsQuery.error)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!model || (!apiKey.trim() && saved?.provider !== provider)) return
    saveMutation.mutate()
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-[16px] font-semibold text-ink">{t('settings.title')}</h1>

      <section className="mt-6 rounded-md border border-line bg-surface-1 px-4 py-3" aria-label={t('settings.language')}>
        <h2 className="text-[13px] font-semibold text-ink">{t('settings.language')}</h2>
        <p className="mt-1 text-[12px] text-ink-muted">{t('settings.languageDesc')}</p>
        <div className="mt-3 flex gap-2">
          {LANGS.map((entry) => {
            const active = entry.id === lang
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setLang(entry.id)}
                aria-pressed={active}
                className={`rounded-md border px-3 py-1.5 text-[13px] transition-colors ${
                  active
                    ? 'border-accent bg-surface-3 font-medium text-ink'
                    : 'border-line text-ink-muted hover:bg-surface-2 hover:text-ink'
                }`}
              >
                {entry.labelNative}
              </button>
            )
          })}
        </div>
      </section>

      <section className="mt-6 rounded-md border border-line bg-surface-1 px-4 py-3" aria-label={t('settings.aiProvider')}>
        <h2 className="text-[13px] font-semibold text-ink">{t('settings.aiProvider')}</h2>
        <p className="mt-1 text-[12px] text-ink-muted">{t('settings.aiDesc')}</p>
        {error && (
          <p role="alert" className="mt-2 text-[12px] text-danger">
            {error}
          </p>
        )}
        {statusQuery.isLoading && <p className="mt-2 text-[13px] text-ink-muted">{t('settings.statusLoading')}</p>}
        {status && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-ink-muted">{t('settings.status')}</dt>
            <dd className="text-ink">{status.configured ? t('settings.available') : t('settings.disabled')}</dd>
            <dt className="text-ink-muted">{t('settings.provider')}</dt>
            <dd className="font-mono text-ink">{status.provider ?? '—'}</dd>
            <dt className="text-ink-muted">{t('settings.model')}</dt>
            <dd className="font-mono text-ink">{status.model ?? '—'}</dd>
            <dt className="text-ink-muted">{t('settings.storedKey')}</dt>
            <dd className="font-mono text-ink">{saved ? saved.keyMasked : '—'}</dd>
          </dl>
        )}

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <label className="block text-[12px] text-ink-muted">
            {t('settings.provider')}
            <select
              value={provider}
              onChange={(event) => {
                setProviderOverride(event.target.value as 'openai' | 'gemini')
                setModelOverride(null)
              }}
              className="mt-1 w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-[13px] text-ink"
            >
              {PROVIDERS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[12px] text-ink-muted">
            {t('settings.model')}
            <select
              value={model}
              onChange={(event) => setModelOverride(event.target.value)}
              disabled={modelsQuery.isLoading || modelsQuery.isError}
              className="mt-1 w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-[13px] text-ink disabled:opacity-60"
            >
              {modelsQuery.data?.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.id}
                </option>
              ))}
            </select>
          </label>
          {modelsError && (
            <div className="text-[12px] text-danger">
              <p role="alert">{modelsError}</p>
              <button
                type="button"
                onClick={() => void modelsQuery.refetch()}
                className="mt-1 rounded-md border border-line-strong px-2 py-1 text-ink hover:bg-surface-2"
              >
                {t('settings.retryModels')}
              </button>
            </div>
          )}
          <label className="block text-[12px] text-ink-muted">
            {t('settings.apiKey')}
            <input
              type="password"
              autoComplete="off"
              maxLength={4096}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t('settings.apiKeyPlaceholder')}
              aria-label={t('settings.apiKey')}
              className="mt-1 w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-[13px] text-ink placeholder:text-ink-faint"
            />
          </label>
          {saveError && (
            <p role="alert" className="text-[12px] text-danger">
              {saveError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={saveMutation.isPending || !model || (!apiKey.trim() && saved?.provider !== provider)}
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveMutation.isPending ? t('settings.saving') : t('settings.saveKey')}
            </button>
            {saved?.keySet && (
              <button
                type="button"
                onClick={() => clearMutation.mutate()}
                disabled={clearMutation.isPending}
                className="rounded-md border border-line px-3 py-1.5 text-[13px] text-danger hover:bg-surface-2 disabled:opacity-50"
              >
                {t('settings.clearKey')}
              </button>
            )}
          </div>
        </form>
        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">{t('settings.keyHint')}</p>
      </section>
    </div>
  )
}
