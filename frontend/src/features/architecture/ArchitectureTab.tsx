import { lazy, Suspense } from 'react'
import { tt } from '../../lib/i18n-core'

const ArchitecturePage = lazy(() => import('./ArchitecturePage'))

export default function ArchitectureTab() {
  return (
    <Suspense fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">{tt('arch.loadingTab')}</p>}>
      <ArchitecturePage />
    </Suspense>
  )
}
