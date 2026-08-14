import { lazy, Suspense } from 'react'
import { tt } from '../../lib/i18n-core'

const FlowsPage = lazy(() => import('./FlowsPage'))

export default function FlowsTab() {
  return (
    <Suspense fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">{tt('common.loading')}</p>}>
      <FlowsPage />
    </Suspense>
  )
}
