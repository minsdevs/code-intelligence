import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getMe } from '../../api/auth'
import GithubConnectControl from './GithubConnectControl'
import { getAiStatus } from '../../api/ai'
import { AI_BUDGET_MUTATION_KEY, AI_BUDGET_QUERY_KEY, budgetAllowsRequests, getAiBudget } from '../../api/aiBudget'
import { clearAiSettings, getAiModels, getAiSettings, saveAiSettings } from '../../api/aiSettings'
import { ApiError, UnauthorizedError } from '../../api/client'
import type { AiStatus } from '../../api/types'
import { disconnectGithub, getGithubConnection } from '../../api/desktopAuth'
import { LANGS } from '../../lib/i18n-core'
import { useI18n } from '../../lib/i18n'
import { queryError } from '../code/codeLocation'
import AiBudgetSettings from './AiBudgetSettings'

const PROVIDERS = ['openai', 'gemini'] as const
type AiSettingsAction =
  | { action: 'save'; provider: 'openai' | 'gemini'; model: string }
  | { action: 'clear' }

export default function SettingsPage() {
  const { t, lang, setLang } = useI18n()
  const queryClient = useQueryClient()
  const desktop = typeof window === 'undefined' ? undefined : window.codeIntelligenceDesktop

  const [providerOverride, setProviderOverride] = useState<'openai' | 'gemini' | null>(null)
  const [modelOverride, setModelOverride] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [disconnectConfirm, setDisconnectConfirm] = useState(false)
  const [switchAccount, setSwitchAccount] = useState(false)
  const [restoreConfirm, setRestoreConfirm] = useState(false)
  const [backupPath, setBackupPath] = useState<string | null>(null)
  const [recoveryBackupPath, setRecoveryBackupPath] = useState<string | null>(null)
  const settingsActionInProgress = useRef(false)
  const submittedApiKey = useRef<string | null>(null)
  useEffect(() => () => { submittedApiKey.current = null }, [])
  const settingsMutation = useMutation({
    mutationFn: async (input: AiSettingsAction) => {
      // Mutation records outlive their observer. Transfer the key privately, never through
      // variables/context/data, and clear the component ref before awaiting the request.
      const key = submittedApiKey.current
      submittedApiKey.current = null
      try {
        if (input.action === 'clear') return await clearAiSettings()
        if (key === null) throw new Error('No pending AI key submission.')
        return await saveAiSettings(input.provider, input.model, key)
      } catch (error) {
        // Provider/transport errors may echo request content; do not cache their detail/cause.
        const message = 'AI settings request failed.'
        if (error instanceof UnauthorizedError) throw new UnauthorizedError(message)
        if (error instanceof ApiError) throw new ApiError(error.status, message)
        // eslint-disable-next-line preserve-caught-error -- A cached cause could retain the raw provider key.
        throw new Error(message)
      } finally {
        submittedApiKey.current = null
      }
    },
    retry: false,
    onMutate: () => Promise.all([
      queryClient.cancelQueries({ queryKey: ['ai-settings'] }),
      queryClient.cancelQueries({ queryKey: ['ai-status'] }),
      queryClient.cancelQueries({ queryKey: AI_BUDGET_QUERY_KEY }),
    ]),
    onSuccess: async (view) => {
      queryClient.setQueryData(['ai-settings'], view)
      setApiKey('')
      setProviderOverride(view.provider)
      setModelOverride(view.model)
      if (view.state !== 'ENABLED') {
        queryClient.setQueryData<AiStatus>(['ai-status'], (previous) => previous
          ? { ...previous, configured: false }
          : undefined)
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ai-status'] }),
        queryClient.invalidateQueries({ queryKey: AI_BUDGET_QUERY_KEY }),
      ])
    },
    onError: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['ai-settings'] }),
      queryClient.invalidateQueries({ queryKey: ['ai-status'] }),
      queryClient.invalidateQueries({ queryKey: AI_BUDGET_QUERY_KEY }),
    ]),
    onSettled: () => {
      submittedApiKey.current = null
      setApiKey('')
      settingsActionInProgress.current = false
    },
  })
  const settingsPending = settingsMutation.isPending
  const budgetPending = useIsMutating({ mutationKey: AI_BUDGET_MUTATION_KEY }) > 0
  const budgetQuery = useQuery({
    queryKey: AI_BUDGET_QUERY_KEY, queryFn: getAiBudget,
    enabled: !settingsPending && !budgetPending, retry: false,
  })
  const desktopBudget = Boolean(desktop) || budgetQuery.data?.available === true

  const statusQuery = useQuery({
    queryKey: ['ai-status'],
    queryFn: getAiStatus,
    enabled: !settingsPending,
    retry: false,
  })
  const settingsQuery = useQuery({
    queryKey: ['ai-settings'],
    queryFn: getAiSettings,
    enabled: !settingsPending,
    retry: false,
  })
  const saved = settingsQuery.data
  const provider = providerOverride ?? saved?.provider ?? 'openai'
  const providers = desktopBudget ? (['openai'] as const) : PROVIDERS
  const modelsQuery = useQuery({
    queryKey: ['ai-models', provider],
    queryFn: () => getAiModels(provider),
    enabled: !settingsPending,
    retry: false,
  })
  const githubQuery = useQuery({
    queryKey: ['github-connection'],
    queryFn: getGithubConnection,
    retry: false,
  })
  const accountQuery = useQuery({
    queryKey: ['account-profile'], queryFn: getMe, retry: false,
    enabled: githubQuery.data?.identityType === 'GITHUB' && githubQuery.data.githubId != null,
  })
  const refreshGithub = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['github-connection'] }),
      queryClient.invalidateQueries({ queryKey: ['account-profile'] }),
    ])
  }
  const runtimeQuery = useQuery({
    queryKey: ['desktop-runtime'],
    queryFn: () => desktop!.runtimeStatus(),
    enabled: Boolean(desktop),
    retry: false,
  })
  const error = queryError(statusQuery.error)
  const modelsError = queryError(modelsQuery.error)
  const status = statusQuery.data
  const desktopAiUnavailable = status?.blockedReason === 'DESKTOP_AI_SAFETY_UNAVAILABLE'
  const budgetReadReady = budgetQuery.isSuccess && !budgetQuery.isFetching && !budgetPending
  const aiAvailable = statusQuery.isSuccess && !statusQuery.isFetching && status?.configured === true
    && !desktopAiUnavailable && budgetReadReady && budgetAllowsRequests(budgetQuery.data, Boolean(desktop))
  const availabilityLabel = saved?.state === 'OFF' ? 'settings.off'
    : desktopAiUnavailable ? 'settings.disabled'
      : saved?.state === 'RECONNECT_REQUIRED' ? 'settings.reconnectRequired'
        : !status?.configured ? 'settings.disabled'
          : !statusQuery.isSuccess || statusQuery.isFetching || !budgetReadReady ? 'settings.availabilityUnknown'
            : budgetQuery.data?.available && budgetQuery.data.state === 'OFF' ? 'settings.off'
              : budgetQuery.data?.available && budgetQuery.data.state === 'RECOVERY_REQUIRED' ? 'settings.budgetRecovery'
                : aiAvailable ? 'settings.available' : 'settings.disabled'
  const model =
    modelOverride ??
    (saved?.provider === provider ? saved.model : undefined) ??
    modelsQuery.data?.[0]?.id ??
    ''
  const settingsUnavailable = settingsPending || budgetPending || settingsQuery.isPending || settingsQuery.isFetching || settingsQuery.isError
  const editingUnavailable = settingsUnavailable || !statusQuery.isSuccess || statusQuery.isFetching || desktopAiUnavailable
  const canReuseKey = saved?.state === 'ENABLED' && saved.keySet && saved.provider === provider
  const listedModel = modelsQuery.data?.some((entry) => entry.id === model) ?? false
  const canSave = !editingUnavailable && !modelsQuery.isPending && !modelsQuery.isError
    && listedModel && Boolean(apiKey.trim() || canReuseKey)
  const blockedState = saved?.state === 'OFF' || saved?.state === 'RECONNECT_REQUIRED'
  const previousRequests = saved && Number.isSafeInteger(saved.activeRequests) && saved.activeRequests > 0
    ? saved.activeRequests
    : 0
  const disconnectMutation = useMutation({
    mutationFn: disconnectGithub,
    onSuccess: async (connection) => {
      setDisconnectConfirm(false)
      queryClient.setQueryData(['github-connection'], connection)
      queryClient.removeQueries({ queryKey: ['account-profile'] })
      await refreshGithub()
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
  const runtimeControlsReady = runtimeQuery.isSuccess && !runtimeQuery.isFetching
    && !restartMutation.isPending && runtimeQuery.data.ready === true && runtimeQuery.data.error === null
  const backupDisabled = !runtimeControlsReady || runtimeQuery.data?.backupAvailable === false
    || backupMutation.isPending || restoreMutation.isPending
  const restoreDisabled = !runtimeControlsReady || runtimeQuery.data?.restoreAvailable === false
    || backupMutation.isPending || restoreMutation.isPending
  const backupUnavailable = runtimeQuery.data?.backupAvailable === false || runtimeQuery.data?.restoreAvailable === false

  const saveError = settingsMutation.error
    ? t(settingsMutation.error instanceof ApiError && settingsMutation.error.status === 409
      ? 'settings.changeConflict'
      : 'settings.changeFailed')
    : queryError(settingsQuery.error)
  const githubError = queryError(githubQuery.error) ?? queryError(disconnectMutation.error)
  const runtimeError = queryError(runtimeQuery.error)
    ?? queryError(restartMutation.error)
    ?? queryError(backupMutation.error)
    ?? queryError(restoreMutation.error)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (settingsActionInProgress.current || !canSave) return
    settingsActionInProgress.current = true
    submittedApiKey.current = apiKey
    setApiKey('')
    settingsMutation.mutate({ action: 'save', provider, model })
  }

  function onClear() {
    if (settingsActionInProgress.current || settingsUnavailable || saved?.state === 'OFF') return
    settingsActionInProgress.current = true
    submittedApiKey.current = null
    setApiKey('')
    settingsMutation.mutate({ action: 'clear' })
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-[16px] font-semibold text-ink">{t('settings.title')}</h1>

      <section id="github-account" className="mt-6 rounded-md border border-line bg-surface-1 px-4 py-3" aria-label={t('settings.github')}>
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
              <dd className="text-ink">{githubQuery.data.connected ? t('settings.githubConnected') : githubQuery.data.reauthenticationReason ? 'GitHub 재인증 필요' : '로컬 모드 · GitHub 미연결'}</dd>
              {githubQuery.data.githubId != null && <>
                <dt className="text-ink-muted">GitHub 계정</dt>
                <dd className="break-all text-ink">{githubQuery.data.identityType === 'GITHUB' && accountQuery.data?.login ? `@${accountQuery.data.login}` : `GitHub ID ${githubQuery.data.githubId ?? '확인 중'}`}</dd>
              </>}
            </dl>
            {githubQuery.data.reauthenticationReason && <p role="status" className="mt-3 text-[12px] text-ink-muted">
              {githubQuery.data.reauthenticationReason === 'TOKEN_EXPIRED' ? 'GitHub 연결이 만료되었습니다.' : 'GitHub 인증의 유효 기간을 확인할 수 없습니다.'} 다시 로그인하세요. 자동 갱신은 아직 지원하지 않으며 로컬 분석 기록은 유지됩니다.
            </p>}
            {!githubQuery.data.connected && (
              <div className="mt-4">
                {switchAccount && <p role="status" className="mb-3 text-[12px] text-ink-muted">이전 연결을 해제했습니다. 브라우저에서 원하는 GitHub 계정인지 확인한 뒤 다시 로그인하세요.</p>}
                <GithubConnectControl oauthAvailable={githubQuery.data.oauthAvailable} onConnected={async () => { setSwitchAccount(false); await refreshGithub() }} />
              </div>
            )}
            {githubQuery.data.githubId != null && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {!disconnectConfirm ? (
                  <>
                  <button type="button" onClick={() => { setSwitchAccount(true); setDisconnectConfirm(true) }} className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-surface-2">계정 전환</button>
                  <button
                    type="button"
                    onClick={() => { setSwitchAccount(false); setDisconnectConfirm(true) }}
                    className="rounded-md border border-line px-3 py-1.5 text-[13px] text-danger hover:bg-surface-2"
                  >
                    {t('settings.unlinkGithub')}
                  </button>
                  </>
                ) : (
                  <div className="flex flex-wrap items-center gap-2" role="alert">
                    <span className="text-[12px] text-danger">{switchAccount ? '계정을 전환하려면 현재 GitHub 연결을 먼저 해제합니다. 로컬 프로젝트와 분석 기록은 유지됩니다.' : t('settings.unlinkConfirm')}</span>
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
                      onClick={() => { setDisconnectConfirm(false); setSwitchAccount(false) }}
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
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">로컬 폴더 분석에는 로그인이 필요하지 않습니다. 연결 해제는 이 앱의 GitHub 접근만 해제하며 로컬 프로젝트와 분석 기록은 유지됩니다. {t('settings.unlinkHint')}</p>
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
        <p className="mt-1 text-[12px] text-ink-muted">{t(desktopAiUnavailable ? 'ai.desktopUnavailable' : 'settings.aiDesc')}</p>
        {error && (
          <p role="alert" className="mt-2 text-[12px] text-danger">
            {error}
          </p>
        )}
        {statusQuery.isLoading && <p className="mt-2 text-[13px] text-ink-muted">{t('settings.statusLoading')}</p>}
        {status && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-ink-muted">{t('settings.status')}</dt>
            <dd className="text-ink">{t(availabilityLabel)}</dd>
            <dt className="text-ink-muted">{t('settings.provider')}</dt>
            <dd className="font-mono text-ink">{saved?.provider ?? status.provider ?? '—'}</dd>
            <dt className="text-ink-muted">{t('settings.model')}</dt>
            <dd className="font-mono text-ink">{saved?.model ?? status.model ?? '—'}</dd>
            <dt className="text-ink-muted">{t('settings.storedKey')}</dt>
            <dd className="font-mono text-ink">{saved?.state === 'ENABLED' && saved.keySet ? saved.keyMasked ?? '—' : '—'}</dd>
          </dl>
        )}

        {!desktopAiUnavailable && saved?.state === 'RECONNECT_REQUIRED' && (
          <p className="mt-3 text-[12px] text-ink-muted" role="status">{t('settings.reconnectHint')}</p>
        )}
        {!desktopAiUnavailable && saved?.state === 'OFF' && (
          <p className="mt-3 text-[12px] text-ink-muted" role="status">{t(desktopBudget ? 'settings.desktopOffHint' : 'settings.offHint')}</p>
        )}
        {blockedState && previousRequests > 0 && (
          <p className="mt-2 text-[12px] text-ink-muted" role="status">
            {t('settings.previousRequests').replace('{count}', String(previousRequests))}
          </p>
        )}

        <form onSubmit={onSubmit} className="mt-4" aria-busy={settingsPending}>
          <fieldset disabled={settingsUnavailable} className="min-w-0 space-y-3 border-0 p-0">
            <label className="block text-[12px] text-ink-muted">
              {t('settings.provider')}
              <select
                value={provider}
                disabled={editingUnavailable}
                onChange={(event) => {
                  setProviderOverride(event.target.value as 'openai' | 'gemini')
                  setModelOverride(null)
                }}
                className="mt-1 w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-[13px] text-ink"
              >
                {providers.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
                {desktopBudget && provider !== 'openai' && <option value={provider} disabled>{provider}</option>}
              </select>
            </label>
            <label className="block text-[12px] text-ink-muted">
              {t('settings.model')}
              <select
                value={model}
                onChange={(event) => setModelOverride(event.target.value)}
                disabled={editingUnavailable || modelsQuery.isLoading || modelsQuery.isError}
                className="mt-1 w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-[13px] text-ink disabled:opacity-60"
              >
                {modelsQuery.data?.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id}
                  </option>
                ))}
                {model && !listedModel && <option value={model} disabled>{model}</option>}
              </select>
            </label>
            {model && !listedModel && modelsQuery.isSuccess && (
              <p className="text-[12px] text-ink-muted">{t('settings.modelUnavailable')}</p>
            )}
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
                disabled={editingUnavailable}
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
                disabled={!canSave}
                className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {settingsPending && settingsMutation.variables?.action === 'save' ? t('settings.saving') : t('settings.saveKey')}
              </button>
              <button
                type="button"
                onClick={onClear}
                disabled={settingsUnavailable || saved?.state === 'OFF'}
                className="rounded-md border border-line px-3 py-1.5 text-[13px] text-danger hover:bg-surface-2 disabled:opacity-50"
              >
                {settingsPending && settingsMutation.variables?.action === 'clear' ? t('settings.clearing') : t('settings.clearKey')}
              </button>
            </div>
          </fieldset>
        </form>
        {!desktopAiUnavailable && budgetReadReady && <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">{t(desktopBudget ? 'settings.desktopKeyHint' : 'settings.keyHint')}</p>}
        <AiBudgetSettings disabled={settingsPending} />
      </section>

      {desktop && (
        <section className="mt-6 rounded-md border border-line bg-surface-1 px-4 py-3" aria-label={t('settings.desktopRuntime')}>
          <h2 className="text-[13px] font-semibold text-ink">{t('settings.desktopRuntime')}</h2>
          <p className="mt-1 text-[12px] text-ink-muted">{t('settings.desktopRuntimeDesc')}</p>
          {runtimeError && <p className="mt-2 text-[12px] text-danger" role="alert">{runtimeError}</p>}
          {runtimeQuery.isLoading && <p className="mt-2 text-[13px] text-ink-muted">{t('settings.runtimeLoading')}</p>}
          {backupUnavailable && <p className="mt-2 text-[12px] text-ink-muted">{t('settings.backupUnavailable')}</p>}
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
              onClick={() => { if (!backupDisabled) backupMutation.mutate() }}
              disabled={backupDisabled}
              className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-surface-2 disabled:opacity-50"
            >
              {backupMutation.isPending ? t('settings.backingUp') : t('settings.backup')}
            </button>
            <button
              type="button"
              onClick={() => { if (!restoreDisabled) setRestoreConfirm(true) }}
              disabled={restoreDisabled}
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
                  onClick={() => { if (!restoreDisabled) restoreMutation.mutate() }}
                  disabled={restoreDisabled}
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
