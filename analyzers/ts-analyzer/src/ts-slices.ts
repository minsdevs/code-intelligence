import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { Project, ts } from 'ts-morph'
import { extractGeneric } from './generic-extractor'
import {
  collectManifestFacts,
  createImportResolver,
  type ManifestFacts,
  type SliceScope,
} from './semantic-extractor'
import { ParserSyntaxError, syntaxDiagnostics, type ParserSyntaxDiagnostic } from './syntax-diagnostics'
import { assembleResponse, createProgramProject, extractProgram, type ProgramOutput } from './ts-extractor'
import type { AnalyzeFile, AnalyzeResponse } from './types'
import { CACHE_LISTS, CACHE_TOTAL_BYTES, cacheKeys, encodeCachedFile, readCachedFile, type CachedRow } from './incremental-cache'

/**
 * Sliced whole-manifest extraction (R10, large size class). One compiler program for 100 MiB of
 * TS/JS needs about 6.4 GiB, so the manifest is processed in programs of about this much source,
 * one at a time, and their facts are merged as if one program had produced them.
 *
 * The rule that keeps the result equal to one whole-manifest program (03 §6, single context):
 * every fact is computed from (a) its own file, (b) the files its import/export/require
 * specifiers resolve to, (c) global-scope files (scripts, declaration files, `declare global`)
 * and (d) the manifest-wide Nest facts (provider tokens, provider class methods, global prefix),
 * which a first pass collects. The checker is only asked about a file's own and global
 * declarations. A slice program therefore holds its owned files, every file they resolve to and
 * all global-scope files. Any resolution that still leaves the program (a React component behind
 * a re-export chain) is reported, and that file is re-extracted with twice the import depth until
 * nothing leaves its program. Output lists are ordered by whole-program pass, file order and
 * emission order, and duplicate graph keys keep the first emission in that order, exactly as one
 * program emits them.
 */
export const SLICE_PROGRAM_BYTES = 12 * 1024 * 1024

type Range = { phase: number; filePath: string; start: number; end: number }
type SliceRun = { output: ProgramOutput; ranges: Map<unknown[], Range[]>; outside: Set<string> }

