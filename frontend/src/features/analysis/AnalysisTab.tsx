import { lazy, Suspense } from 'react'

const AnalysisPage = lazy(() => import('./AnalysisPage'))

export default function AnalysisTab() {
  return (
    <Suspense fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">Analysis를 불러오는 중…</p>}>
      <AnalysisPage />
    </Suspense>
  )
}
