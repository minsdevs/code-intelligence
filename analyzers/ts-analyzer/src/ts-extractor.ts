import { Node, Project, type SourceFile, SyntaxKind, ts } from 'ts-morph'
import type { AnalyzeFile, AnalyzeResponse, ApiCallHit, EndpointHit, RouteHit, SymbolHit } from './types'
import { isTsJs } from './paths'
import { extractGeneric } from './generic-extractor'
import { extractSemanticGraph } from './semantic-extractor'
import { assertParseable } from './syntax-diagnostics'

const HTTP_METHODS: Record<string, true> = {
  GET: true,
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
  HEAD: true,
  OPTIONS: true,
}

const STORE_FACTORIES_BY_SOURCE: Record<string, string[]> = {
  zustand: ['create', 'createStore'],
  redux: ['createStore'],
  '@reduxjs/toolkit': ['createSlice', 'configureStore'],
  pinia: ['defineStore'],
}

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
      noResolve: false,
      strict: false,
    },
  })
  for (const file of tsFiles) {
    project.createSourceFile(file.path, file.content, { overwrite: true, scriptKind: scriptKind(file.path) })
  }

  const routes: RouteHit[] = []
  const endpoints: EndpointHit[] = []
  const components: SymbolHit[] = []
  const hooks: SymbolHit[] = []
  const stores: SymbolHit[] = []
  const apiCalls: ApiCallHit[] = []
  const symbols: SymbolHit[] = []

  const sourceFiles = project.getSourceFiles()
  assertParseable(project, sourceFiles)
  const httpBindings: HttpBindings = {
    inputSources: new Set(sourceFiles),
    globalFetchShadowed: sourceFiles.some(hasGlobalFetchBinding),
  }
  for (const source of sourceFiles) {
    const filePath = source.getFilePath().replace(/^\//, '')
    collectRoutes(source, filePath, routes)
    collectVueRouter(source, filePath, routes)
    collectFileBasedRoutes(source, filePath, routes, endpoints, symbols)
    collectDeclarations(source, filePath, components, hooks, stores)
    collectApiCalls(source, filePath, apiCalls, httpBindings)
  }
  symbols.push(...extractGeneric(files))
  const semantic = extractSemanticGraph(project, files)
  endpoints.push(...semantic.endpoints)

  return {
    routes,
    components,
    hooks,
    stores,
    apiCalls,
    imports: semantic.imports,
    symbols,
    endpoints,
    nodes: semantic.nodes,
    edges: semantic.edges,
    unresolvedCalls: semantic.unresolvedCalls,
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
    if (!isReactRoute(node.getTagNameNode())) {
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

function isReactRoute(tag: Node): boolean {
  const namespaceMember = Node.isPropertyAccessExpression(tag) && tag.getName() === 'Route'
  const local = namespaceMember ? tag.getExpression() : tag
  if (!Node.isIdentifier(local)) return false
  const declarations = local.getSymbol()?.getDeclarations()
  if (declarations?.length !== 1) return false
  const declaration = declarations[0]
  if (namespaceMember ? !Node.isNamespaceImport(declaration)
    : !Node.isImportSpecifier(declaration) || declaration.getName() !== 'Route' || declaration.isTypeOnly()) return false
  const imported = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
  return !!imported && !imported.isTypeOnly()
    && ['react-router-dom', 'react-router'].includes(imported.getModuleSpecifierValue())
}

/**
 * Vue Router config: `createRouter({ routes: [{ path, name, component }] })`.
 * Works for plain JS/TS router config files.
 */
function collectVueRouter(source: SourceFile, filePath: string, routes: RouteHit[]): void {
  source.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return
    }
    const callee = node.getExpression().getText()
    if (callee !== 'createRouter') {
      return
    }
    const firstArg = node.getArguments()[0]
    if (!firstArg || !Node.isObjectLiteralExpression(firstArg)) {
      return
    }
    const routesProp = firstArg.getProperty('routes')
    if (!routesProp || !Node.isPropertyAssignment(routesProp)) {
      return
    }
    const array = routesProp.getInitializer()
    if (!Node.isArrayLiteralExpression(array)) {
      return
    }
    for (const element of array.getElements()) {
      if (!Node.isObjectLiteralExpression(element)) {
        continue
      }
      const pathProp = element.getProperty('path')
      const path =
        pathProp && Node.isPropertyAssignment(pathProp) ? stringFromNode(pathProp.getInitializer()) : null
      if (!path) {
        continue
      }
      const compProp = element.getProperty('component')
      let component: string | null = null
      if (compProp && Node.isPropertyAssignment(compProp)) {
        component = componentFromElement(compProp.getInitializer())
      }
      routes.push({
        path: path.startsWith('/') ? path : `/${path}`,
        component,
        filePath,
        lineStart: element.getStartLineNumber(),
        lineEnd: element.getEndLineNumber(),
      })
    }
  })
}

