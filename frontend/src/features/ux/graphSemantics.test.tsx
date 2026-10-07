import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchitectureView, GraphNodeSummary } from '../../api/types'
import ArchitectureCanvas from '../architecture/ArchitectureCanvas'
import RepositoryNeighborhood from '../projects/RepositoryNeighborhood'

// G-UX A4: React Flow nodes and edges are keyboard focusable, so each must carry a meaningful
// name (never a database id), a visible focus indicator, an accurate keyboard hint, and Enter
// must do what a click does. The relation table stays the full keyboard alternative (A5).

type FlowItem = { id: string; ariaLabel?: string; source?: string; target?: string }
let flowProps: { nodes: FlowItem[]; edges: FlowItem[]; ariaLabelConfig?: Record<string, string> } | null = null

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: {
    nodes: FlowItem[]
    edges: FlowItem[]
    ariaLabelConfig?: Record<string, string>
    children?: ReactNode
  }) => {
    flowProps = props
    return (
      <div data-testid="flow">
        {props.nodes.map((node) => (
          <div key={node.id} className="react-flow__node" data-id={node.id} tabIndex={0} aria-label={node.ariaLabel} role="group" />
        ))}
        {props.edges.map((edge) => (
          <div key={edge.id} className="react-flow__edge" data-id={edge.id} tabIndex={0} aria-label={edge.ariaLabel} role="group" />
        ))}
      </div>
    )
  },
  Background: () => null,
  Controls: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
}))
vi.mock('elkjs/lib/elk-worker.min.js?worker', () => ({ default: class ElkWorker {} }))
vi.mock('elkjs/lib/elk-api.js', () => ({
  default: class ELK {
    layout<T>(graph: T): Promise<T> {
      return Promise.resolve(graph)
    }
  },
}))

const fsModule = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync: (path: string, encoding: 'utf8') => string
}
const { dirname } = import.meta as ImportMeta & { dirname: string }
const stylesheet = readFileSync(`${dirname}/../../index.css`, 'utf8')

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const DB_ID_NAME = /^(Edge from|node:|\d+$)|\bnode:\d+/

beforeEach(() => {
  flowProps = null
  window.localStorage.setItem('code-intelligence.lang', 'en')
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.setItem('code-intelligence.lang', 'ko')
})

describe('relation graph keyboard semantics', () => {
  const selected: GraphNodeSummary = {
    id: 79, nodeType: 'API_ENDPOINT', naturalKey: 'orders', name: 'GET /orders',
    filePath: 'api/OrderController.java', lineStart: 12, lineEnd: 20, areaType: 'BACKEND',
  }
  const caller: GraphNodeSummary = {
    id: 22, nodeType: 'COMPONENT', naturalKey: 'list', name: 'OrderList',
    filePath: 'web/OrderList.tsx', lineStart: 3, lineEnd: 30, areaType: 'FRONTEND',
  }

  it('names neighbourhood nodes and edges by item, relation type and verdict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      resolvedSnapshotId: 1, nodeId: 79, depth: 1, direction: 'in', truncated: false,
      relations: [{ sourceNodeId: 22, targetNodeId: 79, depth: 1, direction: 'in', edgeType: 'CALLS_HTTP', confidence: 'LIKELY', node: caller }],
    }), { headers: { 'Content-Type': 'application/json' } })))
    const onSelect = vi.fn()
    wrap(<RepositoryNeighborhood projectId={7} snapshotId={1} selected={selected} onSelect={onSelect} edgeTypes={['CALLS_HTTP']} />)
    const flow = await screen.findByTestId('flow')
    const edge = flow.querySelector('.react-flow__edge')!
    expect(edge).toHaveAttribute('aria-label', 'OrderList → GET /orders · CALLS_HTTP · Inferred (LIKELY)')
    const names = [...flow.querySelectorAll('[aria-label]')].map((element) => element.getAttribute('aria-label')!)
    expect(names).toContain('GET /orders · api/OrderController.java · selected item')
    expect(names).toContain('OrderList · web/OrderList.tsx')
    expect(names.filter((name) => DB_ID_NAME.test(name))).toEqual([])
    expect(flowProps?.ariaLabelConfig?.['node.a11yDescription.default']).toMatch(/Enter/)
    expect(flowProps?.ariaLabelConfig?.['edge.a11yDescription.default']).not.toMatch(/delete|remove/i)

    const callerNode = within(flow).getByRole('group', { name: 'OrderList · web/OrderList.tsx' })
    fireEvent.keyDown(callerNode, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(caller)
  })

  it('names architecture nodes, layers and edges without database ids', async () => {
    const view: ArchitectureView = {
      area: 'BACKEND',
      groups: [
        { layer: 'CONTROLLER', nodes: [{ id: 79, name: 'OrderController', nodeType: 'CONTROLLER', filePath: 'api/OrderController.java', line: 5 }] },
        { layer: 'SERVICE', nodes: [{ id: 22, name: 'OrderService', nodeType: 'SERVICE', filePath: 'api/OrderService.java', line: 9 }] },
      ],
      edges: [{ sourceGroup: 'CONTROLLER', targetGroup: 'SERVICE', sourceNodeId: 79, targetNodeId: 22, count: 3 }],
    }
    const onOpenNode = vi.fn()
    wrap(<ArchitectureCanvas view={view} onOpenNode={onOpenNode} />)
    const flow = await screen.findByTestId('flow')
    await waitFor(() => expect(flow.querySelector('.react-flow__edge')).not.toBeNull())
    expect(flow.querySelector('.react-flow__edge')).toHaveAttribute('aria-label', 'OrderController → OrderService · 3 relations')
    const names = [...flow.querySelectorAll('[aria-label]')].map((element) => element.getAttribute('aria-label')!)
    expect(names).toEqual(expect.arrayContaining([
      'CONTROLLER layer',
      'OrderController · CONTROLLER · api/OrderController.java',
      'OrderService · SERVICE · api/OrderService.java',
    ]))
    expect(names.filter((name) => DB_ID_NAME.test(name))).toEqual([])

    fireEvent.keyDown(within(flow).getByRole('group', { name: 'OrderService · SERVICE · api/OrderService.java' }), { key: 'Enter' })
    expect(onOpenNode).toHaveBeenCalledWith('api/OrderService.java', 9)
  })

  it('keeps a visible focus indicator on graph edges and nodes', () => {
    expect(stylesheet).toMatch(/\.react-flow \.react-flow__edge:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--color-accent\)/)
    expect(stylesheet).toMatch(/\.react-flow \.react-flow__edge:focus-visible \.react-flow__edge-path\s*\{[^}]*stroke:\s*var\(--color-accent\)/)
    expect(stylesheet).toMatch(/\.react-flow \.react-flow__node:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-accent\)/)
  })
})
