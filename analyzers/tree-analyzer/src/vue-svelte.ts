import type { AnalyzeFile, ApiCallHit, RouteHit, SymbolHit } from './types'
import { javascriptParser } from './tree'

const RESERVED_STEMS = new Set([
  'layout',
  '_layout',
  'error',
  '+layout',
  '+layout.server',
  '+error',
  '+error.server',
])

export function extractVue(file: AnalyzeFile): { components: SymbolHit[]; apiCalls: ApiCallHit[] } {
  const script = extractScriptBlock(file.content)
  const name = pascalCase(stemOf(file.path))
  const components: SymbolHit[] = [{ name, kind: 'COMPONENT', filePath: file.path, lineStart: 1, lineEnd: 1 }]
  const apiCalls = script ? collectJsApiCalls(script, file.path, name) : []
  return { components, apiCalls }
}

export function extractSvelte(file: AnalyzeFile): {
  components: SymbolHit[]
  apiCalls: ApiCallHit[]
  routes: RouteHit[]
} {
  const script = extractScriptBlock(file.content)
  const name = pascalCase(stemOf(file.path))
  const components: SymbolHit[] = [{ name, kind: 'COMPONENT', filePath: file.path, lineStart: 1, lineEnd: 1 }]
  const apiCalls = script ? collectJsApiCalls(script, file.path, name) : []
  const routes: RouteHit[] = []
  const route = svelteKitRoute(file.path)
  if (route) {
    routes.push({ path: route, component: null, filePath: file.path, lineStart: 1, lineEnd: 1 })
  }
  return { components, apiCalls, routes }
}

function extractScriptBlock(content: string): string | null {
  const match = content.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)
  return match ? match[1] : null
}

function collectJsApiCalls(script: string, filePath: string, owner: string): ApiCallHit[] {
  const calls: ApiCallHit[] = []
  const root = javascriptParser().parse(script).rootNode
  walk(root, (node) => {
    if (node.type !== 'call_expression') {
      return
    }
    const parsed = parseCall(node, script)
    if (!parsed) {
      return
    }
    calls.push({
      method: parsed.method,
      url: parsed.url,
      filePath,
      lineStart: node.startPosition.row + 1,
      owner,
    })
  })
  return calls
}

function parseCall(call: any, content: string): { method: string; url: string } | null {
  const args = first(call, 'arguments')
  const url = args?.namedChildren?.[0] ? stringValue(args.namedChildren[0], content) : null
  if (!url) {
    return null
  }
  const callee = call.namedChildren?.[0]
  if (!callee) {
    return null
  }
  if (callee.type === 'identifier' && text(callee, content) === 'fetch') {
    return { method: 'GET', url }
  }
  if (callee.type === 'member_expression') {
    const children = callee.namedChildren ?? []
    const object = children[0] ? text(children[0], content) ?? '' : ''
    const property = children[1] ? text(children[1], content) ?? '' : ''
    if (object === 'axios' || object.endsWith('.axios')) {
      const method = property.toUpperCase()
      if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        return { method, url }
      }
    }
  }
  return null
}

function svelteKitRoute(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const match = normalized.match(/^(?:.*\/)?src\/routes\/(.+)$/)
  if (!match) {
    return null
  }
  const rest = match[1]
  const file = rest.match(/^(.*?)\/?(\+page)(?:\.server)?\.svelte$/)
  if (!file) {
    return null
  }
  const segments = file[1].split('/').filter((segment) => segment.length > 0)
  const last = segments[segments.length - 1]
  if (last !== undefined && RESERVED_STEMS.has(last)) {
    return null
  }
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

function walk(node: any, visit: (node: any) => void): void {
  visit(node)
  for (const child of node.namedChildren ?? []) {
    walk(child, visit)
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

function stemOf(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.(vue|svelte)$/i, '')
}

function pascalCase(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9]+/g, ' ')
  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')
}

export function isVue(path: string): boolean {
  return path.toLowerCase().endsWith('.vue')
}

export function isSvelte(path: string): boolean {
  return path.toLowerCase().endsWith('.svelte')
}
