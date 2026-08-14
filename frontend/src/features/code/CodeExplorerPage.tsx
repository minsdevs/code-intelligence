import { lazy, Suspense, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'react-router-dom'
import { listFiles } from '../../api/files'
import type { FileListItem } from '../../api/types'
import { useT } from '../../lib/i18n'
import { parseProjectId } from '../../lib/projectId'
import { useUiStore } from '../../stores/uiStore'
import { parseLineParam, queryError } from './codeLocation'
import FileTreePanel from './FileTreePanel'
import SymbolPanel from './SymbolPanel'

const CodeViewer = lazy(() => import('./CodeViewer'))
const EMPTY_FILES: FileListItem[] = []

export default function CodeExplorerPage() {
  const t = useT()
  const { projectId: rawId } = useParams()
  const projectId = parseProjectId(rawId)
  const [searchParams, setSearchParams] = useSearchParams()
  const path = searchParams.get('path')
  const line = parseLineParam(searchParams.get('line'))
  const setFocusedFile = useUiStore((state) => state.setFocusedFile)

  const filesQuery = useQuery({
    queryKey: ['files', projectId],
    queryFn: () => listFiles(projectId!),
    enabled: projectId != null,
  })

  useEffect(() => {
    setFocusedFile(path)
  }, [path, setFocusedFile])

  function openLocation(nextPath: string, nextLine: number | null) {
    const params = new URLSearchParams()
    params.set('path', nextPath)
    if (nextLine != null && nextLine > 0) params.set('line', String(nextLine))
    setSearchParams(params)
  }

  if (projectId == null) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{t('code.noProject')}</p>
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
      <FileTreePanel
        files={filesQuery.data ?? EMPTY_FILES}
        selectedPath={path}
        loading={filesQuery.isLoading}
        error={queryError(filesQuery.error)}
        onSelectFile={(nextPath) => openLocation(nextPath, null)}
      />
      <Suspense fallback={<p className="px-5 py-8 text-[13px] text-ink-muted">{t('code.loadingEditor')}</p>}>
        <CodeViewer projectId={projectId} path={path} line={line} />
      </Suspense>
      <SymbolPanel projectId={projectId} path={path} onOpenLocation={openLocation} />
    </div>
  )
}
