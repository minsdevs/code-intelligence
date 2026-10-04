import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { registerPat } from '../../api/auth'
import { ApiError } from '../../api/client'
import {
  cancelNativeGithubOAuth,
  pollNativeGithubOAuth,
  startNativeGithubOAuth,
  type NativeOAuthStart,
} from '../../api/desktopAuth'
import type { MeResponse } from '../../api/types'
import { GithubIcon } from '../../components/icons'
import { useT } from '../../lib/i18n'

const OAUTH_HREF = '/oauth2/authorization/github'

type ConnectStepProps = {
  me: MeResponse | null
  onConnected: () => Promise<void>
  onLocalPath: (path: string) => void
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'))
      return
    }
    const cancel = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export default function ConnectStep({ me, onConnected, onLocalPath }: ConnectStepProps) {
  const t = useT()
  const desktop = window.codeIntelligenceDesktop
  const oauthRun = useRef(0)
  const oauthController = useRef<AbortController | null>(null)
  const oauthAttemptRef = useRef<string | null>(null)
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [oauthBusy, setOauthBusy] = useState(false)
  const [oauthAttempt, setOauthAttempt] = useState<NativeOAuthStart | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(
    () => () => {
      oauthRun.current += 1
      oauthController.current?.abort()
      const attemptId = oauthAttemptRef.current
      oauthAttemptRef.current = null
      if (attemptId) void cancelNativeGithubOAuth(attemptId).catch(() => {})
    },
    [],
  )

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

  const handleNativeOAuth = async () => {
    if (!desktop || oauthController.current) return
    const run = ++oauthRun.current
    const controller = new AbortController()
    oauthController.current = controller
    setOauthBusy(true)
    setError(null)
    try {
      const attempt = await startNativeGithubOAuth()
      if (run !== oauthRun.current) {
        await cancelNativeGithubOAuth(attempt.attemptId)
        return
      }
      oauthAttemptRef.current = attempt.attemptId
      setOauthAttempt(attempt)
      let delaySeconds = attempt.pollAfterSeconds
      while (run === oauthRun.current) {
        await wait(delaySeconds * 1_000, controller.signal)
        if (run !== oauthRun.current) return
        const status = await pollNativeGithubOAuth(attempt.attemptId)
        if (run !== oauthRun.current) return
        if (status.status === 'CONNECTED') {
          oauthAttemptRef.current = null
          await onConnected()
          return
        }
        if (status.status !== 'WAITING') {
          oauthAttemptRef.current = null
          setError(status.message)
          return
        }
        delaySeconds = status.pollAfterSeconds
      }
    } catch (err) {
      if (run === oauthRun.current) {
        const attemptId = oauthAttemptRef.current
        oauthAttemptRef.current = null
        if (attemptId) void cancelNativeGithubOAuth(attemptId).catch(() => {})
        setError(err instanceof Error ? err.message : 'Could not start GitHub login.')
      }
    } finally {
      controller.abort()
      if (run === oauthRun.current) {
        oauthController.current = null
        setOauthAttempt(null)
        setOauthBusy(false)
      }
    }
  }

  const handleCancelOAuth = async () => {
    const run = ++oauthRun.current
    oauthController.current?.abort()
    oauthController.current = null
    const attemptId = oauthAttemptRef.current
    oauthAttemptRef.current = null
    setOauthAttempt(null)
    setOauthBusy(false)
    if (!attemptId) return
    try {
      const status = await cancelNativeGithubOAuth(attemptId)
      if (run === oauthRun.current && status.status === 'CONNECTED') await onConnected()
    } catch (err) {
      if (run === oauthRun.current) {
        setError(err instanceof Error ? err.message : 'Could not cancel GitHub login.')
      }
    }
  }

  const handleOpenVerification = async () => {
    if (!desktop || !oauthAttempt) return
    const run = oauthRun.current
    try {
      await desktop.openExternal(oauthAttempt.verificationUri)
    } catch (err) {
      if (run === oauthRun.current) {
        setError(err instanceof Error ? err.message : 'Could not open GitHub verification.')
      }
    }
  }

  const handlePickFolder = async () => {
    if (!desktop) return
    setError(null)
    try {
      const path = await desktop.pickFolder()
      if (path) onLocalPath(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the folder picker.')
    }
  }

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const file = event.dataTransfer.files.item(0)
    if (!desktop || !file) return
    setError(null)
    try {
      const path = await desktop.authorizeDroppedFolder(file)
      if (path) onLocalPath(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not authorize the dropped folder.')
    }
  }

  const oauthControl = me?.oauthAvailable ? (
    desktop ? (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={oauthBusy}
            onClick={() => void handleNativeOAuth()}
            className="inline-flex items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-3 disabled:opacity-60"
          >
            <GithubIcon />
            {oauthBusy ? (oauthAttempt ? 'Waiting for GitHub…' : 'Starting GitHub login…') : t('connect.continue')}
          </button>
          {oauthBusy && (
            <button
              type="button"
              onClick={() => void handleCancelOAuth()}
              className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-muted"
            >
              Cancel
            </button>
          )}
        </div>
        {oauthAttempt && (
          <div className="rounded-md border border-line bg-surface-2 p-3" role="status">
            <p className="text-[12px] text-ink-muted">Enter this one-time code on GitHub, then approve access:</p>
            <p className="my-2 select-all font-mono text-lg font-semibold tracking-wider text-ink" aria-label="GitHub device code">
              {oauthAttempt.userCode}
            </p>
            <button
              type="button"
              onClick={() => void handleOpenVerification()}
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0"
            >
              Open GitHub verification
            </button>
          </div>
        )}
      </div>
    ) : (
      <a
        href={OAUTH_HREF}
        className="inline-flex w-fit items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-3"
      >
        <GithubIcon />
        {t('connect.continue')}
      </a>
    )
  ) : null

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">Choose a project source</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
          GitHub access and local folders are separate. Local analysis does not require a GitHub
          login.
        </p>
      </div>

      {desktop && (
        <section className="rounded-md border border-line bg-surface-1 p-4">
          <h3 className="text-[13px] font-medium text-ink">Open a folder on this computer</h3>
          <p className="mt-1 text-[12px] text-ink-muted">
            Select a Git or non-Git project. Only the selected folder is authorized.
          </p>
          <div
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => void handleDrop(event)}
            className="mt-3 rounded-md border border-dashed border-line-strong bg-surface-2 p-4 text-center"
          >
            <button
              type="button"
              onClick={() => void handlePickFolder()}
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0"
            >
              Choose folder
            </button>
            <p className="mt-2 text-[11px] text-ink-faint">or drop a project folder here</p>
          </div>
        </section>
      )}

      <section className="rounded-md border border-line bg-surface-1 p-4">
        <h3 className="text-[13px] font-medium text-ink">Import from GitHub</h3>
        <p className="mb-3 mt-1 text-[12px] text-ink-muted">
          Public and private repositories use your GitHub authorization.
        </p>
        {oauthControl}
        {!me?.oauthAvailable && (
          <p className="text-[12px] text-ink-muted">
            GitHub OAuth is not configured. Use a personal access token below.
          </p>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-[12px] text-ink-muted">
            Use a personal access token instead
          </summary>
          <form onSubmit={(event) => void handleSubmit(event)} className="mt-3 flex flex-col gap-3">
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
            <button
              type="submit"
              disabled={submitting}
              className="w-fit rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium text-ink disabled:opacity-60"
            >
              {submitting ? t('connect.submitting') : t('connect.submit')}
            </button>
          </form>
        </details>
      </section>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger"
        >
          {error}
        </p>
      )}
    </div>
  )
}
