import { Project, SyntaxKind, type Node } from 'ts-morph'
import { describe, expect, it } from 'vitest'
import { forEachDescendantOfKinds } from './walk'

const KINDS = [SyntaxKind.FunctionDeclaration, SyntaxKind.FunctionExpression, SyntaxKind.ArrowFunction,
  SyntaxKind.CallExpression, SyntaxKind.BinaryExpression, SyntaxKind.JsxSelfClosingElement]

function source(text: string, path = 'a.tsx') {
  return new Project({ useInMemoryFileSystem: true }).createSourceFile(path, text)
}

function visited(node: Node, kinds: readonly SyntaxKind[]): Node[] {
  const nodes: Node[] = []
  forEachDescendantOfKinds(node, kinds, (match) => nodes.push(match))
  return nodes
}

/** What the walk returned before: one `getDescendantsOfKind` per kind, merged in pre-order. */
function perKind(node: Node, kinds: readonly SyntaxKind[]): Node[] {
  return kinds.length === 1 ? node.getDescendantsOfKind(kinds[0])
    : kinds.flatMap((kind) => node.getDescendantsOfKind(kind)).sort((a, b) => a.getPos() - b.getPos() || b.getEnd() - a.getEnd())
}

describe('forEachDescendantOfKinds', () => {
  it('visits the same wrapper nodes in the same order as one getDescendantsOfKind per kind', () => {
    const file = source([
      '// leading comment',
      'export function outer(a: number) { return [1, 2].map((x) => x + a).filter(function keep(y) { return y > 1 }) }',
      'const f = () => () => outer(1 + 2)(3)',
      'f()()',
      '/** doc */ class C { m() { return outer(4) } }',
      'export const View = () => <div><Item value={f()} /></div>',
      'declare global { function g(): void }',
      'for (const k of [1]) { k++ }',
    ].join('\n'))
    for (const kinds of [KINDS, [SyntaxKind.CallExpression], [SyntaxKind.ArrowFunction, SyntaxKind.ArrowFunction]]) {
      const expected = perKind(file, kinds)
      expect(expected.length).toBeGreaterThan(0)
      // toBe per element: the extractors key maps by wrapper identity.
      const actual = visited(file, kinds)
      expect(actual.length).toBe(expected.length)
      actual.forEach((node, index) => expect(node).toBe(expected[index]))
    }
    const method = file.getClassOrThrow('C').getMethodOrThrow('m')
    expect(visited(method, KINDS)).toEqual(perKind(method, KINDS))
  })

  // G-PERF medium/large TS_PARSING: ts-morph walks the tree once per kind through nested
  // generators, which costs the tree's depth per node; deep expressions made that quadratic.
  it('walks a deeply nested tree once, in time linear in its size', () => {
    const depth = 3_000
    const file = source(`const total = ${Array.from({ length: depth }, (_, i) => `f(${i})`).join(' + ')}\n`, 'deep.ts')
    const started = performance.now()
    const nodes = visited(file, KINDS)
    const elapsed = performance.now() - started
    expect(nodes.filter((node) => node.getKind() === SyntaxKind.CallExpression)).toHaveLength(depth)
    expect(nodes.filter((node) => node.getKind() === SyntaxKind.BinaryExpression)).toHaveLength(depth - 1)
    expect(elapsed).toBeLessThan(1_000)
  })
})
