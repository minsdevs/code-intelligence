import type { AnalyzeFile, SymbolHit } from './types'
import { isGo, isPython } from './paths'

/**
 * Heuristic symbol extraction for Python/Go (기획서 tree-sitter fallback).
 * Avoids native tree-sitter bindings in CI; swap-in remains source-compatible.
 */
export function extractGeneric(files: AnalyzeFile[]): SymbolHit[] {
  const symbols: SymbolHit[] = []
  for (const file of files) {
    if (isPython(file.path)) {
      symbols.push(...extractPython(file))
    } else if (isGo(file.path)) {
      symbols.push(...extractGo(file))
    }
  }
  return symbols
}

function extractPython(file: AnalyzeFile): SymbolHit[] {
  const hits: SymbolHit[] = []
  const lines = file.content.split(/\r?\n/)
  lines.forEach((line, index) => {
    const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (classMatch) {
      hits.push(hit(classMatch[1], 'CLASS', file.path, index + 1))
      return
    }
    const defMatch = line.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)/)
    if (defMatch) {
      hits.push(hit(defMatch[1], 'FUNCTION', file.path, index + 1))
    }
  })
  return hits
}

function extractGo(file: AnalyzeFile): SymbolHit[] {
  const hits: SymbolHit[] = []
  const lines = file.content.split(/\r?\n/)
  lines.forEach((line, index) => {
    const typeMatch = line.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)/)
    if (typeMatch) {
      hits.push(hit(typeMatch[1], 'CLASS', file.path, index + 1))
      return
    }
    const funcMatch = line.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (funcMatch) {
      hits.push(hit(funcMatch[1], 'FUNCTION', file.path, index + 1))
    }
  })
  return hits
}

function hit(name: string, kind: SymbolHit['kind'], filePath: string, line: number): SymbolHit {
  return { name, kind, filePath, lineStart: line, lineEnd: line }
}
