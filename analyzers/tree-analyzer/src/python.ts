import type { AnalyzeFile, EndpointHit, EntityHit, ImportHit, SymbolHit } from './types'
import { pythonParser } from './tree'

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head'])
const ROUTER_RECEIVERS = new Set(['app', 'router', 'api', 'bp', 'blueprint', 'routes'])

export function extractPython(file: AnalyzeFile, localPaths: Set<string>): {
  hasErrors: boolean
  endpoints: EndpointHit[]
  symbols: SymbolHit[]
  entities: EntityHit[]
  imports: ImportHit[]
} {
  const endpoints: EndpointHit[] = []
  const symbols: SymbolHit[] = []
  const entities: EntityHit[] = []
  const imports: ImportHit[] = []
  const content = file.content
  const root = pythonParser().parse(content).rootNode
  const importNames = new Set<string>()

  for (const child of root.namedChildren) {
    if (child.type === 'import_from_statement' || child.type === 'import_statement') {
      collectImports(child, content, file.path, localPaths, imports, importNames)
    }
  }
  for (const child of root.namedChildren) {
    if (child.type === 'decorated_definition') {
      extractDecorated(child, content, file.path, endpoints, symbols)
    } else if (child.type === 'function_definition') {
      const name = text(first(child, 'identifier'), content)
      if (name) {
        symbols.push(symbolHit(name, 'FUNCTION', file.path, child))
      }
    } else if (child.type === 'class_definition') {
      extractClass(child, content, file.path, symbols, entities, importNames)
    } else if (child.type === 'expression_statement') {
      extractDjangoUrls(child, content, file.path, endpoints)
    }
  }
  return { endpoints, symbols, entities, imports, hasErrors: root.hasError }
}

function extractDecorated(
  node: any,
  content: string,
  filePath: string,
  endpoints: EndpointHit[],
  symbols: SymbolHit[],
): void {
  let fn: any = null
  for (const child of node.namedChildren) {
    if (child.type === 'function_definition') {
      fn = child
      break
    }
  }
  for (const child of node.namedChildren) {
    if (child.type !== 'decorator') {
      continue
    }
    const call = first(child, 'call')
    if (!call) {
      continue
    }
    const attribute = first(call, 'attribute')
    if (!attribute) {
      continue
    }
    const attrs = attribute.namedChildren ?? []
    const receiver = attrs[0] ? text(attrs[0], content) ?? '' : ''
    const member = attrs[1] ? text(attrs[1], content) ?? '' : ''
    const base = receiver.split('.').pop() ?? receiver
    if (!ROUTER_RECEIVERS.has(base.toLowerCase())) {
      continue
    }
    const path = firstStringArg(call, content)
    if (!path) {
      continue
    }
    let methods: string[] = []
    if (member === 'route') {
      methods = methodsFromArgs(call, content)
    } else if (HTTP_METHODS.has(member.toLowerCase())) {
      methods = [member.toUpperCase()]
    }
    if (methods.length === 0) {
      continue
    }
    const fnName = fn ? text(first(fn, 'identifier'), content) : null
    const start = fn ? fn.startPosition.row + 1 : call.startPosition.row + 1
    const end = fn ? fn.endPosition.row + 1 : call.startPosition.row + 1
    for (const method of methods) {
      endpoints.push({
        method,
        path,
        handlerKey: `${filePath}#${fnName ?? 'handler'}`,
        handler: fnName,
        filePath,
        lineStart: start,
        lineEnd: end,
      })
    }
    if (fnName) {
      symbols.push(symbolHit(fnName, 'FUNCTION', filePath, fn))
    }
  }
}

function methodsFromArgs(call: any, content: string): string[] {
  const args = first(call, 'argument_list')
  if (!args) {
    return []
  }
  for (const arg of args.namedChildren ?? []) {
    if (arg.type !== 'keyword_argument') {
      continue
    }
    const kw = first(arg, 'identifier')
    if (!kw || text(kw, content) !== 'methods') {
      continue
    }
    const list = first(arg, 'list') ?? first(arg, 'set')
    if (!list) {
      return []
    }
    const methods: string[] = []
    for (const item of list.namedChildren ?? []) {
      const raw = stringValue(item, content)
      if (raw) {
        methods.push(raw.toUpperCase())
      }
    }
    return methods.length > 0 ? methods : ['GET']
  }
  return ['GET']
}

