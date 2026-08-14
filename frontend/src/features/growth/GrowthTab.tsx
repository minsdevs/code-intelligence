import { lazy, Suspense } from 'react'

const GrowthPage = lazy(() => import('./GrowthPage'))

export default function GrowthTab() {
  return (
    <Suspense
      fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">Growth를 불러오는 중…</p>}
    >
      <GrowthPage />
    </Suspense>
  )
}
