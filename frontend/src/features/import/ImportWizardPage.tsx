import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { getMe } from '../../api/auth'
import { useT } from '../../lib/i18n'
import type { MeResponse } from '../../api/types'
import ConnectStep from './ConnectStep'
import ProgressStep from './ProgressStep'
import RepoStep from './RepoStep'
import { WIZARD_STEPS, type WizardStepId } from './wizard'
import type { FolderGrant } from '../../desktop'
import LocalSourceApproval from '../projects/LocalSourceApproval'

export default function ImportWizardPage() {
  const [searchParams] = useSearchParams()
  const initialPath = searchParams.get('path')
  return <ImportWizard key={initialPath ?? ''} initialPath={initialPath} />
}

function ImportWizard({ initialPath }: { initialPath: string | null }) {
  const t = useT()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<WizardStepId>('connect')
  const [me, setMe] = useState<MeResponse | null>(null)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [projectId, setProjectId] = useState<number | null>(null)
  const [jobId, setJobId] = useState<number | null>(null)

  // A URL path carries no grant; only a configured server root can preview it.
  const [localSource, setLocalSource] = useState<{ path: string; grant?: string } | null>(
    initialPath ? { path: initialPath } : null,
  )
  const localPath = localSource?.path ?? null

  const goConnect = useCallback(() => {
    setStep('connect')
    setProjectId(null)
    setJobId(null)
    void getMe()
      .then(setMe)
      .catch(() => setMe(null))
  }, [])

  useEffect(() => {
    let cancelled = false
    void getMe()
      .then((profile) => {
        if (cancelled) return
        setMe(profile)
        if (
          profile.authenticated &&
          !localPath &&
          (profile.credentialKind === 'OAUTH' || profile.credentialKind === 'PAT')
        ) {
          setStep('repo')
        }
      })
      .catch(() => {
        if (!cancelled) setMe(null)
      })
      .finally(() => {
        if (!cancelled) setBootstrapping(false)
      })
    return () => {
      cancelled = true
    }
  }, [localPath])

  const handleConnected = async () => {
    const profile = await getMe()
    setMe(profile)
    await queryClient.invalidateQueries({ queryKey: ['github-connection'] })
    await queryClient.invalidateQueries({ queryKey: ['account-profile'] })
    if (
      profile.authenticated &&
      !localPath &&
      (profile.credentialKind === 'OAUTH' || profile.credentialKind === 'PAT')
    ) {
      setStep('repo')
    }
  }
  const handleLocalPath = (selection: FolderGrant) => {
    setLocalSource({ path: selection.path, grant: selection.grant })
  }

  const handleImported = (nextProjectId: number, nextJobId: number) => {
    setProjectId(nextProjectId)
    setJobId(nextJobId)
    setStep('progress')
  }

  const handleProgressDone = useCallback(() => {
    if (projectId != null) {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      // The workspace moves focus to its heading and announces the finished analysis.
      navigate(`/projects/${projectId}/overview`, { state: { analysisFinished: true } })
    }
  }, [navigate, projectId, queryClient])

  // If a local path is provided and the user is authenticated, show the local import confirmation
  const showLocalConfirm = localPath && me?.authenticated && step !== 'progress'

  return (
    <div className="flex flex-1 flex-col px-6 py-5">
      <header className="mb-5">
        <p className="text-[12px] text-ink-faint">Projects / Import</p>
        <h1 className="mt-0.5 text-[15px] font-semibold text-ink">
          {localPath ? 'Import local project' : 'Import repository'}
        </h1>
      </header>

      {!localPath && (
        <ol aria-label="Import steps" className="mb-6 flex gap-1">
          {WIZARD_STEPS.map((item, index) => {
            const current = item.id === step
            const currentIndex = WIZARD_STEPS.findIndex((entry) => entry.id === step)
            const done = index < currentIndex
            return (
              <li
                key={item.id}
                aria-current={current ? 'step' : undefined}
                className={`flex min-w-0 flex-1 flex-col gap-1 border-b-2 pb-2 ${
                  current ? 'border-accent' : 'border-line'
                }`}
              >
                <span className="font-mono text-[10px] tracking-wide text-ink-faint">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className={`text-[12px] ${current || done ? 'text-ink' : 'text-ink-muted'}`}>
                  {item.label}
                </span>
              </li>
            )
          })}
        </ol>
      )}

      {bootstrapping ? (
        <p className="text-[13px] text-ink-muted">{t('workspace.checking')}</p>
      ) : (
        <>
          {showLocalConfirm && (
            <LocalImportConfirm
              key={`${localPath}:${localSource?.grant ?? ''}`}
              path={localPath}
              grant={localSource?.grant}
              onStarted={handleImported}
              onCancel={() => setLocalSource(null)}
            />
          )}
          {!showLocalConfirm && step === 'connect' && (
            <ConnectStep me={me} onConnected={handleConnected} onLocalPath={handleLocalPath} />
          )}
          {!showLocalConfirm && step === 'repo' && (
            <RepoStep credentialKind={me?.credentialKind ?? null} onImported={handleImported} onUnauthorized={goConnect} />
          )}
          {step === 'progress' && jobId != null && (
            <ProgressStep
              key={jobId}
              jobId={jobId}
              onDone={handleProgressDone}
              onUnauthorized={goConnect}
              onSourcePreviewRequired={(id) => navigate(`/projects/${id}`)}
            />
          )}
        </>
      )}
    </div>
  )
}

/** A supplied path starts no operation until the user requests and approves a preview. */
function LocalImportConfirm({
  path,
  grant,
  onStarted,
  onCancel,
}: {
  path: string
  grant?: string
  onStarted: (projectId: number, jobId: number) => void
  onCancel: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  // A chosen folder replaces the source picker; focus would otherwise fall to <body>.
  useEffect(() => {
    heading.current?.focus()
  }, [])
  return (
    <div className="flex max-w-lg flex-col gap-4">
      <div>
        <h2 ref={heading} tabIndex={-1} className="text-[15px] font-semibold text-ink">
          {t('import.localConfirmTitle')}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
          {t('import.localConfirmDesc')}
        </p>
      </div>

      <div className="rounded-md border border-line bg-surface-2 px-3 py-2.5">
        <span className="text-[11px] text-ink-faint">Project path</span>
        <p className="mt-0.5 break-all font-mono text-[13px] text-ink">{path}</p>
      </div>

      <LocalSourceApproval
        source={{ operation: 'INITIAL', path, grant }}
        onStarted={onStarted}
        onBusyChange={setBusy}
      />

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
