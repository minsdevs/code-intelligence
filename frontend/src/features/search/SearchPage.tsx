import EmptyState from '../../components/EmptyState'

export default function SearchPage() {
  return (
    <EmptyState
      title="통합 검색"
      description="코드 심볼·기능·커밋·노트를 한 번에 검색하는 기능은 Phase 4에서 제공됩니다."
      phase={4}
    >
      <input
        type="search"
        disabled
        aria-label="통합 검색"
        placeholder="검색어 입력… (Phase 4)"
        className="mt-1 w-72 max-w-full cursor-not-allowed rounded-md border border-line bg-surface-2 px-3 py-1.5 text-ink placeholder:text-ink-faint disabled:opacity-60"
      />
    </EmptyState>
  )
}
