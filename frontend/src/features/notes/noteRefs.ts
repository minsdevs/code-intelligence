export type NoteSubjectType = 'FILE' | 'NODE' | 'COMMIT' | 'TASK' | 'NOTE'

export type ParsedNoteRef = {
  type: NoteSubjectType
  rawTarget: string
  label: string
}

const FILE = /@file(?::|\s+)(\S+)/g
const CLASS_METHOD = /@class#([A-Za-z0-9_]+)/g
const CLASS = /@class(?::|\s+)([A-Za-z0-9_#]+)/g
const COMMIT = /@commit(?::|\s+)([a-fA-F0-9]{7,40})/g
const TASK = /@task(?::|\s+)(\d+)/g
const WIKI = /\[\[([^\]]+)\]\]/g

export function parseNoteRefs(markdown: string): ParsedNoteRef[] {
  if (!markdown.trim()) return []
  const refs: ParsedNoteRef[] = []
  addAll(refs, markdown, FILE, 'FILE')
  for (const match of markdown.matchAll(CLASS_METHOD)) {
    refs.push({ type: 'NODE', rawTarget: match[1], label: match[1] })
  }
  addAll(refs, markdown, CLASS, 'NODE')
  addAll(refs, markdown, COMMIT, 'COMMIT')
  addAll(refs, markdown, TASK, 'TASK')
  for (const match of markdown.matchAll(WIKI)) {
    const title = match[1].trim()
    if (title) refs.push({ type: 'NOTE', rawTarget: title, label: title })
  }
  return refs
}

function addAll(refs: ParsedNoteRef[], markdown: string, pattern: RegExp, type: NoteSubjectType) {
  for (const match of markdown.matchAll(pattern)) {
    const target = match[1].trim()
    refs.push({ type, rawTarget: target, label: target })
  }
}

export function noteRefHref(projectId: number, ref: ParsedNoteRef): string {
  switch (ref.type) {
    case 'FILE':
      return `/projects/${projectId}/code?path=${encodeURIComponent(ref.rawTarget)}&sourceContext=current`
    case 'NODE':
      return `/projects/${projectId}/architecture`
    case 'COMMIT':
      return `/projects/${projectId}/history`
    case 'TASK':
      return `/projects/${projectId}/tasks`
    case 'NOTE':
      return `/projects/${projectId}/notes`
  }
}
