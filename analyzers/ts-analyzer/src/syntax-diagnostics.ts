import type { Project, SourceFile } from 'ts-morph'

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
