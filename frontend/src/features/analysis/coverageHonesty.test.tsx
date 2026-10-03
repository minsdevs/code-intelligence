import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCoverage } from '../../api/coverage'
import { compareSnapshots, listSnapshots } from '../../api/snapshots'
import type { CoverageReport, LocalImportSummary, SnapshotComparison } from '../../api/types'
import { CoveragePanel } from './CoveragePanel'
import SnapshotComparisonPanel from './SnapshotComparisonPanel'

vi.mock('../../api/coverage', () => ({ getCoverage: vi.fn() }))
vi.mock('../../api/snapshots', () => ({ listSnapshots: vi.fn(), compareSnapshots: vi.fn() }))

function report(inventoriedFiles = 7): CoverageReport {
  return {
    measurementStatus: 'LEGACY_UNMEASURED',
    supportStatus: 'UNVERIFIED',
    fileCoverage: {
      inventoriedFiles,
      discoveredFiles: inventoriedFiles,
      analyzedFiles: null,
      skippedForCount: null,
      skippedForSize: null,
      skippedBinary: null,
    },
    languageCoverage: [{
      language: 'kotlin', inventoriedFiles, total: inventoriedFiles, analyzed: null, skipped: null, failed: null,
    }],
    analyzerStatuses: [{ name: 'Java Analyzer', status: 'done', failureReason: null }],
    excludedFolders: [],
    partialResults: {
      status: 'UNKNOWN', featuresPartial: false, flowsPartial: false, graphPartial: false,
      reason: 'Per-file outcomes were not recorded.',
    },
    retryableIssues: [],
    unsupportedItems: [],
  }
}

function legacyReport(): CoverageReport {
  const data = report()
  delete data.measurementStatus
  delete data.supportStatus
  delete data.fileCoverage.inventoriedFiles
  delete data.partialResults.status
  data.fileCoverage.analyzedFiles = 888
  data.fileCoverage.discoveredFiles = 888
  data.languageCoverage = [{ language: 'kotlin', total: 888, analyzed: 888, skipped: 0, failed: 0 }]
  data.partialResults.reason = 'Some analyzers are disabled; results may be incomplete.'
  return data
}

function localImport(): LocalImportSummary {
  return {
    schemaVersion: 1,
    policyVersion: 'local-ingest-v1',
    acceptedFiles: 7,
    bytesRead: 1024,
    excludedEntriesByReason: {
      GENERATED_DIRECTORY: 1, SECRET_PATH: 2, IGNORED: 3, BINARY: 4, OVERSIZED: 5,
      FILE_LIMIT: 6, SYMLINK: 7, HARD_LINK: 8, SECRET_CONTENT: 9,
    },
  }
}

function renderQuery(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
}

function comparison(before: CoverageReport, after: CoverageReport): SnapshotComparison {
  const empty = { added: [], removed: [], changed: [] }
  return {
    baseSnapshotId: 1,
    targetSnapshotId: 2,
    features: empty,
    flows: empty,
    findings: empty,
    structure: { nodes: empty, relationships: empty },
    coverage: { before, after },
    renameCandidates: [],
    regressionWarnings: ['The target snapshot has a recorded analyzer step failure; per-file coverage remains unknown.'],
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(listSnapshots).mockResolvedValue([
    { id: 2, commitSha: 'bbbbbbbb', status: 'READY', analyzedAt: null },
    { id: 1, commitSha: 'aaaaaaaa', status: 'READY', analyzedAt: null },
  ])
})

