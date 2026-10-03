import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  activateAiBudget, AI_BUDGET_MUTATION_KEY, AI_BUDGET_QUERY_KEY, dollarsToMicroUsd,
  getAiBudget, microUsdToDollars, saveAiBudget, type AiBudgetLimits,
} from '../../api/aiBudget'
import { ApiError } from '../../api/client'
import { useT } from '../../lib/i18n'

type BudgetAction = ({ action: 'save' } & AiBudgetLimits) | { action: 'activate'; expectedRevision: string }
type Edit = { revision: string; daily: string; monthly: string }

export default function AiBudgetSettings({ disabled = false }: { disabled?: boolean }) {
  const t = useT()
  const client = useQueryClient()
  const busy = useRef(false)
  const pendingActivation = useRef<string | null>(null)
  const [usedTokens, setUsedTokens] = useState<Set<string>>(() => new Set())
  useEffect(() => () => { pendingActivation.current = null }, [])
  const [edit, setEdit] = useState<Edit | null>(null)
  const mutation = useMutation({
    mutationKey: AI_BUDGET_MUTATION_KEY,
    mutationFn: async (action: BudgetAction) => {
      const token = pendingActivation.current
      pendingActivation.current = null
      try {
        if (action.action === 'activate') {
          if (token === null) throw new Error('No pending activation approval.')
          return await activateAiBudget(action.expectedRevision, token)
        }
        return await saveAiBudget({ expectedRevision: action.expectedRevision, dailyLimitMicroUsd: action.dailyLimitMicroUsd, monthlyLimitMicroUsd: action.monthlyLimitMicroUsd })
      } catch (error) {
        // One-use approval values and server detail do not belong in retained mutation errors.
        if (error instanceof ApiError) throw new ApiError(error.status, 'AI budget change could not be confirmed.')
        // eslint-disable-next-line preserve-caught-error -- An untrusted cause could retain the one-use approval.
        throw new Error('AI budget change could not be confirmed.')
      } finally {
        pendingActivation.current = null
      }
    },
    retry: false,
    onMutate: () => Promise.all([
      client.cancelQueries({ queryKey: AI_BUDGET_QUERY_KEY }),
      client.cancelQueries({ queryKey: ['ai-status'] }),
    ]),
    onSuccess: async (view) => {
      client.setQueryData(AI_BUDGET_QUERY_KEY, view)
      setEdit(null)
      await client.invalidateQueries({ queryKey: ['ai-status'] })
    },
    onError: () => Promise.all([
      client.invalidateQueries({ queryKey: AI_BUDGET_QUERY_KEY }),
      client.invalidateQueries({ queryKey: ['ai-status'] }),
    ]),
    onSettled: () => { pendingActivation.current = null; busy.current = false },
  })
  const budget = useQuery({ queryKey: AI_BUDGET_QUERY_KEY, queryFn: getAiBudget, enabled: !mutation.isPending && !disabled, retry: false })
  const view = budget.data
  const currentEdit = edit?.revision === view?.policyRevision ? edit : null
  const daily = currentEdit?.daily ?? (view ? microUsdToDollars(view.dailyLimitMicroUsd) : '0')
  const monthly = currentEdit?.monthly ?? (view ? microUsdToDollars(view.monthlyLimitMicroUsd) : '0')
  const dailyMicro = dollarsToMicroUsd(daily)
  const monthlyMicro = dollarsToMicroUsd(monthly)
  const invalid = dailyMicro === null || monthlyMicro === null
  const changed = dailyMicro !== view?.dailyLimitMicroUsd || monthlyMicro !== view?.monthlyLimitMicroUsd
  const readConfirmed = !disabled && !mutation.isPending && budget.isSuccess && !budget.isFetching
  const unavailable = !readConfirmed || !view?.available
  const freshToken = view?.activationToken && !usedTokens.has(view.activationToken)
  const canActivate = !unavailable && !invalid && !changed && view?.state !== 'READY' && Boolean(freshToken)
  const failure = mutation.error ? t(mutation.error instanceof ApiError && mutation.error.status === 409
    ? 'budget.conflict' : 'budget.changeFailed') : null

  function currentRevision() {
    const state = client.getQueryState(AI_BUDGET_QUERY_KEY)
    return !unavailable && !busy.current && state?.status === 'success' && state.fetchStatus === 'idle'
      && state.data === view && view?.available
  }

  function save(event: FormEvent) {
    event.preventDefault()
    if (!currentRevision() || !view || dailyMicro === null || monthlyMicro === null) return
    busy.current = true
    mutation.mutate({ action: 'save', expectedRevision: view.policyRevision, dailyLimitMicroUsd: dailyMicro, monthlyLimitMicroUsd: monthlyMicro })
  }

  function activate() {
    if (!currentRevision() || !view?.activationToken || !canActivate) return
    const token = view.activationToken
    busy.current = true
    pendingActivation.current = token
    setUsedTokens(previous => new Set(previous).add(token))
    mutation.mutate({ action: 'activate', expectedRevision: view.policyRevision })
  }

  function refresh() {
    if (disabled || busy.current || budget.isFetching) return
    void budget.refetch()
  }

  return (
    <section aria-label={t('budget.title')} className="mt-4 border-t border-line pt-4 text-[12px]">
      <h3 className="font-semibold text-ink">{t('budget.title')}</h3>
      <p className="mt-1 text-ink-muted">{t('budget.description')}</p>
      {budget.isPending && <p className="mt-2 text-ink-muted" role="status">{t('budget.loading')}</p>}
      {budget.isError && (
        <div className="mt-2 text-danger" role="status">
          <p>{t('budget.readFailed')}</p>
        </div>
      )}
      {view && !view.available && <p className="mt-2 text-ink-muted">{t('budget.unavailable')}</p>}
      {view?.available && (
        <>
          <p className="mt-2 text-ink" role="status">{t(readConfirmed ? `budget.state.${view.state}` : 'budget.stateUnknown')}</p>
          {readConfirmed && view.state === 'RECOVERY_REQUIRED' && <p className="mt-1 text-ink-muted">{t('budget.recovery')}</p>}
          {view.state !== 'READY' && !freshToken && <p className="mt-1 text-ink-muted">{t('budget.approvalUnavailable')}</p>}
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt>{t('budget.dailySettled')}</dt><dd>${microUsdToDollars(view.dailySettledMicroUsd)}</dd>
            <dt>{t('budget.monthlySettled')}</dt><dd>${microUsdToDollars(view.monthlySettledMicroUsd)}</dd>
            <dt>{t('budget.held')}</dt><dd>${microUsdToDollars(view.allDatesHeldMicroUsd)}</dd>
            <dt>{t('budget.models')}</dt><dd className="break-words font-mono">{view.supportedModels.join(', ') || '—'}</dd>
          </dl>
          <p className="mt-2 text-ink-muted">{t('budget.heldHint')}</p>
        </>
      )}
      <form onSubmit={save} className="mt-3" aria-busy={mutation.isPending}>
        <fieldset disabled={unavailable} className="space-y-3 border-0 p-0">
          <label className="block text-ink-muted">{t('budget.dailyLimit')}
            <input type="text" inputMode="decimal" maxLength={21} value={daily}
              onChange={event => { if (view) setEdit({ revision: view.policyRevision, daily: event.target.value, monthly }) }}
              className="mt-1 w-full rounded border border-line bg-surface-2 px-2 py-1.5 font-mono text-ink" />
          </label>
          <label className="block text-ink-muted">{t('budget.monthlyLimit')}
            <input type="text" inputMode="decimal" maxLength={21} value={monthly}
              onChange={event => { if (view) setEdit({ revision: view.policyRevision, daily, monthly: event.target.value }) }}
              className="mt-1 w-full rounded border border-line bg-surface-2 px-2 py-1.5 font-mono text-ink" />
          </label>
          {invalid && <p className="text-danger" role="alert">{t('budget.invalidAmount')}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={unavailable || invalid}
              className="rounded border border-line-strong px-3 py-1.5 disabled:opacity-50">{t('budget.save')}</button>
            <button type="button" onClick={activate} disabled={!canActivate}
              className="rounded bg-accent px-3 py-1.5 text-surface-0 disabled:opacity-50">{t('budget.activate')}</button>
          </div>
        </fieldset>
      </form>
      <button type="button" onClick={refresh} disabled={disabled || mutation.isPending || budget.isFetching}
        className="mt-2 rounded border border-line px-2 py-1 disabled:opacity-50">{t('budget.refresh')}</button>
      {failure && <p className="mt-2 text-danger" role="alert">{failure}</p>}
      <p className="mt-2 text-ink-muted">{t('budget.activationHint')}</p>
    </section>
  )
}
