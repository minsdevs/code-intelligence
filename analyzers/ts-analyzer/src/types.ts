export type AnalyzeFile = {
  path: string
  content: string
  /** Backend-owned extraction result; never part of the source manifest. */
  cache?: string
}

export type AnalyzeRequest = {
  files: AnalyzeFile[]
  cacheKey?: string
  /** Chunked whole-project analysis (03 §6); `files` stays empty on session commands. */
  session?: SessionCommand
}

export type SessionCommand = {
  op: 'open' | 'put' | 'seal' | 'analyze' | 'page' | 'close'
  cacheKey?: string
  id?: string
  seq?: number
  page?: number
  /** put: this chunk's files. */
  files?: AnalyzeFile[]
  /** open/seal: the exact manifest. */
  fileCount?: number
  bytes?: number
  digest?: string
}

export type SessionReply = {
  id: string
  op: SessionCommand['op']
  seq?: number
  page?: number
  pages?: number
}

export type RouteHit = {
  path: string
  component: string | null
  filePath: string
  lineStart: number
  lineEnd: number
  componentResolution?: RouteComponentResolution
}

export type RouteComponentResolution = {
  status: 'RESOLVED' | 'UNRESOLVED'
  target: { name: string; filePath: string; lineStart: number; lineEnd: number } | null
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
  cache?: string[]
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
