export type AnalyzeFile = {
  path: string
  content: string
}

export type AnalyzeRequest = {
  files: AnalyzeFile[]
}

export type RouteHit = {
  path: string
  component: string | null
  filePath: string
  lineStart: number
  lineEnd: number
}

export type SymbolHit = {
  name: string
  kind: 'COMPONENT' | 'HOOK' | 'STORE' | 'FUNCTION' | 'CLASS' | 'METHOD'
  filePath: string
  lineStart: number
  lineEnd: number
}

export type ApiCallHit = {
  method: string
  url: string
  filePath: string
  lineStart: number
  owner: string | null
}

export type ImportHit = {
  fromPath: string
  toPath: string
  imported: string
  importedName?: string
  typeOnly?: boolean
}

export type EndpointHit = {
  method: string
  path: string
  handlerKey: string
  handler: string | null
  ownerKey?: string | null
  filePath: string
  lineStart: number
  lineEnd: number
  metadata?: Record<string, unknown>
}

export type SemanticNodeHit = {
  key: string
  type: string
  name: string
  filePath: string | null
  lineStart: number | null
  lineEnd: number | null
  layer: string | null
  metadata: Record<string, unknown>
}

export type SemanticEdgeHit = {
  sourceKey: string
  targetKey: string
  type: string
  confidence: 'CONFIRMED' | 'LIKELY' | 'POSSIBLE'
  filePath: string | null
  lineStart: number | null
  lineEnd: number | null
  metadata: Record<string, unknown>
}

export type UnresolvedCallHit = {
  sourceKey: string
  expression: string
  filePath: string
  lineStart: number
  reason: string
}

export type AnalyzeResponse = {
  fileOutcomes?: { path: string; status: 'SUCCESS' | 'PARTIAL' | 'UNMEASURED'; reason: string }[]
  routes: RouteHit[]
  components: SymbolHit[]
  hooks: SymbolHit[]
  stores: SymbolHit[]
  apiCalls: ApiCallHit[]
  imports: ImportHit[]
  symbols: SymbolHit[]
  endpoints: EndpointHit[]
  nodes: SemanticNodeHit[]
  edges: SemanticEdgeHit[]
  unresolvedCalls: UnresolvedCallHit[]
}
