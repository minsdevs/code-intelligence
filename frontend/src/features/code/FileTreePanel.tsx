import { useMemo, useState } from 'react'
import type { FileListItem } from '../../api/types'
import { FileIcon, FolderIcon } from '../../components/icons'
import { useT } from '../../lib/i18n'
import { ancestorDirs, buildFileTree, type FileTreeNode } from './fileTree'
import { languageTint } from './language'

type FileTreePanelProps = {
  files: FileListItem[]
  selectedPath: string | null
  loading: boolean
  error: string | null
  onSelectFile: (path: string) => void
}

export default function FileTreePanel({
  files,
  selectedPath,
  loading,
  error,
  onSelectFile,
}: FileTreePanelProps) {
  const t = useT()
  const tree = useMemo(() => buildFileTree(files), [files])
  const forcedOpen = useMemo(
    () => new Set(selectedPath ? ancestorDirs(selectedPath) : []),
    [selectedPath],
  )
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const openDirs = useMemo(() => {
    const next = new Set(expanded)
    for (const dir of forcedOpen) next.add(dir)
    return next
  }, [expanded, forcedOpen])

  function toggleDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (openDirs.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <section className="flex w-[18rem] shrink-0 flex-col border-r border-line bg-surface-1">
      <header className="border-b border-line px-3 py-3">
        <h2 className="text-[13px] font-medium text-ink">Files</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{t('code.filesHint')}</p>
      </header>
      {error && (
        <p role="alert" className="px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      {loading && <p className="px-3 py-3 text-[13px] text-ink-muted">{t('code.loadingFiles')}</p>}
      {!loading && files.length === 0 && !error && (
        <p className="px-3 py-3 text-[13px] text-ink-muted">{t('code.noFiles')}</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <ul role="tree" aria-label="Files" className="flex flex-col">
          {tree.map((node) => (
            <TreeRow
              key={node.path}
              node={node}
              depth={0}
              openDirs={openDirs}
              selectedPath={selectedPath}
              onToggleDir={toggleDir}
              onSelectFile={onSelectFile}
            />
          ))}
        </ul>
      </div>
    </section>
  )
}

function TreeRow({
  node,
  depth,
  openDirs,
  selectedPath,
  onToggleDir,
  onSelectFile,
}: {
  node: FileTreeNode
  depth: number
  openDirs: Set<string>
  selectedPath: string | null
  onToggleDir: (path: string) => void
  onSelectFile: (path: string) => void
}) {
  const paddingLeft = 8 + depth * 12
  if (node.kind === 'dir') {
    const open = openDirs.has(node.path)
    return (
      <li>
        <button
          type="button"
          role="treeitem"
          aria-expanded={open}
          aria-label={node.path}
          onClick={() => onToggleDir(node.path)}
          style={{ paddingLeft }}
          className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <span
            aria-hidden="true"
            className={`inline-block text-[10px] text-ink-faint ${open ? 'rotate-90' : ''}`}
          >
            ▸
          </span>
          <FolderIcon className="shrink-0 text-ink-faint" />
          <span className="truncate text-[12px] text-ink">{node.name}</span>
        </button>
        {open && (
          <ul role="group">
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                openDirs={openDirs}
                selectedPath={selectedPath}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectFile}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  const selected = node.path === selectedPath
  return (
    <li>
      <button
        type="button"
        role="treeitem"
        aria-selected={selected}
        aria-current={selected ? 'true' : undefined}
        aria-label={node.path}
        onClick={() => onSelectFile(node.path)}
        style={{ paddingLeft }}
        className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left ${
          selected ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
        }`}
      >
        <FileIcon className={`shrink-0 ${languageTint(node.language)}`} />
        <span className="truncate font-mono text-[12px]">{node.name}</span>
      </button>
    </li>
  )
}
