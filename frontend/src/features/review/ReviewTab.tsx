import { lazy, Suspense } from 'react'

const ReviewPage = lazy(() => import('./ReviewPage'))

export default function ReviewTab() {
  return (
    <Suspense
      fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">Review를 불러오는 중…</p>}
    >
      <ReviewPage />
    </Suspense>
  )
}
