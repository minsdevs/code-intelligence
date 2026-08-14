import { Link } from 'react-router-dom'
import EmptyState from '../../components/EmptyState'

export default function ProjectsPage() {
  return (
    <EmptyState
      title="아직 연결된 프로젝트가 없습니다"
      description="Phase 1의 Import Wizard에서 GitHub 저장소를 가져올 수 있습니다."
      phase={1}
    >
      <Link
        to="/import"
        className="mt-1 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 transition-opacity hover:opacity-90"
      >
        Import repository
      </Link>
      <Link
        to="/projects/demo-project"
        className="mt-1 font-mono text-[12px] text-accent hover:underline"
      >
        워크스페이스 셸 미리보기 (개발용) →
      </Link>
    </EmptyState>
  )
}
