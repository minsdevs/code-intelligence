import { posix } from 'node:path'
import {
  Node,
  type CallExpression,
  type ClassDeclaration,
  type Decorator,
  type Expression,
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

export function extractSemanticGraph(project: Project, files: AnalyzeFile[]): SemanticResult {
  const sourceFiles = project.getSourceFiles()
  const pathSet = new Set(sourceFiles.map((source) => filePathOf(source)))
  const resolveImport = createImportResolver(files, pathSet)
  const bindingsByFile = new Map<string, Map<string, ImportBinding>>()
  const imports: ImportHit[] = []
  for (const source of sourceFiles) {
    const filePath = filePathOf(source)
    const bindings = collectImportBindings(source)
    bindingsByFile.set(filePath, bindings)
    collectResolvedImports(source, filePath, resolveImport, imports)
  }

  const nodes: SemanticNodeHit[] = []
  const edges: SemanticEdgeHit[] = []
  const endpoints: EndpointHit[] = []
  const unresolvedCalls: UnresolvedCallHit[] = []
  const classesByName = new Map<string, DeclarationRef[]>()
  const declarationsByFileAndName = new Map<string, DeclarationRef>()
  const methodsByClassAndName = new Map<string, DeclarationRef>()
  const functionsByName = new Map<string, DeclarationRef[]>()
  const nodeKeys = new Set<string>()

  const addNode = (node: SemanticNodeHit): void => {
    if (!nodeKeys.has(node.key)) {
      nodeKeys.add(node.key)
      nodes.push(node)
    }
  }
  const addEdge = (edge: SemanticEdgeHit): void => {
    if (!edges.some((candidate) =>
      candidate.sourceKey === edge.sourceKey && candidate.targetKey === edge.targetKey && candidate.type === edge.type
    )) {
      edges.push(edge)
    }
  }

  for (const source of sourceFiles) {
    const filePath = filePathOf(source)
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
        methodsByClassAndName.set(`${name}.${methodName}`, { key: methodKey, name: methodName, filePath })
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
      addRef(functionsByName, name, { key, name, filePath })
      declarationsByFileAndName.set(refKey(filePath, name), { key, name, filePath })
    }
  }

  const providerTargets = collectNestModules(
    sourceFiles,
    bindingsByFile,
    resolveImport,
    declarationsByFileAndName,
    classesByName,
    addNode,
    addEdge,
  )
  const globalPrefix = findGlobalPrefix(sourceFiles)

  for (const source of sourceFiles) {
    const filePath = filePathOf(source)
    const bindings = bindingsByFile.get(filePath) ?? new Map()
    for (const declaration of source.getClasses()) {
      const className = declaration.getName()
      if (!className) continue
      const classKey = symbolKey(filePath, className)
      const controller = findImportedDecorator(declaration.getDecorators(), bindings, NEST_COMMON, 'Controller')
      const controllerPath = controller ? staticString(controller.getArguments()[0]) ?? '' : null
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
        if (controllerPath !== null) {
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
          )
        }
        collectMethodCalls(
          method,
          className,
          methodKey,
          filePath,
          injectionTargets,
          methodsByClassAndName,
          functionsByName,
          addNode,
          addEdge,
          unresolvedCalls,
        )
      }
    }
  }

  collectReExports(sourceFiles, resolveImport, imports, addEdge)
  return { endpoints, imports, nodes, edges, unresolvedCalls }
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

