import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'
import type { ArchitectureView, ProjectArea } from '../../api/types'

vi.mock('@monaco-editor/react', () => ({
  default: () => null,
  DiffEditor: () => null,
}))

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({
    nodes,
    onNodeClick,
  }: {
    nodes: Array<{
      id: string
      data: { label: string; filePath: string | null; line: number | null; kind: 'node' | 'group' }
    }>
    onNodeClick?: (event: unknown, node: unknown) => void
  }) => (
    <div data-testid="architecture-flow">
      <span data-testid="group-count">{String(nodes.filter((node) => node.data.kind === 'group').length)}</span>
      <span data-testid="node-count">{String(nodes.filter((node) => node.data.kind === 'node').length)}</span>
      {nodes
        .filter((node) => node.data.kind === 'node')
        .map((node) => (
          <button key={node.id} type="button" onClick={(event) => onNodeClick?.(event, node)}>
            {node.data.label}
          </button>
        ))}
    </div>
  ),
  Background: () => null,
  Controls: () => null,
}))

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

function area(partial: Pick<ProjectArea, 'areaType' | 'selected'>): ProjectArea {
  return {
    confidence: 0.9,
    technologies: [],
    evidences: [],
    ...partial,
  }
}

const backendView: ArchitectureView = {
  area: 'BACKEND',
  groups: [
    {
      layer: 'CONTROLLER',
      nodes: [
        {
          id: 1,
          name: 'TodoController',
          nodeType: 'CLASS',
          filePath: 'src/api/TodoController.java',
          line: 12,
        },
      ],
    },
    {
      layer: 'SERVICE',
      nodes: [
        {
          id: 2,
          name: 'TodoService',
          nodeType: 'CLASS',
          filePath: 'src/service/TodoService.java',
          line: 8,
        },
      ],
    },
  ],
  edges: [
    {
      sourceGroup: 'CONTROLLER',
      targetGroup: 'SERVICE',
      sourceNodeId: null,
      targetNodeId: null,
      count: 3,
    },
  ],
}

const frontendView: ArchitectureView = {
  area: 'FRONTEND',
  groups: [
    {
      layer: 'PAGE',
      nodes: [
        {
          id: 20,
          name: 'TodosPage',
          nodeType: 'FE_ROUTE',
          filePath: 'src/pages/TodosPage.tsx',
          line: 1,
        },
      ],
    },
  ],
  edges: [],
}

const systemView: ArchitectureView = {
  area: 'SYSTEM',
  groups: [
    {
      layer: 'CONTAINER',
      nodes: [
        {
          id: 10,
          name: 'api',
          nodeType: 'CONTAINER',
          filePath: 'docker-compose.yml',
          line: 4,
        },
      ],
    },
  ],
  edges: [],
}

const fetchMock = vi.fn()

function installFetch(areas: ProjectArea[]) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    const path = url.pathname
    if (path === '/api/projects/7/areas') {
      return jsonResponse(areas)
    }
    if (path === '/api/projects/7/architecture') {
      const requested = url.searchParams.get('area')
      if (requested === 'BACKEND') return jsonResponse(backendView)
      if (requested === 'FRONTEND') return jsonResponse(frontendView)
      if (requested === 'SYSTEM') return jsonResponse(systemView)
    }
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderArchitecture() {
  const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/architecture'] })
  return { router, ...render(<RouterProvider router={router} />) }
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({
    aiPanelOpen: true,
    aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
    selectedAreas: [],
  })
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ArchitecturePage', () => {
  it('renders the mocked projection with group and node counts', async () => {
    installFetch([area({ areaType: 'BACKEND', selected: true })])
    renderArchitecture()

    expect(await screen.findByTestId('architecture-flow')).toBeInTheDocument()
    expect(screen.getByTestId('group-count')).toHaveTextContent('2')
    expect(screen.getByTestId('node-count')).toHaveTextContent('2')
    expect(screen.getByRole('button', { name: 'TodoController' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'TodoService' })).toBeInTheDocument()
  })

  it('navigates to the code tab with path and line when a node is clicked', async () => {
    installFetch([area({ areaType: 'BACKEND', selected: true })])
    const { router } = renderArchitecture()

    fireEvent.click(await screen.findByRole('button', { name: 'TodoController' }))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/7/code')
      expect(router.state.location.search).toBe('?path=src%2Fapi%2FTodoController.java&line=12')
    })
  })

  it('hides architecture area tabs that are not selected', async () => {
    installFetch([
      area({ areaType: 'BACKEND', selected: true }),
      area({ areaType: 'INFRASTRUCTURE', selected: false }),
      area({ areaType: 'DEVOPS', selected: false }),
    ])
    renderArchitecture()

    expect(await screen.findByRole('tab', { name: 'Backend' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'System' })).not.toBeInTheDocument()
  })

  it('shows only the System tab when infrastructure is selected', async () => {
    installFetch([
      area({ areaType: 'BACKEND', selected: false }),
      area({ areaType: 'INFRASTRUCTURE', selected: true }),
    ])
    renderArchitecture()

    expect(await screen.findByRole('tab', { name: 'System' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Backend' })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'api' })).toBeInTheDocument()
    await waitFor(() => {
      const architectureCalls = fetchMock.mock.calls.filter((call) => {
        const url = requestUrl(call[0] as RequestInfo | URL)
        return url.pathname === '/api/projects/7/architecture'
      })
      expect(architectureCalls.length).toBeGreaterThan(0)
      expect(requestUrl(architectureCalls[0]![0] as RequestInfo | URL).searchParams.get('area')).toBe(
        'SYSTEM',
      )
    })
  })

  it('shows the Frontend tab when frontend is selected', async () => {
    installFetch([
      area({ areaType: 'BACKEND', selected: false }),
      area({ areaType: 'FRONTEND', selected: true }),
    ])
    renderArchitecture()

    expect(await screen.findByRole('tab', { name: 'Frontend' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Backend' })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'TodosPage' })).toBeInTheDocument()
    await waitFor(() => {
      const architectureCalls = fetchMock.mock.calls.filter((call) => {
        const url = requestUrl(call[0] as RequestInfo | URL)
        return url.pathname === '/api/projects/7/architecture'
      })
      expect(architectureCalls.length).toBeGreaterThan(0)
      expect(requestUrl(architectureCalls[0]![0] as RequestInfo | URL).searchParams.get('area')).toBe(
        'FRONTEND',
      )
    })
  })

  it('shows an empty state when no architecture area is selected', async () => {
    installFetch([
      area({ areaType: 'BACKEND', selected: false }),
      area({ areaType: 'FRONTEND', selected: false }),
    ])
    renderArchitecture()

    expect(await screen.findByText('표시할 영역이 없습니다')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Backend' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Frontend' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'System' })).not.toBeInTheDocument()
  })
})