// File-based routers — Next.js App Router (app/.../page.tsx, app/.../route.ts),
// Expo Router (app/.../index.tsx) and SvelteKit (src/routes/.../+server.ts).
function collectFileBasedRoutes(
  source: SourceFile,
  filePath: string,
  routes: RouteHit[],
  endpoints: EndpointHit[],
  symbols: SymbolHit[],
): void {
  const hit = detectFileBasedRoute(filePath)
  if (!hit) {
    return
  }
  if (hit.kind === 'endpoint') {
    for (const handler of exportedHttpHandlers(source)) {
      endpoints.push({
        method: handler.name,
        path: hit.path,
        handlerKey: `${filePath}#${handler.name}`,
        handler: handler.name,
        filePath,
        lineStart: handler.start,
        lineEnd: handler.end,
      })
      symbols.push({
        name: handler.name,
        kind: 'METHOD',
        filePath,
        lineStart: handler.start,
        lineEnd: handler.end,
      })
    }
    return
  }
  routes.push({
    path: hit.path,
    component: defaultExportName(source),
    filePath,
    lineStart: 1,
    lineEnd: 1,
  })
}

const RESERVED_ROUTE_STEMS = new Set([
  'layout',
  '_layout',
  'loading',
  'error',
  'global-error',
  'not-found',
  'template',
  'icon',
  'apple-icon',
  'opengraph-image',
  'twitter-image',
  'robots',
  'sitemap',
  'manifest',
  'default',
  '+layout',
  '+layout.server',
  '+error',
  '+error.server',
  '+page.server',
  '+layout.ts',
])

function detectFileBasedRoute(filePath: string): { path: string; kind: 'route' | 'endpoint' } | null {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  const match = normalized.match(/^(?:.*\/)?(app|src\/app|src\/routes)\/(.+)$/)
  if (!match) {
    return null
  }
  const rest = match[2]
  const extMatch = rest.match(/^(.*)\.(tsx|ts|jsx|js|mjs|cjs)$/)
  if (!extMatch) {
    return null
  }
  let stem = extMatch[1]
  let kind: 'route' | 'endpoint' = 'route'
  if (stem === '+server' || stem.endsWith('/+server')) {
    stem = stem === '+server' ? '' : stem.slice(0, -7)
    kind = 'endpoint'
  } else if (stem === 'route' || stem.endsWith('/route')) {
    stem = stem === 'route' ? '' : stem.slice(0, -6)
    kind = 'endpoint'
  } else if (stem === '+page' || stem.endsWith('/+page')) {
    stem = stem === '+page' ? '' : stem.slice(0, -5)
  } else if (stem === '+page.server' || stem.endsWith('/+page.server')) {
    stem = stem === '+page.server' ? '' : stem.slice(0, -12)
  } else if (stem === 'page' || stem.endsWith('/page')) {
    stem = stem === 'page' ? '' : stem.slice(0, -5)
  } else if (stem === 'index' || stem.endsWith('/index')) {
    stem = stem === 'index' ? '' : stem.slice(0, -6)
  }
  const segments = splitSegments(stem)
  const last = segments[segments.length - 1]
  if (last !== undefined && RESERVED_ROUTE_STEMS.has(last)) {
    return null
  }
  return { path: segmentsToPath(segments), kind }
}

function splitSegments(rest: string): string[] {
  return rest.split('/').filter((segment) => segment.length > 0)
}

