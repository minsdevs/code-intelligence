import { Node, SyntaxKind, ts, type SourceFile } from 'ts-morph'
import type { AnalyzeFile, RouteComponentResolution, SymbolHit } from './types'
import { createImportResolver } from './semantic-extractor'
import { forEachDescendantOfKinds } from './walk'

type ExportRef = { node?: Node; local?: string; source?: string; imported?: string; typeOnly?: boolean }
type Module = { source: SourceFile; locals: Map<string, Node[]>; exports: Map<string, ExportRef[]> }
const unresolved: RouteComponentResolution = { status: 'UNRESOLVED', target: null }
const filePath = (source: SourceFile): string => source.getFilePath().replace(/^\//, '')
const keyOf = (hit: SymbolHit): string => JSON.stringify([hit.filePath, hit.name])
const WRITE_KINDS = [SyntaxKind.BinaryExpression, SyntaxKind.PrefixUnaryExpression, SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.ForOfStatement, SyntaxKind.ForInStatement]

/**
 * Resolve only supplied value declarations. Never run an import, evaluate a helper,
 * search other modules by component name, or treat the checker's chosen ambiguous
 * export as proof. Star exports, anonymous defaults and computed/HOC values stay
 * unresolved. Existing graph keys lack lexical scope, so duplicate file/name hits
 * are deliberately not linked even when a source position would distinguish them.
 */
export function createReactComponentResolver(
  sources: SourceFile[], files: AnalyzeFile[], declarations: Map<Node, SymbolHit>,
): (initializer: Node | undefined) => RouteComponentResolution {
  const modules = new Map(sources.map(source => [filePath(source), indexModule(source)]))
  const resolveImport = createImportResolver(files, new Set(modules.keys()), { allowPackageFallback: false })
  const occurrences = new Map<string, number>()
  for (const hit of declarations.values()) occurrences.set(keyOf(hit), (occurrences.get(keyOf(hit)) ?? 0) + 1)
  const written = writtenBindings(sources)

  return initializer => {
    let value = initializer
    if (value && Node.isJsxExpression(value)) value = value.getExpression()
    if (!value) return unresolved
    value = unwrap(value)
    const tag = Node.isJsxSelfClosingElement(value) ? value.getTagNameNode()
      : Node.isJsxElement(value) ? value.getOpeningElement().getTagNameNode() : undefined
    if (!tag) return unresolved
    let steps = 0
    const visiting = new Set<Node | string>()
    const visit = (key: Node | string, action: () => Node | null): Node | null => {
      if (++steps > 64 || visiting.has(key)) return null
      visiting.add(key)
      try { return action() } finally { visiting.delete(key) }
    }
    const local = (source: SourceFile, name: string): Node | null => {
      const matches = modules.get(filePath(source))?.locals.get(name)
      return matches?.length === 1 ? declaration(matches[0]) : null
    }
    const exported = (modulePath: string, name: string): Node | null => visit(JSON.stringify([modulePath, name]), () => {
      const module = modules.get(modulePath), candidates = module?.exports.get(name)
      if (!module || candidates?.length !== 1) return null
      const candidate = candidates[0]
      if (candidate.typeOnly) return null
      if (candidate.source && candidate.imported) {
        const target = resolveImport(candidate.source, modulePath)
        return target ? exported(target, candidate.imported) : null
      }
      if (candidate.local) return local(module.source, candidate.local)
      if (candidate.node) {
        return Node.isExportAssignment(candidate.node) ? expression(candidate.node.getExpression()) : declaration(candidate.node)
      }
      return null
    })
    const imported = (node: Node, name: string): Node | null => {
      const statement = node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
      if (!statement || statement.isTypeOnly()) return null
      const target = resolveImport(statement.getModuleSpecifierValue(), filePath(statement.getSourceFile()))
      return target ? exported(target, name) : null
    }
    const declaration = (node: Node): Node | null => visit(node, () => {
      const module = modules.get(filePath(node.getSourceFile()))
      if (!module || written.has(node)) return null
      if (Node.isImportSpecifier(node)) return node.isTypeOnly() ? null : imported(node, node.getName())
      if (Node.isImportClause(node)) return imported(node, 'default')
      if (Node.isVariableDeclaration(node)) {
        const statement = node.getVariableStatement()
        if (!Node.isIdentifier(node.getNameNode()) || statement?.getDeclarationKind() !== 'const'
          || statement.getParent() !== module.source
          || module.locals.get(node.getName())?.length !== 1) return null
        const initializer = node.getInitializer()
        if (!initializer) return null
        const value = unwrap(initializer)
        return Node.isArrowFunction(value) || Node.isFunctionExpression(value)
          ? declarations.has(value) ? value : null : expression(value)
      }
      if (Node.isFunctionDeclaration(node) && node.getParent() === module.source && node.getName()
        && module.locals.get(node.getName()!)?.length === 1 && declarations.has(node)) return node
      return null
    })
    const expression = (raw: Node): Node | null => {
      const value = unwrap(raw)
      if (Node.isIdentifier(value)) {
        const targets = value.getSymbol()?.getDeclarations()
        // Unimported global scripts must not select a declaration in another file.
        return targets?.length === 1 && targets[0].getSourceFile() === value.getSourceFile()
          ? declaration(targets[0]) : null
      }
      if (Node.isPropertyAccessExpression(value) && Node.isIdentifier(value.getExpression())) {
        const targets = value.getExpression().getSymbol()?.getDeclarations()
        return targets?.length === 1 && Node.isNamespaceImport(targets[0])
          && targets[0].getSourceFile() === value.getSourceFile() ? imported(targets[0], value.getName()) : null
      }
      return null
    }
    const target = expression(tag), hit = target ? declarations.get(target) : undefined
    if (!hit || occurrences.get(keyOf(hit)) !== 1) return unresolved
    return { status: 'RESOLVED', target: { name: hit.name, filePath: hit.filePath, lineStart: hit.lineStart, lineEnd: hit.lineEnd } }
  }
}

function unwrap(value: Node): Node {
  while (Node.isParenthesizedExpression(value) || Node.isAsExpression(value)
    || Node.isTypeAssertion(value) || Node.isNonNullExpression(value) || Node.isSatisfiesExpression(value)) value = value.getExpression()
  return value
}

function writtenBindings(sources: SourceFile[]): Set<Node> {
  const result = new Set<Node>()
  const targets = (raw: Node): void => {
    const node = unwrap(raw)
    if (Node.isIdentifier(node)) {
      for (const declaration of node.getSymbol()?.getDeclarations() ?? []) result.add(declaration)
    } else if (Node.isArrayLiteralExpression(node)) {
      for (const element of node.getElements()) targets(element)
    } else if (Node.isObjectLiteralExpression(node)) {
      for (const property of node.getProperties()) {
        if (Node.isPropertyAssignment(property)) targets(property.getInitializerOrThrow())
        else if (Node.isShorthandPropertyAssignment(property)) {
          // The property-name symbol is not the value binding written by destructuring.
          for (const declaration of property.getValueSymbol()?.getDeclarations() ?? []) result.add(declaration)
        }
        else if (Node.isSpreadAssignment(property)) targets(property.getExpression())
      }
    } else if (Node.isSpreadElement(node)) targets(node.getExpression())
    else if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) targets(node.getLeft())
  }
  for (const source of sources) forEachDescendantOfKinds(source, WRITE_KINDS, node => {
    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() >= SyntaxKind.FirstAssignment
      && node.getOperatorToken().getKind() <= SyntaxKind.LastAssignment) targets(node.getLeft())
    else if ((Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node))
      && [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(node.getOperatorToken())) targets(node.getOperand())
    else if (Node.isForOfStatement(node) || Node.isForInStatement(node)) targets(node.getInitializer())
  })
  return result
}

