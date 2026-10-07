import { useEffect, useRef, useState } from 'react'
import {
  cancelNativeGithubOAuth,
  pollNativeGithubOAuth,
  startNativeGithubOAuth,
  type NativeOAuthStart,
} from '../../api/desktopAuth'
import { GithubIcon } from '../../components/icons'
import { useT } from '../../lib/i18n'

const OAUTH_HREF = '/oauth2/authorization/github'

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

export default function GithubConnectControl({
  oauthAvailable,
  onConnected,
}: {
  oauthAvailable: boolean
  onConnected: () => Promise<void>
}) {
  const t = useT()
  const desktop = window.codeIntelligenceDesktop
  const oauthRun = useRef(0)
  const oauthController = useRef<AbortController | null>(null)
  const oauthAttemptRef = useRef<string | null>(null)
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

  const oauthControl = oauthAvailable ? (
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
            {oauthBusy
              ? oauthAttempt
                ? 'Waiting for GitHub…'
                : 'Starting GitHub login…'
              : t('connect.continue')}
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
            <p className="text-[12px] text-ink-muted">
              Enter this one-time code on GitHub, then approve access:
            </p>
            <p
              className="my-2 select-all font-mono text-lg font-semibold tracking-wider text-ink"
              aria-label="GitHub device code"
            >
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
  ) : (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled
        className="w-fit rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-muted opacity-60"
      >
        {t('connect.continue')}
      </button>
      <p className="text-[12px] text-ink-muted">{t('connect.oauthUnavailable')}</p>
    </div>
  )

  return (
    <div className="flex flex-col gap-2">
      {oauthControl}
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
