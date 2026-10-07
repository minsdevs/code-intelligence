import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../stores/uiStore'

// Every product source file under src/ as raw text (Vite resolves this at transform time, so the
// app tsconfig needs no Node types). Test files and test/ helpers are not product sinks.
const productSources = import.meta.glob<string>(
  ['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../**/test/**'],
  { query: '?raw', import: 'default', eager: true },
)

// G-SEC stored-XSS boundary (05 §2: source/Markdown escaped and sanitised). Repository names,
// file paths, commit/PR metadata and AI responses are attacker-controlled strings. They must be
// rendered as text: no element, attribute, script or javascript: URL may come from them.
vi.mock('@monaco-editor/react', () => ({
  default: () => null,
  DiffEditor: ({ original, modified }: { original?: string; modified?: string }) => (
    <div>
      <pre>{original}</pre>
      <pre>{modified}</pre>
    </div>
  ),
}))

const MARK = 'gate-sec-xss'
const PAYLOADS = [
  `<img src=x onerror="window.__gateSecXss='${MARK}-img'">`,
  `<script>window.__gateSecXss='${MARK}-script'</script>`,
  `"><svg onload="window.__gateSecXss='${MARK}-svg'">`,
  `javascript:window.__gateSecXss='${MARK}-url'`,
  `[click](javascript:window.__gateSecXss='${MARK}-md') <a href="javascript:alert(1)">x</a>`,
  `<iframe srcdoc="<script>parent.__gateSecXss=1</script>"></iframe>`,
]
const payload = (index: number) => PAYLOADS[index % PAYLOADS.length]

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input
  if (typeof input === 'string') return new URL(input, 'http://localhost')
  return new URL(input.url, 'http://localhost')
}

const sha = 'a'.repeat(40)
const pulls = [
  { number: 12, title: payload(0), body: payload(4), state: 'open', author: payload(2), mergedAt: null, headSha: sha, baseSha: 'b'.repeat(40) },
]
const review = {
  id: 1,
  pullNumber: 12,
  summary: `${payload(1)} ${payload(4)}`,
  origin: 'AI',
  createdAt: '2026-08-14T00:00:00Z',
  comments: [
    { id: 9, seq: 1, filePath: `src/${payload(2)}.java`, line: 1, severity: 'WARNING', body: payload(0),
      confidence: 'CONFIRMED', evidence: [`file:src/${payload(3)}:1`] },
  ],
}
const commits = PAYLOADS.map((text, index) => ({
  sha: `${index}`.padStart(40, '0'), author: payload(index + 1), message: `${text}\n\n${payload(index + 2)}`,
  committedAt: '2026-01-01T00:00:00Z', additions: 1, deletions: 0,
}))
const commitDetail = { ...commits[0], files: [{ path: `src/${payload(0)}`, changeType: 'MODIFY' }, { path: payload(3), changeType: 'ADD' }] }

const fetchMock = vi.fn()
function installFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestUrl(input).pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'mock' })
    if (path === '/api/csrf') return new Response(null, { status: 204 })
    if (path === '/api/projects/7/pulls') return jsonResponse(pulls)
    if (path === '/api/projects/7/pulls/12/review' && method === 'GET') return jsonResponse(review)
    if (path === '/api/projects/7/commits') return jsonResponse(commits)
    if (path === `/api/projects/7/commits/${commits[0].sha}`) return jsonResponse(commitDetail)
    if (path.startsWith(`/api/projects/7/commits/${commits[0].sha}/diff`))
      return jsonResponse({ changeType: 'MODIFY', oldContent: payload(1), newContent: payload(0) })
    if (path === '/api/projects/7/branches') return jsonResponse([{ name: payload(2), headSha: commits[0].sha }])
    if (path === '/api/projects/7/areas') return jsonResponse([])
    if (path === '/api/projects/7/eras') return jsonResponse([])
    return jsonResponse({ title: 'Not Found', detail: path }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function assertInert() {
  expect((window as unknown as { __gateSecXss?: unknown }).__gateSecXss).toBeUndefined()
  expect(document.querySelectorAll('script, iframe, svg[onload], img[onerror], [srcdoc]').length).toBe(0)
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.name.startsWith('on'), `${element.tagName} ${attribute.name}`).toBe(false)
      if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(attribute.name)) {
        expect(attribute.value.trim().toLowerCase().startsWith('javascript:'), `${attribute.name}=${attribute.value}`).toBe(false)
      }
    }
  }
}

beforeEach(() => {
  window.localStorage.clear()
  useUiStore.setState({ aiPanelOpen: false, aiPanelWidth: AI_PANEL_DEFAULT_WIDTH, selectedAreas: [] })
  fetchMock.mockReset()
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { __gateSecXss?: unknown }).__gateSecXss
})

describe('security: attacker-controlled strings render as inert text', () => {
  it('AI review text, file paths and pull-request metadata never become markup or script URLs', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/review'] })
    render(<RouterProvider router={router} />)
    expect(await screen.findByText((text) => text.includes(`window.__gateSecXss='${MARK}-script'`))).toBeInTheDocument()
    assertInert()
  })

  it('commit messages, authors, branch names and changed-file paths never become markup', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/projects/7/history'] })
    render(<RouterProvider router={router} />)
    expect((await screen.findAllByText((text) => text.includes(`${MARK}-img`))).length).toBeGreaterThan(0)
    assertInert()
  })

  it('product source has no raw-HTML, eval or document-write sink for untrusted strings', () => {
    const sinks = /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|new Function\(|\beval\(|srcDoc=|createContextualFragment/
    const files = Object.entries(productSources)
    expect(files.length).toBeGreaterThan(50)
    const offenders = files.filter(([, text]) => sinks.test(text)).map(([file]) => file.replace(/^\.\.\//, ''))
    expect(offenders).toEqual([])
  })
})
