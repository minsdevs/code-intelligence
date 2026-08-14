import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { FileContent, FileListItem, GraphNodePage, GraphNodeSummary, GraphRelationsResponse } from '../../api/types'
import { buildFileTree } from './fileTree'

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')

  function MockEditor({
    value,
    onMount,
  }: {
    value?: string
    onMount?: (
      editor: {
        revealLineInCenter: (line: number) => void
        deltaDecorations: (oldDecorations: string[], decorations: unknown[]) => string[]
      },
      monaco: { Range: new (a: number, b: number, c: number, d: number) => object },
    ) => void
  }) {
    const [revealed, setRevealed] = React.useState<number | null>(null)

    React.useEffect(() => {
      onMount?.(
        {
          revealLineInCenter: (line) => {
            setRevealed(line)
          },
          deltaDecorations: () => ['dec-1'],
        },
        {
          Range: class Range {
            startLineNumber: number
            startColumn: number
            endLineNumber: number
            endColumn: number
            constructor(sl: number, sc: number, el: number, ec: number) {
              this.startLineNumber = sl
              this.startColumn = sc
              this.endLineNumber = el
              this.endColumn = ec
            }
          },
        },
      )
    }, [onMount])

    return React.createElement(
      'div',
      { 'data-testid': 'monaco-editor' },
      revealed != null
        ? React.createElement('span', { 'data-testid': 'revealed-line' }, String(revealed))
        : null,
      React.createElement('pre', null, value),
    )
  }

  return {
    default: MockEditor,
    DiffEditor: () => null,
  }
})

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input
  if (typeof input === 'string') return new URL(input, 'http://localhost')
  return new URL(input.url, 'http://localhost')
}

const files: FileListItem[] = [
  { path: 'README.md', language: 'markdown', size: 120, lineCount: 8 },
  { path: 'assets/logo.png', language: null, size: 2048, lineCount: null },
  { path: 'docs/huge.txt', language: null, size: 2_000_000, lineCount: 40000 },
  { path: 'src/App.java', language: 'java', size: 80, lineCount: 12 },
  { path: 'src/api/TodoController.java', language: 'java', size: 400, lineCount: 40 },
  { path: 'src/service/TodoService.java', language: 'java', size: 300, lineCount: 30 },
]

const contents: Record<string, FileContent> = {
  'README.md': { path: 'README.md', language: 'markdown', content: '# hello' },
  'src/App.java': { path: 'src/App.java', language: 'java', content: 'class App {\n  void main() {}\n}' },
  'src/api/TodoController.java': {
    path: 'src/api/TodoController.java',
    language: 'java',
    content: 'class TodoController {\n  void create() {}\n}',
  },
  'src/service/TodoService.java': {
    path: 'src/service/TodoService.java',
    language: 'java',
    content: 'class TodoService {\n  void save() {}\n}',
  },
}

function node(partial: Partial<GraphNodeSummary> & Pick<GraphNodeSummary, 'id' | 'name' | 'nodeType'>): GraphNodeSummary {
  return {
    naturalKey: partial.naturalKey ?? `java:${partial.name}`,
    filePath: partial.filePath ?? null,
    lineStart: partial.lineStart ?? null,
    lineEnd: partial.lineEnd ?? null,
    areaType: partial.areaType ?? 'BACKEND',
    ...partial,
  }
}

const controllerNodes: GraphNodePage = {
  page: 1,
  size: 100,
  total: 3,
  items: [
    node({
      id: 1,
      name: 'TodoController.java',
      nodeType: 'FILE',
      filePath: 'src/api/TodoController.java',
      naturalKey: 'file:src/api/TodoController.java',
    }),
    node({
      id: 10,
      name: 'TodoController',
      nodeType: 'CLASS',
      filePath: 'src/api/TodoController.java',
      lineStart: 1,
      naturalKey: 'java:com.example.TodoController',
    }),
    node({
      id: 11,
      name: 'create',
      nodeType: 'METHOD',
      filePath: 'src/api/TodoController.java',
      lineStart: 12,
      naturalKey: 'java:com.example.TodoController#create()',
    }),
  ],
}

const serviceNodes: GraphNodePage = {
  page: 1,
  size: 100,
  total: 2,
  items: [
    node({
      id: 20,
      name: 'TodoService',
      nodeType: 'CLASS',
      filePath: 'src/service/TodoService.java',
      lineStart: 1,
      naturalKey: 'java:com.example.TodoService',
    }),
    node({
      id: 21,
      name: 'save',
      nodeType: 'METHOD',
      filePath: 'src/service/TodoService.java',
      lineStart: 14,
      naturalKey: 'java:com.example.TodoService#save()',
    }),
  ],
}

const emptyNodes: GraphNodePage = { page: 1, size: 100, total: 0, items: [] }

