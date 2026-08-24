import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getMe } from '../../api/auth'
import { createLocalProject } from '../../api/projects'
import { useT } from '../../lib/i18n'
import type { MeResponse } from '../../api/types'
import AreasStep from './AreasStep'
import ConnectStep from './ConnectStep'
import ProgressStep from './ProgressStep'
import RepoStep from './RepoStep'
import { WIZARD_STEPS, type WizardStepId } from './wizard'

export default function ImportWizardPage() {
  const t = useT()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [step, setStep] = useState<WizardStepId>('connect')
  const [me, setMe] = useState<MeResponse | null>(null)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [projectId, setProjectId] = useState<number | null>(null)
  const [jobId, setJobId] = useState<number | null>(null)

  // Local import path from ?path= query parameter (URL-decoded by the browser)
  const localPath = searchParams.get('path')
  const [localImporting, setLocalImporting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

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
        if (profile.authenticated) {
          // If local path is provided, stay on the local confirm step
          if (!localPath) {
            setStep('repo')
          }
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
    if (profile.authenticated) {
      if (!localPath) {
        setStep('repo')
      }
    }
  }

  const handleLocalImport = async () => {
    if (!localPath) return
    setLocalImporting(true)
    setLocalError(null)
    try {
      const created = await createLocalProject(localPath)
      setProjectId(created.project.id)
      setJobId(created.jobId)
      setStep('progress')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setLocalError(message)
    } finally {
      setLocalImporting(false)
    }
  }

  const handleImported = (nextProjectId: number, nextJobId: number) => {
    setProjectId(nextProjectId)
    setJobId(nextJobId)
    setStep('progress')
  }

  const handleProgressDone = useCallback(() => {
    setStep('areas')
  }, [])

  // If a local path is provided and the user is authenticated, show the local import confirmation
  const showLocalConfirm = localPath && me?.authenticated && step !== 'progress' && step !== 'areas'

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
              path={localPath}
              importing={localImporting}
              error={localError}
              onConfirm={() => void handleLocalImport()}
              onCancel={() => navigate('/projects')}
            />
          )}
          {!showLocalConfirm && step === 'connect' && (
            <ConnectStep me={me} onConnected={handleConnected} />
          )}
          {!showLocalConfirm && step === 'repo' && (
            <RepoStep onImported={handleImported} onUnauthorized={goConnect} />
          )}
          {step === 'progress' && jobId != null && (
            <ProgressStep jobId={jobId} onDone={handleProgressDone} onUnauthorized={goConnect} />
          )}
          {step === 'areas' && projectId != null && (
            <AreasStep
              projectId={projectId}
              onSaved={() => navigate(`/projects/${projectId}`)}
              onUnauthorized={goConnect}
            />
          )}
        </>
      )}
    </div>
  )
}

/** Confirmation dialog for importing a local project path from external tools. */
function LocalImportConfirm({
  path,
  importing,
  error,
  onConfirm,
  onCancel,
}: {
  path: string
  importing: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex max-w-lg flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">Confirm local import</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
          An external tool wants to import the following local project for analysis. Please review the path and confirm.
        </p>
      </div>

      <div className="rounded-md border border-line bg-surface-2 px-3 py-2.5">
        <span className="text-[11px] text-ink-faint">Project path</span>
        <p className="mt-0.5 break-all font-mono text-[13px] text-ink">{path}</p>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={importing}
          onClick={onConfirm}
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 disabled:opacity-60"
        >
          {importing ? 'Importing…' : 'Import & Analyze'}
        </button>
        <button
          type="button"
          disabled={importing}
          onClick={onCancel}
          className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
