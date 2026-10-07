import { posix } from 'node:path'
import {
  Node,
  type CallExpression,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type FunctionDeclaration,
  type MethodDeclaration,
  type Project,
  type SourceFile,
  SyntaxKind,
  ts,
} from 'ts-morph'
import type {
  AnalyzeFile,
  EndpointHit,
  ImportHit,
  SemanticEdgeHit,
  SemanticNodeHit,
  UnresolvedCallHit,
} from './types'
import { resolveRelativeImport } from './paths'

type ImportBinding = {
  source: string
  imported: string
  typeOnly: boolean
}

type DeclarationRef = {
  key: string
  name: string
  filePath: string
  classDeclaration?: ClassDeclaration
  functionDeclaration?: FunctionDeclaration
}

type SemanticResult = {
  endpoints: EndpointHit[]
  imports: ImportHit[]
  nodes: SemanticNodeHit[]
  edges: SemanticEdgeHit[]
  unresolvedCalls: UnresolvedCallHit[]
}

type Resolver = (specifier: string, fromPath: string) => string | null

const NEST_COMMON = '@nestjs/common'
const HTTP_DECORATORS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: 'ANY',
}
const CROSS_CUTTING: Record<string, string> = {
  UseGuards: 'GUARD',
  UsePipes: 'PIPE',
  UseInterceptors: 'INTERCEPTOR',
  UseFilters: 'FILTER',
}
const PRISMA_OPERATIONS: Record<string, true> = {
  findUnique: true,
  findUniqueOrThrow: true,
  findFirst: true,
  findFirstOrThrow: true,
  findMany: true,
  create: true,
  createMany: true,
  update: true,
  updateMany: true,
  upsert: true,
  delete: true,
  deleteMany: true,
  count: true,
  aggregate: true,
  groupBy: true,
}
const TYPEORM_OPERATIONS: Record<string, true> = {
  find: true,
  findBy: true,
  findOne: true,
  findOneBy: true,
  save: true,
  insert: true,
  update: true,
  upsert: true,
  remove: true,
  delete: true,
  count: true,
  exists: true,
  createQueryBuilder: true,
}

/**
 * One program of a sliced whole-manifest extraction (ts-slices.ts). The program holds the owned
 * files, every file they resolve to and every global-scope file; facts are reported for owned
 * files only, every emission is kept (the merge dedupes in whole-manifest order), and the
 * manifest-wide Nest facts come from the first pass instead of this program.
 */
export type SliceScope = {
  owned: Set<string>
  /** Every TS/JS path of the manifest, so resolution matches one whole-manifest program. */
  pathSet: Set<string>
  inProgram: Set<string>
  /** The owned file whose facts are being collected. */
  current: string | null
  /** A fact of the current file needed a file outside this program; it is re-run with more context. */
  outside(target: string): void
  /**
   * Items `[start, list.length)` of `list` were emitted for `filePath` in `phase`. Phases number the
   * whole-program passes in their order: 1-2 ts-extractor, 3-7 semantic (imports, declarations,
   * Nest modules, calls, re-exports).
   */
  mark(list: unknown[], phase: number, filePath: string, start: number): void
  manifest?: ManifestFacts
}

/** Manifest-wide inputs of the Nest passes: provider registrations in order and the global prefix. */
export type ManifestFacts = {
  providers: { filePath: string; token: string; ref: DeclarationRef }[]
  providerMethods: Map<string, DeclarationRef>
  prefixFacts: Map<string, GlobalPrefixFacts>
}

export type GlobalPrefixFacts = { unknown: boolean; applications: number; invalid: boolean; prefixes: string[] }

export function extractSemanticGraph(project: Project, files: AnalyzeFile[], scope?: SliceScope): SemanticResult {
  const sourceFiles = project.getSourceFiles()
  const owned = scope ? sourceFiles.filter((source) => scope.owned.has(filePathOf(source))) : sourceFiles
  const resolveImport = scopedResolver(createImportResolver(files, scope?.pathSet ?? new Set(sourceFiles.map((source) => filePathOf(source)))), scope)
  const imports: ImportHit[] = []
  const nodes: SemanticNodeHit[] = []
  const edges: SemanticEdgeHit[] = []
  const endpoints: EndpointHit[] = []
  const unresolvedCalls: UnresolvedCallHit[] = []
  const within = phaseRecorder(scope, [imports, nodes, edges, endpoints, unresolvedCalls])
  const nodeKeys = new Set<string>()
  const edgeKeys = new Set<string>()
  // A slice keeps every emission: which duplicate wins depends on whole-manifest order.
  const addNode = (node: SemanticNodeHit): void => {
    if (scope) nodes.push(node)
    else if (!nodeKeys.has(node.key)) {
      nodeKeys.add(node.key)
      nodes.push(node)
    }
  }
  const addEdge = (edge: SemanticEdgeHit): void => {
    const key = JSON.stringify([edge.sourceKey, edge.targetKey, edge.type])
    if (scope) edges.push(edge)
    else if (!edgeKeys.has(key)) {
      edgeKeys.add(key)
      edges.push(edge)
    }
  }

  const bindingsByFile = new Map<string, Map<string, ImportBinding>>()
  for (const source of sourceFiles) {
    const filePath = filePathOf(source)
    bindingsByFile.set(filePath, collectImportBindings(source))
    if (!scope || scope.owned.has(filePath)) within(3, filePath, () => collectResolvedImports(source, filePath, resolveImport, imports))
  }
  const { classesByName, declarationsByFileAndName, methodsByOwnerAndName } =
    collectDeclarations(sourceFiles, bindingsByFile, within, addNode, addEdge)
  for (const [key, method] of scope?.manifest?.providerMethods ?? []) {
    if (!methodsByOwnerAndName.has(key)) methodsByOwnerAndName.set(key, method)
  }

  let providerTargets = new Map<string, DeclarationRef>()
  for (const source of owned) {
    const filePath = filePathOf(source)
    within(5, filePath, () => {
      collectNestModules([source], bindingsByFile, resolveImport, declarationsByFileAndName, classesByName, addNode, addEdge, providerTargets)
    })
  }
  if (scope?.manifest) {
    providerTargets = new Map()
    for (const provider of scope.manifest.providers) providerTargets.set(provider.token, provider.ref)
  }
  const globalPrefix = combineGlobalPrefix(scope?.manifest
    ? scope.manifest.prefixFacts.values()
    : sourceFiles.map(globalPrefixFacts(new Map())))

  for (const source of owned) {
    const filePath = filePathOf(source)
    within(6, filePath, () => {
      const bindings = bindingsByFile.get(filePath) ?? new Map()
      for (const declaration of source.getClasses()) {
        const className = declaration.getName()
        if (!className) continue
        const classKey = symbolKey(filePath, className)
        const controller = findImportedDecorator(declaration.getDecorators(), bindings, NEST_COMMON, 'Controller')
        const controllerPath = controller ? decoratorPath(controller) : null
        const injectionTargets = constructorInjectionTargets(
          declaration,
          bindings,
          filePath,
          resolveImport,
          declarationsByFileAndName,
          classesByName,
          providerTargets,
        )
        for (const target of injectionTargets.values()) {
          addEdge(edge(classKey, target.key, 'DEPENDS_ON', target.confidence, filePath, target.node, {
            relation: 'INJECTS',
            token: target.token,
          }))
        }
        collectCrossCuttingEdges(declaration.getDecorators(), classKey, filePath, bindings, resolveImport, declarationsByFileAndName, classesByName, addEdge)
        collectMiddlewareEdges(declaration, classKey, filePath, bindings, resolveImport, declarationsByFileAndName, classesByName, addEdge)

        for (const method of declaration.getMethods()) {
          const methodKey = symbolKey(filePath, `${className}.${method.getName()}`)
          collectCrossCuttingEdges(method.getDecorators(), methodKey, filePath, bindings, resolveImport, declarationsByFileAndName, classesByName, addEdge)
          if (controller) {
            collectControllerEndpoints(
              method,
              classKey,
              methodKey,
              controllerPath,
              globalPrefix,
              filePath,
              bindings,
              endpoints,
              addEdge,
              unresolvedCalls,
            )
          }
          collectCallableCalls(
            method,
            classKey,
            methodKey,
            filePath,
            injectionTargets,
            methodsByOwnerAndName,
            resolveImport,
            declarationsByFileAndName,
            addNode,
            addEdge,
            unresolvedCalls,
          )
        }
      }
      for (const declaration of source.getFunctions()) {
        const name = declaration.getName()
        if (!name || !declaration.getBody()) continue
        collectCallableCalls(declaration, '', symbolKey(filePath, name), filePath, new Map(), new Map(),
          resolveImport, declarationsByFileAndName, addNode, addEdge, unresolvedCalls)
      }
    
    })
  }

  for (const source of owned) {
    const filePath = filePathOf(source)
    within(7, filePath, () => collectReExports([source], resolveImport, imports, addEdge))
  }
  return { endpoints, imports, nodes, edges, unresolvedCalls }
}

