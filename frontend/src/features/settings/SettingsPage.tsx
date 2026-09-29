import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getAiStatus } from '../../api/ai'
import { clearAiSettings, getAiModels, getAiSettings, saveAiSettings } from '../../api/aiSettings'
import { disconnectGithub, getGithubConnection } from '../../api/desktopAuth'
import { LANGS } from '../../lib/i18n-core'
import { useI18n } from '../../lib/i18n'
import { queryError } from '../code/codeLocation'

const PROVIDERS = ['openai', 'gemini'] as const

export default function SettingsPage() {
  const t = useI18n().t
  const lang = useI18n().lang
  const setLang = useI18n().setLang
  const queryClient = useQueryClient()
  const desktop = typeof window === 'undefined' ? undefined : window.codeIntelligenceDesktop

  const [providerOverride, setProviderOverride] = useState<'openai' | 'gemini' | null>(null)
  const [modelOverride, setModelOverride] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [disconnectConfirm, setDisconnectConfirm] = useState(false)
  const [restoreConfirm, setRestoreConfirm] = useState(false)
  const [backupPath, setBackupPath] = useState<string | null>(null)
  const [recoveryBackupPath, setRecoveryBackupPath] = useState<string | null>(null)

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
  const githubQuery = useQuery({
    queryKey: ['github-connection'],
    queryFn: getGithubConnection,
    retry: false,
  })
  const runtimeQuery = useQuery({
    queryKey: ['desktop-runtime'],
    queryFn: () => desktop!.runtimeStatus(),
    enabled: Boolean(desktop),
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
  const disconnectMutation = useMutation({
    mutationFn: disconnectGithub,
    onSuccess: async () => {
      setDisconnectConfirm(false)
      await queryClient.invalidateQueries({ queryKey: ['github-connection'] })
    },
  })
  const restartMutation = useMutation({
    mutationFn: () => desktop!.restartRuntime(),
    onSuccess: (status) => queryClient.setQueryData(['desktop-runtime'], status),
  })
  const backupMutation = useMutation({
    mutationFn: () => desktop!.backup(),
    onSuccess: (path) => setBackupPath(path),
  })
  const restoreMutation = useMutation({
    mutationFn: () => desktop!.restore(),
    onSuccess: async (result) => {
      setRestoreConfirm(false)
      setRecoveryBackupPath(result?.recoveryBackup ?? null)
      await queryClient.invalidateQueries({ queryKey: ['desktop-runtime'] })
    },
  })

  const saveError =
    queryError(saveMutation.error) ??
    queryError(clearMutation.error) ??
    queryError(settingsQuery.error)
  const githubError = queryError(githubQuery.error) ?? queryError(disconnectMutation.error)
  const runtimeError = queryError(runtimeQuery.error)
    ?? queryError(restartMutation.error)
    ?? queryError(backupMutation.error)
    ?? queryError(restoreMutation.error)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!model || (!apiKey.trim() && saved?.provider !== provider)) return
    saveMutation.mutate()
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-[16px] font-semibold text-ink">{t('settings.title')}</h1>

      <section className="mt-6 rounded-md border border-line bg-surface-1 px-4 py-3" aria-label={t('settings.github')}>
        <h2 className="text-[13px] font-semibold text-ink">{t('settings.github')}</h2>
        <p className="mt-1 text-[12px] text-ink-muted">{t('settings.githubDesc')}</p>
        {githubError && <p className="mt-2 text-[12px] text-danger" role="alert">{githubError}</p>}
        {githubQuery.isLoading && <p className="mt-2 text-[13px] text-ink-muted">{t('settings.githubLoading')}</p>}
        {githubQuery.data && (
          <>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
              <dt className="text-ink-muted">{t('settings.identity')}</dt>
              <dd className="font-mono text-ink">{githubQuery.data.identityType}</dd>
              <dt className="text-ink-muted">{t('settings.githubStatus')}</dt>
              <dd className="text-ink">{githubQuery.data.connected ? t('settings.githubConnected') : t('settings.githubNotConnected')}</dd>
            </dl>
            {githubQuery.data.connected && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {!disconnectConfirm ? (
                  <button
                    type="button"
                    onClick={() => setDisconnectConfirm(true)}
                    className="rounded-md border border-line px-3 py-1.5 text-[13px] text-danger hover:bg-surface-2"
                  >
                    {t('settings.unlinkGithub')}
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2" role="alert">
                    <span className="text-[12px] text-danger">{t('settings.unlinkConfirm')}</span>
                    <button
                      type="button"
                      onClick={() => disconnectMutation.mutate()}
                      disabled={disconnectMutation.isPending}
                      className="rounded-md bg-danger px-3 py-1.5 text-[13px] font-medium text-surface-0 disabled:opacity-50"
                    >
                      {disconnectMutation.isPending ? t('settings.unlinking') : t('settings.confirmUnlink')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDisconnectConfirm(false)}
                      className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-muted hover:bg-surface-2"
                    >
                      {t('settings.cancel')}
                    </button>
                  </div>
                )}
                {githubQuery.data.githubRevocationUrl && (
                  <button
                    type="button"
                    disabled={!desktop}
                    onClick={() => {
                      if (desktop && githubQuery.data?.githubRevocationUrl) {
                        void desktop.openExternal(githubQuery.data.githubRevocationUrl)
                      }
                    }}
                    className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('settings.revokeGithub')}
                  </button>
                )}
              </div>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">{t('settings.unlinkHint')}</p>
          </>
        )}
      </section>

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

      {desktop && (
        <section className="mt-6 rounded-md border border-line bg-surface-1 px-4 py-3" aria-label={t('settings.desktopRuntime')}>
          <h2 className="text-[13px] font-semibold text-ink">{t('settings.desktopRuntime')}</h2>
          <p className="mt-1 text-[12px] text-ink-muted">{t('settings.desktopRuntimeDesc')}</p>
          {runtimeError && <p className="mt-2 text-[12px] text-danger" role="alert">{runtimeError}</p>}
          {runtimeQuery.isLoading && <p className="mt-2 text-[13px] text-ink-muted">{t('settings.runtimeLoading')}</p>}
          {runtimeQuery.data && (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
              <dt className="text-ink-muted">{t('settings.runtimeReady')}</dt>
              <dd className="text-ink">{runtimeQuery.data.ready ? t('settings.ready') : t('settings.notReady')}</dd>
              <dt className="text-ink-muted">{t('settings.runtimeError')}</dt>
              <dd className="break-words text-danger">{runtimeQuery.data.error ?? '—'}</dd>
              <dt className="text-ink-muted">{t('settings.services')}</dt>
              <dd className="font-mono text-ink">{runtimeQuery.data.services.join(', ') || '—'}</dd>
            </dl>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => restartMutation.mutate()}
              disabled={restartMutation.isPending}
              className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-surface-2 disabled:opacity-50"
            >
              {restartMutation.isPending ? t('settings.restarting') : t('settings.restartRuntime')}
            </button>
            <button
              type="button"
              onClick={() => backupMutation.mutate()}
              disabled={backupMutation.isPending}
              className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-surface-2 disabled:opacity-50"
            >
              {backupMutation.isPending ? t('settings.backingUp') : t('settings.backup')}
            </button>
            <button
              type="button"
              onClick={() => setRestoreConfirm(true)}
              disabled={restoreMutation.isPending}
              className="rounded-md border border-line px-3 py-1.5 text-[13px] text-danger hover:bg-surface-2 disabled:opacity-50"
            >
              {restoreMutation.isPending ? t('settings.restoring') : t('settings.restore')}
            </button>
          </div>
          {restoreConfirm && (
            <div className="mt-3 rounded-md border border-danger/40 bg-surface-2 p-3" role="alert">
              <p className="text-[12px] text-danger">{t('settings.restoreConfirm')}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => restoreMutation.mutate()}
                  disabled={restoreMutation.isPending}
                  className="rounded-md bg-danger px-3 py-1.5 text-[13px] font-medium text-surface-0 disabled:opacity-50"
                >
                  {t('settings.confirmRestore')}
                </button>
                <button
                  type="button"
                  onClick={() => setRestoreConfirm(false)}
                  className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-muted hover:bg-surface-3"
                >
                  {t('settings.cancel')}
                </button>
              </div>
            </div>
          )}
          {(backupPath || recoveryBackupPath) && (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
              {backupPath && <><dt className="text-ink-muted">{t('settings.backupPath')}</dt><dd className="break-all font-mono text-ink">{backupPath}</dd></>}
              {recoveryBackupPath && <><dt className="text-ink-muted">{t('settings.recoveryPath')}</dt><dd className="break-all font-mono text-ink">{recoveryBackupPath}</dd></>}
            </dl>
          )}
        </section>
      )}
    </div>
  )
}
