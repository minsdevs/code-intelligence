import { useQuery } from '@tanstack/react-query'
import { getCoverage } from '../../api/coverage'
import type { CoverageReport, LocalImportSummary } from '../../api/types'

type Props = { projectId: number }

const stepLabels = new Map([
  ['done', '단계 종료 · 파일별 결과 미측정'],
  ['failed', '단계 실패'],
  ['running', '단계 실행 중'],
  ['pending', '단계 대기'],
  ['skipped', '단계 건너뜀'],
])

const importExclusionLabels = new Map([
  ['GENERATED_DIRECTORY', '생성물·의존성 폴더'],
  ['SECRET_PATH', '민감한 파일·폴더 이름'],
  ['IGNORED', '제외 규칙에 해당하는 항목'],
  ['BINARY', '바이너리 파일'],
  ['OVERSIZED', '크기 한도를 넘은 파일'],
  ['FILE_LIMIT', '파일 수 한도를 넘은 파일'],
  ['SYMLINK', '심볼릭 링크'],
  ['HARD_LINK', '하드 링크'],
  ['SECRET_CONTENT', '민감한 내용이 감지된 파일'],
])
const importSummaryFields = new Set(['schemaVersion', 'policyVersion', 'acceptedFiles', 'bytesRead', 'excludedEntriesByReason'])

function inventoryCount(count: number | undefined): number | string {
  return count != null && Number.isSafeInteger(count) && count >= 0 ? count : '알 수 없음'
}

function isBoundedCount(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

function validatedLocalImport(value: unknown): LocalImportSummary | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  const summary = value as Record<string, unknown>
  const fields = Object.keys(summary)
  if (fields.length !== importSummaryFields.size || fields.some((field) => !importSummaryFields.has(field))) return null
  if (summary.schemaVersion !== 1 || summary.policyVersion !== 'local-ingest-v1'
    || !isBoundedCount(summary.acceptedFiles, 50_000) || !isBoundedCount(summary.bytesRead, 536_870_912)) return null
  const reasons = summary.excludedEntriesByReason
  if (reasons == null || typeof reasons !== 'object' || Array.isArray(reasons)) return null
  let encounteredEntries = summary.acceptedFiles
  for (const [reason, count] of Object.entries(reasons)) {
    if (!importExclusionLabels.has(reason) || !isBoundedCount(count, 200_000)) return null
    encounteredEntries += count
    if (encounteredEntries > 200_000) return null
  }
  return value as LocalImportSummary
}

function LocalImportDetails({ summary }: { summary: LocalImportSummary | null }) {
  return (
    <section aria-label="로컬 가져오기 기록">
      <h4 className="font-medium mb-1">로컬 가져오기 기록</h4>
      {summary == null ? (
        <p className="text-xs text-gray-500">가져온 파일 수와 제외 수량 기록을 확인할 수 없습니다.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <dt>기록된 가져온 파일</dt><dd>{summary.acceptedFiles.toLocaleString('ko-KR')}개</dd>
            <dt>처리 중 읽은 바이트</dt><dd>{summary.bytesRead.toLocaleString('ko-KR')}바이트</dd>
          </dl>
          <p className="mt-2 text-xs text-gray-500">가져오기 중 제외된 항목입니다. 제외된 폴더는 항목 1개로 기록되며, 내부 파일 수는 측정되지 않았습니다.</p>
          {Object.keys(summary.excludedEntriesByReason).length === 0 ? (
            <p className="mt-1 text-xs text-gray-500">기록된 제외 항목이 없습니다.</p>
          ) : (
            <dl className="mt-1 grid grid-cols-2 gap-2 text-xs">
              {Array.from(importExclusionLabels).map(([reason, label]) => {
                const count = (summary.excludedEntriesByReason as Record<string, number | undefined>)[reason]
                return count == null ? null : (
                  <div key={reason} className="contents">
                    <dt>{label}</dt><dd>{count.toLocaleString('ko-KR')}개</dd>
                  </div>
                )
              })}
            </dl>
          )}
        </>
      )}
    </section>
  )
}

