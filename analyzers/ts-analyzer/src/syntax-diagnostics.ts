import { ts as tsModule, type Project, type SourceFile } from 'ts-morph'

export type ParserSyntaxDiagnostic = {
  filePath: string
  code: number
  lineStart: number
  columnStart: number
}

// No compiler nodes, diagnostic message text or source snippets escape the parser.
export class ParserSyntaxError extends Error {
  readonly name = 'ParserSyntaxError'

  constructor(
    readonly diagnostics: ParserSyntaxDiagnostic[],
    readonly totalDiagnostics: number,
  ) {
    super(`Input contains ${totalDiagnostics} syntax diagnostic(s); no partial analysis was returned`)
  }
}

export function assertParseable(project: Project, sources: SourceFile[]): void {
  const { diagnostics, total } = syntaxDiagnostics(project, sources)
  // A broken bootstrap/import may affect other files. Reject the whole result.
  if (total > 0) throw new ParserSyntaxError(diagnostics, total)
}

/**
 * Per-file syntax verdict before any program is built (G-ACCURACY D4, 2026-10-11): a file with syntactic
 * diagnostics is excluded from the analysis and published as FAILED/TS_SYNTAX_ERROR; the remaining files
 * are analysed. Nothing in the diagnostics is message text or source: code and position only.
 */
export type SyntaxPartition = { accepted: AnalyzeFileLike[]; rejected: Map<string, ParserSyntaxDiagnostic[]>; total: number }
export type AnalyzeFileLike = { path: string; content: string }

export function partitionBySyntax(files: AnalyzeFileLike[], scriptKindOf: (path: string) => number): SyntaxPartition {
  const rejected = new Map<string, ParserSyntaxDiagnostic[]>()
  const accepted: AnalyzeFileLike[] = []
  let total = 0
  for (const file of files) {
    const source = tsModule.createSourceFile('/' + file.path.replace(/^\/+/, ''), file.content, tsModule.ScriptTarget.ESNext, false, scriptKindOf(file.path))
    const errors = (source as unknown as { parseDiagnostics?: { start?: number; code: number }[] }).parseDiagnostics ?? []
    if (errors.length === 0) { accepted.push(file); continue }
    total += errors.length
    const diagnostics: ParserSyntaxDiagnostic[] = []
    for (const error of errors) {
      if (diagnostics.length >= 100) break
      const location = source.getLineAndCharacterOfPosition(error.start ?? 0)
      diagnostics.push({ filePath: file.path, code: error.code, lineStart: location.line + 1, columnStart: location.character + 1 })
    }
    rejected.set(file.path, diagnostics)
  }
  return { accepted, rejected, total }
}

/** Syntactic diagnostics of `sources` in order, at most 100 reported. */
export function syntaxDiagnostics(project: Project, sources: SourceFile[]): { diagnostics: ParserSyntaxDiagnostic[]; total: number } {
  const diagnostics: ParserSyntaxDiagnostic[] = []
  if (sources.length === 0) return { diagnostics, total: 0 }
  let total = 0
  const program = project.getProgram().compilerObject
  for (const source of sources) {
    const errors = program.getSyntacticDiagnostics(source.compilerNode)
    total += errors.length
    for (const error of errors) {
      if (diagnostics.length >= 100) break
      const location = source.compilerNode.getLineAndCharacterOfPosition(error.start ?? 0)
      diagnostics.push({
        filePath: source.getFilePath().replace(/^\//, ''),
        code: error.code,
        lineStart: location.line + 1,
        columnStart: location.character + 1,
      })
    }
  }
  return { diagnostics, total }
}
