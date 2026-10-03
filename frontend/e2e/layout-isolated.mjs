// Run: node frontend/e2e/layout-isolated.mjs before|after [preserved-source-snapshot]
// Builds a fresh source snapshot; never loads project env/config or proxies an API.
import assert from 'node:assert/strict'
import { mkdtemp, cp, mkdir, symlink, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium, expect } from '@playwright/test'

const phase = process.argv[2]
assert.ok(['before', 'after'].includes(phase), 'Specify before or after')
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputSource = process.argv[3] ? resolve(process.argv[3]) : frontend
const run = await mkdtemp(resolve(tmpdir(), `ci-layout-${phase}-`))
const source = resolve(run, 'source')
const dist = resolve(run, 'dist')
await mkdir(source)
for (const item of ['src', 'index.html', 'package.json']) {
  await cp(resolve(inputSource, item), resolve(source, item), { recursive: true })
}
await symlink(resolve(frontend, 'node_modules'), resolve(source, 'node_modules'), 'dir')
console.log(`LAYOUT_RUN=${run}`)
await build({
  root: source,
  configFile: false,
  envFile: false,
  plugins: [react(), tailwindcss()],
  server: { proxy: {} },
  preview: { proxy: {} },
  build: { outDir: dist, emptyOutDir: false },
  logLevel: 'warn',
})

const path = `src/very-long-directory-for-layout-verification/${'LongSourceName'.repeat(6)}.ts`
const project = {
  id: 7,
  name: `Layout fixture ${'LongProjectName'.repeat(10)}`,
  sourceType: 'GITHUB',
  repoOwner: 'fixture',
  repoName: 'layout',
  defaultBranch: 'main',
  sourceAddress: 'fixture/layout',
  currentSnapshot: {
    id: 1,
    status: 'READY',
    analyzedAt: '2026-01-01T00:00:00Z',
    commitSha: 'a'.repeat(40),
  },
  latestJob: null,
  selectedAreas: [],
  topTechnologies: [],
  latestCommit: null,
  latestPull: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}
const flows = Array.from({ length: 45 }, (_, index) => ({
  id: index + 1,
  name: `${index === 0 ? 'Layout flow' : `Flow ${index + 1}`} ${'LongFlowName'.repeat(8)}`,
  kind: 'BACKEND',
  entryNodeId: 1,
}))
const detail = (id) => ({
  ...flows[id - 1],
  steps: Array.from({ length: 18 }, (_, index) => ({
    seq: index + 1,
    nodeId: index + 1,
    nodeName: `${'LongServiceMethod'.repeat(6)}${index}`,
    nodeType: 'METHOD',
    filePath: path,
    line: index + 1,
    description: `Synthetic step ${index + 1}: ${'LongDescription'.repeat(9)}`,
  })),
  evidences: [{ filePath: path, lineStart: 1, lineEnd: 2, excerpt: 'Synthetic source evidence' }],
})
const budget = {
  available: false,
  state: 'OFF',
  policyRevision: '0',
  activationToken: null,
  dailyLimitMicroUsd: '0',
  monthlyLimitMicroUsd: '0',
  allDatesHeldMicroUsd: '0',
  dailySettledMicroUsd: '0',
  monthlySettledMicroUsd: '0',
  supportedModels: [],
}
function mock(url) {
  const endpoint = url.pathname
  if (endpoint === '/api/projects') return [project]
  if (endpoint === '/api/projects/7') return project
  if (endpoint === '/api/projects/7/areas') return []
  if (endpoint === '/api/ai/status') return { configured: false, provider: null, model: null }
  if (endpoint === '/api/ai/budget') return budget
  if (endpoint === '/api/auth/me')
    return { authenticated: false, login: null, credentialKind: null, oauthAvailable: false }
  if (endpoint === '/api/projects/7/flows') return flows
  if (/^\/api\/projects\/7\/flows\/\d+$/.test(endpoint))
    return detail(Number(endpoint.split('/').at(-1)))
  if (endpoint === '/api/projects/7/snapshots') return [project.currentSnapshot]
  if (endpoint === '/api/projects/7/files')
    return [{ path, language: 'TYPESCRIPT', size: 100, lineCount: 30, resolvedSnapshotId: 1 }]
  if (endpoint === '/api/projects/7/graph/nodes') return { items: [], page: 0, size: 0, total: 0 }
  if (endpoint === '/api/projects/7/file-content')
    return {
      resolvedSnapshotId: 1,
      contentOid: 'b'.repeat(40),
      sourceState: 'AVAILABLE',
      snapshotTime: '2026-01-01T00:00:00Z',
      currentSnapshot: true,
      evidenceState: null,
      path,
      language: 'TYPESCRIPT',
      content: Array.from(
        { length: 30 },
        (_, index) => `export const fixture${index} = '${'long code '.repeat(15)}';`,
      ).join('\n'),
    }
  return undefined
}

