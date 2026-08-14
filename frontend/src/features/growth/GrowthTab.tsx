import { lazy, Suspense } from 'react'
import { tt } from '../../lib/i18n-core'

const GrowthPage = lazy(() => import('./GrowthPage'))

export default function GrowthTab() {
  return (
    <Suspense fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">{tt('common.loading')}</p>}>
      <GrowthPage />
    </Suspense>
  )
}
