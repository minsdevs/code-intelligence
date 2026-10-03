import { describe, expect, it } from 'vitest'
import { extractTs } from './ts-extractor'

function calls(content: string) {
  return extractTs([{ path: 'src/http-boundary.ts', content }]).apiCalls
}

describe('HTTP call provenance and method boundary', () => {
  it('regression: rejects shadowed fetch and unrelated axios-shaped receivers', () => {
    const result = calls(`
      export function execute(fetch: (url: string) => void) { fetch('/local-function') }
      const notaxios = { get(url: string) { return url } }
      notaxios.get('/local-object')
      const axios = { post(url: string) { return url } }
      axios.post('/unimported-object')
    `)
    expect(result).toEqual([])
  })

  it('regression: treats a dynamic fetch method as UNKNOWN instead of GET', () => {
    const result = calls(`
      declare const chosenMethod: string
      export function execute() { return fetch('/v3/sales', { method: chosenMethod }) }
    `)
    expect(result).toEqual([
      expect.objectContaining({ url: '/v3/sales', method: 'UNKNOWN', owner: 'execute' }),
    ])
  })

  it('preserves builtin fetch defaults, literal methods and source location', () => {
    expect(calls(`export function execute() {
      fetch('/default')
      fetch('/post', { method: 'post' })
    }`)).toEqual([
      expect.objectContaining({ url: '/default', method: 'GET', owner: 'execute', filePath: 'src/http-boundary.ts', lineStart: 2 }),
      expect.objectContaining({ url: '/post', method: 'POST', owner: 'execute', lineStart: 3 }),
    ])
  })
})

describe('fetch lexical provenance', () => {
  it.each([
    ['script const', `const fetch = (url: string) => url; fetch('/local')`],
    ['script let', `let fetch = (url: string) => url; fetch('/local')`],
    ['script var nested in a block', `if (true) { var fetch = (url: string) => url } fetch('/local')`],
    ['script destructuring', `const { fetch } = { fetch: (url: string) => url }; fetch('/local')`],
    ['script renamed binding', `const { request: fetch } = { request: (url: string) => url }; fetch('/local')`],
    ['script nested binding', `const { client: { fetch } } = { client: { fetch: (url: string) => url } }; fetch('/local')`],
    ['local function', `function fetch(url: string) { return url } fetch('/local')`],
    ['script class', `class fetch {}; fetch('/local')`],
    ['script enum', `enum fetch { local }; fetch('/local')`],
    ['script namespace', `namespace fetch { export const local = true }; fetch('/local')`],
    ['function parameter', `export function run(fetch: any) { fetch('/local') }`],
    ['destructured parameter', `export function run({ fetch }: any) { fetch('/local') }`],
    ['block declaration', `export {}; { const fetch = (url: string) => url; fetch('/local') }`],
    ['later local declaration', `export function run() { fetch('/local'); const fetch = (url: string) => url }`],
    ['catch binding', `export {}; try {} catch (fetch) { fetch('/local') }`],
    ['loop binding', `export {}; for (const fetch of []) { fetch('/local') }`],
    ['named function expression', `export const run = function fetch() { fetch('/local') }`],
    ['unrelated import', `import fetch from './not-http'; fetch('/local')`],
    ['import alias', `import { local as fetch } from './not-http'; fetch('/local')`],
  ])('does not classify %s as builtin fetch', (_name, content) => {
    expect(calls(content)).toEqual([])
  })

  it('keeps a builtin call outside an unrelated local block binding', () => {
    expect(calls(`export {};
      { const fetch = (url: string) => url; fetch('/local') }
      function run(fetch: any) { fetch('/parameter') }
      fetch('/builtin')
    `)).toEqual([expect.objectContaining({ url: '/builtin', method: 'GET' })])
  })

  it('does not borrow a global builtin across a script-level fetch variable in another supplied file', () => {
    const response = extractTs([
      { path: 'globals.ts', content: `const fetch = (url: string) => url` },
      { path: 'consumer.ts', content: `export function run() { fetch('/not-proven-builtin') }` },
    ])
    expect(response.apiCalls).toEqual([])
  })

  it('does not let an unrelated module fetch binding suppress a builtin call in another module', () => {
    const response = extractTs([
      { path: 'local.ts', content: `export const fetch = (url: string) => url; fetch('/local')` },
      { path: 'consumer.ts', content: `export function run() { fetch('/builtin') }` },
    ])
    expect(response.apiCalls).toEqual([expect.objectContaining({ url: '/builtin', method: 'GET', filePath: 'consumer.ts' })])
  })

  it('does not trust supplied code merely because its path resembles a compiler default library', () => {
    expect(extractTs([
      { path: 'node_modules/typescript/lib/lib.dom.d.ts', content: `declare function fetch(value: string): number` },
      { path: 'consumer.ts', content: `export function run() { fetch('/local-definition') }` },
    ]).apiCalls).toEqual([])
  })
})