/**
 * First pass of a sliced extraction: the Nest provider registrations, provider class methods and
 * global-prefix facts of the owned files, which every later slice needs whole-manifest.
 */
export function collectManifestFacts(project: Project, files: AnalyzeFile[], scope: SliceScope, facts: ManifestFacts): void {
  const sourceFiles = project.getSourceFiles()
  const resolveImport = scopedResolver(createImportResolver(files, scope.pathSet), scope)
  const bindingsByFile = new Map(sourceFiles.map((source) => [filePathOf(source), collectImportBindings(source)]))
  const ignore = (): void => {}
  const { classesByName, declarationsByFileAndName, methodsByOwnerAndName } =
    collectDeclarations(sourceFiles, bindingsByFile, (_phase, _file, run) => run(), ignore, ignore)
  const prefixFacts = globalPrefixFacts(new Map())
  for (const source of sourceFiles) {
    const filePath = filePathOf(source)
    if (!scope.owned.has(filePath)) continue
    scope.current = filePath
    try {
      const providers = new Map<string, DeclarationRef>()
      collectNestModules([source], bindingsByFile, resolveImport, declarationsByFileAndName, classesByName, ignore, ignore, providers,
        (token, ref) => facts.providers.push({ filePath, token, ref: { key: ref.key, name: ref.name, filePath: ref.filePath } }))
      for (const ref of providers.values()) {
        for (const [key, method] of methodsByOwnerAndName) if (key.startsWith(`${ref.key}.`)) facts.providerMethods.set(key, method)
      }
      facts.prefixFacts.set(filePath, prefixFacts(source))
    } finally { scope.current = null }
  }
}

function scopedResolver(resolve: Resolver, scope: SliceScope | undefined): Resolver {
  if (!scope) return resolve
  return (specifier, fromPath) => {
    const resolved = resolve(specifier, fromPath)
    if (resolved && !scope.inProgram.has(resolved)) scope.outside(resolved)
    return resolved
  }
}

export function phaseRecorder(scope: SliceScope | undefined, lists: unknown[][]):
  (phase: number, filePath: string, run: () => void) => void {
  return (phase, filePath, run) => {
    if (!scope) {
      run()
      return
    }
    const starts = lists.map((list) => list.length)
    const previous = scope.current
    scope.current = filePath
    try { run() } finally { scope.current = previous }
    lists.forEach((list, index) => scope.mark(list, phase, filePath, starts[index]))
  }
}

function collectDeclarations(
  sourceFiles: SourceFile[],
  bindingsByFile: Map<string, Map<string, ImportBinding>>,
  within: (phase: number, filePath: string, run: () => void) => void,
  addNode: (node: SemanticNodeHit) => void,
  addEdge: (edge: SemanticEdgeHit) => void,
): {
  classesByName: Map<string, DeclarationRef[]>
  declarationsByFileAndName: Map<string, DeclarationRef>
  methodsByOwnerAndName: Map<string, DeclarationRef>
} {
  const classesByName = new Map<string, DeclarationRef[]>()
  const declarationsByFileAndName = new Map<string, DeclarationRef>()
  const methodsByOwnerAndName = new Map<string, DeclarationRef>()
  for (const source of sourceFiles) {
    const filePath = filePathOf(source)
    within(4, filePath, () => {
      const bindings = bindingsByFile.get(filePath) ?? new Map()
      for (const declaration of source.getClasses()) {
        const name = declaration.getName()
        if (!name) continue
        const moduleDecorator = findImportedDecorator(declaration.getDecorators(), bindings, NEST_COMMON, 'Module')
        const controllerDecorator = findImportedDecorator(declaration.getDecorators(), bindings, NEST_COMMON, 'Controller')
        const injectableDecorator = findImportedDecorator(declaration.getDecorators(), bindings, NEST_COMMON, 'Injectable')
        const entityDecorator = findImportedDecorator(declaration.getDecorators(), bindings, 'typeorm', 'Entity')
        const key = symbolKey(filePath, name)
        const validation = collectValidationMetadata(declaration, bindings)
        const nestRole = moduleDecorator ? 'MODULE' : controllerDecorator ? 'CONTROLLER' : injectableDecorator ? 'PROVIDER' : null
        const type = moduleDecorator ? 'MODULE' : entityDecorator ? 'DB_ENTITY' : 'CLASS'
        const metadata: Record<string, unknown> = {
          exported: declaration.isExported() || declaration.isDefaultExport(),
        }
        if (nestRole) metadata.nestRole = nestRole
        if (validation.length > 0) metadata.validation = validation
        if (entityDecorator) {
          metadata.orm = 'TYPEORM'
          metadata.table = staticString(entityDecorator.getArguments()[0]) ?? name
        }
        addNode(hit(key, type, name, filePath, declaration, 'BACKEND', metadata))
        addEdge(edge(fileKey(filePath), key, 'CONTAINS', 'CONFIRMED', filePath, declaration, { relation: 'DECLARES' }))
        addRef(classesByName, name, { key, name, filePath, classDeclaration: declaration })
        declarationsByFileAndName.set(refKey(filePath, name), { key, name, filePath, classDeclaration: declaration })

        for (const method of declaration.getMethods()) {
          const methodName = method.getName()
          const methodKey = symbolKey(filePath, `${name}.${methodName}`)
          const methodMetadata: Record<string, unknown> = {
            async: method.isAsync(),
            parameters: method.getParameters().map((parameter) => ({
              name: parameter.getName(),
              type: parameter.getTypeNode()?.getText() ?? null,
              decorators: parameter.getDecorators().map((decorator) => importedDecoratorName(decorator, bindings)?.name ?? decorator.getName()),
            })),
            returnType: method.getReturnTypeNode()?.getText() ?? null,
          }
          addNode(hit(methodKey, 'METHOD', methodName, filePath, method, 'BACKEND', methodMetadata))
          addEdge(edge(key, methodKey, 'DECLARES', 'CONFIRMED', filePath, method, {}))
          methodsByOwnerAndName.set(`${key}.${methodName}`, { key: methodKey, name: methodName, filePath })
        }
      }

      for (const declaration of source.getInterfaces()) {
        const name = declaration.getName()
        const key = symbolKey(filePath, name)
        addNode(hit(key, 'INTERFACE', name, filePath, declaration, 'BACKEND', {
          exported: declaration.isExported() || declaration.isDefaultExport(),
        }))
        addEdge(edge(fileKey(filePath), key, 'CONTAINS', 'CONFIRMED', filePath, declaration, { relation: 'DECLARES' }))
        declarationsByFileAndName.set(refKey(filePath, name), { key, name, filePath })
      }

      for (const declaration of source.getTypeAliases()) {
        const name = declaration.getName()
        const key = symbolKey(filePath, name)
        addNode(hit(key, 'INTERFACE', name, filePath, declaration, 'BACKEND', {
          exported: declaration.isExported() || declaration.isDefaultExport(),
          declarationKind: 'TYPE_ALIAS',
        }))
        addEdge(edge(fileKey(filePath), key, 'CONTAINS', 'CONFIRMED', filePath, declaration, { relation: 'DECLARES' }))
        declarationsByFileAndName.set(refKey(filePath, name), { key, name, filePath })
      }

      for (const declaration of source.getFunctions()) {
        const name = declaration.getName()
        if (!name) continue
        const key = symbolKey(filePath, name)
        addNode(hit(key, 'METHOD', name, filePath, declaration, areaFor(filePath), {
          declarationKind: 'FUNCTION',
          exported: declaration.isExported() || declaration.isDefaultExport(),
          async: declaration.isAsync(),
        }))
        addEdge(edge(fileKey(filePath), key, 'CONTAINS', 'CONFIRMED', filePath, declaration, { relation: 'DECLARES' }))
        const ref = { key, name, filePath, functionDeclaration: declaration }
        declarationsByFileAndName.set(refKey(filePath, name), ref)
        if (declaration.isDefaultExport()) declarationsByFileAndName.set(refKey(filePath, 'default'), ref)
      }
    
    })
  }
  return { classesByName, declarationsByFileAndName, methodsByOwnerAndName }
}

