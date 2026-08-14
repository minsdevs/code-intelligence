import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractTs } from './ts-extractor'
import { assertSafeRelativePath } from './paths'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../../../backend/src/test/resources/fixtures')

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

  it('rejects parent path segments', () => {
    expect(() => assertSafeRelativePath('../secret.ts')).toThrow(/must not contain/)
  })
})