function segmentsToPath(segments: string[]): string {
  const visible = segments.filter(
    (segment) => !(segment.startsWith('(') && segment.endsWith(')')) && !segment.startsWith('@'),
  )
  const parts = visible.map((segment) => {
    if (segment.startsWith('[[...')) {
      return '*' + segment.slice(5, -2)
    }
    if (segment.startsWith('[...')) {
      return '*' + segment.slice(4, -1)
    }
    if (segment.startsWith('[') && segment.endsWith(']')) {
      return ':' + segment.slice(1, -1)
    }
    return segment
  })
  if (parts.length === 0) {
    return '/'
  }
  return '/' + parts.join('/')
}

function exportedHttpHandlers(source: SourceFile): { name: string; start: number; end: number }[] {
  const handlers: { name: string; start: number; end: number }[] = []
  for (const fn of source.getFunctions()) {
    if (!fn.isExported()) {
      continue
    }
    const name = fn.getName()
    if (name && HTTP_METHODS[name.toUpperCase()]) {
      handlers.push({ name: name.toUpperCase(), start: fn.getStartLineNumber(), end: fn.getEndLineNumber() })
    }
  }
  for (const declaration of source.getVariableDeclarations()) {
    if (!declaration.isExported()) {
      continue
    }
    const name = declaration.getName()
    if (HTTP_METHODS[name.toUpperCase()]) {
      handlers.push({
        name: name.toUpperCase(),
        start: declaration.getStartLineNumber(),
        end: declaration.getEndLineNumber(),
      })
    }
  }
  return handlers
}

function defaultExportName(source: SourceFile): string | null {
  const text = source.getFullText()
  const functionMatch = text.match(/export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
  if (functionMatch) {
    return functionMatch[1]
  }
  const identifierMatch = text.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*[;=]?/)
  if (identifierMatch) {
    return identifierMatch[1]
  }
  return null
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
    if (Node.isCallExpression(node) && isImportedStoreFactory(node, source)) {
      stores.push({
        name: enclosingName(node) ?? 'store',
        kind: 'STORE',
        filePath,
        lineStart: node.getStartLineNumber(),
        lineEnd: node.getEndLineNumber(),
      })
    }
  })
}

function isImportedStoreFactory(node: Node, source: SourceFile): boolean {
  if (!Node.isCallExpression(node)) return false
  const expression = node.getExpression().getText()
  const dot = expression.indexOf('.')
  const localName = dot < 0 ? expression : expression.slice(0, dot)
  const memberName = dot < 0 ? null : expression.slice(dot + 1)
  for (const declaration of source.getImportDeclarations()) {
    const moduleSource = declaration.getModuleSpecifierValue()
    const factories = STORE_FACTORIES_BY_SOURCE[moduleSource]
    if (!factories) continue
    const namespace = declaration.getNamespaceImport()
    if (namespace?.getText() === localName && memberName && factories.includes(memberName)) return true
    for (const named of declaration.getNamedImports()) {
      const imported = named.getName()
      const local = named.getAliasNode()?.getText() ?? imported
      if (local === expression && factories.includes(imported)) return true
    }
  }
  return false
}

type HttpBindings = { inputSources: Set<SourceFile>; globalFetchShadowed: boolean }

// A script-level runtime binding can collide with lib.dom's global fetch declaration.
// In that case the checker may report only lib.dom, so keep this narrow syntactic guard too.
function hasGlobalFetchBinding(source: SourceFile): boolean {
  if (ts.isExternalModule(source.compilerNode)) return false
  if (source.getEnums().some((declaration) => declaration.getName() === 'fetch')) return true
  const bindsFetch = (name: Node): boolean => {
    if (Node.isIdentifier(name)) return name.getText() === 'fetch'
    if (Node.isObjectBindingPattern(name) || Node.isArrayBindingPattern(name)) {
      return name.getElements().some((element) => Node.isBindingElement(element) && bindsFetch(element.getNameNode()))
    }
    return false
  }
  return source.getDescendantsOfKind(SyntaxKind.VariableDeclaration).some((declaration) => {
    if (!bindsFetch(declaration.getNameNode())) return false
    const lexical = declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclarationList)?.getDeclarationKind() !== 'var'
    const scope = declaration.getFirstAncestor((ancestor) =>
      Node.isSourceFile(ancestor) || Node.isModuleBlock(ancestor) || ts.isFunctionLike(ancestor.compilerNode)
      || lexical && (Node.isBlock(ancestor) || Node.isCaseBlock(ancestor) || Node.isForStatement(ancestor)
        || Node.isForInStatement(ancestor) || Node.isForOfStatement(ancestor)),
    )
    return scope === source
  })
}

