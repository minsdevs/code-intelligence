import { lazy, Suspense, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'react-router-dom'
import { listFiles } from '../../api/files'
import { getProject } from '../../api/projects'
import { listSnapshots } from '../../api/snapshots'
import type { FileListItem } from '../../api/types'
import { useT } from '../../lib/i18n'
import { parseProjectId } from '../../lib/projectId'
import { useUiStore } from '../../stores/uiStore'
import { canonicalSourcePath, parseLineParam, queryError } from './codeLocation'
import FileTreePanel from './FileTreePanel'
import SymbolPanel from './SymbolPanel'

const CodeViewer = lazy(() => import('./CodeViewer'))
const EMPTY_FILES: FileListItem[] = []

export default function CodeExplorerPage() {
  const t = useT()
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const [searchParams, setSearchParams] = useSearchParams()
  const path = canonicalSourcePath(searchParams.get('path'))
  const sourceContext = searchParams.get('sourceContext') ?? 'current'
  const rawSnapshot = searchParams.get('snapshotId')
  const requestedSnapshot = parseLineParam(rawSnapshot)
  const rawEvidence = searchParams.get('evidenceId')
  const evidenceId = parseLineParam(rawEvidence)
  const unknown =
    !['current', 'snapshot', 'evidence'].includes(sourceContext) ||
    (rawSnapshot != null && requestedSnapshot == null) ||
    (sourceContext !== 'current' && requestedSnapshot == null) ||
    (rawEvidence != null && (evidenceId == null || sourceContext !== 'evidence'))
  const line =
    unknown || sourceContext === 'evidence' ? null : parseLineParam(searchParams.get('line'))
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: projectId != null,
  })
  const snapshotsQuery = useQuery({
    queryKey: ['snapshots', projectId],
    queryFn: () => listSnapshots(projectId!),
    enabled: projectId != null,
  })
  const snapshotId = requestedSnapshot ?? projectQuery.data?.currentSnapshot?.id ?? null
  const setFocusedFile = useUiStore((state) => state.setFocusedFile)

  const filesQuery = useQuery({
    queryKey: ['files', projectId, snapshotId],
    queryFn: () => listFiles(projectId!, snapshotId),
    enabled: projectId != null && snapshotId != null && !unknown,
  })

  useEffect(() => {
    setFocusedFile(path)
  }, [path, setFocusedFile])

  function openLocation(nextPath: string, versioned = false) {
    const params = new URLSearchParams(searchParams)
    params.delete('evidenceId')
    params.set('sourceContext', versioned ? 'evidence' : 'snapshot')
    if (snapshotId != null) params.set('snapshotId', String(snapshotId))
    params.delete('line')
    params.set('path', nextPath)
    setSearchParams(params)
  }

  if (projectId == null) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{t('code.noProject')}</p>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-[12px]">
        <label>
          Snapshot{' '}
          <select
            aria-label="Source snapshot"
            value={unknown ? 'unknown' : (requestedSnapshot ?? 'current')}
            onChange={(event) => {
              const params = new URLSearchParams(searchParams)
              params.delete('line')
              params.delete('evidenceId')
              params.delete('snapshotId')
              params.set('sourceContext', event.target.value === 'current' ? 'current' : 'snapshot')
              if (event.target.value !== 'current') params.set('snapshotId', event.target.value)
              setSearchParams(params)
            }}
          >
            {unknown && (
              <option value="unknown" disabled>
                미확인 근거 / Unknown context
              </option>
            )}
            <option value="current">현재 소스 / Current source</option>
            {(snapshotsQuery.data ?? []).map((snapshot) => (
              <option key={snapshot.id} value={snapshot.id}>
                #{snapshot.id} · {snapshot.analyzedAt ?? snapshot.status}
              </option>
            ))}
          </select>
        </label>
        {projectQuery.isError && (
          <span role="alert">프로젝트의 snapshot을 확인할 수 없습니다.</span>
        )}
      </header>
      <div
        role="region"
        aria-label="Code panels"
        tabIndex={0}
        className="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <FileTreePanel
          files={unknown ? EMPTY_FILES : (filesQuery.data ?? EMPTY_FILES)}
          selectedPath={path}
          loading={!unknown && filesQuery.isLoading}
          error={queryError(filesQuery.error)}
          onSelectFile={(nextPath) => openLocation(nextPath)}
        />
        <div className="flex min-h-0 min-w-[20rem] flex-1 flex-col [overflow-wrap:anywhere]">
          <Suspense
            fallback={
              <p className="px-5 py-8 text-[13px] text-ink-muted">{t('code.loadingEditor')}</p>
            }
          >
            <CodeViewer
              projectId={projectId}
              snapshotId={snapshotId}
              path={path}
              line={line}
              sourceContext={unknown ? 'unknown' : sourceContext}
              evidenceId={evidenceId}
              onOpenCurrent={() => {
                const params = new URLSearchParams()
                if (path) params.set('path', path)
                params.set('sourceContext', 'current')
                setSearchParams(params)
              }}
            />
          </Suspense>
        </div>
        <SymbolPanel
          projectId={projectId}
          snapshotId={unknown ? null : snapshotId}
          path={unknown ? null : path}
          onOpenLocation={(nextPath) => openLocation(nextPath, true)}
        />
      </div>
    </div>
  )
}
