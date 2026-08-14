const BY_LANGUAGE: Record<string, string> = {
  java: 'java',
  kotlin: 'kotlin',
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  go: 'go',
  sql: 'sql',
  yaml: 'yaml',
  markdown: 'markdown',
  xml: 'xml',
  html: 'html',
  json: 'json',
  css: 'css',
  scss: 'scss',
  gradle: 'java',
  dockerfile: 'dockerfile',
  shell: 'shell',
  properties: 'ini',
  rust: 'rust',
  ruby: 'ruby',
  php: 'php',
  csharp: 'csharp',
  c: 'c',
  cpp: 'cpp',
  swift: 'swift',
  toml: 'ini',
}

export function monacoLanguage(path: string, language: string | null): string {
  if (language && BY_LANGUAGE[language]) return BY_LANGUAGE[language]
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

export function languageTint(language: string | null): string {
  switch (language) {
    case 'java':
    case 'kotlin':
      return 'text-accent'
    case 'typescript':
    case 'javascript':
      return 'text-ok'
    case 'sql':
      return 'text-danger'
    default:
      return 'text-ink-faint'
  }
}
