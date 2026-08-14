import { lazy, Suspense } from 'react'

const NotesPage = lazy(() => import('./NotesPage'))

export default function NotesTab() {
  return (
    <Suspense
      fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">Notes를 불러오는 중…</p>}
    >
      <NotesPage />
    </Suspense>
  )
}
