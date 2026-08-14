import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getMe } from '../../api/auth'
import type { MeResponse } from '../../api/types'
import AreasStep from './AreasStep'
import ConnectStep from './ConnectStep'
import ProgressStep from './ProgressStep'
import RepoStep from './RepoStep'
import { WIZARD_STEPS, type WizardStepId } from './wizard'

export default function ImportWizardPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<WizardStepId>('connect')
  const [me, setMe] = useState<MeResponse | null>(null)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [projectId, setProjectId] = useState<number | null>(null)
  const [jobId, setJobId] = useState<number | null>(null)

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
  }, [])

  const handleConnected = async () => {
    const profile = await getMe()
    setMe(profile)
    if (profile.authenticated) {
      setStep('repo')
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

  return (
    <div className="flex flex-1 flex-col px-6 py-5">
      <header className="mb-5">
        <p className="text-[12px] text-ink-faint">Projects / Import</p>
        <h1 className="mt-0.5 text-[15px] font-semibold text-ink">Import repository</h1>
      </header>

      <ol aria-label="Import 단계" className="mb-6 flex gap-1">
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

      {bootstrapping ? (
        <p className="text-[13px] text-ink-muted">세션을 확인하는 중…</p>
      ) : (
        <>
          {step === 'connect' && <ConnectStep me={me} onConnected={handleConnected} />}
          {step === 'repo' && (
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
