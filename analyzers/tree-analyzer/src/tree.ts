import Parser from 'tree-sitter'
import Python from 'tree-sitter-python'
import Go from 'tree-sitter-go'
import Javascript from 'tree-sitter-javascript'
import type { AnalyzeFile, AnalyzeResponse } from './types'
import { extractPython, isPython } from './python'
import { extractGo, isGo } from './go'
import { extractSvelte, extractVue, isSvelte, isVue } from './vue-svelte'

const python = new Parser()
python.setLanguage(Python)
const go = new Parser()
go.setLanguage(Go)
const javascript = new Parser()
javascript.setLanguage(Javascript)

export function pythonParser(): Parser {
  return python
}

export function goParser(): Parser {
  return go
}

export function javascriptParser(): Parser {
  return javascript
}

export function extract(files: AnalyzeFile[]): AnalyzeResponse {
  const localPaths = new Set(files.map((file) => file.path))
  const response: AnalyzeResponse = {
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
  for (const file of files) {
    if (isPython(file.path)) {
      const result = extractPython(file, localPaths)
      response.endpoints.push(...result.endpoints)
      response.symbols.push(...result.symbols)
      response.entities.push(...result.entities)
      response.imports.push(...result.imports)
    } else if (isGo(file.path)) {
      const result = extractGo(file)
      response.endpoints.push(...result.endpoints)
      response.symbols.push(...result.symbols)
    } else if (isVue(file.path)) {
      const result = extractVue(file)
      response.components.push(...result.components)
      response.apiCalls.push(...result.apiCalls)
    } else if (isSvelte(file.path)) {
      const result = extractSvelte(file)
      response.components.push(...result.components)
      response.apiCalls.push(...result.apiCalls)
      response.routes.push(...result.routes)
    }
  }
  return response
}