function builtinFetch(expression: Node, bindings: HttpBindings): boolean {
  if (!Node.isIdentifier(expression) || expression.getText() !== 'fetch' || bindings.globalFetchShadowed
      || expression.getFirstAncestorByKind(SyntaxKind.WithStatement)) return false
  const declarations = expression.getSymbol()?.getDeclarations() ?? []
  const program = expression.getProject().getProgram().compilerObject
  return declarations.every((declaration) => !bindings.inputSources.has(declaration.getSourceFile())
    && program.isSourceFileDefaultLibrary(declaration.getSourceFile().compilerNode))
}

function axiosDefaultImport(expression: Node): boolean {
  if (!Node.isIdentifier(expression)) return false
  const declarations = expression.getSymbol()?.getDeclarations() ?? []
  if (declarations.length !== 1) return false
  const declaration = declarations[0]
  if (!Node.isImportClause(declaration)
      && !(Node.isImportSpecifier(declaration) && declaration.getName() === 'default' && !declaration.isTypeOnly())) return false
  const imported = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
  return imported?.getModuleSpecifierValue() === 'axios' && !imported.isTypeOnly()
}

// Ordered object properties matter: a later spread/computed key may replace a literal method.
// A later explicit property can in turn establish the final own value without executing code.
function httpConfigProperty(object: Node, name: string): { present: boolean; value: Node | undefined } {
  let result = { present: false, value: undefined as Node | undefined }
  if (!Node.isObjectLiteralExpression(object)) return { present: true, value: undefined }
  for (const property of object.getProperties()) {
    if (Node.isSpreadAssignment(property)) { result = { present: true, value: undefined }; continue }
    const key = property.getNameNode()
    const computed = Node.isComputedPropertyName(key)
    const keyExpression = computed ? key.getExpression() : key
    const keyName = Node.isIdentifier(keyExpression) && !computed ? keyExpression.getText()
      : Node.isStringLiteral(keyExpression) || Node.isNoSubstitutionTemplateLiteral(keyExpression) ? keyExpression.getLiteralText() : null
    if (keyName === null || keyName === '__proto__') { result = { present: true, value: undefined }; continue }
    if (keyName === name) result = { present: true, value: Node.isPropertyAssignment(property) ? property.getInitializer() : undefined }
  }
  return result
}

function httpMethod(options: Node | undefined): string {
  if (!options) return 'GET'
  const method = httpConfigProperty(options, 'method')
  if (!method.present) return 'GET'
  const value = method.value
  return value && (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value))
    ? value.getLiteralText().toUpperCase() : 'UNKNOWN'
}

function collectApiCalls(source: SourceFile, filePath: string, apiCalls: ApiCallHit[], bindings: HttpBindings): void {
  source.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return
    }
    const parsed = parseApiCall(node, bindings)
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


function parseApiCall(node: Node, bindings: HttpBindings): { method: string; url: string } | null {
  if (!Node.isCallExpression(node)) {
    return null
  }
  const expr = node.getExpression()
  const args = node.getArguments()
  if (builtinFetch(expr, bindings)) {
    const url = stringFromNode(args[0])
    if (!url) {
      return null
    }
    return { method: httpMethod(args[1]), url }
  }
  if (Node.isPropertyAccessExpression(expr)) {
    const name = expr.getName()
    const http = name.toUpperCase()
    if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(http) && axiosDefaultImport(expr.getExpression())) {
      const url = stringFromNode(args[0])
      if (url) {
        return { method: http, url }
      }
    }
  }
  if (args[0] && Node.isObjectLiteralExpression(args[0]) && axiosDefaultImport(expr)) {
    const url = stringFromNode(httpConfigProperty(args[0], 'url').value)
    const method = httpMethod(args[0])
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
  // Vue lazy import: () => import('./views/X.vue') → component name X
  if (Node.isArrowFunction(expr)) {
    const body = expr.getBody()
    if (body && Node.isCallExpression(body) && body.getExpression().getText() === 'import') {
      const url = stringFromNode(body.getArguments()[0])
      if (url) {
        const base = url.split('/').pop() ?? url
        const cleaned = base.replace(/\.(vue|tsx?|jsx?)$/, '')
        return cleaned.length > 0 ? cleaned : null
      }
    }
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
