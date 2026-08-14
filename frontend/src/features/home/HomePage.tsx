import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listProjects } from '../../api/projects'
import type { Project } from '../../api/types'
import EmptyState from '../../components/EmptyState'
import { areaLabel } from '../areas/labels'
import { firstLine, formatWhen, shortSha } from '../history/format'

export default function HomePage() {
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  })

  const projects = projectsQuery.data ?? []

  return (
    <div className="flex flex-1 flex-col px-6 py-5">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[15px] font-semibold text-ink">Projects</h1>
          <p className="mt-0.5 text-[13px] text-ink-muted">가져온 저장소의 영역·분석 상태·최근 이력을 봅니다.</p>
        </div>
        <Link
          to="/import"
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 transition-opacity hover:opacity-90"
        >
          Import repository
        </Link>
      </header>

      {projectsQuery.isLoading && <p className="text-[13px] text-ink-muted">프로젝트를 불러오는 중…</p>}

      {projectsQuery.isError && (
        <p role="alert" className="text-[12px] text-danger">
          프로젝트 목록을 불러오지 못했습니다.
        </p>
      )}

      {!projectsQuery.isLoading && !projectsQuery.isError && projects.length === 0 && (
        <EmptyState
          title="프로젝트를 연결하면 여기에 표시됩니다"
          description="GitHub 저장소를 import하면 영역·기술·최근 커밋이 카드로 나타납니다."
        >
          <Link
            to="/import"
            className="mt-1 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 transition-opacity hover:opacity-90"
          >
            Import repository
          </Link>
        </EmptyState>
      )}

      {projects.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <li key={project.id}>
              <ProjectCard project={project} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ProjectCard({ project }: { project: Project }) {
  const analyzing = isAnalyzing(project)
  const snapshot = project.currentSnapshot
  const areas = project.selectedAreas ?? []
  const techs = project.topTechnologies ?? []

  return (
    <Link
      to={`/projects/${project.id}`}
      className={`block rounded-md border border-line bg-surface-1 p-4 transition-colors hover:border-line-strong hover:bg-surface-2 ${
        analyzing ? 'shadow-[inset_3px_0_0_var(--color-accent)]' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-mono text-[14px] font-semibold text-ink">
          {project.repoOwner}/{project.repoName}
        </h2>
        {analyzing && (
          <span role="status" className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-accent">
            분석 중
          </span>
        )}
      </div>

      <dl className="mt-3 flex flex-col gap-2 text-[12px]">
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">영역</dt>
          <dd className="mt-0.5 text-ink-muted">
            {areas.length > 0 ? areas.map((area) => areaLabel(area)).join(', ') : '선택 없음'}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">기술</dt>
          <dd className="mt-0.5 text-ink-muted">{techs.length > 0 ? techs.join(', ') : '—'}</dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">스냅샷</dt>
          <dd className="mt-0.5 text-ink-muted">
            {snapshot
              ? `${snapshot.status}${snapshot.analyzedAt ? ` · ${formatWhen(snapshot.analyzedAt)}` : ''}`
              : '분석 전'}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">최근 커밋</dt>
          <dd className="mt-0.5 font-mono text-ink-muted">
            {project.latestCommit
              ? `${shortSha(project.latestCommit.sha)} ${firstLine(project.latestCommit.message)}`
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">최근 PR</dt>
          <dd className="mt-0.5 text-ink-muted">
            {project.latestPull
              ? `#${project.latestPull.number} ${project.latestPull.title} (${project.latestPull.state})`
              : '—'}
          </dd>
        </div>
      </dl>
    </Link>
  )
}

function isAnalyzing(project: Project): boolean {
  const job = project.latestJob?.status
  return project.currentSnapshot?.status === 'ANALYZING' || job === 'QUEUED' || job === 'RUNNING'
}
