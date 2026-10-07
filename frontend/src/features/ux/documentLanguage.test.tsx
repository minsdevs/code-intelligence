import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, useI18n } from '../../lib/i18n'
import LocalSourceApproval from '../projects/LocalSourceApproval'
import RepositoryOverviewPage from '../projects/RepositoryOverviewPage'

// G-UX A18: <html lang> follows the UI language, and English mode renders no hard-coded Korean.
// Text belongs in translations.ts; the only Hangul allowed in product code is the native name of
// the Korean language option, which carries its own lang="ko".

vi.mock('@xyflow/react', () => ({
  ReactFlow: () => null,
  Background: () => null,
  Controls: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
}))
vi.mock('../../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/projects')>()),
  previewLocalProject: vi.fn(async () => ({
    previewToken: 'opaque-token-never-display',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    operation: 'INITIAL',
    sourceName: 'fixture-source',
    snapshotId: null,
    changes: { added: 3, modified: 0, deleted: 0, total: 3 },
    changedPaths: ['src/a.ts'],
    localImport: {
      schemaVersion: 1,
      policyVersion: 'local-ingest-v1',
      acceptedFiles: 3,
      bytesRead: 128,
      excludedEntriesByReason: { GENERATED_DIRECTORY: 1, SECRET_PATH: 1 },
    },
  })),
}))

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/

const sources = import.meta.glob<string>(['../../**/*.{ts,tsx}', '!../../**/*.test.{ts,tsx}', '!../../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

function withoutComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** Visible text plus the names and hints a screen reader reads from attributes. */
function renderedText(root: HTMLElement): string {
  const attributes = [...root.querySelectorAll('[aria-label],[placeholder],[title],[alt],[aria-description]')]
    .filter((element) => element.closest('[lang="ko"]') == null)
    .flatMap((element) => ['aria-label', 'placeholder', 'title', 'alt', 'aria-description'].map((name) => element.getAttribute(name) ?? ''))
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[lang="ko"]').forEach((element) => element.remove())
  return [clone.textContent ?? '', ...attributes].join('\n')
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const node = {
  id: 10, name: 'GET /orders', nodeType: 'API_ENDPOINT', naturalKey: 'module-a:orders',
  filePath: 'a/Orders.ts', lineStart: 12, lineEnd: 14, areaType: 'BACKEND',
}
const snapshot = { id: 1, commitSha: 'abc', status: 'DONE', analyzedAt: '2026-10-01' }

function stubOverviewApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost')
    if (url.pathname === '/api/projects/7') return json({ id: 7, name: 'Orders', currentSnapshot: snapshot })
    if (url.pathname.endsWith('/snapshots')) return json([snapshot])
    if (url.pathname.endsWith('/files')) return json([{ path: 'a/Orders.ts', language: 'TypeScript', size: 80, lineCount: 14 }])
    if (url.pathname.endsWith('/graph/overview')) return json({ resolvedSnapshotId: 1, nodeCounts: { CONTROLLER: 1 }, edgeCounts: { CALLS: 1 } })
    if (url.pathname.endsWith('/graph/nodes')) return json({ resolvedSnapshotId: 1, items: [node], page: 0, size: 40, total: 1 })
    if (url.pathname.endsWith('/graph/nodes/10')) return json({ ...node, resolvedSnapshotId: 1, metadata: {}, evidences: [] })
    if (url.pathname.endsWith('/relations')) {
      return json({ resolvedSnapshotId: 1, nodeId: 10, relations: [], depth: 1, direction: 'in', truncated: false })
    }
    return json({}, 404)
  }))
}

beforeEach(() => {
  window.localStorage.setItem('code-intelligence.lang', 'en')
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.setItem('code-intelligence.lang', 'ko')
})

describe('document language', () => {
  it('keeps hard-coded Korean out of product source', () => {
    const offenders: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith('/lib/translations.ts')) continue
      withoutComments(source).split('\n').forEach((line, index) => {
        if (!HANGUL.test(line)) return
        if (path.endsWith('/lib/i18n-core.ts') && /id: 'ko'/.test(line)) return
        offenders.push(`${path}:${index + 1}: ${line.trim().slice(0, 80)}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('sets <html lang> from the UI language and follows a switch', () => {
    function Switch() {
      const { setLang } = useI18n()
      return <button onClick={() => setLang('ko')}>switch</button>
    }
    render(<I18nProvider><Switch /></I18nProvider>)
    expect(document.documentElement.lang).toBe('en')
    fireEvent.click(screen.getByRole('button', { name: 'switch' }))
    expect(document.documentElement.lang).toBe('ko')
  })

  it('renders the overview, neighborhood and coverage report without Korean in English mode', async () => {
    stubOverviewApi()
    const router = createMemoryRouter(
      [{ path: '/projects/:projectId/overview', element: <RepositoryOverviewPage /> }],
      { initialEntries: ['/projects/7/overview?snapshotId=1&nodeId=10'] },
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <I18nProvider>
        <QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>
      </I18nProvider>,
    )
    await screen.findByText('GET /orders · Check together before changing')
    await screen.findByText(/not evidence of no impact/)
    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
    expect(document.documentElement.lang).toBe('en')
    expect(renderedText(container)).not.toMatch(HANGUL)
  })

  it('renders the local import preview without Korean in English mode', async () => {
    const { container } = render(
      <I18nProvider>
        <LocalSourceApproval source={{ operation: 'INITIAL', path: '/fixture' }} onStarted={vi.fn()} />
      </I18nProvider>,
    )
    expect(renderedText(container)).not.toMatch(HANGUL)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview files to import' }))
    })
    await screen.findByRole('button', { name: 'Import and analyze the reviewed files' })
    expect(renderedText(container)).not.toMatch(HANGUL)
  })
})
