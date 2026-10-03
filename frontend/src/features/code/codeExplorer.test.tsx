import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { FileContent, FileListItem, GraphNodePage, GraphNodeSummary, GraphRelationsResponse } from '../../api/types'
import { buildFileTree } from './fileTree'

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')

  function MockEditor({
    value,
    path,
    onMount,
  }: {
    value?: string
    path?: string
    onMount?: (
      editor: {
        revealLineInCenter: (line: number) => void
        deltaDecorations: (oldDecorations: string[], decorations: unknown[]) => string[]
      },
      monaco: { Range: new (a: number, b: number, c: number, d: number) => object },
    ) => void
  }) {
    const [revealed, setRevealed] = React.useState<number | null>(null)
    const [highlighted, setHighlighted] = React.useState<number[]>([])

    React.useEffect(() => {
      onMount?.(
        {
          revealLineInCenter: (line) => {
            setRevealed(line)
          },
          deltaDecorations: (_oldDecorations, decorations) => {
            setHighlighted(decorations.map((decoration) => (decoration as { range: { startLineNumber: number } }).range.startLineNumber))
            return decorations.map((_, index) => `dec-${index}`)
          },
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
      { 'data-testid': 'monaco-editor', 'data-model-path': path },
      revealed != null
        ? React.createElement('span', { 'data-testid': 'revealed-line' }, String(revealed))
        : null,
      ...highlighted.map((line) => React.createElement('span', { key: line, 'data-testid': 'highlighted-line' }, String(line))),
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

const sourceMeta = { resolvedSnapshotId: 70, contentOid: 'a'.repeat(40), sourceState: 'AVAILABLE' as const,
  snapshotTime: '2026-10-02T00:00:00Z', currentSnapshot: true, evidenceState: null }

const contents: Record<string, FileContent> = {
  'README.md': { ...sourceMeta, path: 'README.md', language: 'markdown', content: '# hello' },
  'src/App.java': { ...sourceMeta, path: 'src/App.java', language: 'java', content: 'class App {\n  void main() {}\n}' },
  'src/api/TodoController.java': {
    ...sourceMeta,
    path: 'src/api/TodoController.java',
    language: 'java',
    content: 'class TodoController {\n  void create() {}\n}',
  },
  'src/service/TodoService.java': {
    ...sourceMeta,
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
let fileContentOverride: ((url: URL) => Response | Promise<Response> | undefined) | undefined

function fileRequests(): URL[] {
  return fetchMock.mock.calls
    .map((call) => requestUrl(call[0] as RequestInfo | URL))
    .filter((url) => url.pathname.endsWith('/file-content'))
}

function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/projects/7') return jsonResponse({ id: 7, name: 'fixture', currentSnapshot: { id: 70 } })
    if (path === '/api/projects/7/snapshots') return jsonResponse([
      { id: 69, status: 'READY', analyzedAt: '2026-10-01T00:00:00Z' },
      { id: 70, status: 'READY', analyzedAt: '2026-10-02T00:00:00Z' },
    ])
    if (path === '/api/projects/7/files') {
      return jsonResponse(files)
    }
    if (path === '/api/projects/7/file-content') {
      const overridden = fileContentOverride?.(url)
      if (overridden !== undefined) return overridden
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
  fileContentOverride = undefined
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
    const { router } = renderCode()

    fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }))
    fireEvent.click(await screen.findByRole('treeitem', { name: 'src/App.java' }))

    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('class App')
    await waitFor(() => {
      const fetched = fetchMock.mock.calls.some((call) => {
        const url = requestUrl(call[0] as RequestInfo | URL)
        return (
          url.pathname === '/api/projects/7/file-content' && url.searchParams.get('path') === 'src/App.java'
          && url.searchParams.get('snapshotId') === '70'
        )
      })
      expect(fetched).toBe(true)
    })
    expect(useUiStore.getState().focusedFile).toBe('src/App.java')
    const params = new URLSearchParams(router.state.location.search)
    expect(params.get('sourceContext')).toBe('snapshot')
    expect(params.get('snapshotId')).toBe('70')
  })

  it('reveals the requested line when entering with path and line query', async () => {
    renderCode('/projects/7/code?path=src/App.java&line=2')

    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('class App')
    expect(await screen.findByTestId('revealed-line')).toHaveTextContent('2')
    expect(screen.getByTestId('highlighted-line')).toHaveTextContent('2')
  })

  it('opens the caller snapshot without applying an unverified historical line', async () => {
    const { router } = renderCode('/projects/7/code?path=src/api/TodoController.java')

    fireEvent.click(await screen.findByRole('button', { name: /create/ }))

    fireEvent.click(await screen.findByRole('button', { name: /src\/service\/TodoService.java:14/ }))

    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('path')).toBe('src/service/TodoService.java')
      expect(params.get('line')).toBeNull()
      expect(params.get('snapshotId')).toBe('70')
      expect(params.get('sourceContext')).toBe('evidence')
    })
    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('class TodoService')
    expect(screen.getByText(/LEGACY_SOURCE_UNVERIFIED/)).toBeInTheDocument()
    expect(screen.queryByTestId('highlighted-line')).not.toBeInTheDocument()
    expect(useUiStore.getState().focusedNode?.id).toBe(21)
  })

  it('keeps graph symbols unverified after leaving a feature evidence link', async () => {
    const { router } = renderCode('/projects/7/code?path=src/api/TodoController.java&line=1&snapshotId=70&evidenceId=901&sourceContext=evidence')

    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('class TodoController')
    expect(screen.getByText(/LEGACY_SOURCE_UNVERIFIED/)).toBeInTheDocument()
    expect(screen.queryByTestId('highlighted-line')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /^TodoController/ }))

    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search)
      expect(params.get('snapshotId')).toBe('70')
      expect(params.get('sourceContext')).toBe('evidence')
      expect(params.get('evidenceId')).toBeNull()
    })
    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('class TodoController')
    expect(screen.getByText(/LEGACY_SOURCE_UNVERIFIED/)).toBeInTheDocument()
    expect(screen.queryByTestId('highlighted-line')).not.toBeInTheDocument()
  })

  it.each(['./src/App.java', 'src//App.java', 'src/./App.java', 'src\\App.java'])(
    'opens a current-source link with harmless relative spelling: %s',
    async (path) => {
      renderCode(`/projects/7/code?${new URLSearchParams({ path, sourceContext: 'current' })}`)

      expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('class App')
      expect(screen.getByTestId('source-context')).toHaveTextContent('현재 소스')
      expect(fileRequests()).not.toHaveLength(0)
      for (const request of fileRequests()) {
        expect(request.searchParams.get('path')).toBe('src/App.java')
        expect(request.searchParams.get('snapshotId')).toBe('70')
      }
      expect(screen.queryByTestId('source-unavailable')).not.toBeInTheDocument()
    },
  )

  it.each(['../src/App.java', 'src/../App.java', '/src/App.java', 'C:\\src\\App.java', 'src/%2e%2e/App.java'])(
    'preserves unsafe input for server rejection: %s',
    async (path) => {
      fileContentOverride = () => jsonResponse({ detail: 'Invalid source path' }, 400)
      renderCode(`/projects/7/code?${new URLSearchParams({ path, line: '2', sourceContext: 'current' })}`)

      expect(await screen.findByText('Invalid source path')).toBeInTheDocument()
      expect(fileRequests()).not.toHaveLength(0)
      for (const request of fileRequests()) expect(request.searchParams.get('path')).toBe(path)
      expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument()
      expect(screen.queryByTestId('highlighted-line')).not.toBeInTheDocument()
    },
  )

  it.each([
    ['evidence', null],
    ['snapshot', null],
    ['evidence', ''],
    ['snapshot', ''],
    ['evidence', '0'],
    ['snapshot', '-1'],
    ['evidence', '9007199254740992'],
    ['snapshot', 'invalid'],
  ])('treats %s context with snapshot %s as unknown', async (sourceContext, snapshotId) => {
    const params = new URLSearchParams({ path: 'src/App.java', line: '2', sourceContext: sourceContext! })
    if (snapshotId != null) params.set('snapshotId', snapshotId)
    const { router } = renderCode(`/projects/7/code?${params}`)

    expect(await screen.findByTestId('source-unavailable')).toHaveTextContent('SOURCE_CONTEXT_UNKNOWN')
    await screen.findByRole('heading', { name: 'fixture' })
    expect(fileRequests()).toHaveLength(0)
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('highlighted-line')).not.toBeInTheDocument()
    expect(new URLSearchParams(router.state.location.search).get('sourceContext')).toBe(sourceContext)
  })

  it('hides existing source and highlights until unknown evidence explicitly opens current source', async () => {
    const { router } = renderCode('/projects/7/code?path=src/App.java&line=2&sourceContext=current')
    expect(await screen.findByTestId('highlighted-line')).toHaveTextContent('2')
    const requestCount = fileRequests().length

    await act(async () => {
      await router.navigate('/projects/7/code?path=src/App.java&line=2&snapshotId=70&sourceContext=unknown')
    })
    expect(await screen.findByTestId('source-unavailable')).toHaveTextContent('SOURCE_CONTEXT_UNKNOWN')
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('highlighted-line')).not.toBeInTheDocument()
    expect(fileRequests()).toHaveLength(requestCount)

    fireEvent.click(screen.getByRole('button', { name: /Open current source/ }))
    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('class App')
    const params = new URLSearchParams(router.state.location.search)
    expect(params.get('sourceContext')).toBe('current')
    expect(params.get('line')).toBeNull()
    expect(screen.queryByTestId('highlighted-line')).not.toBeInTheDocument()
  })

  it.each([
    { mismatch: 'snapshot', change: { resolvedSnapshotId: 71 } },
    { mismatch: 'path', change: { path: 'src/Other.java' } },
  ])('hides source whose response $mismatch does not match the request', async ({ change }) => {
    fileContentOverride = () => jsonResponse({ ...contents['src/App.java'], ...change, content: 'MISMATCHED SOURCE' })
    renderCode('/projects/7/code?path=src/App.java&line=2&snapshotId=70&sourceContext=snapshot')

    expect(await screen.findByTestId('source-unavailable')).toHaveTextContent('EVIDENCE_STALE')
    expect(screen.queryByText('MISMATCHED SOURCE')).not.toBeInTheDocument()
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('highlighted-line')).not.toBeInTheDocument()
  })

  it.each([
    { status: 409, code: 'EVIDENCE_STALE' },
    { status: 410, code: 'SOURCE_UNAVAILABLE' },
  ])('clears previously displayed source and highlights on $status $code', async ({ status, code }) => {
    const { router } = renderCode('/projects/7/code?path=src/App.java&line=2&sourceContext=current')
    expect(await screen.findByTestId('highlighted-line')).toHaveTextContent('2')
    fileContentOverride = () => jsonResponse({ code, detail: 'Snapshot source cannot be read' }, status)

    await act(async () => {
      await router.navigate('/projects/7/code?path=src/App.java&line=2&snapshotId=69&sourceContext=snapshot')
    })
    expect(await screen.findByTestId('source-unavailable')).toHaveTextContent(code)
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('highlighted-line')).not.toBeInTheDocument()
    expect(screen.queryByText(/class App/)).not.toBeInTheDocument()
  })

  it('keeps current bytes after a delayed historical response and separates the models when switching back', async () => {
    let releaseOld!: (response: Response) => void
    const delayedOld = new Promise<Response>((resolve) => { releaseOld = resolve })
    const oldContent = { ...contents['src/App.java'], resolvedSnapshotId: 69, contentOid: 'b'.repeat(40), currentSnapshot: false, content: 'class Historical_A {}' }
    const currentContent = { ...contents['src/App.java'], content: 'class Current_B {}' }
    let holdOldOnce = true
    fileContentOverride = (url) => {
      if (url.searchParams.get('snapshotId') === '69') {
        if (holdOldOnce) {
          holdOldOnce = false
          return delayedOld
        }
        return jsonResponse(oldContent)
      }
      return jsonResponse(currentContent)
    }
    const { router } = renderCode('/projects/7/code?path=src/App.java&snapshotId=69&sourceContext=snapshot')
    await waitFor(() => expect(fileRequests().some((url) => url.searchParams.get('snapshotId') === '69')).toBe(true))

    await act(async () => { await router.navigate('/projects/7/code?path=src/App.java&sourceContext=current') })
    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('Current_B')
    expect(screen.getByTestId('monaco-editor')).toHaveAttribute('data-model-path', expect.stringContaining('snapshot://7/70/'))
    await act(async () => { releaseOld(jsonResponse(oldContent)) })
    expect(screen.getByTestId('monaco-editor')).toHaveTextContent('Current_B')
    expect(screen.queryByText(/Historical_A/)).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Source snapshot' }), { target: { value: '69' } })
    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('Historical_A')
    expect(screen.getByTestId('monaco-editor')).toHaveAttribute('data-model-path', expect.stringContaining('snapshot://7/69/'))
    expect(screen.queryByText(/Current_B/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Source snapshot' }), { target: { value: 'current' } })
    expect(await screen.findByTestId('monaco-editor')).toHaveTextContent('Current_B')
    expect(screen.queryByText(/Historical_A/)).not.toBeInTheDocument()
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
