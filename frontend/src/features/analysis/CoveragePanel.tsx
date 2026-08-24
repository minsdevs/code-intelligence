import { useQuery } from '@tanstack/react-query'
import { getCoverage } from '../../api'
import type { CoverageReport } from '../../api'

type Props = { projectId: number }

export function CoveragePanel({ projectId }: Props) {
  const { data, isLoading, error } = useQuery<CoverageReport>({
    queryKey: ['coverage', projectId],
    queryFn: () => getCoverage(projectId),
  })

  if (isLoading) return <div className="text-sm text-gray-500">분석 범위 보고서 로딩 중...</div>
  if (error || !data) return null

  const { fileCoverage, languageCoverage, analyzerStatuses, partialResults, retryableIssues, unsupportedItems } = data

  return (
    <div className="space-y-4 rounded border p-4 text-sm">
      <h3 className="font-semibold text-base">분석 범위 보고서</h3>

      {/* File coverage */}
      <section>
        <h4 className="font-medium mb-1">파일 범위</h4>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <span>발견한 파일</span><span>{fileCoverage.discoveredFiles}</span>
          <span>분석한 파일</span><span>{fileCoverage.analyzedFiles}</span>
          {fileCoverage.skippedForCount > 0 && (
            <><span className="text-amber-600">파일 수 초과로 건너뜀</span><span className="text-amber-600">{fileCoverage.skippedForCount}</span></>
          )}
          {fileCoverage.skippedForSize > 0 && (
            <><span className="text-amber-600">파일 크기 초과로 건너뜀</span><span className="text-amber-600">{fileCoverage.skippedForSize}</span></>
          )}
        </div>
      </section>

      {/* Language coverage */}
      {languageCoverage.length > 0 && (
        <section>
          <h4 className="font-medium mb-1">언어별 분석</h4>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500">
                <th>언어</th><th>전체</th><th>분석</th><th>건너뜀</th><th>실패</th>
              </tr>
            </thead>
            <tbody>
              {languageCoverage.map((lc) => (
                <tr key={lc.language}>
                  <td>{lc.language}</td>
                  <td>{lc.total}</td>
                  <td>{lc.analyzed}</td>
                  <td className={lc.skipped > 0 ? 'text-amber-600' : ''}>{lc.skipped}</td>
                  <td className={lc.failed > 0 ? 'text-red-600' : ''}>{lc.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Analyzer statuses */}
      <section>
        <h4 className="font-medium mb-1">분석기 상태</h4>
        <ul className="space-y-1 text-xs">
          {analyzerStatuses.map((a) => (
            <li key={a.name} className="flex items-center gap-2">
              <span className={
                a.status === 'active' ? 'text-green-600' :
                a.status === 'failed' ? 'text-red-600' : 'text-gray-400'
              }>●</span>
              <span>{a.name}</span>
              <span className="text-gray-500">{a.status === 'active' ? '활성' : a.status === 'disabled' ? '비활성' : '실패'}</span>
              {a.failureReason && <span className="text-red-500 text-[10px]">({a.failureReason})</span>}
            </li>
          ))}
        </ul>
      </section>

      {/* Partial results warning */}
      {partialResults.reason && (
        <section className="rounded bg-amber-50 p-2 text-xs text-amber-800">
          ⚠️ {partialResults.reason}
        </section>
      )}

      {/* Retryable */}
      {retryableIssues.length > 0 && (
        <section>
          <h4 className="font-medium mb-1 text-blue-700">다시 분석하면 해결 가능</h4>
          <ul className="list-disc pl-4 text-xs text-blue-700">
            {retryableIssues.map((issue, i) => <li key={i}>{issue}</li>)}
          </ul>
        </section>
      )}

      {/* Unsupported */}
      {unsupportedItems.length > 0 && (
        <section>
          <h4 className="font-medium mb-1 text-gray-500">현재 지원하지 않는 항목</h4>
          <ul className="list-disc pl-4 text-xs text-gray-500">
            {unsupportedItems.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </section>
      )}
    </div>
  )
}