describe('coverage measurement honesty', () => {
  it('shows inventory while ignoring contradictory analyzed, success, and zero-failure counters', async () => {
    const data = report()
    data.fileCoverage.analyzedFiles = 777
    data.languageCoverage[0].analyzed = 777
    data.languageCoverage[0].failed = 0
    vi.mocked(getCoverage).mockResolvedValue(data)
    renderQuery(<CoveragePanel projectId={7} />)

    const panel = await screen.findByRole('region', { name: '분석 범위 보고서' })
    expect(within(panel).getByText(/분석 범위 측정 불가/)).toBeInTheDocument()
    const language = within(panel).getByRole('row', { name: /kotlin/ })
    expect(within(language).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['7', '알 수 없음', '알 수 없음'])
    expect(within(panel).queryByText('777')).not.toBeInTheDocument()
    expect(within(panel).queryByText('0')).not.toBeInTheDocument()
    expect(within(panel).queryByText(/\d+%/)).not.toBeInTheDocument()
    expect(within(panel).getByText(/공개 지원 범위는 검증되지 않았습니다/)).toBeInTheDocument()
    expect(within(panel).getByText('단계 종료 · 파일별 결과 미측정')).toBeInTheDocument()
  })

  it('treats a missing measurement status and legacy active or disabled labels as unknown', async () => {
    const data = legacyReport()
    data.analyzerStatuses = [
      { name: 'Java Analyzer', status: 'active', failureReason: null },
      { name: 'TypeScript Analyzer', status: 'disabled', failureReason: 'current configuration only' },
    ]
    vi.mocked(getCoverage).mockResolvedValue(data)
    renderQuery(<CoveragePanel projectId={7} />)

    const panel = await screen.findByRole('region', { name: '분석 범위 보고서' })
    expect(within(panel).getByText(/측정 상태가 제공되지 않았습니다/)).toBeInTheDocument()
    const language = within(panel).getByRole('row', { name: /kotlin/ })
    expect(within(language).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['알 수 없음', '알 수 없음', '알 수 없음'])
    expect(within(panel).queryByText('888')).not.toBeInTheDocument()
    expect(within(panel).queryByText(/^(활성|비활성)$/)).not.toBeInTheDocument()
    expect(within(panel).queryByText(/current configuration|Some analyzers are disabled/)).not.toBeInTheDocument()
    for (const row of within(panel).getAllByRole('listitem')) {
      expect(within(row).getByText('알 수 없음')).toBeInTheDocument()
    }
  })

  it('preserves explicit recorded failures even in old responses without a measurement status', async () => {
    const data = legacyReport()
    data.analyzerStatuses = [{ name: 'TypeScript Analyzer', status: 'failed', failureReason: 'fixture parser failure' }]
    vi.mocked(getCoverage).mockResolvedValue(data)
    renderQuery(<CoveragePanel projectId={7} />)

    expect(await screen.findByText('단계 실패')).toBeInTheDocument()
    expect(screen.getByText('(fixture parser failure)')).toBeInTheDocument()
    expect(screen.getByText(/분석 범위 측정 불가/)).toBeInTheDocument()
    expect(screen.queryByText('888')).not.toBeInTheDocument()
  })

  it('shows zero inventory without manufacturing measured zero outcomes', async () => {
    vi.mocked(getCoverage).mockResolvedValue(report(0))
    renderQuery(<CoveragePanel projectId={7} />)
    const language = await screen.findByRole('row', { name: /kotlin/ })
    expect(within(language).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['0', '알 수 없음', '알 수 없음'])
  })

  it('labels recorded inventory omissions separately and leaves missing counts unreported', async () => {
    const data = report()
    data.fileCoverage.skippedForCount = 3
    vi.mocked(getCoverage).mockResolvedValue(data)
    renderQuery(<CoveragePanel projectId={7} />)
    expect(await screen.findByText('파일 수 한도로 제외된 기록')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.queryByText('파일 크기 한도로 제외된 기록')).not.toBeInTheDocument()
  })

  it('maps an unfamiliar step value to unknown', async () => {
    const data = report()
    data.analyzerStatuses[0].status = 'constructor'
    vi.mocked(getCoverage).mockResolvedValue(data)
    renderQuery(<CoveragePanel projectId={7} />)
    const row = await screen.findByRole('listitem')
    expect(within(row).getByText('알 수 없음')).toBeInTheDocument()
  })

  it('keeps measurement unavailability visible when the coverage request fails', async () => {
    vi.mocked(getCoverage).mockRejectedValue(new Error('fixture unavailable'))
    renderQuery(<CoveragePanel projectId={7} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('분석 결과의 완전성은 알 수 없습니다')
  })
})

describe('snapshot comparison inventory', () => {
  it.each([
    { name: 'new', before: report(7), after: report(9), expected: 'Inventory: 7 → 9 files. Analysis coverage unmeasured.' },
    { name: 'legacy', before: legacyReport(), after: legacyReport(), expected: 'Inventory: unknown → unknown files. Analysis coverage unmeasured.' },
    { name: 'mixed', before: report(7), after: legacyReport(), expected: 'Inventory: 7 → unknown files. Analysis coverage unmeasured.' },
  ])('labels $name responses as inventory and keeps analysis coverage unmeasured', async ({ before, after, expected }) => {
    vi.mocked(compareSnapshots).mockResolvedValue(comparison(before, after))
    renderQuery(<SnapshotComparisonPanel projectId={7} />)

    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(screen.queryByText(/analyzed files|888/)).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('recorded analyzer step failure')
  })
})

describe('recorded local import counts', () => {
  it('uses safe Korean exclusion labels and preserves unmeasured analysis outcomes', async () => {
    const data = report()
    data.localImport = localImport()
    vi.mocked(getCoverage).mockResolvedValue(data)
    renderQuery(<CoveragePanel projectId={7} />)

    const imported = await screen.findByRole('region', { name: '로컬 가져오기 기록' })
    expect(within(imported).getByText('기록된 가져온 파일').nextElementSibling).toHaveTextContent('7개')
    expect(within(imported).getByText('처리 중 읽은 바이트').nextElementSibling).toHaveTextContent('1,024바이트')
    for (const [label, count] of [
      ['생성물·의존성 폴더', 1], ['민감한 파일·폴더 이름', 2], ['제외 규칙에 해당하는 항목', 3],
      ['바이너리 파일', 4], ['크기 한도를 넘은 파일', 5], ['파일 수 한도를 넘은 파일', 6],
      ['심볼릭 링크', 7], ['하드 링크', 8], ['민감한 내용이 감지된 파일', 9],
    ] as const) {
      expect(within(imported).getByText(label).nextElementSibling).toHaveTextContent(`${count}개`)
    }
    expect(within(imported).getByText(/제외된 폴더는 항목 1개로 기록되며, 내부 파일 수는 측정되지 않았습니다/)).toBeInTheDocument()
    expect(imported).not.toHaveTextContent(/GENERATED_DIRECTORY|SECRET_CONTENT|schemaVersion|local-ingest-v1/)
    expect(screen.getByText(/분석 범위 측정 불가/)).toBeInTheDocument()
    const language = screen.getByRole('row', { name: /kotlin/ })
    expect(within(language).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['7', '알 수 없음', '알 수 없음'])
  })

  it.each([null, undefined])('keeps %s local import evidence unavailable rather than reporting zero', async (summary) => {
    const data = report()
    data.localImport = summary
    vi.mocked(getCoverage).mockResolvedValue(data)
    renderQuery(<CoveragePanel projectId={7} />)
    const imported = await screen.findByRole('region', { name: '로컬 가져오기 기록' })
    expect(within(imported).getByText('가져온 파일 수와 제외 수량 기록을 확인할 수 없습니다.')).toBeInTheDocument()
    expect(within(imported).queryByText('기록된 가져온 파일')).not.toBeInTheDocument()
    expect(within(imported).queryByText('0개')).not.toBeInTheDocument()
  })

  it.each([
    { name: 'unknown reason', summary: { ...localImport(), excludedEntriesByReason: { '/private/fixture/.env': 2 } } },
    { name: 'extra raw path field', summary: { ...localImport(), path: '/private/fixture/.env' } },
    { name: 'unknown schema', summary: { ...localImport(), schemaVersion: 2 } },
    { name: 'missing policy', summary: { ...localImport(), policyVersion: undefined } },
    { name: 'string count', summary: { ...localImport(), acceptedFiles: '7' } },
    { name: 'file cap', summary: { ...localImport(), acceptedFiles: 50001 } },
    { name: 'byte cap', summary: { ...localImport(), bytesRead: 536870913 } },
    { name: 'combined entry cap', summary: { ...localImport(), excludedEntriesByReason: { IGNORED: 199994 } } },
    { name: 'negative reason count', summary: { ...localImport(), excludedEntriesByReason: { BINARY: -1 } } },
  ])('treats $name as unavailable without displaying raw evidence', async ({ summary }) => {
    const data = report()
    data.localImport = summary as LocalImportSummary
    vi.mocked(getCoverage).mockResolvedValue(data)
    renderQuery(<CoveragePanel projectId={7} />)
    const imported = await screen.findByRole('region', { name: '로컬 가져오기 기록' })
    expect(within(imported).getByText('가져온 파일 수와 제외 수량 기록을 확인할 수 없습니다.')).toBeInTheDocument()
    expect(imported).not.toHaveTextContent(/private|fixture|schemaVersion|local-ingest|199994|536870913/)
    expect(within(imported).queryByText('기록된 가져온 파일')).not.toBeInTheDocument()
  })

  it('distinguishes explicitly recorded zero imports from missing evidence', async () => {
    const data = report(0)
    data.localImport = { ...localImport(), acceptedFiles: 0, bytesRead: 0, excludedEntriesByReason: {} }
    vi.mocked(getCoverage).mockResolvedValue(data)
    renderQuery(<CoveragePanel projectId={7} />)
    const imported = await screen.findByRole('region', { name: '로컬 가져오기 기록' })
    expect(within(imported).getByText('기록된 가져온 파일').nextElementSibling).toHaveTextContent('0개')
    expect(within(imported).getByText('기록된 제외 항목이 없습니다.')).toBeInTheDocument()
    expect(screen.getByText(/분석 범위 측정 불가/)).toBeInTheDocument()
  })
})
