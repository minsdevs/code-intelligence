declare module 'tree-sitter' {
  export class Language {}
  export interface SyntaxPosition {
    row: number
    column: number
  }
  export interface SyntaxNode {
    type: string
    childCount: number
    namedChildren: SyntaxNode[]
    children: SyntaxNode[]
    startIndex: number
    endIndex: number
    startPosition: SyntaxPosition
    endPosition: SyntaxPosition
  }
  export class Tree {
    rootNode: SyntaxNode
  }
  export default class Parser {
    setLanguage(language: unknown): void
    parse(input: string): Tree
  }
}

declare module 'tree-sitter-python' {
  const language: import('tree-sitter').Language
  export default language
}

declare module 'tree-sitter-go' {
  const language: import('tree-sitter').Language
  export default language
}

declare module 'tree-sitter-javascript' {
  const language: import('tree-sitter').Language
  export default language
}
