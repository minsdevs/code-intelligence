import { DiffEditor } from '@monaco-editor/react'

function languageFromPath(path: string): string {
  const name = path.toLowerCase()
  if (name.endsWith('.java')) return 'java'
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'typescript'
  if (name.endsWith('.js') || name.endsWith('.jsx')) return 'javascript'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'yaml'
  if (name.endsWith('.md')) return 'markdown'
  if (name.endsWith('.xml') || name.endsWith('.html')) return 'xml'
  if (name.endsWith('.css')) return 'css'
  if (name.endsWith('.sql')) return 'sql'
  if (name.endsWith('.gradle') || name.endsWith('.kts')) return 'java'
  return 'plaintext'
}

type DiffViewerProps = {
  path: string
  original: string | null
  modified: string | null
}

export default function DiffViewer({ path, original, modified }: DiffViewerProps) {
  return (
    <div className="h-[min(520px,55vh)] min-h-[240px] overflow-hidden border-t border-line" data-testid="diff-viewer">
      <DiffEditor
        original={original ?? ''}
        modified={modified ?? ''}
        language={languageFromPath(path)}
        theme="vs-dark"
        height="100%"
        options={{
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          automaticLayout: true,
        }}
      />
    </div>
  )
}