const fetchMock = vi.fn()

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/projects/7/files') {
      return jsonResponse(files)
    }
    if (path === '/api/projects/7/file-content') {
      const filePath = url.searchParams.get('path') ?? ''
      if (filePath === 'assets/logo.png') {
        return jsonResponse({ title: 'Unsupported Media Type', detail: 'Binary files cannot be displayed.' }, 415)
      }
      if (filePath === 'docs/huge.txt') {
        return jsonResponse({ title: 'Content Too Large', detail: 'File exceeds the size limit.' }, 413)
      }
      const body = contents[filePath]
      if (!body) return jsonResponse({ title: 'Not Found', detail: filePath }, 404)
      return jsonResponse(body)
    }
    if (path === '/api/projects/7/graph/nodes') {
      const filePath = url.searchParams.get('path')
      if (filePath === 'src/api/TodoController.java') return jsonResponse(controllerNodes)
      if (filePath === 'src/service/TodoService.java') return jsonResponse(serviceNodes)
      return jsonResponse(emptyNodes)
    }
    if (path === '/api/projects/7/graph/nodes/11/relations') {
      const direction = url.searchParams.get('direction')
      const relations: GraphRelationsResponse = {
        nodeId: 11,
        direction: direction ?? 'out',
        depth: 1,
        relations:
          direction === 'in'
            ? [
                {
                  depth: 1,
                  direction: 'in',
                  edgeType: 'CALLS',
                  confidence: 'CONFIRMED',
                  node: node({
                    id: 21,
                    name: 'save',
                    nodeType: 'METHOD',
                    filePath: 'src/service/TodoService.java',
                    lineStart: 14,
                    naturalKey: 'java:com.example.TodoService#save()',
                  }),
                },
              ]
            : [
                {
                  depth: 1,
                  direction: 'out',
                  edgeType: 'CALLS',
                  confidence: 'POSSIBLE',
                  node: node({
                    id: 31,
                    name: 'insert',
                    nodeType: 'METHOD',
                    filePath: 'src/repository/TodoRepository.java',
                    lineStart: 8,
                    naturalKey: 'java:com.example.TodoRepository#insert()',
                  }),
                },
              ],
      }
      return jsonResponse(relations)
    }
    if (path.startsWith('/api/projects/7/graph/nodes/') && path.endsWith('/relations')) {
      return jsonResponse({ nodeId: 0, direction: 'out', depth: 1, relations: [] })
    }
    if (path === '/api/projects/7/areas') {
      return jsonResponse([])
    }
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderCode(entry = '/projects/7/code') {
  const router = createMemoryRouter(routes, { initialEntries: [entry] })
  const view = render(<RouterProvider router={router} />)
  return { router, ...view }
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({
    aiPanelOpen: true,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
    focusedFile: null,
    focusedNode: null,
  })
  fetchMock.mockReset()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildFileTree', () => {
  it('nests directories and sorts dirs before files', () => {
    const tree = buildFileTree(files)
    expect(tree.map((node) => node.name)).toEqual(['assets', 'docs', 'src', 'README.md'])
    const src = tree.find((node) => node.kind === 'dir' && node.name === 'src')
    expect(src?.kind).toBe('dir')
    if (src?.kind === 'dir') {
      expect(src.children.map((child) => child.name)).toEqual(['api', 'service', 'App.java'])
    }
  })
})

describe('CodeExplorerPage', () => {
  it('fetches file content when a tree file is selected', async () => {
    renderCode()

    fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }))
    fireEvent.click(await screen.findByRole('treeitem', { name: 'src/App.java' }))

    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('class App')
    await waitFor(() => {
      const fetched = fetchMock.mock.calls.some((call) => {
        const url = requestUrl(call[0] as RequestInfo | URL)
        return (
          url.pathname === '/api/projects/7/file-content' && url.searchParams.get('path') === 'src/App.java'
        )
      })
      expect(fetched).toBe(true)
    })
    expect(useUiStore.getState().focusedFile).toBe('src/App.java')
  })

  it('reveals the requested line when entering with path and line query', async () => {
    renderCode('/projects/7/code?path=src/App.java&line=2')

    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('class App')
    expect(await screen.findByTestId('revealed-line')).toHaveTextContent('2')
  })

  it('navigates to the caller file and line when a callers item is clicked', async () => {
    const { router } = renderCode('/projects/7/code?path=src/api/TodoController.java')

    fireEvent.click(await screen.findByRole('button', { name: /create/ }))

    fireEvent.click(await screen.findByRole('button', { name: /src\/service\/TodoService.java:14/ }))

    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('path')).toBe('src/service/TodoService.java')
      expect(params.get('line')).toBe('14')
    })
    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('class TodoService')
    expect(useUiStore.getState().focusedNode?.id).toBe(21)
  })

  it('shows guidance for oversized files', async () => {
    renderCode('/projects/7/code?path=docs/huge.txt')
    expect(await screen.findByRole('status')).toHaveTextContent('크기 상한을 초과')
  })

  it('shows guidance for binary files', async () => {
    renderCode('/projects/7/code?path=assets/logo.png')
    expect(await screen.findByRole('status')).toHaveTextContent('바이너리 파일은 미리볼 수 없습니다')
  })
})
