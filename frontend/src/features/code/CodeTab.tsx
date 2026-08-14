import { lazy, Suspense } from 'react'

const CodeExplorerPage = lazy(() => import('./CodeExplorerPage'))

export default function CodeTab() {
  return (
    <Suspense fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">코드 탐색기를 불러오는 중…</p>}>
      <CodeExplorerPage />
    </Suspense>
  )
}