function extractClass(
  node: any,
  content: string,
  filePath: string,
  symbols: SymbolHit[],
  entities: EntityHit[],
  importNames: Set<string>,
): void {
  const name = text(first(node, 'identifier'), content)
  if (!name) {
    return
  }
  const lineStart = node.startPosition.row + 1
  const lineEnd = node.endPosition.row + 1
  const bases = (node.namedChildren ?? [])
    .filter((n: any) => n.type === 'argument_list')
    .flatMap((n: any) => n.namedChildren ?? [])
    .map((n: any) => text(n, content) ?? '')
  if (bases.some((base: string) => base === 'Base' || importNames.has(base))) {
    entities.push({
      name,
      tableName: findTableName(node, content) ?? name,
      source: 'SQLALCHEMY',
      filePath,
      lineStart,
    })
  } else {
    symbols.push(symbolHit(name, 'CLASS', filePath, node))
  }
  const block = first(node, 'block')
  if (!block) {
    return
  }
  for (const member of block.namedChildren ?? []) {
    if (member.type === 'function_definition') {
      const fnName = text(first(member, 'identifier'), content)
      if (fnName) {
        symbols.push(symbolHit(fnName, 'METHOD', filePath, member))
      }
    }
  }
}

function findTableName(classNode: any, content: string): string | null {
  const block = first(classNode, 'block')
  if (!block) {
    return null
  }
  for (const stmt of block.namedChildren ?? []) {
    if (stmt.type !== 'expression_statement') {
      continue
    }
    const assignment = first(stmt, 'assignment')
    if (!assignment) {
      continue
    }
    const left = text(first(assignment, 'identifier'), content)
    if (left !== '__tablename__') {
      continue
    }
    return stringValue(first(assignment, 'string'), content)
  }
  return null
}

function extractDjangoUrls(node: any, content: string, filePath: string, endpoints: EndpointHit[]): void {
  const assignment = first(node, 'assignment')
  if (!assignment) {
    return
  }
  const target = text(first(assignment, 'identifier'), content)
  if (target !== 'urlpatterns' && target !== 'urls') {
    return
  }
  const list = first(assignment, 'list')
  if (!list) {
    return
  }
  for (const item of list.namedChildren ?? []) {
    if (item.type !== 'call') {
      continue
    }
    const fnName = text(first(item, 'identifier'), content)
    if (fnName !== 'path' && fnName !== 're_path') {
      continue
    }
    const path = firstStringArg(item, content)
    if (!path) {
      continue
    }
    const args = first(item, 'argument_list')
    const view = args?.namedChildren?.[1] ? text(args.namedChildren[1], content) : null
    endpoints.push({
      method: 'ANY',
      path: path.startsWith('/') ? path : `/${path}`,
      handlerKey: `${filePath}#urls#${path}`,
      handler: view,
      filePath,
      lineStart: item.startPosition.row + 1,
      lineEnd: item.endPosition.row + 1,
    })
  }
}

function collectImports(
  node: any,
  content: string,
  filePath: string,
  localPaths: Set<string>,
  imports: ImportHit[],
  importNames: Set<string>,
): void {
  if (node.type === 'import_from_statement') {
    const moduleNode = first(node, 'dotted_name')
    const module = text(moduleNode, content) ?? ''
    for (const child of node.namedChildren ?? []) {
      if (child.type === 'dotted_name' && child !== moduleNode) {
        const imported = text(child, content)
        if (imported) {
          importNames.add(imported)
          pushImport(imports, filePath, module, imported, localPaths)
        }
      }
    }
    return
  }
  const dotted = node.namedChildren?.[0]
  if (dotted && dotted.type === 'dotted_name') {
    const module = text(dotted, content) ?? ''
    const imported = module.split('.').pop() ?? module
    importNames.add(imported)
    pushImport(imports, filePath, module, imported, localPaths)
  }
}

function pushImport(
  imports: ImportHit[],
  fromPath: string,
  module: string,
  imported: string,
  localPaths: Set<string>,
): void {
  const clean = module.replace(/^\.+/, '')
  if (!clean) {
    return
  }
  const rel = clean.replace(/\./g, '/')
  const candidates = [`${rel}.py`, `${rel}/__init__.py`]
  for (const candidate of candidates) {
    if (localPaths.has(candidate)) {
      imports.push({ fromPath, toPath: candidate, imported })
      return
    }
  }
}

function symbolHit(name: string, kind: SymbolHit['kind'], filePath: string, node: any): SymbolHit {
  return {
    name,
    kind,
    filePath,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
  }
}

function firstStringArg(call: any, content: string): string | null {
  const args = first(call, 'argument_list')
  if (!args) {
    return null
  }
  for (const arg of args.namedChildren ?? []) {
    if (arg.type === 'string' || arg.type === 'concatenated_string') {
      return stringValue(arg, content)
    }
  }
  return null
}

function stringValue(node: any, content: string): string | null {
  const raw = text(node, content)
  if (!raw) {
    return null
  }
  return raw.replace(/^['"]|['"]$/g, '')
}

function first(node: any, type: string): any {
  for (const child of node?.namedChildren ?? []) {
    if (child.type === type) {
      return child
    }
  }
  return null
}

function text(node: any, content: string): string | null {
  if (!node || node.startIndex == null || node.endIndex == null) {
    return null
  }
  return content.slice(node.startIndex, node.endIndex)
}

export function isPython(path: string): boolean {
  return path.toLowerCase().endsWith('.py')
}