function indexModule(source: SourceFile): Module {
  const locals = new Map<string, Node[]>(), exports = new Map<string, ExportRef[]>()
  const addLocal = (name: string, node: Node): void => { const rows = locals.get(name) ?? []; rows.push(node); locals.set(name, rows) }
  const addExport = (name: string, ref: ExportRef): void => { const rows = exports.get(name) ?? []; rows.push(ref); exports.set(name, rows) }
  for (const statement of source.getStatements()) {
    if (Node.isImportDeclaration(statement)) {
      const defaultImport = statement.getDefaultImport()
      if (defaultImport) addLocal(defaultImport.getText(), defaultImport.getParent())
      const namespace = statement.getNamespaceImport()
      if (namespace) addLocal(namespace.getText(), namespace)
      for (const named of statement.getNamedImports()) addLocal(named.getAliasNode()?.getText() ?? named.getName(), named)
    } else if (Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement)
      || Node.isInterfaceDeclaration(statement) || Node.isTypeAliasDeclaration(statement) || Node.isEnumDeclaration(statement)) {
      const name = statement.getName()
      if (name) addLocal(name, statement)
      if (statement.hasModifier(SyntaxKind.ExportKeyword)) {
        const exportedName = statement.hasModifier(SyntaxKind.DefaultKeyword) ? 'default' : name
        if (exportedName) addExport(exportedName, { node: statement,
          typeOnly: Node.isInterfaceDeclaration(statement) || Node.isTypeAliasDeclaration(statement) })
      }
    } else if (Node.isVariableStatement(statement)) {
      for (const declaration of statement.getDeclarations()) {
        if (!Node.isIdentifier(declaration.getNameNode())) continue
        addLocal(declaration.getName(), declaration)
        if (statement.hasModifier(SyntaxKind.ExportKeyword)) addExport(declaration.getName(), { node: declaration })
      }
    } else if (Node.isExportAssignment(statement) && !statement.isExportEquals()) {
      addExport('default', { node: statement })
    } else if (Node.isExportDeclaration(statement)) {
      const specifier = statement.getModuleSpecifierValue()
      for (const named of statement.getNamedExports()) {
        addExport(named.getAliasNode()?.getText() ?? named.getName(), {
          ...(specifier ? { source: specifier, imported: named.getName() } : { local: named.getName() }),
          typeOnly: statement.isTypeOnly() || named.isTypeOnly(),
        })
      }
      const clause = statement.compilerNode.exportClause
      // Namespace exports are explicit, but not a supported component declaration.
      if (clause && ts.isNamespaceExport(clause)) addExport(clause.name.text, {})
    }
  }
  return { source, locals, exports }
}
