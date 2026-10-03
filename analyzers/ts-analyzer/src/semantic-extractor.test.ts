import { describe, expect, it } from 'vitest'
import { extractTs } from './ts-extractor'

describe('top-level function call provenance', () => {
  it.each(['ts', 'mts', 'cts'])('links a direct same-file function call in .%s', (extension) => {
    const file = `service.${extension}`
    const result = extractTs([{ path: file, content: `export function service() { return 42; }
      export async function api() { return await service(); }` }])
    expect(result.edges.filter(edge => edge.type === 'CALLS')).toEqual([
      expect.objectContaining({ sourceKey: `ts:${file}#api`, targetKey: `ts:${file}#service`, confidence: 'CONFIRMED',
        lineStart: 2, metadata: { expression: 'service', asyncBoundary: true } }),
    ])
  })

  it('resolves an imported function alias using its source declaration', () => {
    const result = extractTs([
      { path: 'service.mts', content: 'export function read() { return 42 }' },
      { path: 'api.mts', content: "import { read as load } from './service.mjs'; export function api() { return load() }" },
    ])
    expect(result.edges).toContainEqual(expect.objectContaining({ sourceKey: 'ts:api.mts#api', targetKey: 'ts:service.mts#read', type: 'CALLS' }))
  })

  it.each([
    'export function api(service: () => number) { return service() }',
    'export function api() { const service = () => 1; return service() }',
    'export function api() { return () => service() }',
    'export function api() { function nested() { return service() }; return nested() }',
    'export function api() { return { read() { return service() } } }',
  ])('does not misattribute shadowed or nested call targets: %s', (caller) => {
    const result = extractTs([{ path: 'scope.ts', content: `export function service() { return 42 } ${caller}` }])
    expect(result.edges.filter(edge => edge.type === 'CALLS')).toEqual([])
  })
})

describe('bounded constant Nest paths', () => {
  it('follows same-file const literal aliases for controller and method paths', () => {
    const result = extractTs([{ path: 'controller.ts', content: `import { Controller, Get } from '@nestjs/common';
      const segment = 'known-orders'; const alias = (segment as const); const id = ':id';
      @Controller(alias) export class Orders { @Get(id) read() {} }` }])
    expect(result.endpoints).toEqual([expect.objectContaining({ path: '/known-orders/:id', filePath: 'controller.ts' })])
    expect(result.unresolvedCalls).toEqual([])
  })

  it.each([
    ["let segment = 'mutable';", 'segment'],
    ["const segment = process.env.SYNTHETIC_ROUTE;", 'segment'],
    ["const segment = makeRoute();", 'segment'],
    ["const segment = 'pre' + 'fix';", 'segment'],
    ["const { segment } = { segment: 'destructured' };", 'segment'],
    ["import { segment } from './other';", 'segment'],
    ["const first = second; const second = first;", 'first'],
    ["const first = second; const second = 'later';", 'first'],
    [Array.from({ length: 70 }, (_, i) => `const part${i} = ${i === 0 ? "'deep'" : `part${i - 1}`};`).join(' '), 'part69'],
  ])('leaves unsupported constant evaluation unresolved: %s', (declarations, argument) => {
    const result = extractTs([
      { path: 'other.ts', content: "export const segment = 'external'" },
      { path: 'controller.ts', content: `import { Controller, Get } from '@nestjs/common'; ${declarations}
        @Controller(${argument}) export class Orders { @Get() read() {} }` },
    ])
    expect(result.endpoints).toEqual([])
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ reason: 'UNRESOLVED_ROUTE_PATH' }))
  })

  it('does not infer a decorator value from a declaration after the class', () => {
    const result = extractTs([{ path: 'controller.ts', content: `import { Controller, Get } from '@nestjs/common';
      @Controller(segment) export class Orders { @Get() read() {} }
      const segment = 'too-late';` }])
    expect(result.endpoints).toEqual([])
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ reason: 'UNRESOLVED_ROUTE_PATH' }))
  })
})

