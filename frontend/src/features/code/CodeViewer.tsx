import Editor, { type OnMount } from '@monaco-editor/react'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { ApiError } from '../../api/client'
import { getFileContent } from '../../api/files'
import type { FileContent } from '../../api/types'
import { useT } from '../../lib/i18n'
import { configureMonaco } from '../../lib/monacoSetup'
import { queryError } from './codeLocation'
import { monacoLanguage } from './language'
import OpenInIdeButton from './OpenInIdeButton'

configureMonaco()

type CodeViewerProps = {
  projectId: number
  snapshotId: number | null
  evidenceId: number | null
  sourceContext: string
  onOpenCurrent: () => void
  path: string | null
  line: number | null
}

export default function CodeViewer({
  projectId,
  snapshotId,
  evidenceId,
  sourceContext,
  onOpenCurrent,
  path,
  line,
}: CodeViewerProps) {
  const t = useT()
  const query = useQuery({
    queryKey: ['file-content', projectId, snapshotId, path, evidenceId],
    queryFn: () => getFileContent(projectId, path!, snapshotId, evidenceId),
    enabled: path != null && path.length > 0 && snapshotId != null && sourceContext !== 'unknown',
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: 'always',
  })

  const contentMatches =
    query.data?.resolvedSnapshotId === snapshotId &&
    query.data?.path === path &&
    query.data?.sourceState === 'AVAILABLE'
  const legacyEvidence =
    sourceContext === 'evidence' || query.data?.evidenceState === 'LEGACY_SOURCE_UNVERIFIED'
  const highlightLine =
    legacyEvidence || sourceContext === 'unknown' || query.isFetching || !contentMatches
      ? null
      : line != null && line <= query.data!.content.split('\n').length
        ? line
        : null

  if (path == null || path.length === 0) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{t('code.selectFile')}</p>
  }

  if (sourceContext === 'unknown')
    return (
      <section className="px-5 py-8" data-testid="source-unavailable">
        <p role="status">
          SOURCE_CONTEXT_UNKNOWN · 이 근거의 snapshot은 미확인입니다. 현재 파일로 대체하지 않습니다.
        </p>
        <button type="button" onClick={onOpenCurrent}>
          현재 소스 별도 열기 / Open current source
        </button>
      </section>
    )
  if (query.error instanceof ApiError && (query.error.status === 409 || query.error.status === 410))
    return (
      <section className="px-5 py-8" data-testid="source-unavailable">
        <p role="alert">
          {query.error.code ??
            (query.error.status === 409 ? 'EVIDENCE_STALE' : 'SOURCE_UNAVAILABLE')}{' '}
          · {query.error.message}
        </p>
        <button type="button" onClick={onOpenCurrent}>
          현재 소스 별도 열기 / Open current source
        </button>
      </section>
    )

  const blocked = blockedFileMessage(query.error)
  if (blocked === 'file-too-large' || blocked === 'binary-file') {
    return (
      <section className="flex min-h-0 flex-1 flex-col px-5 py-8" aria-label={t('code.fileLabel')}>
        <p className="font-mono text-[12px] text-ink-faint">{path}</p>
        <p role="status" className="mt-3 max-w-md text-[13px] leading-relaxed text-ink-muted">
          {blocked === 'file-too-large'
            ? t('code.tooLarge')
            : query.error instanceof ApiError && query.error.code === 'SOURCE_ENCODING_UNSUPPORTED'
              ? query.error.message
              : t('code.binary')}
        </p>
      </section>
    )
  }

  const error = queryError(query.error)
  if (error) {
    return (
      <section className="flex min-h-0 flex-1 flex-col px-5 py-8" aria-label={t('code.fileLabel')}>
        <p className="font-mono text-[12px] text-ink-faint">{path}</p>
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {error}
        </p>
      </section>
    )
  }

  if (query.data && !query.isFetching && !contentMatches)
    return (
      <section className="px-5 py-8" data-testid="source-unavailable">
        <p role="alert">EVIDENCE_STALE · 응답의 snapshot/path를 확인할 수 없습니다.</p>
        <button type="button" onClick={onOpenCurrent}>
          현재 소스 별도 열기 / Open current source
        </button>
      </section>
    )
  if (query.isFetching || !query.data || !contentMatches) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{t('code.loadingFile')}</p>
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('code.fileLabel')}>
      <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2">
        <p className="truncate font-mono text-[12px] text-ink-muted">{path}</p>
        {sourceContext === 'current' && query.data.currentSnapshot && !legacyEvidence && (
          <OpenInIdeButton projectId={projectId} filePath={path} line={line ?? 1} />
        )}
      </header>
      <p className="px-4 py-1 text-[11px] text-ink-muted" data-testid="source-context">
        Snapshot #{query.data.resolvedSnapshotId} · {query.data.snapshotTime ?? '시간 미확인'} ·{' '}
        {query.data.currentSnapshot ? '현재 / Current' : '과거 / Historical'}
        {sourceContext === 'current' ? ' · 현재 소스' : ''}
      </p>
      {legacyEvidence && (
        <p role="status" className="px-4 py-1 text-[11px] text-warn">
          LEGACY_SOURCE_UNVERIFIED · snapshot 원본은 확인했지만 분석 근거가 같은 bytes에서
          생성됐는지는 미검증입니다. 줄 강조를 하지 않습니다.
        </p>
      )}
      <div className="min-h-0 flex-1" data-testid="code-viewer">
        <VerifiedSourceEditor
          key={`${projectId}/${query.data.resolvedSnapshotId}/${path}/${query.data.contentOid}`}
          projectId={projectId}
          file={query.data}
          highlightLine={highlightLine}
        />
      </div>
    </section>
  )
}

function VerifiedSourceEditor({
  projectId,
  file,
  highlightLine,
}: {
  projectId: number
  file: FileContent
  highlightLine: number | null
}) {
  const t = useT()
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null)
  const decorationsRef = useRef<string[]>([])

  const applyLine = useCallback((target: number | null) => {
    const ed = editorRef.current
    const monaco = monacoRef.current
    if (!ed || !monaco) return
    if (target == null || target < 1) {
      decorationsRef.current = ed.deltaDecorations(decorationsRef.current, [])
      return
    }
    ed.revealLineInCenter(target)
    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, [
      {
        range: new monaco.Range(target, 1, target, 1),
        options: { isWholeLine: true, className: 'code-explorer-line' },
      },
    ])
  }, [])

  const handleMount = useCallback<OnMount>(
    (ed, monaco) => {
      editorRef.current = ed
      monacoRef.current = monaco
      applyLine(highlightLine)
    },
    [applyLine, highlightLine],
  )

  useEffect(() => {
    applyLine(highlightLine)
  }, [applyLine, highlightLine])

  return (
    <Editor
      path={`snapshot://${projectId}/${file.resolvedSnapshotId}/${file.contentOid}/${file.path}`}
      value={file.content}
      language={monacoLanguage(file.path, file.language)}
      theme="vs-dark"
      height="100%"
      onMount={handleMount}
      options={{
        readOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        automaticLayout: true,
        glyphMargin: true,
        readOnlyMessage: { value: t('code.readOnly') },
      }}
    />
  )
}

function blockedFileMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  if (error.status === 413) {
    return 'file-too-large'
  }
  if (error.status === 415) {
    return 'binary-file'
  }
  return null
}
