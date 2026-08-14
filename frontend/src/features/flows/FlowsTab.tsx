import { lazy, Suspense } from 'react'

const FlowsPage = lazy(() => import('./FlowsPage'))

export default function FlowsTab() {
  return (
    <Suspense fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">Flows를 불러오는 중…</p>}>
      <FlowsPage />
    </Suspense>
  )
}