export function CoveragePanel({ projectId }: Props) {
  const { data, isLoading, error } = useQuery<CoverageReport>({
    queryKey: ['coverage', projectId],
    queryFn: () => getCoverage(projectId),
  })

  if (isLoading) return <div className="text-sm text-gray-500">분석 범위 보고서 로딩 중...</div>
  if (error || !data) {
    return <p role="alert" className="text-sm text-amber-700">분석 범위 정보를 불러올 수 없습니다. 분석 결과의 완전성은 알 수 없습니다.</p>
  }

  const { fileCoverage, languageCoverage, analyzerStatuses } = data
  const hasInventoryContract = data.measurementStatus === 'LEGACY_UNMEASURED'
  const countSkips = hasInventoryContract ? fileCoverage.skippedForCount : null
  const sizeSkips = hasInventoryContract ? fileCoverage.skippedForSize : null

  return (
    <section aria-label="분석 범위 보고서" className="space-y-4 rounded border p-4 text-sm">
      <h3 className="font-semibold text-base">분석 범위 보고서</h3>
      <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">
        분석 범위 측정 불가. 파일별 분석 성공·실패 수와 결과 완전성은 알 수 없습니다.
        {hasInventoryContract ? ' 이 스냅샷에는 파일별 분석 결과가 기록되어 있지 않습니다.' : ' 측정 상태가 제공되지 않았습니다.'}
      </p>

      <section>
        <h4 className="font-medium mb-1">파일 목록</h4>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <span>목록에 등록된 파일</span><span>{inventoryCount(fileCoverage.inventoriedFiles)}</span>
          {countSkips != null && Number.isSafeInteger(countSkips) && countSkips > 0 && (
            <><span className="text-amber-600">파일 수 한도로 제외된 기록</span><span className="text-amber-600">{countSkips}</span></>
          )}
          {sizeSkips != null && Number.isSafeInteger(sizeSkips) && sizeSkips > 0 && (
            <><span className="text-amber-600">파일 크기 한도로 제외된 기록</span><span className="text-amber-600">{sizeSkips}</span></>
          )}
        </div>
      </section>

      <LocalImportDetails summary={validatedLocalImport(data.localImport)} />

      {languageCoverage.length > 0 && (
        <section>
          <h4 className="font-medium mb-1">언어별 파일 목록</h4>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500">
                <th scope="col">언어</th><th scope="col">등록된 파일</th><th scope="col">분석 성공</th><th scope="col">분석 실패</th>
              </tr>
            </thead>
            <tbody>
              {languageCoverage.map((language) => (
                <tr key={language.language}>
                  <th scope="row" className="text-left font-normal">{language.language}</th>
                  <td>{inventoryCount(language.inventoriedFiles)}</td>
                  <td>알 수 없음</td>
                  <td>알 수 없음</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h4 className="font-medium mb-1">기록된 분석기 단계</h4>
        <p className="mb-1 text-xs text-gray-500">단계가 종료되어도 파일별 분석 여부와 성공 건수는 알 수 없습니다.</p>
        {analyzerStatuses.length === 0 && <p className="text-xs text-gray-500">알 수 없음</p>}
        <ul className="space-y-1 text-xs">
          {analyzerStatuses.map((analyzer) => (
            <li key={analyzer.name} className="flex items-center gap-2">
              <span className={analyzer.status === 'failed' ? 'text-red-600' : 'text-gray-400'} aria-hidden="true">●</span>
              <span>{analyzer.name}</span>
              <span className="text-gray-500">{stepLabels.get(analyzer.status) ?? '알 수 없음'}</span>
              {analyzer.status === 'failed' && analyzer.failureReason && <span className="text-red-500 text-[10px]">({analyzer.failureReason})</span>}
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-gray-500">언어·프레임워크별 공개 지원 범위는 검증되지 않았습니다.</p>
    </section>
  )
}
