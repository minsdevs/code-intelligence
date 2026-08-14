import { lazy, Suspense } from 'react'

const FeaturesPage = lazy(() => import('./FeaturesPage'))

export default function FeaturesTab() {
  return (
    <Suspense fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">Features를 불러오는 중…</p>}>
      <FeaturesPage />
    </Suspense>
  )
}
