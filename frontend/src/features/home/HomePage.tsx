import EmptyState from '../../components/EmptyState'

export default function HomePage() {
  return (
    <EmptyState
      title="프로젝트를 연결하면 여기에 표시됩니다"
      description="GitHub 저장소 연동, 영역 감지, 분석 파이프라인은 Phase 1에서 제공됩니다."
      phase={1}
    />
  )
}
