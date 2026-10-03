import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractTs } from './ts-extractor'
import { assertSafeRelativePath } from './paths'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../../../backend/src/test/resources/fixtures')

describe('React Route binding provenance', () => {
  it.each(['react-router-dom', 'react-router'])('recognizes a named Route alias from %s', (source) => {
    const result = extractTs([{ path: 'view.tsx', content: `import { Route as ScreenRoute } from '${source}';
      export function View() { return <ScreenRoute path="/orders" element={<Orders />} /> }` }])
    expect(result.routes).toEqual([expect.objectContaining({ path: '/orders', component: 'Orders', filePath: 'view.tsx', lineStart: 2 })])
  })

  it('recognizes a namespace Route only through its value import', () => {
    const result = extractTs([{ path: 'view.tsx', content: `import * as Router from 'react-router-dom';
      export function View() { return <Router.Route path="/orders" /> }` }])
    expect(result.routes.map(route => route.path)).toEqual(['/orders'])
  })

  it.each([
    "function Route(props: any) { return null }; export const view = <Route path='/fake' />",
    "import { Route } from './unrelated'; export const view = <Route path='/fake' />",
    "import type { Route } from 'react-router-dom'; export const view = <Route path='/fake' />",
    "import { type Route } from 'react-router-dom'; export const view = <Route path='/fake' />",
    "import * as Router from './unrelated'; export const view = <Router.Route path='/fake' />",
    "import type * as Router from 'react-router-dom'; export const view = <Router.Route path='/fake' />",
    "import { Route } from 'react-router-dom'; export function View(Route: any) { return <Route path='/fake' /> }",
    "import { Route as ScreenRoute } from 'react-router-dom'; export function View(ScreenRoute: any) { return <ScreenRoute path='/fake' /> }",
    "import * as Router from 'react-router-dom'; export function View(Router: any) { return <Router.Route path='/fake' /> }",
  ])('does not identify an unproven or shadowed Route: %s', (content) => {
    expect(extractTs([{ path: 'view.tsx', content }]).routes).toEqual([])
  })
})

describe('explicit TypeScript module extensions', () => {
  it.each([['mts', 'mjs'], ['cts', 'cjs']])('parses .%s and resolves its runtime .%s import', (sourceExt, importExt) => {
    const result = extractTs([
      { path: `worker.${sourceExt}`, content: 'export function execute() {}' },
      { path: `consumer.${sourceExt}`, content: `import { execute } from './worker.${importExt}';
        export class Consumer { run() { execute(); fetch('/module') } }` },
    ])
    expect(result.imports).toContainEqual(expect.objectContaining({ fromPath: `consumer.${sourceExt}`, toPath: `worker.${sourceExt}` }))
    expect(result.edges.filter(edge => edge.type === 'CALLS')).toEqual([
      expect.objectContaining({ targetKey: `ts:worker.${sourceExt}#execute` }),
    ])
    expect(result.apiCalls).toEqual([expect.objectContaining({ url: '/module', filePath: `consumer.${sourceExt}` })])
  })

  it('prefers TypeScript source to emitted mjs for a runtime extension import', () => {
    const result = extractTs([
      { path: 'worker.mts', content: 'export function execute() {}' },
      { path: 'worker.mjs', content: 'export function execute() {}' },
      { path: 'consumer.ts', content: "import { execute } from './worker.mjs'; class Consumer { run() { execute() } }" },
    ])
    expect(result.edges.filter(edge => edge.type === 'CALLS')).toEqual([
      expect.objectContaining({ targetKey: 'ts:worker.mts#execute' }),
    ])
  })
})

describe('syntax uncertainty', () => {
  it.each([
    ['broken.ts', "export const SYNTHETIC_SECRET_MARKER = ;"],
    ['broken.tsx', 'export const view = <div>'],
    ['broken.mts', 'export class Broken {'],
    ['broken.cts', 'export const value = ;'],
  ])('rejects a syntactically broken %s with location-only diagnostics', (path, content) => {
    let failure: unknown
    try { extractTs([{ path, content }]) } catch (error) { failure = error }
    expect(failure).toMatchObject({
      name: 'ParserSyntaxError',
      diagnostics: expect.arrayContaining([expect.objectContaining({ filePath: path, code: expect.any(Number), lineStart: 1, columnStart: expect.any(Number) })]),
    })
    expect(String(failure)).not.toContain('SYNTHETIC_SECRET_MARKER')
    expect(JSON.stringify(failure)).not.toContain('SYNTHETIC_SECRET_MARKER')
  })

  it('does not return apparently complete endpoints when another bootstrap file cannot parse', () => {
    expect(() => extractTs([
      { path: 'controller.ts', content: "import { Controller, Get } from '@nestjs/common'; @Controller('orders') class Orders { @Get() read() {} }" },
      { path: 'main.ts', content: "import { NestFactory } from '@nestjs/core'; const app = await NestFactory.create( ;" },
    ])).toThrowError(expect.objectContaining({ name: 'ParserSyntaxError' }))
  })

  it('bounds returned diagnostics while retaining the total across files', () => {
    let failure: unknown
    try {
      extractTs(['a.ts', 'b.ts'].map(path => ({ path, content: 'const value = ;\n'.repeat(80) })))
    } catch (error) { failure = error }
    expect(failure).toMatchObject({ name: 'ParserSyntaxError', totalDiagnostics: 160 })
    expect((failure as { diagnostics: unknown[] }).diagnostics).toHaveLength(100)
  })

  it('does not execute valid input or conflate missing imports/types with parse errors', () => {
    expect(() => extractTs([{ path: 'not-executed.ts', content: `import { missing } from './not-provided';
      throw new Error('must never run'); const value: MissingType = missing();` }])).not.toThrow()
  })
})

