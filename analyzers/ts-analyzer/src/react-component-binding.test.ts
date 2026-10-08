import { describe, expect, it } from 'vitest'
import { extractTs } from './ts-extractor'
import type { AnalyzeFile } from './types'

function binding(imports: string, page: string, { expression = '<Selected />', extra = [] as AnalyzeFile[], body = '' } = {}) {
  return extractTs([
    { path: 'ui/Router.tsx', content: `import { Route } from 'react-router-dom'; ${imports}
      ${body} export function Router() { return <Route path="/detail" element={${expression}} /> }` },
    { path: 'ui/Page.tsx', content: page }, ...extra,
  ]).routes.find(route => route.path === '/detail')?.componentResolution
}

describe('React component declaration binding', () => {
  it('resolves a default import alias to the exported declaration, not a same-named component elsewhere', () => {
    const result = extractTs([
      { path: 'ui/Router.tsx', content: `import { Route } from 'react-router-dom';
        import Selected from './Page';
        export function Router() { return <Route path="/detail" element={<Selected />} /> }` },
      { path: 'ui/Page.tsx', content: 'export default function ActualPage() { return <h1>detail</h1> }' },
      { path: 'admin/Page.tsx', content: 'export default function Selected() { return <h1>unrelated</h1> }' },
    ])
    expect(result.routes).toContainEqual(expect.objectContaining({
      path: '/detail', component: 'Selected',
      componentResolution: { status: 'RESOLVED', target: { name: 'ActualPage', filePath: 'ui/Page.tsx', lineStart: 1, lineEnd: 1 } },
    }))
  })

  it.each([
    ['named default', 'export default function ActualPage() { return <h1/> }'],
    ['const default', 'const ActualPage = () => <h1/>; export default ActualPage;'],
    ['explicit default export', 'function ActualPage() { return <h1/> }; export { ActualPage as default };'],
    ['immutable alias', 'const ActualPage = () => <h1/>; const Alias = ActualPage; export default Alias;'],
    ['parenthesized default', 'const ActualPage = () => <h1/>; export default (ActualPage);'],
  ])('resolves %s by the actual value declaration', (_name, content) => {
    expect(binding("import Selected from './Page';", content)).toEqual({
      status: 'RESOLVED', target: { name: 'ActualPage', filePath: 'ui/Page.tsx', lineStart: 1, lineEnd: 1 },
    })
  })

  it.each([
    "import { default as Selected } from './Page';",
    "import * as Pages from './Page'; const Selected = Pages.default;",
  ])('follows explicit default namespace/value binding: %s', imports => {
    expect(binding(imports, 'export default function ActualPage() { return <h1/> }')?.target?.name).toBe('ActualPage')
  })

  it('handles a direct namespace element and paired JSX without descendant guessing', () => {
    expect(binding("import * as Pages from './Page';", 'export default function ActualPage() { return <h1/> }',
      { expression: '<Pages.default></Pages.default>' })?.target?.name).toBe('ActualPage')
  })

  it('retains named export aliases and follows an explicit value re-export chain', () => {
    expect(binding("import { Renamed as Selected } from './Page';",
      'function ActualPage() { return <h1/> }; export { ActualPage as Renamed };')?.target?.name).toBe('ActualPage')
    expect(binding("import Selected from './Page';", "export { Screen as default } from './barrel';", {
      extra: [{ path: 'ui/barrel.ts', content: "export { default as Screen } from './Actual';" },
        { path: 'ui/Actual.tsx', content: 'export default function ActualPage() { return <h1/> }' }],
    })).toEqual({ status: 'RESOLVED', target: { name: 'ActualPage', filePath: 'ui/Actual.tsx', lineStart: 1, lineEnd: 1 } })
  })

  it('resolves an imported value exported as default but never treats an export statement as a local JSX binding', () => {
    const extra = [{ path: 'ui/Actual.tsx', content: 'export default function ActualPage() { return <h1/> }' }]
    expect(binding("import Selected from './Page';", "import Actual from './Actual'; export default Actual;", { extra })?.target?.name).toBe('ActualPage')
    expect(binding("export { default as Selected } from './Page';", extra[0].content)?.status).toBe('UNRESOLVED')
  })

  it('uses the existing input-only tsconfig alias resolver', () => {
    const extra = [{ path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { paths: { '@ui/*': ['ui/*'] } } }) }]
    expect(binding("import Selected from '@ui/Page';", 'export default function ActualPage() { return <h1/> }', { extra })?.target?.filePath).toBe('ui/Page.tsx')
  })

  it.each([
    ["import type Selected from './Page';", 'export default function ActualPage() { return <h1/> }'],
    ["import { type default as Selected } from './Page';", 'export default function ActualPage() { return <h1/> }'],
    ["import Selected from './Page';", 'function ActualPage() { return <h1/> }; export { type ActualPage as default };'],
    ["import Selected from './Page';", 'export default interface ActualPage {}'],
    ["import Selected from './Page';", 'export function Selected() { return <h1/> }'],
    ["import { Selected } from './Page';", 'function Selected() { return <h1/> }; export {};'],
    ["import Selected from './absent';", 'export default function Selected() { return <h1/> }'],
    ["import Selected from './Page';", 'const ActualPage = () => <h1/>; export default wrap(ActualPage);'],
    ["import Selected from './Page';", 'export default () => <h1/>;'],
    ["import Selected from './Page';", 'let ActualPage = () => <h1/>; export default ActualPage;'],
    ["import Selected from './Page';", 'const Alias = Other; const Other = Alias; export default Alias;'],
    ["import { Selected } from './Page';", "export * from './Actual';"],
  ])('keeps an unproven export unresolved: %s / %s', (imports, page) => {
    expect(binding(imports, page, { extra: [{ path: 'ui/Actual.tsx', content: 'export function Selected() { return <h1/> }' }] }))
      .toEqual({ status: 'UNRESOLVED', target: null })
  })

  it('rejects a type-only hop in an otherwise valid explicit re-export chain', () => {
    expect(binding("import Selected from './Page';", "export { type default } from './Actual';", {
      extra: [{ path: 'ui/Actual.tsx', content: 'export default function ActualPage() { return <h1/> }' }],
    })?.status).toBe('UNRESOLVED')
  })

  it('does not choose between two default export declarations', () => {
    expect(binding("import Selected from './Page';", 'export default function One() { return <h1/> }; export default function Two() { return <h2/> };')?.status)
      .toBe('UNRESOLVED')
  })

  it('rejects same-file/name graph-key collisions even when the JSX symbol has one exact declaration', () => {
    expect(binding("import Selected from './Page';", `export default function ActualPage() { return <h1/> }
      function Scope() { function ActualPage() { return <h2/> }; return <ActualPage/> }`)?.status).toBe('UNRESOLVED')
  })

  it('rejects parameter and destructuring shadows instead of reconnecting the outer import', () => {
    for (const parameter of ['Selected: any', '{ Selected }: any']) {
      const result = extractTs([
        { path: 'ui/Router.tsx', content: `import { Route } from 'react-router-dom'; import Selected from './Page';
          export function Router(${parameter}) { return <Route path="/detail" element={<Selected />} /> }` },
        { path: 'ui/Page.tsx', content: 'export default function ActualPage() { return <h1/> }' },
      ])
      expect(result.routes[0].componentResolution).toEqual({ status: 'UNRESOLVED', target: null })
    }
  })

  it.each(['flag ? <Selected/> : <Other/>', 'wrap(<Selected/>)', '() => <Selected/>', '<><Selected/></>'])
  ('never chooses a descendant from an unsupported element expression: %s', expression => {
    expect(binding("import Selected from './Page';", 'export default function ActualPage() { return <h1/> }', { expression })?.status).toBe('UNRESOLVED')
  })

  it('rejects spreads/duplicate elements that could replace the supplied component', () => {
    for (const attributes of ['element={<Selected/>} {...props}', 'element={<Selected/>} element={<Other/>}']) {
      const result = extractTs([{ path: 'ui/Router.tsx', content: `import { Route } from 'react-router-dom';
        function Selected() { return <h1/> }; export const view = <Route path="/detail" ${attributes} />;` }])
      expect(result.routes[0].componentResolution?.status).toBe('UNRESOLVED')
    }
  })

  it('permits a unique local non-exported function or const declaration', () => {
    for (const body of ['function Selected() { return <h1/> }', 'const Selected = () => <h1/>;']) {
      expect(binding('', '', { body })?.target?.filePath).toBe('ui/Router.tsx')
    }
  })

  it('bounds long and cyclic explicit re-export chains', () => {
    const extra = Array.from({ length: 80 }, (_, index) => ({ path: `ui/H${index}.tsx`, content:
      index === 79 ? 'export default function End() { return <h1/> }' : `export { default } from './H${index + 1}';` }))
    expect(binding("import Selected from './Page';", "export { default } from './H0';", { extra })?.status).toBe('UNRESOLVED')
    expect(binding("import Selected from './Page';", "export { default } from './Page';")?.status).toBe('UNRESOLVED')
  })

  it.each(['ActualPage = Other;', '({ page: ActualPage } = holder);', '({ ActualPage } = holder);', '[ActualPage] = values;',
    'ActualPage ||= Other;', 'for (ActualPage of values) {}', 'function mutate() { ActualPage = Other }'])
  ('does not bind a function with an observed reassignment: %s', write => {
    expect(binding("import Selected from './Page';", `function ActualPage() { return <h1/> }
      function Other() { return <h2/> } ${write} export { ActualPage as default };`)?.status).toBe('UNRESOLVED')
  })

  it('refuses duplicated package identities regardless of input order', () => {
    const files = [
      { path: 'ui/Router.tsx', content: `import { Route } from 'react-router-dom'; import Selected from '@fixture/ui';
        export function Router() { return <Route path="/detail" element={<Selected/>}/> }` },
      { path: 'a/package.json', content: '{"name":"@fixture/ui"}' },
      { path: 'a/src/index.tsx', content: 'export default function One() { return <h1/> }' },
      { path: 'b/package.json', content: '{"name":"@fixture/ui"}' },
      { path: 'b/src/index.tsx', content: 'export default function Two() { return <h2/> }' },
    ]
    for (const input of [files, [...files].reverse()]) expect(extractTs(input).routes[0].componentResolution?.status).toBe('UNRESOLVED')
  })

  it.each([
    { exports: './src/Actual.tsx' }, { main: './src/Actual.tsx' },
    { exports: { '.': { import: './src/Actual.tsx', default: './src/Other.tsx' } } }, {},
  ])('never promotes a package src/index heuristic to explicit component proof: %j', metadata => {
    const files = [
      { path: 'ui/Router.tsx', content: `import { Route } from 'react-router-dom'; import Selected from '@fixture/ui';
        export function Router() { return <Route path="/detail" element={<Selected/>}/> }` },
      { path: 'pkg/package.json', content: JSON.stringify({ name: '@fixture/ui', ...metadata }) },
      { path: 'pkg/src/index.tsx', content: 'export default function WrongPage() { return <h1/> }' },
      { path: 'pkg/src/Actual.tsx', content: 'export default function ActualPage() { return <h2/> }' },
    ]
    for (const input of [files, [...files].reverse()]) expect(extractTs(input).routes[0].componentResolution)
      .toEqual({ status: 'UNRESOLVED', target: null })
  })

  it('allows a supplied tsconfig path binding without falling through to package metadata guesses', () => {
    const result = extractTs([
      { path: 'tsconfig.json', content: '{"compilerOptions":{"paths":{"@fixture/ui":["pkg/src/Actual.tsx"]}}}' },
      { path: 'ui/Router.tsx', content: `import { Route } from 'react-router-dom'; import Selected from '@fixture/ui';
        export function Router() { return <Route path="/detail" element={<Selected/>}/> }` },
      { path: 'pkg/package.json', content: '{"name":"@fixture/ui","exports":"./src/Actual.tsx"}' },
      { path: 'pkg/src/index.tsx', content: 'export default function WrongPage() { return <h1/> }' },
      { path: 'pkg/src/Actual.tsx', content: 'export default function ActualPage() { return <h2/> }' },
    ])
    expect(result.routes[0].componentResolution?.target?.filePath).toBe('pkg/src/Actual.tsx')
    expect(result.routes[0].componentResolution?.target?.name).toBe('ActualPage')
  })

  it('does not resolve two declarations that collide on a route key', () => {
    const result = extractTs([{ path: 'ui/Router.tsx', content: `import { Route } from 'react-router-dom';
      function Selected() { return <h1/> }
      export function One() { return <Route path="/detail" element={<Selected/>}/> }
      export function Two(Selected: any) { return <Route path="/detail" element={<Selected/>}/> }` }])
    expect(result.routes).toHaveLength(2)
    expect(result.routes.every(route => route.componentResolution?.status === 'UNRESOLVED')).toBe(true)
  })
})
