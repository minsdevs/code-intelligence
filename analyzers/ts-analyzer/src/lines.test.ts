import { Project, SyntaxKind } from 'ts-morph'
import { describe, expect, it } from 'vitest'
import { endLine, startLine } from './lines'

function source(text: string, path = 'a.tsx') {
  return new Project({ useInMemoryFileSystem: true }).createSourceFile(path, text)
}

describe('startLine / endLine', () => {
  it('equal ts-morph getStartLineNumber / getEndLineNumber for every node, whatever the line endings', () => {
    const text = [
      '/** doc */\r\nexport function a() {\r\n  return 1\r\n}',
      'const b = () =>\r  2 // lone carriage return',
      'const c = "x y"; const d = 3',
      '\n\nclass E {\n  /** m */\n  m() { return [1,\n 2].map((x) => x) }\n}',
      'export const V = () => <div>\n  <I v={a()} />\n</div>',
    ].join('\n')
    const file = source(text)
    const nodes = file.getDescendants()
    expect(nodes.length).toBeGreaterThan(50)
    for (const node of nodes) {
      expect([startLine(node), endLine(node)]).toEqual([node.getStartLineNumber(), node.getEndLineNumber()])
    }
  })

  // G-PERF medium/large TS_PARSING: ts-morph counts newlines from the start of the file on every
  // call, so line numbers of a file's nodes cost its size per node (15% of the large class's time).
  it('costs a lookup, not a scan of the file, per node', () => {
    const lines = 20_000
    const file = source(Array.from({ length: lines }, (_, i) => `f(${i})`).join('\n'), 'long.ts')
    const calls = file.getDescendantsOfKind(SyntaxKind.CallExpression)
    const started = performance.now()
    let last = 0
    for (const call of calls) last = Math.max(last, startLine(call), endLine(call))
    const elapsed = performance.now() - started
    expect(calls).toHaveLength(lines)
    expect(last).toBe(lines)
    expect(elapsed).toBeLessThan(500)
  })
})
