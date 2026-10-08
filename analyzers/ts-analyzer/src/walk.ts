import type { Node, SyntaxKind, ts } from 'ts-morph'

/**
 * Visits the descendants of the given kinds in the pre-order `forEachDescendant` visits them,
 * but wraps only those nodes. A full `forEachDescendant` keeps one ts-morph wrapper per compiler
 * node for the project's lifetime (about 600 MB for the medium size class).
 *
 * The compiler tree is walked once, iteratively: `getDescendantsOfKind` walks it once per
 * kind through nested generators, which costs the tree's depth per node (about 45% of the medium
 * class's TS extraction CPU time). All requested kinds are parse-tree kinds, which ts-morph also
 * searches through `forEachChild`, so the matches and their order are the same.
 */
export function forEachDescendantOfKinds(node: Node, kinds: readonly SyntaxKind[], visit: (node: Node) => void): void {
  const byKind = new Map<SyntaxKind, ts.Node[]>(kinds.map((kind) => [kind, []]))
  const preOrder: ts.Node[] = []
  // An explicit stack: deep expressions (long `+` chains) would overflow a recursive walk.
  const pending: ts.Node[] = []
  const pushChildren = (parent: ts.Node) => {
    const children: ts.Node[] = []
    // A truthy callback result stops forEachChild, so the push result is discarded.
    parent.forEachChild((child) => { children.push(child) })
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index])
  }
  pushChildren(node.compilerNode)
  while (pending.length > 0) {
    const current = pending.pop()!
    const bucket = byKind.get(current.kind)
    if (bucket) {
      bucket.push(current)
      preOrder.push(current)
    }
    pushChildren(current)
  }
  // The same wrappers `getDescendantsOfKind` returns (node identity is a map key in the extractors),
  // created in pre-order so each one's parent wrapper already exists (wrapping a deep node first
  // would wrap its ancestors recursively).
  const wrapper = node as unknown as { _getNodeFromCompilerNode(compilerNode: ts.Node): Node }
  const wrapped = new Map<ts.Node, Node>()
  for (const compilerNode of preOrder) wrapped.set(compilerNode, wrapper._getNodeFromCompilerNode(compilerNode))
  const wrap = (compilerNodes: ts.Node[]) => compilerNodes.map((compilerNode) => wrapped.get(compilerNode)!)
  const matches = kinds.length === 1 ? wrap(byKind.get(kinds[0])!)
    // Distinct nodes start at distinct positions unless one contains the other; the container
    // (the longer node) comes first in pre-order.
    : kinds.flatMap((kind) => wrap(byKind.get(kind)!)).sort((a, b) => a.getPos() - b.getPos() || b.getEnd() - a.getEnd())
  for (const match of matches) visit(match)
}