const network = {
  serverApiRequests: [],
  blockedRequests: [],
  unexpectedApis: [],
  mockedRequests: [],
}
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  // A missed browser mock still cannot reach a backend.
  if (/^\/(api|oauth2|login)(\/|$)/.test(url.pathname)) {
    network.serverApiRequests.push(url.pathname)
    response.writeHead(503).end('Mock required')
    return
  }
  try {
    const asset = resolve(dist, `.${decodeURIComponent(url.pathname)}`)
    assert.ok(asset.startsWith(dist + sep))
    const file = extname(asset) ? asset : resolve(dist, 'index.html')
    const body = await readFile(file)
    response
      .writeHead(200, {
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'",
      })
      .end(body)
  } catch {
    response.writeHead(404).end('Missing fixture asset')
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
const results = []
const errors = []
let completed = false
let failure = null
const boundedMessage = (error) =>
  String(error instanceof Error ? error.message : error).slice(0, 1000)
try {
  browser = await chromium.launch({ headless: true })
  for (const [width, height] of [
    [980, 700],
    [1280, 800],
    [1440, 900],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      serviceWorkers: 'block',
    })
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url())
      if (url.origin !== origin || request.method() !== 'GET') {
        network.blockedRequests.push(`${request.method()} ${url.origin}${url.pathname}`)
        await route.abort('blockedbyclient')
        return
      }
      if (url.pathname.startsWith('/api/')) {
        const body = mock(url)
        if (body === undefined) network.unexpectedApis.push(url.pathname)
        network.mockedRequests.push(url.pathname)
        await route.fulfill({
          status: body === undefined ? 500 : 200,
          contentType: 'application/json',
          body: JSON.stringify(body ?? { error: 'Unhandled fixture API' }),
        })
        return
      }
      if (
        !['document', 'script', 'stylesheet', 'font', 'image', 'other'].includes(
          request.resourceType(),
        )
      ) {
        network.blockedRequests.push(`${request.resourceType()} ${url.pathname}`)
        await route.abort('blockedbyclient')
        return
      }
      await route.continue()
    })
    await context.routeWebSocket('**/*', (socket) => socket.close())
    await context.addInitScript(() => localStorage.setItem('code-intelligence.lang', 'en'))
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${origin}/projects/7/flows`)
    const article = page.getByRole('article', { name: 'Flow detail' })
    await expect(article).toBeVisible()
    await page.screenshot({ path: resolve(run, `${phase}-${width}x${height}-flows.png`) })
    const metrics = await page.evaluate(() => {
      const main = document.querySelector('main'),
        article = document.querySelector('article')
      const box = (element) => {
        const b = element.getBoundingClientRect()
        return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right }
      }
      return {
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        main: box(main),
        detail: box(article),
        detailScrollWidth: article.scrollWidth,
        detailClientWidth: article.clientWidth,
        detailScrollHeight: article.scrollHeight,
        detailClientHeight: article.clientHeight,
        separatorFocusable: document.querySelector('[role="separator"]')?.tabIndex === 0,
      }
    })
    results.push({ width, height, metrics })
    if (phase === 'after') {
      assert.ok(metrics.documentWidth <= width + 1, 'No document horizontal overflow')
      assert.ok(metrics.detail.width >= 280, 'Readable flow detail width')
      assert.ok(
        metrics.detailScrollWidth <= metrics.detailClientWidth + 1,
        'Long detail labels fit',
      )
      assert.equal(metrics.separatorFocusable, true, 'AI separator is keyboard focusable')
      const separator = page.getByRole('separator', { name: 'Adjust AI panel width' })
      await separator.focus()
      await page.keyboard.press('Home')
      await expect(separator).toHaveAttribute('aria-valuenow', '280')
      await page.keyboard.press('ArrowLeft')
      await expect(separator).toHaveAttribute('aria-valuenow', '304')
      await page.keyboard.press('ArrowRight')
      await expect(separator).toHaveAttribute('aria-valuenow', '280')
      await page.keyboard.press('End')
      assert.equal(
        await separator.getAttribute('aria-valuenow'),
        await separator.getAttribute('aria-valuemax'),
      )
      const centerWidth = await page
        .locator('main')
        .evaluate((element) => element.getBoundingClientRect().width)
      assert.ok(centerWidth >= 399, 'AI resize preserves workspace width')
      const grip = await separator.boundingBox()
      await page.mouse.move(grip.x + grip.width / 2, grip.y + 100)
      await page.mouse.down()
      await page.mouse.move(width - 340, grip.y + 100)
      await page.mouse.up()
      assert.equal(
        Number(await separator.getAttribute('aria-valuenow')),
        Math.min(340, Number(await separator.getAttribute('aria-valuemax'))),
        'Pointer resize remains usable',
      )
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible()
      await page.reload()
      await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).focus()
      await page.keyboard.press('Space')
      await expect(
        page.getByRole('button', { name: 'Collapse sidebar', exact: true }),
      ).toBeVisible()
      await expect(article).toBeVisible()
      const tabs = page.getByRole('navigation', { name: 'Workspace tabs' })
      await tabs.getByRole('link', { name: 'Playground', exact: true }).focus()
      await page.keyboard.press('Tab')
      await expect(tabs.getByRole('link', { name: 'Growth', exact: true })).toBeFocused()
      await expect(tabs.getByRole('link', { name: 'Growth', exact: true })).toBeInViewport()
      await tabs.getByRole('link', { name: 'Flows', exact: true }).focus()
      const list = page.getByRole('list', { name: 'Flow list', exact: true })
      await list.getByRole('button').last().focus()
      await expect(list.getByRole('button').last()).toBeInViewport()
    }
    await page.getByRole('button', { name: 'Collapse AI panel', exact: true }).click()
    await page.screenshot({ path: resolve(run, `${phase}-${width}x${height}-flows-ai-closed.png`) })
    await page.getByRole('button', { name: 'Expand AI panel', exact: true }).click()
    // Independent vertical scroll must keep the workspace header reachable.
    await article.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    results.at(-1).evidenceVisible = await article
      .getByRole('button', { name: /Synthetic source evidence/ })
      .isVisible()
    if (phase === 'after') {
      const sourceReadsBefore = network.mockedRequests.filter((item) =>
        item.endsWith('/file-content'),
      ).length
      await expect(article.getByRole('button', { name: /Synthetic source evidence/ })).toBeVisible()
      await article.getByRole('button', { name: /Synthetic source evidence/ }).click()
      await expect(page.getByTestId('source-unavailable')).toContainText('SOURCE_CONTEXT_UNKNOWN')
      assert.equal(
        network.mockedRequests.filter((item) => item.endsWith('/file-content')).length,
        sourceReadsBefore,
        'Legacy flow evidence never silently reads current source',
      )
    }
    await page.goto(
      `${origin}/projects/7/code?path=${encodeURIComponent(path)}&snapshotId=1&sourceContext=snapshot`,
    )
    await expect(page.getByTestId('code-viewer')).toBeAttached({ timeout: 30000 })
    await expect(page.locator('.monaco-editor').first()).toBeAttached({ timeout: 30000 })
    results.at(-1).code = await page.getByTestId('code-viewer').evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }))
    if (phase === 'after') {
      assert.ok(results.at(-1).code.width >= 280, 'Readable code viewer width')
      const panels = page.getByRole('region', { name: 'Code panels', exact: true })
      await panels.focus()
      const oldScroll = await panels.evaluate((element) => element.scrollLeft)
      await page.keyboard.press('ArrowRight')
      await expect
        .poll(() => panels.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(oldScroll)
      await page.getByTestId('code-viewer').scrollIntoViewIfNeeded()
      await expect(page.getByTestId('code-viewer')).toBeInViewport()
    }
    await page.screenshot({ path: resolve(run, `${phase}-${width}x${height}-code.png`) })
    await context.close()
  }
  assert.deepEqual(network.serverApiRequests, [], 'No API reached the static server')
  assert.deepEqual(network.blockedRequests, [], 'No unexpected network attempt')
  assert.deepEqual(network.unexpectedApis, [], 'All API requests explicitly mocked')
  assert.deepEqual(errors, [], 'No page runtime errors')
  completed = true
} catch (error) {
  failure = boundedMessage(error)
  throw error
} finally {
  // Always attempt both owned-handle cleanups, even if one rejects.
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => browser?.close()),
    new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
  ])
  const cleanupErrors = cleanup
    .filter((result) => result.status === 'rejected')
    .map((result) => boundedMessage(result.reason))
  const assertionFailed = failure !== null
  if (!assertionFailed && cleanupErrors.length > 0)
    failure = cleanupErrors.join('; ').slice(0, 1000)
  await writeFile(
    resolve(run, 'results.json'),
    JSON.stringify(
      {
        phase,
        completed,
        passed: completed && !failure,
        failure,
        cleanupErrors,
        results,
        network,
        errors,
      },
      null,
      2,
    ),
  )
  await writeFile(resolve(run, 'network.json'), JSON.stringify({ network, errors }, null, 2))
  if (!assertionFailed && cleanupErrors.length > 0) throw new Error(failure)
}
console.log(
  JSON.stringify({ phase, run, completed, passed: completed && !failure, results }, null, 2),
)
