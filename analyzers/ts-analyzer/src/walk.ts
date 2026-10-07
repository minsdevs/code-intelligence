import type { Node, SyntaxKind } from 'ts-morph'

/**
 * Visits the descendants of the given kinds in the pre-order `forEachDescendant` visits them,
 * but wraps only those nodes. A full `forEachDescendant` keeps one ts-morph wrapper per compiler
 * node for the project's lifetime (about 600 MB for the medium size class).
 */
export function forEachDescendantOfKinds(node: Node, kinds: readonly SyntaxKind[], visit: (node: Node) => void): void {
  const matches = kinds.length === 1 ? node.getDescendantsOfKind(kinds[0])
    // Distinct nodes start at distinct positions unless one contains the other; the container
    // (the longer node) comes first in pre-order.
    : kinds.flatMap((kind) => node.getDescendantsOfKind(kind)).sort((a, b) => a.getPos() - b.getPos() || b.getEnd() - a.getEnd())
  for (const match of matches) visit(match)
}
