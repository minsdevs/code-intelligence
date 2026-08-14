import { lazy, Suspense } from 'react'

const PlaygroundPage = lazy(() => import('./PlaygroundPage'))

export default function PlaygroundTab() {
  return (
    <Suspense
      fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">Playground를 불러오는 중…</p>}
    >
      <PlaygroundPage />
    </Suspense>
  )
}
