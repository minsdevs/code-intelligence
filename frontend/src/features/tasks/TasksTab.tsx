import { lazy, Suspense } from 'react'

const TasksPage = lazy(() => import('./TasksPage'))

export default function TasksTab() {
  return (
    <Suspense
      fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">Tasks를 불러오는 중…</p>}
    >
      <TasksPage />
    </Suspense>
  )
}
