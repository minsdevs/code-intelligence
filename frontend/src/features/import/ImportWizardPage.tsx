import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { getMe } from '../../api/auth'
import { useT } from '../../lib/i18n'
import type { MeResponse } from '../../api/types'
import ConnectStep from './ConnectStep'
import ProgressStep from './ProgressStep'
import RepoStep from './RepoStep'
import { WIZARD_STEPS, type WizardStepId } from './wizard'
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

  const [localPath, setLocalPath] = useState<string | null>(initialPath)

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
    if (
      profile.authenticated &&
      !localPath &&
      (profile.credentialKind === 'OAUTH' || profile.credentialKind === 'PAT')
    ) {
      setStep('repo')
    }
  }
  const handleLocalPath = (path: string) => {
    setLocalPath(path)
  }

  const handleImported = (nextProjectId: number, nextJobId: number) => {
    setProjectId(nextProjectId)
    setJobId(nextJobId)
    setStep('progress')
  }

  const handleProgressDone = useCallback(() => {
    if (projectId != null) {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      navigate(`/projects/${projectId}/overview`)
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
              key={localPath}
              path={localPath}
              onStarted={handleImported}
              onCancel={() => setLocalPath(null)}
            />
          )}
          {!showLocalConfirm && step === 'connect' && (
            <ConnectStep me={me} onConnected={handleConnected} onLocalPath={handleLocalPath} />
          )}
          {!showLocalConfirm && step === 'repo' && (
            <RepoStep onImported={handleImported} onUnauthorized={goConnect} />
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
  onStarted,
  onCancel,
}: {
  path: string
  onStarted: (projectId: number, jobId: number) => void
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex max-w-lg flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">로컬 가져오기 확인</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
          폴더를 확인하고 미리보기를 요청하세요. 가져올 파일을 검토한 뒤 별도로 승인하면 분석을
          시작합니다.
        </p>
      </div>

      <div className="rounded-md border border-line bg-surface-2 px-3 py-2.5">
        <span className="text-[11px] text-ink-faint">Project path</span>
        <p className="mt-0.5 break-all font-mono text-[13px] text-ink">{path}</p>
      </div>

      <LocalSourceApproval
        source={{ operation: 'INITIAL', path }}
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
