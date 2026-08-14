import type { FileListItem } from '../../api/types'

export type FileTreeDir = {
  kind: 'dir'
  name: string
  path: string
  children: FileTreeNode[]
}

export type FileTreeFile = {
  kind: 'file'
  name: string
  path: string
  language: string | null
  size: number
  lineCount: number | null
}

export type FileTreeNode = FileTreeDir | FileTreeFile

export function buildFileTree(files: FileListItem[]): FileTreeNode[] {
  const root: FileTreeDir = { kind: 'dir', name: '', path: '', children: [] }

  for (const file of files) {
    const parts = file.path.split('/').filter((part) => part.length > 0)
    if (parts.length === 0) continue
    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!
      const dirPath = parts.slice(0, i + 1).join('/')
      let dir = current.children.find(
        (child): child is FileTreeDir => child.kind === 'dir' && child.path === dirPath,
      )
      if (!dir) {
        dir = { kind: 'dir', name, path: dirPath, children: [] }
        current.children.push(dir)
      }
      current = dir
    }
    current.children.push({
      kind: 'file',
      name: parts[parts.length - 1]!,
      path: file.path,
      language: file.language,
      size: file.size,
      lineCount: file.lineCount,
    })
  }

  sortTree(root.children)
  return root.children
}

export function ancestorDirs(filePath: string): string[] {
  const parts = filePath.split('/').filter((part) => part.length > 0)
  const dirs: string[] = []
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join('/'))
  }
  return dirs
}

function sortTree(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const node of nodes) {
    if (node.kind === 'dir') sortTree(node.children)
  }
}