export function extractSliced(
  files: AnalyzeFile[], tsFiles: AnalyzeFile[], budget = SLICE_PROGRAM_BYTES,
  onProgram?: (program: { files: number; bytes: number }) => void,
  incremental = false, onReuse?: (path: string) => void, cacheKey?: string,
): AnalyzeResponse {
  const plan: Plan = { ...planManifest(files, tsFiles), onProgram }
  const identity = incremental ? cacheKeys(files, plan) : undefined
  const cached = new Map<string, ReturnType<typeof readCachedFile>>()
  if (identity) for (const file of tsFiles) {
    const entry = readCachedFile(file.cache, file.path, undefined, identity.whole, cacheKey)
    if (entry) cached.set(file.path, entry)
  }
  plan.singleProgram = incremental && tsFiles.every((file) => !file.cache)
    && tsFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <= 16 * 1024 * 1024
  if (plan.singleProgram) budget = Number.POSITIVE_INFINITY
  const facts: ManifestFacts = { providers: [], providerMethods: new Map(), prefixFacts: new Map() }
  // First pass: manifest-wide Nest facts, from the only files that can declare them.
  const nestFiles = cached.size === plan.order.length ? [] : plan.order.filter((path) => plan.nestCandidate(path))
  runSlices(plan, nestFiles, budget, (project, scope) => {
    const run: ManifestFacts = { providers: [], providerMethods: new Map(), prefixFacts: new Map() }
    const outside = new Set<string>()
    scope.outside = () => { if (scope.current) outside.add(scope.current) }
    collectManifestFacts(project, files, scope, run)
    // Registration order within a file is kept; files are ordered by the whole-manifest order below.
    facts.providers.push(...run.providers.filter((provider) => !outside.has(provider.filePath)))
    for (const [key, method] of run.providerMethods) facts.providerMethods.set(key, method)
    for (const [path, value] of run.prefixFacts) if (!outside.has(path)) facts.prefixFacts.set(path, value)
    return { outside }
  })
  facts.providers.sort((a, b) => plan.index.get(a.filePath)! - plan.index.get(b.filePath)!)
  const keys = identity?.keys(facts)
  if (identity && keys) for (const file of tsFiles) {
    if (!cached.has(file.path)) {
      const entry = readCachedFile(file.cache, file.path, keys.get(file.path), identity.whole, cacheKey)
      if (entry) cached.set(file.path, entry)
    }
    if (cached.has(file.path)) onReuse?.(file.path)
  }

  const diagnostics: { index: number; diagnostics: ParserSyntaxDiagnostic[] }[] = []
  let totalDiagnostics = 0
  const results: { owned: Set<string>; run: SliceRun }[] = []
  const escalated = new Set<string>()
  runSlices(plan, plan.order.filter((path) => !cached.has(path)), budget, (project, scope, owned) => {
    const sources = project.getSourceFiles().filter((source) => owned.has(source.getFilePath().replace(/^\//, '')))
    for (const source of sources) {
      const found = syntaxDiagnostics(project, [source])
      totalDiagnostics += found.total
      if (found.total > 0) diagnostics.push({ index: plan.index.get(source.getFilePath().replace(/^\//, ''))!, diagnostics: found.diagnostics })
    }
    // A syntax error anywhere rejects the whole result; later slices only count diagnostics.
    if (totalDiagnostics > 0) return { outside: new Set() }
    const ranges = new Map<unknown[], Range[]>()
    const outside = new Set<string>()
    scope.manifest = facts
    scope.mark = (list, phase, filePath, start) => {
      if (list.length > start) {
        const rows = ranges.get(list) ?? []
        rows.push({ phase, filePath, start, end: list.length })
        ranges.set(list, rows)
      }
    }
    scope.outside = () => { if (scope.current) outside.add(scope.current) }
    const output = extractProgram(files, project, scope)
    for (const path of outside) escalated.add(path)
    results.push({ owned, run: { output, ranges, outside } })
    return { outside }
  })
  if (totalDiagnostics > 0) {
    diagnostics.sort((a, b) => a.index - b.index)
    throw new ParserSyntaxError(diagnostics.flatMap((entry) => entry.diagnostics).slice(0, 100), totalDiagnostics)
  }
  for (const [path, entry] of cached) {
    const output = emptyOutput()
    const ranges = new Map<unknown[], Range[]>()
    for (const row of entry!.rows) {
      const list = outputList(output, row.list)
      const start = list.length
      list.push(...row.items)
      const marks = ranges.get(list) ?? []
      marks.push({ phase: row.phase, filePath: path, start, end: list.length })
      ranges.set(list, marks)
    }
    results.push({ owned: new Set([path]), run: { output, ranges, outside: new Set() } })
  }
  // Serialize before assembleResponse mutates route ambiguity markers.
  const cache: string[] = []
  if (identity) {
    const rows = new Map<string, CachedRow[]>()
    for (const { owned, run } of results) for (const name of CACHE_LISTS) {
      const list = outputList(run.output, name)
      for (const range of run.ranges.get(list) ?? []) {
        if (!owned.has(range.filePath) || run.outside.has(range.filePath)) continue
        const fileRows = rows.get(range.filePath) ?? []
        fileRows.push({ list: name, phase: range.phase, items: list.slice(range.start, range.end) })
        rows.set(range.filePath, fileRows)
      }
    }
    let bytes = 0
    for (const path of plan.order) {
      const key = escalated.has(path) ? identity.whole : cached.get(path)?.key ?? keys!.get(path)!
      const encoded = encodeCachedFile(path, key, identity.whole, rows.get(path) ?? [], cacheKey)
      if (!encoded) continue
      if (bytes + Buffer.byteLength(encoded) > CACHE_TOTAL_BYTES) break
      bytes += Buffer.byteLength(encoded)
      cache.push(encoded)
    }
  }
  const response = merge(plan, tsFiles, files, results)
  if (identity) response.cache = cache
  return response
}

function emptyOutput(): ProgramOutput {
  return { routes: [], endpoints: [], components: [], hooks: [], stores: [], apiCalls: [], symbols: [],
    semantic: { endpoints: [], imports: [], nodes: [], edges: [], unresolvedCalls: [] } }
}

function outputList(output: ProgramOutput, name: string): Record<string, unknown>[] {
  const [parent, child] = name.split('.')
  return (child ? (output.semantic as unknown as Record<string, unknown>)[child]
    : (output as unknown as Record<string, unknown>)[parent]) as Record<string, unknown>[]
}

type Plan = {
  order: string[]
  index: Map<string, number>
  files: Map<string, AnalyzeFile>
  bytes: Map<string, number>
  targets: Map<string, string[]>
  global: string[]
  pathSet: Set<string>
  nestCandidate(path: string): boolean
  onProgram?: (program: { files: number; bytes: number }) => void
  singleProgram?: boolean
  transientProject?: Project
  unknown: Set<string>
}

function planManifest(files: AnalyzeFile[], tsFiles: AnalyzeFile[]): Plan {
  const byPath = new Map(tsFiles.map((file) => [file.path, file]))
  const order = programOrder(tsFiles)
  const index = new Map(order.map((path, position) => [path, position]))
  const pathSet = new Set(order)
  const resolve = createImportResolver(files, pathSet)
  const targets = new Map<string, string[]>()
  const bytes = new Map<string, number>()
  const global: string[] = []
  let globalNest = false
  const unknown = new Set<string>()
  for (const path of order) {
    const file = byPath.get(path)!
    bytes.set(path, Buffer.byteLength(file.content))
    // A superset of what the extractors resolve: every module specifier the scanner finds.
    const scanned = ts.preProcessFile(file.content, true, true)
    if (scanned.typeReferenceDirectives.length || scanned.libReferenceDirectives.length
      || /(?:import|require)\s*\(\s*[^'"\s]/.test(file.content)) unknown.add(path)
    const resolved = new Set<string>()
    for (const reference of [...scanned.importedFiles, ...scanned.referencedFiles]) {
      const target = resolve(reference.fileName, path)
      if (target && target !== path) resolved.add(target)
    }
    targets.set(path, [...resolved])
    if (isGlobalScope(file)) {
      global.push(path)
      globalNest ||= /NestFactory|@nestjs\/core/.test(file.content)
    }
  }
  return {
    order, index, files: byPath, bytes, targets, global, pathSet, unknown,
    nestCandidate: (path) => {
      const content = byPath.get(path)!.content
      // Provider registrations need an @nestjs/common Module import; application and prefix facts
      // need NestFactory/@nestjs/core in the file or in a global-scope file it can see.
      return content.includes('@nestjs/common') && content.includes('Module')
        || globalNest || /NestFactory|@nestjs\/core/.test(content)
    },
  }
}

/** The order `project.getSourceFiles()` returns for the whole manifest (directory depth first). */
function programOrder(tsFiles: AnalyzeFile[]): string[] {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  for (const file of tsFiles) project.createSourceFile(file.path, '', { overwrite: true })
  return project.getSourceFiles().map((source) => source.getFilePath().replace(/^\//, ''))
}

/**
 * Files whose top-level declarations are visible to every file: scripts (no ES module syntax),
 * declaration files and `declare global` blocks. CommonJS and JSX-only files are included too,
 * which only adds context.
 */
function isGlobalScope(file: AnalyzeFile): boolean {
  if (/\.d\.[cm]?ts$/i.test(file.path) || /\bdeclare\s+global\b/.test(file.content)) return true
  const parsed = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.ESNext, false)
  return (parsed as unknown as { externalModuleIndicator?: unknown }).externalModuleIndicator === undefined
}

type SliceVisitor = (project: Project, scope: SliceScope, owned: Set<string>) => { outside: Set<string> }

/** Runs `visit` over programs whose owned files cover `owned` once; escalates files that leave them. */
function runSlices(plan: Plan, owned: string[], budget: number, visit: SliceVisitor): void {
  const global = new Set(plan.global)
  const globalBytes = plan.global.reduce((sum, path) => sum + plan.bytes.get(path)!, 0)
  const slices: { owned: string[]; depth: number }[] = []
  let current: string[] = []
  let program = new Set<string>()
  let size = globalBytes
  for (const path of owned) {
    const needed = [path, ...plan.targets.get(path)!].filter((entry) => !global.has(entry))
    const extra = needed.filter((entry) => !program.has(entry)).reduce((sum, entry) => sum + plan.bytes.get(entry)!, 0)
    if (current.length > 0 && size + extra > budget) {
      slices.push({ owned: current, depth: 1 })
      current = []
      program = new Set()
      size = globalBytes
    }
    current.push(path)
    for (const entry of needed) {
      if (program.has(entry)) continue
      program.add(entry)
      size += plan.bytes.get(entry)!
    }
  }
  if (current.length > 0) slices.push({ owned: current, depth: 1 })

  while (slices.length > 0) {
    const slice = slices.shift()!
    const programPaths = plan.singleProgram || slice.owned.some((path) => plan.unknown.has(path))
      ? new Set(plan.order) : neighbourhood(plan, slice.owned, slice.depth)
    const ownedSet = new Set(slice.owned)
    const programFiles = plan.order.filter((path) => programPaths.has(path)).map((path) => plan.files.get(path)!)
    if (!plan.transientProject) plan.onProgram?.({ files: programFiles.length, bytes: programFiles.reduce((sum, file) => sum + plan.bytes.get(file.path)!, 0) })
    const project = plan.transientProject ?? createProgramProject(programFiles)
    if (plan.singleProgram) plan.transientProject = project
    const scope: SliceScope = {
      owned: ownedSet, pathSet: plan.pathSet, inProgram: programPaths, current: null,
      outside: () => {}, mark: () => {},
    }
    const { outside } = visit(project, scope, ownedSet)
    if (!plan.singleProgram) releasePrograms()
    if (outside.size === 0) continue
    if (slice.depth === Number.POSITIVE_INFINITY) throw new Error('A TS slice of the whole manifest cannot leave it')
    // Re-run only the files whose facts left the program, with twice the import depth; a resolution
    // the scanner did not see falls back to the whole manifest, which nothing can leave.
    const escalated = [...outside].sort((a, b) => plan.index.get(a)! - plan.index.get(b)!)
    const grows = neighbourhood(plan, escalated, slice.depth * 2).size > neighbourhood(plan, escalated, slice.depth).size
    slices.unshift({ owned: escalated, depth: grows ? slice.depth * 2 : Number.POSITIVE_INFINITY })
  }
}

let collect: (() => void) | null | undefined
/**
 * Collects the finished program before the next one is parsed. Without it V8 grows the heap past
 * several dead programs (large class: 3.2 GiB peak RSS observed, 2.2 GiB with this collection).
 */
function releasePrograms(): void {
  if (collect === undefined) {
    try {
      setFlagsFromString('--expose-gc')
      collect = runInNewContext('gc') as () => void
    } catch {
      collect = null
    }
  }
  collect?.()
}

function neighbourhood(plan: Plan, owned: string[], depth: number): Set<string> {
  if (depth === Number.POSITIVE_INFINITY) return new Set(plan.order)
  const result = new Set<string>([...owned, ...plan.global])
  let frontier = owned
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: string[] = []
    for (const path of frontier) {
      for (const target of plan.targets.get(path)!) {
        if (!result.has(target)) {
          result.add(target)
          next.push(target)
        }
      }
    }
    frontier = next
  }
  return result
}

function merge(plan: Plan, tsFiles: AnalyzeFile[], files: AnalyzeFile[], results: { owned: Set<string>; run: SliceRun }[]): AnalyzeResponse {
  const ordered = <T>(pick: (output: ProgramOutput) => T[]): T[] => {
    const rows: { phase: number; index: number; offset: number; item: T }[] = []
    for (const { owned, run } of results) {
      const list = pick(run.output)
      for (const range of run.ranges.get(list) ?? []) {
        // Context files and files re-run elsewhere report nothing from this program.
        if (!owned.has(range.filePath) || run.outside.has(range.filePath)) continue
        for (let offset = range.start; offset < range.end; offset++) {
          rows.push({ phase: range.phase, index: plan.index.get(range.filePath)!, offset, item: list[offset] })
        }
      }
    }
    rows.sort((a, b) => a.phase - b.phase || a.index - b.index || a.offset - b.offset)
    return rows.map((row) => row.item)
  }
  const firstByKey = <T>(items: T[], key: (item: T) => string): T[] => {
    const seen = new Set<string>()
    return items.filter((item) => {
      const value = key(item)
      if (seen.has(value)) return false
      seen.add(value)
      return true
    })
  }
  const output: ProgramOutput = {
    routes: ordered((value) => value.routes),
    endpoints: ordered((value) => value.endpoints),
    components: ordered((value) => value.components),
    hooks: ordered((value) => value.hooks),
    stores: ordered((value) => value.stores),
    apiCalls: ordered((value) => value.apiCalls),
    symbols: [...ordered((value) => value.symbols), ...extractGeneric(files)],
    semantic: {
      endpoints: ordered((value) => value.semantic.endpoints),
      imports: ordered((value) => value.semantic.imports),
      nodes: firstByKey(ordered((value) => value.semantic.nodes), (node) => node.key),
      edges: firstByKey(ordered((value) => value.semantic.edges), (edge) => JSON.stringify([edge.sourceKey, edge.targetKey, edge.type])),
      unresolvedCalls: ordered((value) => value.semantic.unresolvedCalls),
    },
  }
  return assembleResponse(tsFiles, output)
}
