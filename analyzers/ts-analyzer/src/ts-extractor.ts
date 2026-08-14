import { Node, Project, type SourceFile, SyntaxKind, ts } from 'ts-morph'
import type { AnalyzeFile, AnalyzeResponse, ApiCallHit, ImportHit, RouteHit, SymbolHit } from './types'
import { isTsJs, resolveRelativeImport } from './paths'
import { extractGeneric } from './generic-extractor'

export function extractTs(files: AnalyzeFile[]): AnalyzeResponse {
  const tsFiles = files.filter((file) => isTsJs(file.path))
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      esModuleInterop: true,
      skipLibCheck: true,
      noResolve: true,
      strict: false,
    },
  })
  for (const file of tsFiles) {
    project.createSourceFile(file.path, file.content, { overwrite: true, scriptKind: scriptKind(file.path) })
  }

  const routes: RouteHit[] = []
  const components: SymbolHit[] = []
  const hooks: SymbolHit[] = []
  const stores: SymbolHit[] = []
  const apiCalls: ApiCallHit[] = []
  const imports: ImportHit[] = []
  const pathSet = new Set(tsFiles.map((file) => file.path))

  for (const source of project.getSourceFiles()) {
    const filePath = source.getFilePath().replace(/^\//, '')
    collectRoutes(source, filePath, routes)
    collectDeclarations(source, filePath, components, hooks, stores)
    collectApiCalls(source, filePath, apiCalls)
    collectImports(source, filePath, pathSet, imports)
  }

  return {
    routes,
    components,
    hooks,
    stores,
    apiCalls,
    imports,
    symbols: extractGeneric(files),
  }
}

function scriptKind(path: string): ts.ScriptKind {
  const lower = path.toLowerCase()
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function collectRoutes(source: SourceFile, filePath: string, routes: RouteHit[]): void {
  source.forEachDescendant((node) => {
    if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) {
      return
    }
    const tag = node.getTagNameNode().getText()
    if (tag !== 'Route' && !tag.endsWith('.Route')) {
      return
    }
    const pathAttr = node.getAttribute('path')
    if (!pathAttr || !Node.isJsxAttribute(pathAttr)) {
      return
    }
    const routePath = stringFromInitializer(pathAttr.getInitializer())
    if (routePath == null) {
      return
    }
    const elementAttr = node.getAttribute('element')
    let component: string | null = null
    if (elementAttr && Node.isJsxAttribute(elementAttr)) {
      component = componentFromElement(elementAttr.getInitializer())
    }
    routes.push({
      path: routePath.startsWith('/') ? routePath : `/${routePath}`,
      component,
      filePath,
      lineStart: node.getStartLineNumber(),
      lineEnd: node.getEndLineNumber(),
    })
  })
}

function collectDeclarations(
  source: SourceFile,
  filePath: string,
  components: SymbolHit[],
  hooks: SymbolHit[],
  stores: SymbolHit[],
): void {
  source.forEachDescendant((node) => {
    if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isArrowFunction(node)) {
      const name = functionName(node)
      if (!name) {
        return
      }
      const start = node.getStartLineNumber()
      const end = node.getEndLineNumber()
      if (isHookName(name)) {
        hooks.push({ name, kind: 'HOOK', filePath, lineStart: start, lineEnd: end })
        return
      }
      if (isPascalCase(name) && containsJsx(node)) {
        components.push({ name, kind: 'COMPONENT', filePath, lineStart: start, lineEnd: end })
      }
    }
    if (Node.isCallExpression(node)) {
      const callee = node.getExpression().getText()
      if (callee === 'create' || callee.endsWith('.create') || callee === 'createSlice') {
        stores.push({
          name: enclosingName(node) ?? 'store',
          kind: 'STORE',
          filePath,
          lineStart: node.getStartLineNumber(),
          lineEnd: node.getEndLineNumber(),
        })
      }
    }
  })
}

function collectApiCalls(source: SourceFile, filePath: string, apiCalls: ApiCallHit[]): void {
  source.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return
    }
    const parsed = parseApiCall(node)
    if (!parsed) {
      return
    }
    apiCalls.push({
      method: parsed.method,
      url: parsed.url,
      filePath,
      lineStart: node.getStartLineNumber(),
      owner: enclosingName(node),
    })
  })
}

