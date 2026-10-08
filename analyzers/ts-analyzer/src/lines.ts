import type { Node, ts } from 'ts-morph'

/**
 * Line numbers as ts-morph's `getStartLineNumber()` / `getEndLineNumber()` count them (one plus
 * the `\n` characters before the node's start or end; `\r` and other separators do not count),
 * from one sorted list of newline offsets per source text instead of a scan from the file's start
 * on every call, which made a file's line numbers quadratic in its size.
 */
const newlineOffsets = new WeakMap<ts.SourceFile, number[]>()

function newlinesBefore(sourceFile: ts.SourceFile, pos: number): number {
  let offsets = newlineOffsets.get(sourceFile)
  if (!offsets) {
    offsets = []
    const text = sourceFile.text
    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) offsets.push(index)
    newlineOffsets.set(sourceFile, offsets)
  }
  let low = 0
  let high = offsets.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (offsets[middle] < pos) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * The node's 1-based start line. ts-morph counts up to the start of the node's line, which has
 * the same number of `\n` before it as the node's start.
 */
export function startLine(node: Node): number {
  return newlinesBefore(node.getSourceFile().compilerNode, node.getStart()) + 1
}

/** The node's 1-based end line (counted like {@link startLine}, from the node's end). */
export function endLine(node: Node): number {
  return newlinesBefore(node.getSourceFile().compilerNode, node.getEnd()) + 1
}
