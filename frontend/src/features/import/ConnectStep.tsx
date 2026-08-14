import { useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import { registerPat } from '../../api/auth'
import { useT } from '../../lib/i18n'
import type { MeResponse } from '../../api/types'
import { GithubIcon } from '../../components/icons'

const OAUTH_HREF = '/oauth2/authorization/github'

type ConnectStepProps = {
  me: MeResponse | null
  onConnected: () => Promise<void>
}

export default function ConnectStep({ me, onConnected }: ConnectStepProps) {
  const t = useT()
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = token.trim()
    if (!value) {
      setError(t('connect.errorEmpty'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await registerPat(value)
      setToken('')
      await onConnected()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('connect.errorEmpty'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex max-w-lg flex-col gap-5">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{t('connect.title')}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{t('connect.description')}</p>
      </div>

      {me?.oauthAvailable && (
        <a
          href={OAUTH_HREF}
          className="inline-flex w-fit items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-3"
        >
          <GithubIcon />
          {t('connect.continue')}
        </a>
      )}

      {me?.oauthAvailable && (
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">{t('connect.or')}</p>
      )}

      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-muted">{t('connect.tokenLabel')}</span>
          <input
            type="password"
            name="token"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t('connect.placeholder')}
            className="rounded-md border border-line bg-surface-2 px-3 py-1.5 font-mono text-[13px] text-ink placeholder:text-ink-faint"
          />
        </label>
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="w-fit rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 disabled:opacity-60"
        >
          {submitting ? t('connect.submitting') : t('connect.submit')}
        </button>
      </form>
    </div>
  )
}
