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
  kind: 'COMPONENT' | 'HOOK' | 'STORE' | 'FUNCTION' | 'CLASS'
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

export type AnalyzeResponse = {
  routes: RouteHit[]
  components: SymbolHit[]
  hooks: SymbolHit[]
  stores: SymbolHit[]
  apiCalls: ApiCallHit[]
  imports: ImportHit[]
  symbols: SymbolHit[]
}
