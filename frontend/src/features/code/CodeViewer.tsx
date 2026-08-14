import Editor, { type OnMount } from '@monaco-editor/react'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { ApiError } from '../../api/client'
import { getFileContent } from '../../api/files'
import { useT } from '../../lib/i18n'
import { configureMonaco } from '../../lib/monacoSetup'
import { queryError } from './codeLocation'
import { monacoLanguage } from './language'

configureMonaco()

type CodeViewerProps = {
  projectId: number
  path: string | null
  line: number | null
}

export default function CodeViewer({ projectId, path, line }: CodeViewerProps) {
  const t = useT()
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null)
  const decorationsRef = useRef<string[]>([])

  const query = useQuery({
    queryKey: ['file-content', projectId, path],
    queryFn: () => getFileContent(projectId, path!),
    enabled: path != null && path.length > 0,
  })

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
    },
    [],
  )

  useEffect(() => {
    applyLine(line)
  }, [applyLine, line, query.data?.content])

  if (path == null || path.length === 0) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{t('code.selectFile')}</p>
  }

  const blocked = blockedFileMessage(query.error)
  if (blocked === 'file-too-large' || blocked === 'binary-file') {
    return (
      <section className="flex min-h-0 flex-1 flex-col px-5 py-8" aria-label={t('code.fileLabel')}>
        <p className="font-mono text-[12px] text-ink-faint">{path}</p>
        <p role="status" className="mt-3 max-w-md text-[13px] leading-relaxed text-ink-muted">
          {blocked === 'file-too-large' ? t('code.tooLarge') : t('code.binary')}
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

  if (query.isLoading || !query.data) {
    return <p className="px-5 py-8 text-[13px] text-ink-muted">{t('code.loadingFile')}</p>
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('code.fileLabel')}>
      <header className="shrink-0 border-b border-line px-4 py-2">
        <p className="truncate font-mono text-[12px] text-ink-muted">{path}</p>
      </header>
      <div className="min-h-0 flex-1" data-testid="code-viewer">
        <Editor
          path={path}
          value={query.data.content}
          language={monacoLanguage(path, query.data.language)}
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
      </div>
    </section>
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
