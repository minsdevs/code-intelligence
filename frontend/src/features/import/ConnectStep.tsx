import { useState, type DragEvent, type FormEvent } from 'react'
import { registerPat } from '../../api/auth'
import { ApiError } from '../../api/client'
import type { MeResponse } from '../../api/types'
import GithubConnectControl from '../settings/GithubConnectControl'
import { useT } from '../../lib/i18n'


type ConnectStepProps = {
  me: MeResponse | null
  onConnected: () => Promise<void>
  onLocalPath: (path: string) => void
}

export default function ConnectStep({ me, onConnected, onLocalPath }: ConnectStepProps) {
  const t = useT()
  const desktop = window.codeIntelligenceDesktop
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
        <GithubConnectControl oauthAvailable={Boolean(me?.oauthAvailable)} onConnected={onConnected} />

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