function collectImportBindings(source: SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>()
  for (const declaration of source.getImportDeclarations()) {
    const moduleSource = declaration.getModuleSpecifierValue()
    const declarationTypeOnly = declaration.isTypeOnly()
    const defaultImport = declaration.getDefaultImport()
    if (defaultImport) {
      bindings.set(defaultImport.getText(), { source: moduleSource, imported: 'default', typeOnly: declarationTypeOnly })
    }
    const namespaceImport = declaration.getNamespaceImport()
    if (namespaceImport) {
      bindings.set(namespaceImport.getText(), { source: moduleSource, imported: '*', typeOnly: declarationTypeOnly })
    }
    for (const named of declaration.getNamedImports()) {
      const local = named.getAliasNode()?.getText() ?? named.getName()
      bindings.set(local, {
        source: moduleSource,
        imported: named.getName(),
        typeOnly: declarationTypeOnly || named.isTypeOnly(),
      })
    }
  }
  return bindings
}

function collectResolvedImports(
  source: SourceFile,
  filePath: string,
  resolveImport: Resolver,
  imports: ImportHit[],
): void {
  for (const declaration of source.getImportDeclarations()) {
    const resolved = resolveImport(declaration.getModuleSpecifierValue(), filePath)
    if (!resolved) continue
    const declarationTypeOnly = declaration.isTypeOnly()
    const defaultImport = declaration.getDefaultImport()
    if (defaultImport) {
      imports.push({
        fromPath: filePath,
        toPath: resolved,
        imported: defaultImport.getText(),
        importedName: 'default',
        typeOnly: declarationTypeOnly,
      })
    }
    const namespaceImport = declaration.getNamespaceImport()
    if (namespaceImport) {
      imports.push({
        fromPath: filePath,
        toPath: resolved,
        imported: namespaceImport.getText(),
        importedName: '*',
        typeOnly: declarationTypeOnly,
      })
    }
    for (const named of declaration.getNamedImports()) {
      imports.push({
        fromPath: filePath,
        toPath: resolved,
        imported: named.getAliasNode()?.getText() ?? named.getName(),
        importedName: named.getName(),
        typeOnly: declarationTypeOnly || named.isTypeOnly(),
      })
    }
    if (!defaultImport && !namespaceImport && declaration.getNamedImports().length === 0) {
      imports.push({ fromPath: filePath, toPath: resolved, imported: '*', importedName: '*', typeOnly: false })
    }
  }
}