function collectImports(source: SourceFile, filePath: string, pathSet: Set<string>, imports: ImportHit[]): void {
  for (const decl of source.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue()
    const resolved = resolveImportedFile(spec, filePath, pathSet)
    if (!resolved) {
      continue
    }
    const names: string[] = []
    const def = decl.getDefaultImport()
    if (def) {
      names.push(def.getText())
    }
    for (const named of decl.getNamedImports()) {
      names.push(named.getName())
    }
    if (names.length === 0) {
      names.push('*')
    }
    for (const imported of names) {
      imports.push({ fromPath: filePath, toPath: resolved, imported })
    }
  }
}

function resolveImportedFile(spec: string, fromPath: string, pathSet: Set<string>): string | null {
  const relative = resolveRelativeImport(fromPath, spec)
  if (!relative) {
    return null
  }
  const candidates = [
    relative,
    `${relative}.ts`,
    `${relative}.tsx`,
    `${relative}.js`,
    `${relative}.jsx`,
    `${relative}/index.ts`,
    `${relative}/index.tsx`,
  ]
  for (const candidate of candidates) {
    if (pathSet.has(candidate)) {
      return candidate
    }
  }
  return relative
}

function parseApiCall(node: Node): { method: string; url: string } | null {
  if (!Node.isCallExpression(node)) {
    return null
  }
  const expr = node.getExpression()
  const args = node.getArguments()
  if (Node.isIdentifier(expr) && expr.getText() === 'fetch') {
    const url = stringFromNode(args[0])
    if (!url) {
      return null
    }
    let method = 'GET'
    if (args[1] && Node.isObjectLiteralExpression(args[1])) {
      const methodProp = args[1].getProperty('method')
      if (methodProp && Node.isPropertyAssignment(methodProp)) {
        method = (stringFromNode(methodProp.getInitializer()) ?? 'GET').toUpperCase()
      }
    }
    return { method, url }
  }
  if (Node.isPropertyAccessExpression(expr)) {
    const name = expr.getName()
    const objectText = expr.getExpression().getText()
    if (objectText === 'axios' || objectText.endsWith('axios')) {
      const http = name.toUpperCase()
      if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(http)) {
        const url = stringFromNode(args[0])
        if (url) {
          return { method: http, url }
        }
      }
    }
  }
  if (Node.isIdentifier(expr) && expr.getText() === 'axios' && args[0] && Node.isObjectLiteralExpression(args[0])) {
    const urlProp = args[0].getProperty('url')
    const methodProp = args[0].getProperty('method')
    const url = urlProp && Node.isPropertyAssignment(urlProp) ? stringFromNode(urlProp.getInitializer()) : null
    const method =
      methodProp && Node.isPropertyAssignment(methodProp)
        ? (stringFromNode(methodProp.getInitializer()) ?? 'GET').toUpperCase()
        : 'GET'
    if (url) {
      return { method, url }
    }
  }
  return null
}

function stringFromInitializer(initializer: Node | undefined): string | null {
  if (!initializer) {
    return null
  }
  if (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer)) {
    return initializer.getLiteralText()
  }
  if (Node.isJsxExpression(initializer)) {
    return stringFromNode(initializer.getExpression())
  }
  return stringFromNode(initializer)
}

function stringFromNode(node: Node | undefined): string | null {
  if (!node) {
    return null
  }
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText()
  }
  if (Node.isTemplateExpression(node)) {
    return node.getText().slice(1, -1)
  }
  return null
}

function componentFromElement(initializer: Node | undefined): string | null {
  if (!initializer) {
    return null
  }
  const expr = Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer
  if (!expr) {
    return null
  }
  if (Node.isJsxSelfClosingElement(expr) || Node.isJsxOpeningElement(expr)) {
    return expr.getTagNameNode().getText()
  }
  if (Node.isIdentifier(expr)) {
    return expr.getText()
  }
  const ident = expr.getFirstDescendantByKind(SyntaxKind.Identifier)
  return ident ? ident.getText() : null
}

function functionName(node: Node): string | null {
  if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node)) {
    return node.getName() ?? enclosingName(node)
  }
  if (Node.isArrowFunction(node)) {
    return enclosingName(node)
  }
  return null
}

function enclosingName(node: Node): string | null {
  const fn = node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)
  if (fn?.getName()) {
    return fn.getName() ?? null
  }
  const varDecl = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
  if (varDecl) {
    return varDecl.getName()
  }
  return null
}

function containsJsx(node: Node): boolean {
  return node
    .getDescendants()
    .some((child) => Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child) || Node.isJsxFragment(child))
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name)
}

function isHookName(name: string): boolean {
  return name.startsWith('use') && name.length > 3 && name[3] === name[3]?.toUpperCase()
}