function createImportResolver(files: AnalyzeFile[], pathSet: Set<string>): Resolver {
  const aliases: { pattern: string; targets: string[]; baseDir: string }[] = []
  const packages = new Map<string, string>()
  for (const file of files) {
    const normalizedPath = normalize(file.path)
    if (/\/(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i.test(`/${normalizedPath}`)) {
      const parsed = ts.parseConfigFileTextToJson(normalizedPath, file.content)
      const config = parsed.config as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | undefined
      const configDir = posix.dirname(normalizedPath)
      const baseDir = normalize(posix.join(configDir === '.' ? '' : configDir, config?.compilerOptions?.baseUrl ?? '.'))
      for (const [pattern, targets] of Object.entries(config?.compilerOptions?.paths ?? {})) {
        aliases.push({ pattern, targets, baseDir })
      }
    }
    if (posix.basename(normalizedPath) === 'package.json') {
      try {
        const value = JSON.parse(file.content) as { name?: unknown }
        if (typeof value.name === 'string') packages.set(value.name, posix.dirname(normalizedPath))
      } catch {
        // Invalid package metadata is analysis input, not executable configuration.
      }
    }
  }

  return (specifier: string, fromPath: string): string | null => {
    const relative = resolveRelativeImport(fromPath, specifier)
    if (relative) return resolveCandidate(relative, pathSet)
    for (const alias of aliases) {
      const wildcard = alias.pattern.indexOf('*')
      const prefix = wildcard < 0 ? alias.pattern : alias.pattern.slice(0, wildcard)
      const suffix = wildcard < 0 ? '' : alias.pattern.slice(wildcard + 1)
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue
      const capture = specifier.slice(prefix.length, specifier.length - suffix.length)
      for (const target of alias.targets) {
        const candidate = normalize(posix.join(alias.baseDir, target.replace('*', capture)))
        const resolved = resolveCandidate(candidate, pathSet)
        if (resolved) return resolved
      }
    }
    for (const [packageName, packageDir] of packages) {
      if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue
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
): Map<string, DeclarationRef> {
  const providers = new Map<string, DeclarationRef>()
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
                providers.set(normalizeToken(token), ref)
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
          if (propertyName === 'providers') providers.set(normalizeToken(ref.name), ref)
        }
      }
    }
  }
  return providers
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
  }
  return declarations.get(refKey(filePath, localName)) ?? unique(classesByName.get(localName))
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
        target = declarations.get(refKey(filePath, typeName)) ?? unique(classesByName.get(typeName))
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
  controllerPath: string,
  globalPrefix: string,
  filePath: string,
  bindings: Map<string, ImportBinding>,
  endpoints: EndpointHit[],
  addEdge: (edge: SemanticEdgeHit) => void,
): void {
  for (const decorator of method.getDecorators()) {
    const imported = importedDecoratorName(decorator, bindings)
    if (!imported || imported.source !== NEST_COMMON) continue
    const httpMethod = HTTP_DECORATORS[imported.name]
    if (!httpMethod) continue
    const methodPath = staticString(decorator.getArguments()[0]) ?? ''
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

function collectMethodCalls(
  method: MethodDeclaration,
  className: string,
  sourceKey: string,
  filePath: string,
  injectionTargets: Map<string, { key: string; className: string | null; token: string; confidence: 'CONFIRMED' | 'LIKELY'; node: Node }>,
  methodsByClassAndName: Map<string, DeclarationRef>,
  functionsByName: Map<string, DeclarationRef[]>,
  addNode: (node: SemanticNodeHit) => void,
  addEdge: (edge: SemanticEdgeHit) => void,
  unresolvedCalls: UnresolvedCallHit[],
): void {
  for (const call of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression()
    const text = expression.getText()
    const prisma = text.match(/^this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/)
    if (prisma && PRISMA_OPERATIONS[prisma[3]] && (prisma[1].toLowerCase().includes('prisma') || injectionTargets.get(prisma[1])?.className?.includes('Prisma'))) {
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
    if (member) {
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
        const target = methodsByClassAndName.get(`${injected.className}.${member[2]}`)
        if (target) {
          addEdge(edge(sourceKey, target.key, 'CALLS', injected.confidence, filePath, call, callMetadata(call)))
          continue
        }
      }
      const own = methodsByClassAndName.get(`${className}.${member[2]}`)
      if (member[1] === 'this' && own) {
        addEdge(edge(sourceKey, own.key, 'CALLS', 'CONFIRMED', filePath, call, callMetadata(call)))
        continue
      }
    }

    if (Node.isIdentifier(expression)) {
      const target = unique(functionsByName.get(expression.getText()))
      if (target) {
        addEdge(edge(sourceKey, target.key, 'CALLS', 'CONFIRMED', filePath, call, callMetadata(call)))
        continue
      }
    }
    if (Node.isPropertyAccessExpression(expression) || Node.isElementAccessExpression(expression)) {
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

function findGlobalPrefix(sourceFiles: SourceFile[]): string {
  for (const source of sourceFiles) {
    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression()
      if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== 'setGlobalPrefix') continue
      const prefix = staticString(call.getArguments()[0])
      if (prefix != null) return prefix
    }
  }
  return ''
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

function repositoryTypeArgument(typeText: string): string | null {
  const match = typeText.match(/(?:Repository|MongoRepository|TreeRepository)\s*<\s*([A-Za-z_$][\w$]*)/)
  return match?.[1] ?? null
}

function addRef(map: Map<string, DeclarationRef[]>, name: string, ref: DeclarationRef): void {
  const values = map.get(name) ?? []
  values.push(ref)
  map.set(name, values)
}

function unique(values: DeclarationRef[] | undefined): DeclarationRef | null {
  return values?.length === 1 ? values[0] : null
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