describe('Axios import provenance', () => {
  it('recognizes a real value default import and its alias while preserving literal config calls', () => {
    expect(calls(`import client from 'axios'
      export function run() {
        client.get('/get')
        client.post('/post')
        client({ url: '/default' })
        client({ url: '/patch', method: 'patch' })
      }
    `).map(call => [call.method, call.url])).toEqual([
      ['GET', '/get'], ['POST', '/post'], ['GET', '/default'], ['PATCH', '/patch'],
    ])
  })

  it('recognizes a named default import alias by its declaration', () => {
    expect(calls(`import { default as request } from 'axios'; request.delete('/delete')`))
      .toEqual([expect.objectContaining({ method: 'DELETE', url: '/delete' })])
  })

  it('retains only calls bound to the import when a parameter or inner local shadows the alias', () => {
    expect(calls(`import client from 'axios'
      client.get('/before')
      function run(client: any) { client.get('/parameter'); client({ url: '/parameter-config' }) }
      { const client = { get(url: string) { return url } }; client.get('/block') }
      client.get('/after')
    `).map(call => call.url)).toEqual(['/before', '/after'])
  })

  it.each([
    ['unrelated default import', `import axios from './axios'; axios.get('/local')`],
    ['unrelated named import', `import { request as axios } from './local'; axios.get('/local')`],
    ['type-only default import', `import type axios from 'axios'; axios.get('/type-only')`],
    ['type-only named default import', `import { type default as axios } from 'axios'; axios.get('/type-only')`],
    ['type-only import declaration', `import type { default as axios } from 'axios'; axios.get('/type-only')`],
    ['named Axios class', `import { Axios as axios } from 'axios'; axios.get('/not-static-method')`],
    ['namespace without default member', `import * as axios from 'axios'; axios.get('/not-default')`],
    ['suffix object', `const notaxios = { get() {} }; notaxios.get('/local')`],
    ['unbound name', `axios.get('/unbound')`],
  ])('rejects %s as an Axios default client', (_name, content) => {
    expect(calls(content)).toEqual([])
  })
})

describe('HTTP option uncertainty', () => {
  it.each([
    ['dynamic value', `{ method: selected }`],
    ['method shorthand', `{ method }`],
    ['opaque config', `options`],
    ['unknown spread', `{ ...options }`],
    ['spread after literal', `{ method: 'POST', ...options }`],
    ['computed key after literal', `{ method: 'POST', [key]: 'PUT' }`],
    ['method getter', `{ get method() { return 'POST' } }`],
    ['method declaration', `{ method() { return 'POST' } }`],
    ['prototype method', `{ __proto__: options }`],
    ['interpolated method', "{ method: `P${suffix}` }"],
  ])('keeps %s UNKNOWN while preserving the HTTP URL', (_name, options) => {
    expect(calls(`export {}; fetch('/known-http', ${options})`))
      .toEqual([expect.objectContaining({ method: 'UNKNOWN', url: '/known-http' })])
  })

  it('takes the final explicit own property after a spread or duplicate method', () => {
    expect(calls(`export {};
      fetch('/after-spread', { ...options, method: 'post' })
      fetch('/duplicate', { method: 'GET', method: 'PATCH' })
      fetch('/computed-literal', { ['method']: 'delete' })
      fetch('/empty', {})
      fetch('/headers', { headers: options })
    `).map(call => [call.method, call.url])).toEqual([
      ['POST', '/after-spread'], ['PATCH', '/duplicate'], ['DELETE', '/computed-literal'],
      ['GET', '/empty'], ['GET', '/headers'],
    ])
  })

  it('applies the same method uncertainty and property ordering to imported Axios config', () => {
    expect(calls(`import axios from 'axios'
      axios({ url: '/dynamic', method: selected })
      axios({ ...options, url: '/spread' })
      axios({ url: '/overridden', ...options })
      axios({ ...options, url: '/literal', method: 'put' })
      axios({ url: '/duplicate', method: 'GET', method: 'DELETE' })
    `).map(call => [call.method, call.url])).toEqual([
      ['UNKNOWN', '/dynamic'], ['UNKNOWN', '/spread'], ['PUT', '/literal'], ['DELETE', '/duplicate'],
    ])
  })

  it('preserves the existing URL-template shape without treating an interpolated method as literal', () => {
    expect(calls('export {}; fetch(`/api/items/${id}`, { method: `P${suffix}` })'))
      .toEqual([expect.objectContaining({ method: 'UNKNOWN', url: '/api/items/${id}' })])
  })
})
