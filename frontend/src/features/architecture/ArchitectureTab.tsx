import { lazy, Suspense } from 'react'

const ArchitecturePage = lazy(() => import('./ArchitecturePage'))

export default function ArchitectureTab() {
  return (
    <Suspense fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">아키텍처 뷰를 불러오는 중…</p>}>
      <ArchitecturePage />
    </Suspense>
  )
}