describe('own method call provenance', () => {
  it('links direct and arrow-lexical this calls to the declaring class only', () => {
    const result = extractTs([
      { path: 'other.ts', content: 'export class Other { read() {} }' },
      { path: 'service.ts', content: `export class Service {
        run() { return this.read() }
        later() { return () => this.read() }
        read() { return 1 }
      }` },
    ])
    expect(result.edges.filter(edge => edge.type === 'CALLS')).toEqual([
      expect.objectContaining({ sourceKey: 'ts:service.ts#Service.run', targetKey: 'ts:service.ts#Service.read', confidence: 'CONFIRMED', lineStart: 2 }),
      expect.objectContaining({ sourceKey: 'ts:service.ts#Service.later', targetKey: 'ts:service.ts#Service.read', confidence: 'CONFIRMED', lineStart: 3 }),
    ])
    expect(result.unresolvedCalls).toEqual([])
  })

  it.each([
    ['regular nested function', 'class Service { read() {} run() { function nested() { this.read() } } }'],
    ['object method receiver', 'class Service { read() {} run() { return { nested() { this.read() } } } }'],
    ['nested class receiver', 'class Service { read() {} run() { return class Inner { nested() { this.read() } } } }'],
    ['static target on an instance', 'class Service { static read() {} run() { this.read() } }'],
    ['instance target on a static receiver', 'class Service { read() {} static run() { this.read() } }'],
    ['static and instance key collision', 'class Service { static read() {} read() {} run() { this.read() } }'],
    ['property shadows the method', 'class Service { read() {} read = external; run() { this.read() } }'],
    ['parameter property shadows the method', 'class Service { constructor(private read: any) {} read() {} run() { this.read() } }'],
    ['inherited implementation', 'class Parent { read() {} } class Service extends Parent { run() { this.read() } }'],
    ['dynamic member', "class Service { read() {} run(key: string) { this[key]() } }"],
    ['member named this', 'class Service { read() {} run() { this.this.read() } }'],
  ])('keeps %s unresolved', (_label, content) => {
    const result = extractTs([{ path: 'service.ts', content }])
    expect(result.edges.filter(edge => edge.type === 'CALLS')).toEqual([])
    expect(result.unresolvedCalls.length).toBeGreaterThan(0)
  })

  it('does not treat an injected receiver inside a regular nested function as class this', () => {
    const result = extractTs([{ path: 'service.ts', content: `class Dependency { read() {} }
      class Service { constructor(private dep: Dependency) {} run() { function nested() { this.dep.read() } } }` }])
    expect(result.edges.filter(edge => edge.type === 'CALLS')).toEqual([])
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ expression: 'this.dep.read' }))
  })
})