function read(rel: string): string {
  return readFileSync(join(fixtures, rel), 'utf8')
}

describe('extractTs', () => {
  it('extracts react-mini routes, TodoItem, and fetch /api/todos', () => {
    const result = extractTs([
      { path: 'src/App.tsx', content: read('react-mini/src/App.tsx') },
      { path: 'src/pages/TodosPage.tsx', content: read('react-mini/src/pages/TodosPage.tsx') },
      { path: 'src/pages/HomePage.tsx', content: read('react-mini/src/pages/HomePage.tsx') },
      { path: 'src/components/TodoItem.tsx', content: read('react-mini/src/components/TodoItem.tsx') },
    ])
    expect(result.routes.map((route) => route.path).sort()).toEqual(['/', '/todos'])
    expect(result.routes.find((route) => route.path === '/todos')?.component).toBe('TodosPage')
    expect(result.components.map((item) => item.name)).toEqual(expect.arrayContaining(['TodoItem', 'TodosPage', 'App']))
    expect(result.apiCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'GET', url: '/api/todos', owner: 'TodosPage' }),
      ]),
    )
    expect(result.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromPath: 'src/pages/TodosPage.tsx',
          toPath: 'src/components/TodoItem.tsx',
          imported: 'TodoItem',
        }),
      ]),
    )
  })

  it('extracts fullstack-mini frontend under frontend/ prefix', () => {
    const result = extractTs([
      { path: 'frontend/src/App.tsx', content: read('fullstack-mini/frontend/src/App.tsx') },
      { path: 'frontend/src/pages/TodosPage.tsx', content: read('fullstack-mini/frontend/src/pages/TodosPage.tsx') },
      { path: 'frontend/src/components/TodoItem.tsx', content: read('fullstack-mini/frontend/src/components/TodoItem.tsx') },
    ])
    expect(result.routes.map((route) => route.path).sort()).toEqual(['/', '/todos'])
    expect(result.apiCalls[0]).toMatchObject({ url: '/api/todos', method: 'GET' })
  })

  it('extracts python/go symbols heuristically', () => {
    const result = extractTs([
      { path: 'app.py', content: 'class Worker:\n    def run(self):\n        pass\n' },
      { path: 'main.go', content: 'type Server struct {}\nfunc Listen() {}\n' },
    ])
    expect(result.symbols.map((item) => `${item.kind}:${item.name}`).sort()).toEqual(
      ['CLASS:Server', 'CLASS:Worker', 'FUNCTION:Listen', 'FUNCTION:run'].sort(),
    )
  })

  it('extracts Next.js App Router pages and route handlers', () => {
    const result = extractTs([
      {
        path: 'app/results/page.tsx',
        content: 'export default async function ResultsPage() { return <div>results</div> }',
      },
      {
        path: 'app/compare/[slug]/page.tsx',
        content: 'export default function ComparePage() { return <div>compare</div> }',
      },
      {
        path: 'app/api/price/route.ts',
        content:
          'export async function GET() { return Response.json({}) }\nexport async function POST(req) { return Response.json({}) }',
      },
      {
        path: 'app/(tabs)/index.tsx',
        content: 'export default function Home() { return <div>home</div> }',
      },
    ])
    expect(result.routes.map((route) => route.path).sort()).toEqual(['/', '/compare/:slug', '/results'])
    expect(result.routes.find((route) => route.path === '/results')?.component).toBe('ResultsPage')
    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort()).toEqual([
      'GET /api/price',
      'POST /api/price',
    ])
  })

  it('extracts Expo Router index pages under app/', () => {
    const result = extractTs([
      { path: 'app/diagnosis/index.tsx', content: 'export default function Diagnosis() { return <div>d</div> }' },
      { path: 'app/my-info.tsx', content: 'export default function MyInfo() { return <div>i</div> }' },
    ])
    expect(result.routes.map((route) => route.path).sort()).toEqual(['/diagnosis', '/my-info'])
  })

  it('extracts Vue Router config with lazy imports', () => {
    const result = extractTs([
      {
        path: 'src/router/index.ts',
        content: [
          "import { createRouter } from 'vue-router'",
          'const router = createRouter({',
          '  routes: [',
          "    { path: '/', component: Home },",
          "    { path: '/about', name: 'about', component: () => import('./views/About.vue') },",
          '  ],',
          '})',
        ].join('\n'),
      },
    ])
    expect(result.routes.map((route) => route.path).sort()).toEqual(['/', '/about'])
    expect(result.routes.find((route) => route.path === '/about')?.component).toBe('About')
  })

  it('extracts SvelteKit +server route handlers', () => {
    const result = extractTs([
      {
        path: 'src/routes/api/watches/+server.ts',
        content: 'export async function GET() { return new Response() }\nexport const DELETE = async () => new Response()',
      },
    ])
    expect(result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort()).toEqual([
      'DELETE /api/watches',
      'GET /api/watches',
    ])
  })

  it('extracts provenance-aware NestJS modules, routes, DI, calls, aliases, and ORM access', () => {
    const result = extractTs([
      {
        path: 'tsconfig.json',
        content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } }),
      },
      {
        path: 'src/main.ts',
        content: `import { NestFactory } from '@nestjs/core'; const app = await NestFactory.create(AppModule); app.setGlobalPrefix('api')`,
      },
      {
        path: 'src/app.module.ts',
        content: `
          import { Module as NestModule, forwardRef } from '@nestjs/common'
          import { UsersController } from './users.controller'
          import { UsersService } from '@app/users.service'
          import { SharedModule } from './shared.module'
          import { PrismaUserRepository, USER_REPO } from './user.repository'
          @NestModule({
            imports: [forwardRef(() => SharedModule)],
            controllers: [UsersController],
            providers: [UsersService, { provide: USER_REPO, useClass: PrismaUserRepository }],
            exports: [UsersService],
          })
          export class AppModule {}
        `,
      },
      {
        path: 'src/shared.module.ts',
        content: `import { Module } from '@nestjs/common'; @Module({}) export class SharedModule {}`,
      },
      {
        path: 'src/users.controller.ts',
        content: `
          import { Controller as HttpController, Get as Read, UseGuards } from '@nestjs/common'
          import type { UserDto } from './user.dto'
          import { UsersService } from './users.service'
          import { AuthGuard } from './auth.guard'
          @HttpController('users')
          export class UsersController {
            constructor(private readonly users: UsersService) {}
            @Read(':id') @UseGuards(AuthGuard)
            get(): Promise<UserDto> { return this.users.findById() }
          }
        `,
      },
      {
        path: 'src/users.service.ts',
        content: `
          import { Inject, Injectable } from '@nestjs/common'
          import { USER_REPO, UserRepository } from './user.repository'
          @Injectable()
          export class UsersService {
            constructor(@Inject(USER_REPO) private readonly repo: UserRepository) {}
            findById() { return this.repo.findById() }
          }
        `,
      },
      {
        path: 'src/user.repository.ts',
        content: `
          import { Injectable } from '@nestjs/common'
          export const USER_REPO = Symbol('USER_REPO')
          export interface UserRepository { findById(): unknown }
          @Injectable()
          export class PrismaUserRepository {
            constructor(private readonly prisma: PrismaService) {}
            findById() { return this.prisma.user.findUnique({ where: { id: 1 } }) }
          }
        `,
      },
      { path: 'src/user.dto.ts', content: `export interface UserDto { id: number }` },
      { path: 'src/auth.guard.ts', content: `export class AuthGuard {}` },
      {
        path: 'src/not-nest.ts',
        content: `
          function Controller(_: string) { return () => undefined }
          function Get() { return () => undefined }
          @Controller('wrong') class WrongController { @Get() wrong() {} }
          const client = { create() { return 1 } }
          export const value = client.create()
        `,
      },
    ])

    expect(result.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/api/users/:id',
        handlerKey: 'ts:src/users.controller.ts#UsersController.get',
        ownerKey: 'ts:src/users.controller.ts#UsersController',
      }),
    )
    expect(result.endpoints.some((endpoint) => endpoint.path.includes('wrong'))).toBe(false)
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'ts:src/app.module.ts#AppModule', type: 'MODULE' }),
        expect.objectContaining({ key: 'ts:src/users.service.ts#UsersService', type: 'CLASS' }),
        expect.objectContaining({ key: 'data:prisma:user', type: 'DB_ENTITY' }),
      ]),
    )
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKey: 'ts:src/app.module.ts#AppModule',
          targetKey: 'ts:src/shared.module.ts#SharedModule',
          type: 'DEPENDS_ON',
        }),
        expect.objectContaining({
          sourceKey: 'ts:src/users.controller.ts#UsersController.get',
          targetKey: 'ts:src/users.service.ts#UsersService.findById',
          type: 'CALLS',
        }),
        expect.objectContaining({
          sourceKey: 'ts:src/user.repository.ts#PrismaUserRepository.findById',
          targetKey: 'data:prisma:user',
          type: 'READS_WRITES',
        }),
      ]),
    )
    expect(result.imports).toContainEqual(
      expect.objectContaining({
        fromPath: 'src/app.module.ts',
        toPath: 'src/users.service.ts',
        imported: 'UsersService',
        typeOnly: false,
      }),
    )
    expect(result.imports).toContainEqual(expect.objectContaining({ imported: 'UserDto', typeOnly: true }))
    expect(result.stores).toEqual([])
  })

  it('rejects parent path segments', () => {
    expect(() => assertSafeRelativePath('../secret.ts')).toThrow(/must not contain/)
  })
})
