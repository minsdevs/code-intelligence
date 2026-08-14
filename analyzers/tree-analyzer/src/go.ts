import type { AnalyzeFile, EndpointHit, SymbolHit } from './types'
import { goParser } from './tree'

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const ROUTER_RECEIVERS = /^(r|router|engine|api|group|app|e|mux|srv|server)$/

export function extractGo(file: AnalyzeFile): { endpoints: EndpointHit[]; symbols: SymbolHit[] } {
  const endpoints: EndpointHit[] = []
  const symbols: SymbolHit[] = []
  const content = file.content
  const root = goParser().parse(content).rootNode

  for (const node of root.namedChildren) {
    if (node.type === 'function_declaration' || node.type === 'method_declaration') {
      const name = text(first(node, 'identifier') ?? first(node, 'field_identifier'), content)
      if (name) {
        symbols.push(symbolHit(name, node.type === 'method_declaration' ? 'METHOD' : 'FUNCTION', file.path, node))
      }
    } else if (node.type === 'type_declaration') {
      collectTypes(node, content, file.path, symbols)
    }
  }

  walkCalls(root, content, file.path, endpoints)
  return { endpoints, symbols }
}

function collectTypes(node: any, content: string, filePath: string, symbols: SymbolHit[]): void {
  const spec = first(node, 'type_spec')
  if (!spec) {
    return
  }
  const name = text(first(spec, 'type_identifier'), content)
  if (!name) {
    return
  }
  const hasStruct = (spec.namedChildren ?? []).some((child: any) => child.type === 'struct_type')
  if (hasStruct) {
    symbols.push(symbolHit(name, 'CLASS', filePath, spec))
  }
}

function walkCalls(node: any, content: string, filePath: string, endpoints: EndpointHit[]): void {
  if (node.type === 'call_expression') {
    extractEndpointCall(node, content, filePath, endpoints)
  }
  for (const child of node.namedChildren ?? []) {
    walkCalls(child, content, filePath, endpoints)
  }
}

function extractEndpointCall(call: any, content: string, filePath: string, endpoints: EndpointHit[]): void {
  const selector = first(call, 'selector_expression')
  if (!selector) {
    return
  }
  const children = selector.namedChildren ?? []
  const receiver = children[0] ? text(children[0], content) ?? '' : ''
  const member = children[1] ? text(children[1], content) ?? '' : ''
  const args = first(call, 'argument_list')
  const path = args?.namedChildren?.[0] ? stringValue(args.namedChildren[0], content) : null
  if (!path) {
    return
  }
  let method: string | null = null
  if (HTTP_METHODS.has(member)) {
    const base = receiver.split('.').pop() ?? receiver
    if (ROUTER_RECEIVERS.test(base.toLowerCase())) {
      method = member
    }
  } else if ((member === 'HandleFunc' || member === 'Handle') && /^(http|mux|r|router)$/.test(receiver)) {
    method = 'ANY'
  }
  if (!method) {
    return
  }
  const handler = args?.namedChildren?.[1]
    ? (text(args.namedChildren[1], content) ?? '').split('.').pop() ?? null
    : null
  endpoints.push({
    method,
    path,
    handlerKey: `${filePath}#${handler ?? 'handler'}`,
    handler,
    filePath,
    lineStart: call.startPosition.row + 1,
    lineEnd: call.endPosition.row + 1,
  })
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

function stringValue(node: any, content: string): string | null {
  const raw = text(node, content)
  if (!raw) {
    return null
  }
  return raw.replace(/^['"`]|['"`]$/g, '')
}

export function isGo(path: string): boolean {
  return path.toLowerCase().endsWith('.go')
}