describe('semantic target and route provenance', () => {
  it('calls the imported declaration when another file exports the same class and method name', () => {
    const result = extractTs([
      { path: 'a/live.service.ts', content: "export class DuplicateService { execute() { return 'live' } }" },
      { path: 'z/other.service.ts', content: "export class DuplicateService { execute() { return 'other' } }" },
      {
        path: 'consumer.ts',
        content: `import { DuplicateService as ActualService } from './a/live.service';
          export class Consumer {
            constructor(private readonly service: ActualService) {}
            run() { return this.service.execute() }
          }`,
      },
    ])
    expect(result.edges.filter((edge) => edge.type === 'CALLS')).toEqual([
      expect.objectContaining({
        sourceKey: 'ts:consumer.ts#Consumer.run',
        targetKey: 'ts:a/live.service.ts#DuplicateService.execute',
        confidence: 'CONFIRMED',
      }),
    ])
  })

  it('reports dynamic Nest controller and method paths instead of inventing root endpoints', () => {
    const result = extractTs([
      {
        path: 'controller.ts',
        content: `import { Controller, Get } from '@nestjs/common';
          const segment = process.env.SYNTHETIC_ROUTE_SEGMENT;
          @Controller(segment) export class DynamicController { @Get(':id') get() {} }
          @Controller('known') export class DynamicMethod { @Get(segment) get() {} }`,
      },
    ])
    expect(result.endpoints).toEqual([])
    expect(result.edges.filter((edge) => edge.type === 'EXPOSES')).toEqual([])
    expect(result.unresolvedCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: 'ts:controller.ts#DynamicController.get', reason: 'UNRESOLVED_ROUTE_PATH' }),
      expect.objectContaining({ sourceKey: 'ts:controller.ts#DynamicMethod.get', reason: 'UNRESOLVED_ROUTE_PATH' }),
    ]))
  })

  it('resolves the same path alias within the importing file nearest tsconfig scope', () => {
    const result = extractTs([
      { path: 'apps/a/tsconfig.json', content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@feature/*': ['src/*'] } } }) },
      { path: 'apps/z/tsconfig.json', content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@feature/*': ['src/*'] } } }) },
      { path: 'apps/a/src/repository.ts', content: 'export class RegionalRepository { list() { return [] } }' },
      { path: 'apps/z/src/repository.ts', content: 'export class RegionalRepository { list() { return [] } }' },
      {
        path: 'apps/z/src/consumer.ts',
        content: `import { RegionalRepository } from '@feature/repository';
          export class Consumer { constructor(private readonly repo: RegionalRepository) {} run() { return this.repo.list() } }`,
      },
    ])
    expect(result.imports).toContainEqual(expect.objectContaining({
      fromPath: 'apps/z/src/consumer.ts', toPath: 'apps/z/src/repository.ts', imported: 'RegionalRepository',
    }))
    expect(result.imports.some((item) => item.toPath === 'apps/a/src/repository.ts')).toBe(false)
    expect(result.edges.filter((edge) => edge.type === 'CALLS')).toEqual([
      expect.objectContaining({ targetKey: 'ts:apps/z/src/repository.ts#RegionalRepository.list' }),
    ])
  })

  it('ignores an unrelated setGlobalPrefix and follows the imported Nest factory receiver', () => {
    const result = extractTs([
      { path: 'a/tool.ts', content: "const tool = { setGlobalPrefix(_: string) {} }; tool.setGlobalPrefix('not-a-server');" },
      {
        path: 'b/main.ts',
        content: "import { NestFactory as Factory } from '@nestjs/core'; const app = await Factory.create(AppModule); app.setGlobalPrefix('real');",
      },
      {
        path: 'b/controller.ts',
        content: "import { Controller, Get } from '@nestjs/common'; @Controller('items') export class Items { @Get() get() {} }",
      },
    ])
    expect(result.endpoints.map((endpoint) => endpoint.path)).toEqual(['/real/items'])
  })

  it('does not borrow a missing method from another same-named class', () => {
    const result = extractTs([
      { path: 'live.ts', content: 'export class Service {}' },
      { path: 'other.ts', content: 'export class Service { execute() {} }' },
      { path: 'consumer.ts', content: "import { Service } from './live'; export class Consumer { constructor(private svc: Service) {} run() { this.svc.execute() } }" },
    ])
    expect(result.edges.filter((edge) => edge.type === 'CALLS')).toEqual([])
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ expression: 'this.svc.execute', reason: 'UNRESOLVED_TARGET' }))
  })

  it('does not guess an unimported or unresolved class from another module by its unique name', () => {
    const result = extractTs([
      { path: 'elsewhere.ts', content: 'export class Service { execute() {} }' },
      { path: 'consumer.ts', content: 'export class Consumer { constructor(private svc: Service) {} run() { this.svc.execute() } }' },
      { path: 'module.ts', content: "import { Module } from '@nestjs/common'; import { Service } from './missing'; @Module({ providers: [Service] }) export class AppModule {}" },
    ])
    expect(result.edges.some((edge) => edge.targetKey.startsWith('ts:elsewhere.ts#') && ['CALLS', 'DEPENDS_ON'].includes(edge.type))).toBe(false)
    expect(result.edges.some((edge) => edge.sourceKey === 'ts:module.ts#AppModule' && edge.targetKey === 'ts:elsewhere.ts#Service')).toBe(false)
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ expression: 'this.svc.execute', reason: 'UNRESOLVED_TARGET' }))
  })

  it('preserves explicitly empty Nest paths and resolves an earlier immutable literal', () => {
    const result = extractTs([
      { path: 'controller.ts', content: `import { Controller, Get } from '@nestjs/common';
        @Controller() export class Root { @Get() read() {} }
        const path = 'known'; @Controller(path) export class Constant { @Get() read() {} }` },
    ])
    expect(result.endpoints.map((endpoint) => endpoint.path)).toEqual(['/', '/known'])
    expect(result.unresolvedCalls).toEqual([])
  })

  it.each([false, true])('rejects ambiguous same-directory alias configuration regardless of input order (%s)', (reversed) => {
    const files = [
      { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '@repo': ['a'] } } }) },
      { path: 'tsconfig.other.json', content: JSON.stringify({ compilerOptions: { paths: { '@repo': ['b'] } } }) },
      { path: 'a.ts', content: 'export class Repository { read() {} }' },
      { path: 'b.ts', content: 'export class Repository { read() {} }' },
      { path: 'consumer.ts', content: "import { Repository } from '@repo'; export class Consumer { constructor(private repo: Repository) {} read() { this.repo.read() } }" },
    ]
    const result = extractTs(reversed ? files.reverse() : files)
    expect(result.imports).toEqual([])
    expect(result.edges.filter((edge) => edge.type === 'CALLS')).toEqual([])
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ reason: 'UNRESOLVED_TARGET' }))
  })

  it('does not apply ancestor aliases through an unimplemented nearest config inheritance', () => {
    const result = extractTs([
      { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '@repo': ['a'] } } }) },
      { path: 'app/tsconfig.json', content: JSON.stringify({ extends: './unprovided-config.json' }) },
      { path: 'a.ts', content: 'export class Repository { read() {} }' },
      { path: 'app/consumer.ts', content: "import { Repository } from '@repo'; export class Consumer { constructor(private repo: Repository) {} read() { this.repo.read() } }" },
    ])
    expect(result.imports).toEqual([])
    expect(result.edges.filter((edge) => edge.type === 'CALLS')).toEqual([])
  })

  it('matches exact aliases exactly and prefers them over wildcard aliases', () => {
    const result = extractTs([
      { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '@repo*': ['other'], '@repo': ['actual'], '@exact': ['actual'] } } }) },
      { path: 'actual.ts', content: 'export class Repository {}' },
      { path: 'other.ts', content: 'export class Repository {}' },
      { path: 'consumer.ts', content: "import { Repository } from '@repo'; import { Repository as Missing } from '@exact-extra';" },
    ])
    expect(result.imports).toEqual([expect.objectContaining({ imported: 'Repository', toPath: 'actual.ts' })])
  })

  it('does not guess aliases from malformed nearest configuration', () => {
    const result = extractTs([
      { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '@repo': [7] } } }) },
      { path: 'repo.ts', content: 'export class Repository {}' },
      { path: 'consumer.ts', content: "import { Repository } from '@repo';" },
    ])
    expect(result.imports).toEqual([])
  })

  const controller = { path: 'controller.ts', content: "import { Controller, Get } from '@nestjs/common'; @Controller('items') export class Items { @Get() get() {} }" }

  it('keeps the real Nest prefix through an immutable receiver alias', () => {
    const result = extractTs([
      controller,
      { path: 'main.ts', content: "import { NestFactory } from '@nestjs/core'; const app = await NestFactory.create(AppModule); const server = app; server.setGlobalPrefix('api');" },
    ])
    expect(result.endpoints.map((endpoint) => endpoint.path)).toEqual(['/api/items'])
    expect(result.unresolvedCalls).toEqual([])
  })

  it('does not apply one app prefix to an unprefixed second Nest app', () => {
    const result = extractTs([
      controller,
      { path: 'main.ts', content: "import { NestFactory } from '@nestjs/core'; const first = await NestFactory.create(A); first.setGlobalPrefix('api'); const second = await NestFactory.create(B);" },
    ])
    expect(result.endpoints).toEqual([])
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ reason: 'UNRESOLVED_GLOBAL_PREFIX' }))
  })

  it('does not bind a function parameter to an unrelated exported function by name', () => {
    const result = extractTs([
      { path: 'other.ts', content: 'export function execute() { return 42 }' },
      { path: 'use.ts', content: 'export class Use { run(execute: () => number) { return execute() } }' },
    ])
    expect(result.edges.filter((edge) => edge.type === 'CALLS')).toEqual([])
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ expression: 'execute', reason: 'UNRESOLVED_TARGET' }))
  })

  it('follows two immutable receiver aliases and a real factory alias through parentheses', () => {
    const result = extractTs([
      controller,
      { path: 'main.ts', content: `import * as Nest from '@nestjs/core'; const Factory = (Nest.NestFactory);
        const app = await Factory.create(AppModule); const first = (app); const server = ((first)); server.setGlobalPrefix('api');` },
    ])
    expect(result.endpoints.map((endpoint) => endpoint.path)).toEqual(['/api/items'])
  })

  it.each([
    'const Core = Nest; const app = await Core.NestFactory.create(AppModule);',
    'const { NestFactory: Factory } = Nest; const app = await Factory.create(AppModule);',
    "const Core = (Nest); const Other = Core; const app = await Other['NestFactory'].create(AppModule);",
  ])('preserves the prefix from a namespace-derived Nest factory: %s', (creation) => {
    const result = extractTs([
      controller,
      { path: 'main.ts', content: `import * as Nest from '@nestjs/core'; ${creation} app.setGlobalPrefix('api');` },
    ])
    expect(result.endpoints.map((endpoint) => endpoint.path)).toEqual(['/api/items'])
  })

  it.each([
    'let Core = Nest; const app = await Core.NestFactory.create(AppModule);',
    'const key = process.env.FACTORY; const { [key]: Factory } = Nest; const app = await Factory.create(AppModule);',
    'const { NestFactory: Factory = fallback } = Nest; const app = await Factory.create(AppModule);',
    'const Factory = wrap(Nest.NestFactory); const app = await Factory.create(AppModule);',
    'const Core = { ...Nest }; const app = await Core.NestFactory.create(AppModule);',
  ])('leaves ambiguous namespace-derived factory creation unresolved: %s', (creation) => {
    const result = extractTs([
      controller,
      { path: 'main.ts', content: `import * as Nest from '@nestjs/core'; ${creation} app.setGlobalPrefix('api');` },
    ])
    expect(result.endpoints).toEqual([])
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ reason: 'UNRESOLVED_GLOBAL_PREFIX' }))
  })

  it.each([
    "let server = app; server.setGlobalPrefix('api');",
    "const server = app.getHttpAdapter(); server.setGlobalPrefix('api');",
    "const server = wrap(app); server.setGlobalPrefix('api');",
    "const first = second; const second = first; first.setGlobalPrefix('api');",
    Array.from({ length: 70 }, (_, i) => `const alias${i} = ${i === 0 ? 'app' : `alias${i - 1}`};`).join(' ') + " alias69.setGlobalPrefix('api');",
  ])('does not turn an unsupported or mutable receiver alias into the empty prefix: %s', (aliases) => {
    const result = extractTs([
      controller,
      { path: 'main.ts', content: `import { NestFactory } from '@nestjs/core'; const app = await NestFactory.create(AppModule); ${aliases}` },
    ])
    expect(result.endpoints).toEqual([])
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ reason: 'UNRESOLVED_GLOBAL_PREFIX' }))
  })

  it('ignores an immutable alias of an unrelated prefix-like object', () => {
    const result = extractTs([
      controller,
      { path: 'main.ts', content: `import { NestFactory } from '@nestjs/core'; const app = await NestFactory.create(AppModule);
        const tool = { setGlobalPrefix(_: string) {} }; const other = tool; other.setGlobalPrefix('fake'); app.setGlobalPrefix('api');` },
    ])
    expect(result.endpoints.map((endpoint) => endpoint.path)).toEqual(['/api/items'])
  })

  it('handles shared receiver initializer graphs without repeatedly expanding both branches', () => {
    const aliases = Array.from({ length: 18 }, (_, i) => `const tool${i + 1} = Object.assign({}, tool${i}, tool${i});`).join('\n')
    const result = extractTs([
      controller,
      { path: 'main.ts', content: `import { NestFactory } from '@nestjs/core'; const app = await NestFactory.create(AppModule);
        const tool0 = { setGlobalPrefix(_: string) {} }; ${aliases}
        tool18.setGlobalPrefix('fake'); app.setGlobalPrefix('api');` },
    ])
    expect(result.endpoints.map((endpoint) => endpoint.path)).toEqual(['/api/items'])
  })

  it('resolves bare calls through same-file declarations and actual named/default import bindings', () => {
    const result = extractTs([
      { path: 'helpers.ts', content: 'export function execute() {} export default function defaultExecute() {}' },
      { path: 'other.ts', content: 'export function execute() {}' },
      { path: 'use.ts', content: `import defaultHelper, { execute as remoteHelper } from './helpers';
        function localHelper() {} export class Use { run() { localHelper(); remoteHelper(); defaultHelper(); } }` },
    ])
    expect(result.edges.filter((edge) => edge.type === 'CALLS').map((edge) => edge.targetKey)).toEqual([
      'ts:use.ts#localHelper', 'ts:helpers.ts#execute', 'ts:helpers.ts#defaultExecute',
    ])
  })

  it('uses the importing file nearest tsconfig for a bare function import alias', () => {
    const result = extractTs([
      { path: 'a/tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '@helper': ['helper'] } } }) },
      { path: 'b/tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '@helper': ['helper'] } } }) },
      { path: 'a/helper.ts', content: 'export function execute() {}' },
      { path: 'b/helper.ts', content: 'export function execute() {}' },
      { path: 'b/use.ts', content: "import { execute as go } from '@helper'; export class Use { run() { go() } }" },
    ])
    expect(result.edges.filter((edge) => edge.type === 'CALLS')).toEqual([
      expect.objectContaining({ targetKey: 'ts:b/helper.ts#execute', confidence: 'CONFIRMED' }),
    ])
  })

  it.each([
    'function execute() {} export class Use { run(execute: () => void) { execute() } }',
    'function execute() {} export class Use { run() { function execute() {} execute() } }',
    "import { execute } from './missing'; export class Use { run() { execute() } }",
    "import type { execute } from './other'; export class Use { run() { execute() } }",
    "import { hidden as execute } from './other'; export class Use { run() { execute() } }",
  ])('does not replace a shadowed or unproven bare call with another function: %s', (content) => {
    const result = extractTs([
      { path: 'other.ts', content: 'export function execute() {} function hidden() {}' },
      { path: 'use.ts', content },
    ])
    expect(result.edges.filter((edge) => edge.type === 'CALLS')).toEqual([])
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ expression: 'execute', reason: 'UNRESOLVED_TARGET' }))
  })

  it('preserves the first relation and evidence when duplicate module declarations share an edge', () => {
    const result = extractTs([
      { path: 'service.ts', content: 'export class Service {}' },
      { path: 'module.ts', content: `import { Module } from '@nestjs/common'; import { Service } from './service';
        @Module({ controllers: [Service],
          providers: [Service, Service] }) export class AppModule {}` },
    ])
    const declarations = result.edges.filter((edge) => edge.sourceKey === 'ts:module.ts#AppModule' && edge.targetKey === 'ts:service.ts#Service')
    expect(declarations).toEqual([
      expect.objectContaining({ type: 'DECLARES', lineStart: 2, metadata: { relation: 'NEST_MODULE_CONTROLLERS' } }),
    ])
  })

  it('supports the actual namespace-imported Nest factory', () => {
    const result = extractTs([
      controller,
      { path: 'main.ts', content: "import * as Nest from '@nestjs/core'; const app = await Nest.NestFactory.create(AppModule); app.setGlobalPrefix('api');" },
    ])
    expect(result.endpoints.map((endpoint) => endpoint.path)).toEqual(['/api/items'])
  })

  it('ignores a shadowed factory and a shadowed receiver instead of matching their names', () => {
    const result = extractTs([
      controller,
      { path: 'main.ts', content: `import { NestFactory } from '@nestjs/core';
        const app = await NestFactory.create(AppModule); app.setGlobalPrefix('actual');
        async function fakeFactory(NestFactory: any) { const app = await NestFactory.create(); app.setGlobalPrefix('fake'); }
        function fakeReceiver(app: any) { app.setGlobalPrefix('also-fake'); }` },
    ])
    expect(result.endpoints.map((endpoint) => endpoint.path)).toEqual(['/actual/items'])
  })

  it.each([
    "const app = await NestFactory.create(AppModule); app.setGlobalPrefix('unproven');",
    "import { NestFactory } from '@nestjs/core'; const app = await NestFactory.create(AppModule); app.setGlobalPrefix(process.env.PREFIX);",
    "import { NestFactory } from '@nestjs/core'; let app = await NestFactory.create(AppModule); app.setGlobalPrefix('mutable');",
    "import { NestFactory } from '@nestjs/core'; const app = await NestFactory.create(AppModule); app.setGlobalPrefix('api', { exclude: ['items'] });",
    "import { NestFactory } from '@nestjs/core'; const a = await NestFactory.create(A); const b = await NestFactory.create(B); a.setGlobalPrefix('a'); b.setGlobalPrefix('b');",
  ])('reports unsupported or ambiguous Nest prefix configuration: %s', (content) => {
    const result = extractTs([controller, { path: 'main.ts', content }])
    expect(result.endpoints).toEqual([])
    expect(result.edges.filter((edge) => edge.type === 'EXPOSES')).toEqual([])
    expect(result.unresolvedCalls).toContainEqual(expect.objectContaining({ reason: 'UNRESOLVED_GLOBAL_PREFIX' }))
  })
})
