import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { FeatureEvidenceView } from '../api/types'
import EvidenceList from './EvidenceList'

describe('EvidenceList source navigation', () => {
  it.each([
    { context: 'legacy unknown', metadata: {} },
    { context: 'known historical', metadata: { snapshotId: 69, evidenceId: 901, sourceState: 'LEGACY_SOURCE_UNVERIFIED' as const } },
  ])('keeps $context evidence on the source-context navigation path', ({ metadata }) => {
    const evidence: FeatureEvidenceView = {
      filePath: 'src/App.java', lineStart: 12, lineEnd: 14, excerpt: 'historical source excerpt', ...metadata,
    }
    const onOpen = vi.fn()
    render(<EvidenceList projectId={7} evidences={[evidence]} onOpen={onOpen} />)

    expect(screen.queryByRole('button', { name: /Open in IDE/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Select IDE' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /src\/App.java:12/ }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('src/App.java', 12, evidence)
  })
})