export function createImportResolver(
  files: AnalyzeFile[], pathSet: Set<string>, { allowPackageFallback = true } = {},
): Resolver {
  type Alias = { pattern: string; targets: string[]; baseDir: string }
  const configs: { directory: string; aliases: Alias[] | null }[] = []
  const packages = new Map<string, string | null>()
  for (const file of files) {
    const normalizedPath = normalize(file.path)
    if (/\/(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i.test(`/${normalizedPath}`)) {
      const parsed = ts.parseConfigFileTextToJson(normalizedPath, file.content)
      const config = parsed.config as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | undefined
      const configDir = posix.dirname(normalizedPath)
      const directory = configDir === '.' ? '' : `${configDir}/`
      const options = config?.compilerOptions
      if (parsed.error || !config || typeof config !== 'object' ||
        options != null && (typeof options !== 'object' ||
          options.baseUrl != null && typeof options.baseUrl !== 'string' ||
          options.paths != null && (typeof options.paths !== 'object' || Array.isArray(options.paths)))) {
        configs.push({ directory, aliases: null })
        continue
      }
      const baseDir = normalize(posix.join(configDir, options?.baseUrl ?? '.'))
      const aliases: Alias[] = []
      let invalid = false
      for (const [pattern, targets] of Object.entries(options?.paths ?? {})) {
        if (pattern.split('*').length > 2 || !Array.isArray(targets) ||
          targets.some((target) => typeof target !== 'string' || target.split('*').length > 2)) {
          invalid = true
          break
        }
        aliases.push({ pattern, targets, baseDir })
      }
      configs.push({ directory, aliases: invalid ? null : aliases })
    }
    if (posix.basename(normalizedPath) === 'package.json') {
      try {
        const value = JSON.parse(file.content) as { name?: unknown }
        if (typeof value.name === 'string') {
          const directory = posix.dirname(normalizedPath)
          packages.set(value.name, packages.has(value.name) && packages.get(value.name) !== directory ? null : directory)
        }
      } catch {
        // Invalid package metadata is analysis input, not executable configuration.
      }
    }
  }

  return (specifier: string, fromPath: string): string | null => {
    const relative = resolveRelativeImport(fromPath, specifier)
    if (relative) return resolveCandidate(relative, pathSet)
    const applicable = configs.filter((config) => fromPath.startsWith(config.directory))
    const nearestLength = Math.max(-1, ...applicable.map((config) => config.directory.length))
    const nearest = applicable.filter((config) => config.directory.length === nearestLength)
    const resolutions: (string | null)[] = []
    let matched = false
    for (const config of nearest) {
      if (config.aliases === null) return null
      const matches = config.aliases.flatMap((alias) => {
        const wildcard = alias.pattern.indexOf('*')
        if (wildcard < 0) return specifier === alias.pattern ? [{ alias, capture: '', priority: Infinity }] : []
        const prefix = alias.pattern.slice(0, wildcard)
        const suffix = alias.pattern.slice(wildcard + 1)
        if (specifier.length < prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return []
        return [{ alias, capture: specifier.slice(prefix.length, specifier.length - suffix.length), priority: prefix.length }]
      })
      matched ||= matches.length > 0
      const priority = Math.max(-1, ...matches.map((match) => match.priority))
      const candidates = matches.filter((match) => match.priority === priority).map(({ alias, capture }) => {
        for (const target of alias.targets) {
          const resolved = resolveCandidate(normalize(posix.join(alias.baseDir, target.replace('*', capture))), pathSet)
          if (resolved) return resolved
        }
        return null
      })
      resolutions.push(candidates.length > 0 && candidates.every((candidate) => candidate === candidates[0]) ? candidates[0] : null)
    }
    if (matched) {
      // Same-directory config variants must agree; input order is not configuration selection.
      return resolutions.length > 0 && resolutions.every((value) => value === resolutions[0]) ? resolutions[0] : null
    }
    // A conventional package/src/index guess is not proof of the package's
    // exports/main entry. Exact binding consumers must opt out of this legacy path.
    if (!allowPackageFallback) return null
    for (const [packageName, packageDir] of packages) {
      if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue
      if (packageDir === null) return null
      const suffix = specifier === packageName ? '' : specifier.slice(packageName.length + 1)
      const candidate = normalize(posix.join(packageDir, suffix || 'src/index'))
      const resolved = resolveCandidate(candidate, pathSet)
      if (resolved) return resolved
    }
    return null
  }
}

function resolveCandidate(candidate: string, pathSet: Set<string>): string | null {
  if (candidate.startsWith('../') || candidate === '..') return null
  // Node ESM/CJS runtime specifiers point back to TypeScript source when supplied.
  const moduleExtension = candidate.match(/\.(mjs|cjs)$/)
  if (moduleExtension) {
    const stem = candidate.slice(0, -4)
    const extension = moduleExtension[1] === 'mjs' ? 'mts' : 'cts'
    for (const value of [`${stem}.${extension}`, `${stem}.d.${extension}`, candidate]) {
      if (pathSet.has(value)) return value
    }
    return null
  }
  for (const value of [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.js`,
    `${candidate}.jsx`,
    `${candidate}/index.ts`,
    `${candidate}/index.tsx`,
    `${candidate}/index.js`,
  ]) {
    if (pathSet.has(value)) return value
  }
  return null
}

function collectNestModules(
  sourceFiles: SourceFile[],
  bindingsByFile: Map<string, Map<string, ImportBinding>>,
  resolveImport: Resolver,
  declarations: Map<string, DeclarationRef>,
  classesByName: Map<string, DeclarationRef[]>,
  addNode: (node: SemanticNodeHit) => void,
  addEdge: (edge: SemanticEdgeHit) => void,
  providers: Map<string, DeclarationRef>,
  onProvider?: (token: string, ref: DeclarationRef) => void,
): void {
  const register = (token: string, ref: DeclarationRef): void => {
    providers.set(token, ref)
    onProvider?.(token, ref)
  }
  for (const source of sourceFiles) {
    const filePath = filePathOf(source)
    const bindings = bindingsByFile.get(filePath) ?? new Map()
    for (const declaration of source.getClasses()) {
      const name = declaration.getName()
      if (!name) continue
      const moduleDecorator = findImportedDecorator(declaration.getDecorators(), bindings, NEST_COMMON, 'Module')
      if (!moduleDecorator) continue
      const metadata = moduleDecorator.getArguments()[0]
      if (!metadata || !Node.isObjectLiteralExpression(metadata)) continue
      const moduleKey = symbolKey(filePath, name)
      for (const propertyName of ['imports', 'controllers', 'providers', 'exports'] as const) {
        for (const expression of propertyExpressions(metadata, propertyName)) {
          if (Node.isObjectLiteralExpression(expression) && propertyName === 'providers') {
            const tokenExpression = propertyInitializer(expression, 'provide')
            const implementation =
              propertyInitializer(expression, 'useClass') ??
              propertyInitializer(expression, 'useExisting') ??
              propertyInitializer(expression, 'useFactory') ??
              propertyInitializer(expression, 'useValue')
            const token = tokenExpression?.getText()
            if (!token) continue
            const tokenKey = `nest-token:${normalizeToken(token)}`
            addNode({
              key: tokenKey,
              type: 'CLASS',
              name: token,
              filePath,
              lineStart: expression.getStartLineNumber(),
              lineEnd: expression.getEndLineNumber(),
              layer: 'BACKEND',
              metadata: { nestRole: 'INJECTION_TOKEN' },
            })
            addEdge(edge(moduleKey, tokenKey, 'DECLARES', 'CONFIRMED', filePath, expression, { relation: 'NEST_PROVIDER' }))
            if (implementation) {
              const ref = resolveExpressionRef(implementation, filePath, bindings, resolveImport, declarations, classesByName)
              if (ref) {
                register(normalizeToken(token), ref)
                addEdge(edge(tokenKey, ref.key, 'DEPENDS_ON', 'CONFIRMED', filePath, expression, {
                  relation: providerRelation(expression),
                }))
              }
            }
            continue
          }
          const ref = resolveExpressionRef(expression, filePath, bindings, resolveImport, declarations, classesByName)
          if (!ref) continue
          const type = propertyName === 'imports' ? 'DEPENDS_ON' : propertyName === 'exports' ? 'EXPORTS' : 'DECLARES'
          addEdge(edge(moduleKey, ref.key, type, 'CONFIRMED', filePath, expression, {
            relation: `NEST_MODULE_${propertyName.toUpperCase()}`,
          }))
          if (propertyName === 'providers') register(normalizeToken(ref.name), ref)
        }
      }
    }
  }
}

function propertyExpressions(object: Node, name: string): Expression[] {
  if (!Node.isObjectLiteralExpression(object)) return []
  const initializer = propertyInitializer(object, name)
  if (!initializer || !Node.isArrayLiteralExpression(initializer)) return []
  return initializer.getElements().filter(Node.isExpression)
}

function propertyInitializer(object: Node, name: string): Expression | undefined {
  if (!Node.isObjectLiteralExpression(object)) return undefined
  const property = object.getProperty(name)
  if (!property || !Node.isPropertyAssignment(property)) return undefined
  return property.getInitializer()
}

function providerRelation(object: Node): string {
  if (!Node.isObjectLiteralExpression(object)) return 'NEST_PROVIDER'
  for (const name of ['useClass', 'useValue', 'useFactory', 'useExisting']) {
    if (object.getProperty(name)) return name
  }
  return 'NEST_PROVIDER'
}

function resolveExpressionRef(
  expression: Expression,
  filePath: string,
  bindings: Map<string, ImportBinding>,
  resolveImport: Resolver,
  declarations: Map<string, DeclarationRef>,
  classesByName: Map<string, DeclarationRef[]>,
): DeclarationRef | null {
  let current: Node = expression
  if (Node.isCallExpression(current)) {
    const callExpression = current.getExpression()
    const callName = callExpression.getText()
    if (importedFunction(callName, bindings, NEST_COMMON) === 'forwardRef') {
      const argument = current.getArguments()[0]
      if (argument && (Node.isArrowFunction(argument) || Node.isFunctionExpression(argument))) {
        const body = argument.getBody()
        current = Node.isBlock(body) ? body.getDescendantsOfKind(SyntaxKind.Identifier)[0] ?? body : body
      }
    } else if (Node.isPropertyAccessExpression(callExpression)) {
      current = callExpression.getExpression()
    } else {
      current = callExpression
    }
  }
  if (!Node.isIdentifier(current)) return null
  const localName = current.getText()
  const binding = bindings.get(localName)
  if (binding) {
    const resolved = resolveImport(binding.source, filePath)
    if (resolved) {
      return declarations.get(refKey(resolved, binding.imported === 'default' ? localName : binding.imported)) ?? null
    }
    return null
  }
  return declarations.get(refKey(filePath, localName)) ?? null
}

function constructorInjectionTargets(
  declaration: ClassDeclaration,
  bindings: Map<string, ImportBinding>,
  filePath: string,
  resolveImport: Resolver,
  declarations: Map<string, DeclarationRef>,
  classesByName: Map<string, DeclarationRef[]>,
  providerTargets: Map<string, DeclarationRef>,
): Map<string, { key: string; className: string | null; token: string; confidence: 'CONFIRMED' | 'LIKELY'; node: Node }> {
  const targets = new Map<string, { key: string; className: string | null; token: string; confidence: 'CONFIRMED' | 'LIKELY'; node: Node }>()
  for (const constructor of declaration.getConstructors()) {
    for (const parameter of constructor.getParameters()) {
      const inject = findImportedDecorator(parameter.getDecorators(), bindings, NEST_COMMON, 'Inject')
      const token = inject?.getArguments()[0]?.getText()
      if (token) {
        const provider = providerTargets.get(normalizeToken(token))
        if (provider) {
          targets.set(parameter.getName(), {
            key: provider.key,
            className: provider.name,
            token,
            confidence: 'CONFIRMED',
            node: parameter,
          })
          continue
        }
      }
      const typeText = parameter.getTypeNode()?.getText()
      if (!typeText) continue
      const repositoryEntity = repositoryTypeArgument(typeText)
      if (repositoryEntity) {
        targets.set(parameter.getName(), {
          key: `data:typeorm:${repositoryEntity}`,
          className: null,
          token: typeText,
          confidence: 'LIKELY',
          node: parameter,
        })
        continue
      }
      const typeName = typeText.replace(/<.*>/s, '').replace(/\[\]$/, '').trim()
      const binding = bindings.get(typeName)
      let target: DeclarationRef | null = null
      if (binding) {
        const resolved = resolveImport(binding.source, filePath)
        if (resolved) target = declarations.get(refKey(resolved, binding.imported === 'default' ? typeName : binding.imported)) ?? null
      } else {
        target = declarations.get(refKey(filePath, typeName)) ?? null
      }
      if (target) {
        targets.set(parameter.getName(), {
          key: target.key,
          className: target.name,
          token: token ?? typeName,
          confidence: 'CONFIRMED',
          node: parameter,
        })
      }
    }
  }
  return targets
}

function collectControllerEndpoints(
  method: MethodDeclaration,
  controllerKey: string,
  methodKey: string,
  controllerPath: string | null,
  globalPrefix: string | null,
  filePath: string,
  bindings: Map<string, ImportBinding>,
  endpoints: EndpointHit[],
  addEdge: (edge: SemanticEdgeHit) => void,
  unresolvedCalls: UnresolvedCallHit[],
): void {
  for (const decorator of method.getDecorators()) {
    const imported = importedDecoratorName(decorator, bindings)
    if (!imported || imported.source !== NEST_COMMON) continue
    const httpMethod = HTTP_DECORATORS[imported.name]
    if (!httpMethod) continue
    const methodPath = decoratorPath(decorator)
    if (controllerPath === null || methodPath === null || globalPrefix === null) {
      unresolvedCalls.push({
        sourceKey: methodKey,
        expression: decorator.getText(),
        filePath,
        lineStart: decorator.getStartLineNumber(),
        reason: globalPrefix === null ? 'UNRESOLVED_GLOBAL_PREFIX' : 'UNRESOLVED_ROUTE_PATH',
      })
      continue
    }
    const path = joinUrl(globalPrefix, controllerPath, methodPath)
    const versionDecorator = findImportedDecorator(method.getDecorators(), bindings, NEST_COMMON, 'Version')
    const metadata: Record<string, unknown> = {
      controllerKey,
      parameterTypes: method.getParameters().map((parameter) => parameter.getTypeNode()?.getText() ?? null),
      responseType: method.getReturnTypeNode()?.getText() ?? null,
    }
    const version = versionDecorator ? staticString(versionDecorator.getArguments()[0]) : null
    if (version) metadata.version = version
    endpoints.push({
      method: httpMethod,
      path,
      handlerKey: methodKey,
      handler: method.getName(),
      ownerKey: controllerKey,
      filePath,
      lineStart: decorator.getStartLineNumber(),
      lineEnd: method.getEndLineNumber(),
      metadata,
    })
    addEdge(edge(controllerKey, endpointKey(httpMethod, path), 'EXPOSES', 'CONFIRMED', filePath, decorator, {}))
  }
}

function collectCrossCuttingEdges(
  decorators: Decorator[],
  sourceKey: string,
  filePath: string,
  bindings: Map<string, ImportBinding>,
  resolveImport: Resolver,
  declarations: Map<string, DeclarationRef>,
  classesByName: Map<string, DeclarationRef[]>,
  addEdge: (edge: SemanticEdgeHit) => void,
): void {
  for (const decorator of decorators) {
    const imported = importedDecoratorName(decorator, bindings)
    const role = imported?.source === NEST_COMMON ? CROSS_CUTTING[imported.name] : undefined
    if (!role) continue
    for (const argument of decorator.getArguments().filter(Node.isExpression)) {
      const ref = resolveExpressionRef(argument, filePath, bindings, resolveImport, declarations, classesByName)
      if (ref) addEdge(edge(sourceKey, ref.key, 'DEPENDS_ON', 'CONFIRMED', filePath, decorator, { relation: role }))
    }
  }
}

function collectMiddlewareEdges(
  declaration: ClassDeclaration,
  moduleKey: string,
  filePath: string,
  bindings: Map<string, ImportBinding>,
  resolveImport: Resolver,
  declarations: Map<string, DeclarationRef>,
  classesByName: Map<string, DeclarationRef[]>,
  addEdge: (edge: SemanticEdgeHit) => void,
): void {
  const configure = declaration.getMethod('configure')
  if (!configure) return
  for (const call of configure.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression()
    if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== 'apply') continue
    for (const argument of call.getArguments().filter(Node.isExpression)) {
      const ref = resolveExpressionRef(argument, filePath, bindings, resolveImport, declarations, classesByName)
      if (ref) addEdge(edge(moduleKey, ref.key, 'DEPENDS_ON', 'CONFIRMED', filePath, call, { relation: 'MIDDLEWARE' }))
    }
  }
}

function collectCallableCalls(
  method: MethodDeclaration | FunctionDeclaration,
  classKey: string,
  sourceKey: string,
  filePath: string,
  injectionTargets: Map<string, { key: string; className: string | null; token: string; confidence: 'CONFIRMED' | 'LIKELY'; node: Node }>,
  methodsByOwnerAndName: Map<string, DeclarationRef>,
  resolveImport: Resolver,
  declarations: Map<string, DeclarationRef>,
  addNode: (node: SemanticNodeHit) => void,
  addEdge: (edge: SemanticEdgeHit) => void,
  unresolvedCalls: UnresolvedCallHit[],
): void {
  for (const call of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    // Nested callbacks/functions have their own execution owner. Until they have graph
    // identities, do not attribute their calls to the surrounding top-level function.
    if (Node.isFunctionDeclaration(method)
      && call.getFirstAncestor(ancestor => ts.isFunctionLike(ancestor.compilerNode)) !== method) continue
    // A decorator factory runs while declaring the class, not as this method's call.
    if (call.getFirstAncestorByKind(SyntaxKind.Decorator)) continue
    const expression = call.getExpression()
    const text = expression.getText()
    const classThis = Node.isMethodDeclaration(method) && !method.isStatic() && hasMethodThis(call, method)
    if (classThis && Node.isPropertyAccessExpression(expression) && Node.isThisExpression(expression.getExpression())) {
      const targets = expression.getNameNode().getSymbol()?.getDeclarations()
      const target = targets?.length === 1 ? targets[0] : undefined
      // Symbol identity rejects property/parameter shadows, overload ambiguity,
      // inheritance and static/instance collisions in the current graph key scheme.
      if (target && Node.isMethodDeclaration(target) && !target.isStatic() && target.getBody()
        && target.getParent() === method.getParent()
        && method.getParentIfKind(SyntaxKind.ClassDeclaration)?.getMethods().filter(item => item.getName() === target.getName()).length === 1) {
        const own = methodsByOwnerAndName.get(`${classKey}.${target.getName()}`)
        if (own) {
          addEdge(edge(sourceKey, own.key, 'CALLS', 'CONFIRMED', filePath, call, callMetadata(call)))
          continue
        }
      }
    }
    const prisma = text.match(/^this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/)
    if (classThis && prisma && PRISMA_OPERATIONS[prisma[3]] && (prisma[1].toLowerCase().includes('prisma') || injectionTargets.get(prisma[1])?.className?.includes('Prisma'))) {
      const dataKey = `data:prisma:${prisma[2]}`
      addNode({
        key: dataKey,
        type: 'DB_ENTITY',
        name: prisma[2],
        filePath,
        lineStart: call.getStartLineNumber(),
        lineEnd: call.getEndLineNumber(),
        layer: 'DATABASE',
        metadata: { orm: 'PRISMA', operation: prisma[3], confidence: 'LIKELY' },
      })
      addEdge(edge(sourceKey, dataKey, 'READS_WRITES', 'LIKELY', filePath, call, { orm: 'PRISMA', operation: prisma[3] }))
      continue
    }

    const member = text.match(/^this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/)
    if (classThis && member) {
      const injected = injectionTargets.get(member[1])
      if (injected?.key.startsWith('data:typeorm:') && TYPEORM_OPERATIONS[member[2]]) {
        addNode({
          key: injected.key,
          type: 'DB_ENTITY',
          name: injected.key.slice('data:typeorm:'.length),
          filePath,
          lineStart: injected.node.getStartLineNumber(),
          lineEnd: injected.node.getEndLineNumber(),
          layer: 'DATABASE',
          metadata: { orm: 'TYPEORM', confidence: 'LIKELY' },
        })
        addEdge(edge(sourceKey, injected.key, 'READS_WRITES', 'LIKELY', filePath, call, { orm: 'TYPEORM', operation: member[2] }))
        continue
      }
      if (injected?.className) {
        const target = methodsByOwnerAndName.get(`${injected.key}.${member[2]}`)
        if (target) {
          addEdge(edge(sourceKey, target.key, 'CALLS', injected.confidence, filePath, call, callMetadata(call)))
          continue
        }
      }
    }

    if (Node.isIdentifier(expression)) {
      const target = resolveFunctionTarget(expression, filePath, resolveImport, declarations)
      if (target) {
        addEdge(edge(sourceKey, target.key, 'CALLS', 'CONFIRMED', filePath, call, callMetadata(call)))
        continue
      }
    }
    if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression) || Node.isElementAccessExpression(expression)) {
      unresolvedCalls.push({
        sourceKey,
        expression: text,
        filePath,
        lineStart: call.getStartLineNumber(),
        reason: Node.isElementAccessExpression(expression) ? 'DYNAMIC_MEMBER' : 'UNRESOLVED_TARGET',
      })
    }
  }
}

function hasMethodThis(call: CallExpression, method: MethodDeclaration): boolean {
  for (const ancestor of call.getAncestors()) {
    if (ancestor === method) return true
    if (Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor)
      || ts.isFunctionLike(ancestor.compilerNode) && !Node.isArrowFunction(ancestor)) return false
  }
  return false
}

function resolveFunctionTarget(
  expression: Node,
  filePath: string,
  resolveImport: Resolver,
  declarations: Map<string, DeclarationRef>,
): DeclarationRef | null {
  const targets = expression.getSymbol()?.getDeclarations()
  if (targets?.length !== 1) return null
  const target = targets[0]
  if (Node.isFunctionDeclaration(target)) {
    if (filePathOf(target.getSourceFile()) !== filePath) return null
    const ref = declarations.get(refKey(filePath, target.getName() ?? ''))
    return ref?.functionDeclaration === target ? ref : null
  }
  if (!Node.isImportSpecifier(target) && !Node.isImportClause(target)) return null
  if (Node.isImportSpecifier(target) && target.isTypeOnly()) return null
  const imported = target.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
  if (!imported || imported.isTypeOnly()) return null
  const resolved = resolveImport(imported.getModuleSpecifierValue(), filePath)
  if (!resolved) return null
  const importedName = Node.isImportSpecifier(target) ? target.getName() : 'default'
  const ref = declarations.get(refKey(resolved, importedName))
  const fn = ref?.functionDeclaration
  if (!fn || (importedName === 'default' ? !fn.isDefaultExport() : !fn.isExported() || fn.isDefaultExport())) return null
  return ref ?? null
}

function callMetadata(call: CallExpression): Record<string, unknown> {
  return {
    expression: call.getExpression().getText(),
    asyncBoundary: Node.isAwaitExpression(call.getParent()),
  }
}

function collectValidationMetadata(
  declaration: ClassDeclaration,
  bindings: Map<string, ImportBinding>,
): Record<string, unknown>[] {
  const validation: Record<string, unknown>[] = []
  for (const property of declaration.getProperties()) {
    for (const decorator of property.getDecorators()) {
      const imported = importedDecoratorName(decorator, bindings)
      if (imported?.source !== 'class-validator') continue
      validation.push({
        property: property.getName(),
        decorator: imported.name,
        arguments: decorator.getArguments().map((argument) => argument.getText()),
        lineStart: decorator.getStartLineNumber(),
      })
    }
  }
  return validation
}

function collectReExports(
  sourceFiles: SourceFile[],
  resolveImport: Resolver,
  imports: ImportHit[],
  addEdge: (edge: SemanticEdgeHit) => void,
): void {
  for (const source of sourceFiles) {
    const filePath = filePathOf(source)
    for (const declaration of source.getExportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue()
      if (!specifier) continue
      const resolved = resolveImport(specifier, filePath)
      if (!resolved) continue
      const names = declaration.getNamedExports()
      if (names.length === 0) {
        imports.push({ fromPath: filePath, toPath: resolved, imported: '*', importedName: '*', typeOnly: declaration.isTypeOnly() })
      } else {
        for (const named of names) {
          imports.push({
            fromPath: filePath,
            toPath: resolved,
            imported: named.getAliasNode()?.getText() ?? named.getName(),
            importedName: named.getName(),
            typeOnly: declaration.isTypeOnly() || named.isTypeOnly(),
          })
        }
      }
      addEdge(edge(fileKey(filePath), fileKey(resolved), 'EXPORTS', 'CONFIRMED', filePath, declaration, {
        typeOnly: declaration.isTypeOnly(),
      }))
    }
  }
}

/**
 * Per-file part of the Nest global prefix. Proven applications and prefixes only ever come from the
 * file's own declarations (or global scripts), so the manifest result combines per-file facts.
 */
function globalPrefixFacts(origins: Map<Node, ApplicationOrigin>): (source: SourceFile) => GlobalPrefixFacts {
  return (source) => {
    const facts: GlobalPrefixFacts = { unknown: false, applications: 0, invalid: false, prefixes: [] }
    const calls = source.getDescendantsOfKind(SyntaxKind.CallExpression)
    for (const call of calls) {
      const factory = factoryCreation(call)
      if (factory === 'UNKNOWN') facts.unknown = true
      if (factory === 'NEST') facts.applications += 1
    }
    for (const call of calls) {
      const expression = call.getExpression()
      if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== 'setGlobalPrefix') continue
      // A proven application is always a NestFactory.create call, i.e. one of the counted applications.
      const application = applicationOrigin(expression.getExpression(), origins)
      if (application === 'UNKNOWN') facts.invalid = true
      if (!application || application === 'UNKNOWN') continue
      const prefix = staticString(call.getArguments()[0])
      // Options (e.g. excluded routes) and dynamic values require wider analysis.
      if (prefix === null || call.getArguments().length !== 1) facts.invalid = true
      else facts.prefixes.push(prefix)
    }
    return facts
  }
}

function combineGlobalPrefix(files: Iterable<GlobalPrefixFacts>): string | null {
  let applications = 0
  let invalid = false
  const prefixes = new Set<string>()
  for (const facts of files) {
    if (facts.unknown) return null
    applications += facts.applications
    invalid ||= facts.invalid
    for (const prefix of facts.prefixes) prefixes.add(prefix)
  }
  // There is no controller-to-bootstrap ownership proof for multiple applications yet.
  if (applications > 1 || invalid) return null
  return prefixes.size > 1 ? null : prefixes.values().next().value ?? ''
}

type FactoryOrigin = 'NEST' | 'UNKNOWN' | null
type ApplicationOrigin = CallExpression | 'UNKNOWN' | null

function unwrapExpression(node: Node): Node {
  while (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) ||
    Node.isTypeAssertion(node) || Node.isNonNullExpression(node)) node = node.getExpression()
  return node
}

function factoryCreation(call: CallExpression): FactoryOrigin {
  const expression = call.getExpression()
  return Node.isPropertyAccessExpression(expression) && expression.getName() === 'create'
    ? factoryOrigin(expression.getExpression()) : null
}

function factoryOrigin(value: Node, seen = new Set<Node>(), depth = 0): FactoryOrigin {
  if (depth >= 64) return 'UNKNOWN'
  const factory = unwrapExpression(value)
  if (Node.isIdentifier(factory)) {
    const declarations = factory.getSymbol()?.getDeclarations()
    if (!declarations?.length) return factory.getText() === 'NestFactory' ? 'UNKNOWN' : null
    if (declarations.length !== 1) return null
    const target = declarations[0]
    if (Node.isVariableDeclaration(target)) {
      if (seen.has(target)) return 'UNKNOWN'
      const initializer = target.getInitializer()
      if (!initializer) return null
      const origin = factoryOrigin(initializer, new Set([...seen, target]), depth + 1)
      return origin === 'NEST' && target.getVariableStatement()?.getDeclarationKind() !== 'const' ? 'UNKNOWN' : origin
    }
    if (Node.isBindingElement(target)) {
      const variable = target.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
      const initializer = variable?.getInitializer()
      if (!initializer) return null
      const namespace = namespaceOrigin(initializer, seen, depth + 1)
      if (namespace === null) return null
      const property = target.getPropertyNameNode() ?? target.getNameNode()
      const name = Node.isIdentifier(property) ? property.getText() : staticString(property)
      if (namespace === 'UNKNOWN' || !Node.isObjectBindingPattern(target.getParent()) ||
        target.getParent().getParent() !== variable || target.getDotDotDotToken() || target.getInitializer() ||
        variable?.getVariableStatement()?.getDeclarationKind() !== 'const' || name !== 'NestFactory') return 'UNKNOWN'
      return 'NEST'
    }
    if (Node.isNamespaceImport(target)) return namespaceOrigin(factory, seen, depth + 1) === null ? null : 'UNKNOWN'
    if (!Node.isImportSpecifier(target)) return null
    const imported = target.getImportDeclaration()
    return target.getName() === 'NestFactory' && !target.isTypeOnly() &&
      !imported.isTypeOnly() && imported.getModuleSpecifierValue() === '@nestjs/core' ? 'NEST' : null
  }
  if (Node.isPropertyAccessExpression(factory) || Node.isElementAccessExpression(factory)) {
    const namespace = namespaceOrigin(factory.getExpression(), seen, depth + 1)
    if (namespace === null) return null
    const name = Node.isPropertyAccessExpression(factory) ? factory.getName() : staticString(factory.getArgumentExpression())
    return name === 'NestFactory' ? namespace : 'UNKNOWN'
  }
  return null
}

function namespaceOrigin(value: Node, seen = new Set<Node>(), depth = 0): FactoryOrigin {
  if (depth >= 64) return 'UNKNOWN'
  const namespace = unwrapExpression(value)
  if (!Node.isIdentifier(namespace)) return null
  const declarations = namespace.getSymbol()?.getDeclarations()
  if (declarations?.length !== 1) return null
  const target = declarations[0]
  if (Node.isVariableDeclaration(target)) {
    if (seen.has(target)) return 'UNKNOWN'
    const initializer = target.getInitializer()
    if (!initializer) return null
    const origin = namespaceOrigin(initializer, new Set([...seen, target]), depth + 1)
    return origin === 'NEST' && target.getVariableStatement()?.getDeclarationKind() !== 'const' ? 'UNKNOWN' : origin
  }
  if (!Node.isNamespaceImport(target)) return null
  const imported = target.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
  return imported?.getModuleSpecifierValue() === '@nestjs/core' && !imported.isTypeOnly() ? 'NEST' : null
}

function applicationOrigin(value: Node, cache: Map<Node, ApplicationOrigin>, seen = new Set<Node>(), depth = 0): ApplicationOrigin {
  const cached = cache.get(value)
  if (cached !== undefined) return cached
  if (depth >= 64) return 'UNKNOWN'
  const origin = resolveApplicationOrigin(value, cache, seen, depth)
  cache.set(value, origin)
  return origin
}

function resolveApplicationOrigin(value: Node, cache: Map<Node, ApplicationOrigin>, seen: Set<Node>, depth: number): ApplicationOrigin {
  const receiver = unwrapExpression(value)
  if (Node.isIdentifier(receiver)) {
    const declarations = receiver.getSymbol()?.getDeclarations()
    if (declarations?.length !== 1) return null
    const target = declarations[0]
    if (!Node.isVariableDeclaration(target)) {
      return factoryOrigin(receiver) !== null || namespaceOrigin(receiver) !== null ? 'UNKNOWN' : null
    }
    if (seen.has(target)) return 'UNKNOWN'
    const initializer = target.getInitializer()
    if (!initializer) return null
    const origin = applicationOrigin(initializer, cache, new Set([...seen, target]), depth + 1)
    return origin !== null && target.getVariableStatement()?.getDeclarationKind() !== 'const' ? 'UNKNOWN' : origin
  }
  if (Node.isAwaitExpression(receiver)) {
    const awaited = unwrapExpression(receiver.getExpression())
    if (Node.isCallExpression(awaited)) {
      const factory = factoryCreation(awaited)
      if (factory === 'NEST') return awaited
      if (factory === 'UNKNOWN') return 'UNKNOWN'
    }
  }
  if (Node.isCallExpression(receiver) && factoryCreation(receiver) !== null) return 'UNKNOWN'
  // A transformation of a proven application is unsupported, not proof of an empty prefix.
  for (const child of receiver.getChildren()) {
    if (applicationOrigin(child, cache, seen, depth + 1) !== null) return 'UNKNOWN'
  }
  return null
}

function findImportedDecorator(
  decorators: Decorator[],
  bindings: Map<string, ImportBinding>,
  source: string,
  importedName: string,
): Decorator | undefined {
  return decorators.find((decorator) => {
    const imported = importedDecoratorName(decorator, bindings)
    return imported?.source === source && imported.name === importedName
  })
}

function importedDecoratorName(
  decorator: Decorator,
  bindings: Map<string, ImportBinding>,
): { source: string; name: string } | null {
  const expression = decorator.getExpression()
  const target = Node.isCallExpression(expression) ? expression.getExpression().getText() : expression.getText()
  const dot = target.indexOf('.')
  if (dot >= 0) {
    const namespace = bindings.get(target.slice(0, dot))
    return namespace?.imported === '*' ? { source: namespace.source, name: target.slice(dot + 1) } : null
  }
  const binding = bindings.get(target)
  return binding ? { source: binding.source, name: binding.imported } : null
}

function importedFunction(name: string, bindings: Map<string, ImportBinding>, source: string): string | null {
  const binding = bindings.get(name)
  return binding?.source === source ? binding.imported : null
}

function staticString(node: Node | undefined): string | null {
  if (!node) return null
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText()
  return null
}

function decoratorPath(decorator: Decorator): string | null {
  return decorator.getArguments().length === 0 ? '' : constantRouteString(decorator.getArguments()[0])
}

function constantRouteString(node: Node | undefined, seen = new Set<Node>(), depth = 0): string | null {
  if (!node || depth >= 64) return null
  const value = unwrapExpression(node)
  const literal = staticString(value)
  if (literal !== null) return literal
  if (!Node.isIdentifier(value)) return null
  const declarations = value.getSymbol()?.getDeclarations()
  if (declarations?.length !== 1) return null
  const target = declarations[0]
  if (!Node.isVariableDeclaration(target) || seen.has(target)
    || target.getSourceFile() !== value.getSourceFile() || target.getEnd() >= value.getStart()) return null
  const statement = target.getVariableStatement()
  // Top-level immutable literals only: no execution, cross-file initialization or control-flow guesses.
  if (statement?.getDeclarationKind() !== 'const' || !Node.isSourceFile(statement.getParent())) return null
  return constantRouteString(target.getInitializer(), new Set([...seen, target]), depth + 1)
}

function repositoryTypeArgument(typeText: string): string | null {
  const match = typeText.match(/(?:Repository|MongoRepository|TreeRepository)\s*<\s*([A-Za-z_$][\w$]*)/)
  return match?.[1] ?? null
}

function addRef(map: Map<string, DeclarationRef[]>, name: string, ref: DeclarationRef): void {
  const values = map.get(name) ?? []
  values.push(ref)
  map.set(name, values)
}

function hit(
  key: string,
  type: string,
  name: string,
  filePath: string,
  node: Node,
  layer: string | null,
  metadata: Record<string, unknown>,
): SemanticNodeHit {
  return {
    key,
    type,
    name,
    filePath,
    lineStart: node.getStartLineNumber(),
    lineEnd: node.getEndLineNumber(),
    layer,
    metadata,
  }
}

function edge(
  sourceKey: string,
  targetKey: string,
  type: string,
  confidence: 'CONFIRMED' | 'LIKELY' | 'POSSIBLE',
  filePath: string,
  node: Node,
  metadata: Record<string, unknown>,
): SemanticEdgeHit {
  return {
    sourceKey,
    targetKey,
    type,
    confidence,
    filePath,
    lineStart: node.getStartLineNumber(),
    lineEnd: node.getEndLineNumber(),
    metadata,
  }
}

function filePathOf(source: SourceFile): string {
  return normalize(source.getFilePath().replace(/^\//, ''))
}

function normalize(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, '/')).replace(/^\.\//, '')
  return normalized === '.' ? '' : normalized
}

function fileKey(path: string): string {
  return `file:${normalize(path)}`
}

function symbolKey(path: string, qualifiedName: string): string {
  return `ts:${normalize(path)}#${qualifiedName}`
}

function endpointKey(method: string, path: string): string {
  return `endpoint:${method.toUpperCase()}:${path}`
}

function refKey(path: string, name: string): string {
  return `${normalize(path)}#${name}`
}

function normalizeToken(token: string): string {
  return token.replace(/\s+/g, '')
}

function joinUrl(...segments: string[]): string {
  const parts = segments.flatMap((segment) => segment.split('/')).filter(Boolean)
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

function areaFor(filePath: string): string {
  const lower = filePath.toLowerCase()
  return lower.includes('frontend') || lower.endsWith('.tsx') || lower.endsWith('.jsx') ? 'FRONTEND' : 'BACKEND'
}
