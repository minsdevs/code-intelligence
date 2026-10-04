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
}

export type EndpointHit = {
  method: string
  path: string
  handlerKey: string
  handler: string | null
  filePath: string
  lineStart: number
  lineEnd: number
}

export type EntityHit = {
  name: string
  tableName: string
  source: string
  filePath: string
  lineStart: number
}

export type AnalyzeResponse = {
  fileOutcomes?: { path: string; status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'UNSUPPORTED'; reason: string }[]
  routes: RouteHit[]
  components: SymbolHit[]
  hooks: SymbolHit[]
  stores: SymbolHit[]
  apiCalls: ApiCallHit[]
  imports: ImportHit[]
  symbols: SymbolHit[]
  endpoints: EndpointHit[]
  entities: EntityHit[]
}

export const EMPTY_RESPONSE: AnalyzeResponse = {
  routes: [],
  components: [],
  hooks: [],
  stores: [],
  apiCalls: [],
  imports: [],
  symbols: [],
  endpoints: [],
  entities: [],
}
