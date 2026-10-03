/* Launched only by backend snapshotSourceTest against its disposable real server and DB. */
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium, expect } = require('@playwright/test');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, message, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function blobOid(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function main() {
  const args = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  assert.match(args.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(['navigation', 'races'].includes(args.scenario));
  const browser = await chromium.launch({ headless: true });
  try {
    // Match the preload: the per-launch token belongs on API requests, never top-level navigation.
    const apiHeaders = { 'X-Code-Intelligence-Token': args.token };
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await context.addInitScript(({ baseUrl, token }) => {
      window.codeIntelligenceDesktop = { apiBaseUrl: baseUrl, apiToken: token };
    }, { baseUrl: args.baseUrl, token: args.token });
    const page = await context.newPage();
    const errors = [];
    const sourceRequests = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Page error:', error.message); });
    page.on('request', request => {
      if (request.url().includes('/file-content?')) sourceRequests.push(request.url());
    });
    const document = await page.goto(args.baseUrl);
    assert.equal(document.status(), 200, 'Public bootstrap HTML');
    await expect(page.getByRole('link', { name: 'Code Intelligence home' })).toBeVisible();

    async function navigate(url) {
      await page.evaluate(url => { history.pushState(null, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }, url);
    }
    const codeUrl = (snapshot, path = args.path, project = args.project, extra = '') =>
      `/projects/${project}/code?path=${encodeURIComponent(path)}${snapshot == null ? '' : `&snapshotId=${snapshot}`}${extra}`;
    const sourcePath = (project, snapshot, path = args.path) =>
      `/api/projects/${project}/file-content?path=${encodeURIComponent(path)}&snapshotId=${snapshot}`;
    const modelUri = (expected, snapshot, project = args.project) =>
      `snapshot://${project}/${snapshot}/${blobOid(expected)}/${args.path}`;

    async function renderFrames() {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function content(expected, snapshot, project = args.project, current) {
      const viewer = page.getByTestId('code-viewer');
      await expect(viewer).toBeVisible({ timeout: 45000 });
      await expect(viewer.locator('.view-lines')).toHaveText(expected.trimEnd(), { timeout: 15000 });
      for (const marker of ['AAAA', 'BBBB', 'CCCC', 'PPPP', 'QQQQ'].filter(marker => !expected.includes(marker))) {
        await expect(viewer).not.toContainText(marker);
      }
      await expect(viewer.locator('.monaco-editor').first()).toHaveAttribute('data-uri', modelUri(expected, snapshot, project));
      await expect(page.getByTestId('source-context')).toContainText(`Snapshot #${snapshot}`);
      if (current !== undefined) {
        await expect(page.getByTestId('source-context')).toContainText(current ? '현재 / Current' : '과거 / Historical');
      }
    }
    async function unavailable(code) {
      await expect(page.getByTestId('source-unavailable')).toContainText(code);
      await expect(page.getByTestId('code-viewer')).toHaveCount(0);
      await expect(page.locator('.code-explorer-line')).toHaveCount(0);
      for (const marker of ['AAAA', 'BBBB', 'CCCC', 'PPPP', 'QQQQ']) {
        await expect(page.getByTestId('source-unavailable')).not.toContainText(marker);
      }
    }
    async function api(path, body, expectedStatus = body === undefined ? 200 : 202) {
      let response;
      if (body === undefined) {
        response = await context.request.get(args.baseUrl + path, { headers: apiHeaders });
      } else {
        const primed = await context.request.get(args.baseUrl + '/api/csrf', { headers: apiHeaders });
        assert.equal(primed.status(), 204);
        const csrf = (await context.cookies(args.baseUrl)).find(cookie => cookie.name === 'XSRF-TOKEN');
        assert.ok(csrf, 'CSRF token from the real server');
        response = await context.request.post(args.baseUrl + path, {
          data: body, headers: { ...apiHeaders, 'X-XSRF-TOKEN': decodeURIComponent(csrf.value) },
        });
      }
      assert.equal(response.status(), expectedStatus, `${path}: unexpected response status`);
      return response.json();
    }
    async function refreshByApi(nextContent) {
      await fs.writeFile(args.sourceFile, nextContent);
      const status = await api(`/api/projects/${args.project}/local-source-status`);
      assert.equal(status.state, 'CHANGED');
      assert.deepEqual([status.changes.added, status.changes.modified, status.changes.deleted], [0, 1, 0]);
      const preview = await api(`/api/projects/${args.project}/local-preview`, {}, 200);
      assert.equal(preview.operation, 'REFRESH');
      assert.equal(preview.snapshotId, status.snapshotId);
      assert.deepEqual([preview.changes.added, preview.changes.modified, preview.changes.deleted], [0, 1, 0]);
      const job = await api(`/api/projects/${args.project}/reanalyze`, { previewToken: preview.previewToken });
      await expect.poll(async () => (await api(`/api/jobs/${job.jobId}`)).status, { timeout: 45000 }).toBe('DONE');
      const project = await api(`/api/projects/${args.project}`);
      assert.notEqual(project.currentSnapshot.id, args.a);
      return project.currentSnapshot.id;
    }
    async function selectSnapshot(snapshot) {
      await page.getByRole('combobox', { name: 'Source snapshot' }).selectOption(String(snapshot));
      await expect.poll(() => new URL(page.url()).searchParams.get('snapshotId')).toBe(String(snapshot));
      assert.equal(new URL(page.url()).searchParams.get('line'), null);
      assert.equal(new URL(page.url()).searchParams.get('evidenceId'), null);
    }
    async function highlightedA() {
      await navigate(codeUrl(args.a, args.path, args.project, '&line=1'));
      await content(args.before, args.a, args.project, false);
      await expect(page.locator('.code-explorer-line')).toHaveCount(1);
    }

    if (args.scenario === 'navigation') {
      await navigate(`/projects/${args.project}/code`);
      await page.getByRole('treeitem', { name: args.path, exact: true }).click();
      await content(args.before, args.a, args.project, true);

      // A real legacy Flow DTO has no snapshot context. Clicking its evidence must fail closed.
      await navigate(`/projects/${args.project}/flows`);
      await page.getByRole('button', { name: /S1 legacy flow/ }).click();
      const legacyEvidence = page.getByRole('article', { name: 'Flow detail' })
        .getByRole('button', { name: `${args.path}:1 legacy fixture`, exact: true });
      await expect(legacyEvidence).toBeVisible();
      const requestsBeforeLegacy = sourceRequests.length;
      await legacyEvidence.click();
      await unavailable('SOURCE_CONTEXT_UNKNOWN');
      await renderFrames();
      assert.equal(sourceRequests.length, requestsBeforeLegacy, 'A legacy evidence click must not fetch current source');
      assert.equal(new URL(page.url()).searchParams.get('sourceContext'), 'unknown');
      assert.equal(new URL(page.url()).searchParams.get('snapshotId'), null);
      await page.getByRole('button', { name: /Open current source/ }).click();
      await content(args.before, args.a, args.project, true);
      assert.equal(new URL(page.url()).searchParams.get('line'), null);

      await navigate(`/projects/${args.project}/features`);
      await page.getByRole('button', { name: /S1 source feature/ }).click();
      const featureEvidence = () => page.getByRole('article', { name: 'Feature detail' })
        .getByRole('button', { name: `${args.path}:1 snapshot fixture`, exact: true });
      await featureEvidence().click();
      await content(args.before, args.a, args.project, true);
      assert.equal(new URL(page.url()).searchParams.get('snapshotId'), String(args.a));
      assert.equal(new URL(page.url()).searchParams.get('evidenceId'), String(args.evidence));
      await expect(page.getByText(/LEGACY_SOURCE_UNVERIFIED/)).toBeVisible();
      await expect(page.locator('.code-explorer-line')).toHaveCount(0);

      const featureListUrl = `${args.baseUrl}/api/projects/${args.project}/features`;
      const featureDetailUrl = `${featureListUrl}/${args.feature}`;
      const cachedList = await context.request.get(featureListUrl, { headers: apiHeaders });
      const cachedDetail = await context.request.get(featureDetailUrl, { headers: apiHeaders });
      assert.equal(cachedList.status(), 200);
      assert.equal(cachedDetail.status(), 200);
      const detail = await cachedDetail.json();
      assert.equal(detail.resolvedSnapshotId, args.a);
      assert.equal(detail.evidences.find(item => item.evidenceId === args.evidence).snapshotId, args.a);

      const b = await refreshByApi(args.after);
      // Remount the code page so its real project query observes B after this out-of-band API refresh.
      await navigate(`/projects/${args.project}/notes`);
      await expect(page.getByRole('button', { name: 'S1 sentinel', exact: true })).toBeVisible();
      await navigate(codeUrl(null, args.path, args.project, '&sourceContext=current'));
      await content(args.after, b, args.project, true); // Populate actual current project context with B.

      // Replay only previously fetched, unmodified feature metadata, as a stale tab/cache would.
      // Every file-content request still reaches the real backend/JGit reader.
      await page.route(featureListUrl, route => route.fulfill({ response: cachedList }));
      await page.route(featureDetailUrl, route => route.fulfill({ response: cachedDetail }));
      await navigate(`/projects/${args.project}/features`);
      await page.getByRole('button', { name: /S1 source feature/ }).click();
      const historicalRequest = page.waitForRequest(request => {
        const url = new URL(request.url());
        return url.pathname === `/api/projects/${args.project}/file-content`
          && url.searchParams.get('snapshotId') === String(args.a)
          && url.searchParams.get('evidenceId') === String(args.evidence);
      });
      await featureEvidence().click();
      await historicalRequest;
      assert.equal(new URL(page.url()).searchParams.get('snapshotId'), String(args.a));
      assert.equal(new URL(page.url()).searchParams.get('evidenceId'), String(args.evidence));
      await unavailable('SOURCE_UNAVAILABLE'); // Local refresh retired A's object store.
      await page.unroute(featureListUrl);
      await page.unroute(featureDetailUrl);

      await navigate(`/projects/${args.project}/notes`);
      await page.getByRole('button', { name: 'S1 sentinel', exact: true }).click();
      await page.getByRole('button', { name: `file:${args.path} · 현재 소스`, exact: true }).click();
      await content(args.after, b, args.project, true);
      const noteUrl = new URL(page.url());
      assert.equal(noteUrl.searchParams.get('sourceContext'), 'current');
      assert.equal(noteUrl.searchParams.get('snapshotId'), null);
      assert.equal(noteUrl.searchParams.get('evidenceId'), null);
      await expect(page.getByTestId('source-context')).toContainText('현재 소스');
      console.log(`PASS ${args.path}: real code tree, feature A across refresh/current B, legacy Flow click, preserved note current B`);
    } else {
      const releaseA = deferred(), heldA = deferred(), deliveredA = deferred();
      const releaseB = deferred(), heldB = deferred();
      let holdA = true, holdB = true, oldRequest;
      await page.route('**/file-content?*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === `/api/projects/${args.project}/file-content` && url.searchParams.get('path') === args.path) {
          if (holdA && url.searchParams.get('snapshotId') === String(args.a)) {
            holdA = false;
            oldRequest = route.request();
            const response = await route.fetch(); // Real backend bytes; delay only browser delivery.
            assert.equal(response.status(), 200);
            assert.equal((await response.json()).content, args.before);
            heldA.resolve(); await releaseA.promise; await route.fulfill({ response }); deliveredA.resolve();
            return;
          }
          if (holdB && url.searchParams.get('snapshotId') === String(args.b)) {
            holdB = false;
            const response = await route.fetch();
            heldB.resolve(); await releaseB.promise; await route.fulfill({ response });
            return;
          }
        }
        await route.continue();
      });
      await navigate(codeUrl(args.a));
      await within(heldA.promise, 'Old A response did not arrive');
      await selectSnapshot(args.b);
      await within(heldB.promise, 'New B response did not arrive');
      await expect(page.getByTestId('code-viewer')).toHaveCount(0);
      await expect(page.locator('.code-explorer-line')).toHaveCount(0);
      releaseB.resolve();
      await content(args.after, args.b, args.project, true);

      // Watch every DOM mutation until A's body has reached the browser and rendering has settled.
      await page.evaluate(() => {
        window.__s1WrongSource = [];
        window.__s1SourceObserver = new MutationObserver(() => {
          const text = document.querySelector('[data-testid="code-viewer"] .view-lines')?.textContent ?? '';
          if (text.includes('AAAA')) window.__s1WrongSource.push(text);
        });
        window.__s1SourceObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      const oldFinished = page.waitForEvent('requestfinished', { predicate: request => request === oldRequest });
      releaseA.resolve();
      await within(Promise.all([deliveredA.promise, oldFinished]), 'Delayed A response was not consumed');
      await renderFrames();
      await content(args.after, args.b, args.project, true);
      const wrong = await page.evaluate(() => {
        window.__s1SourceObserver.disconnect();
        return window.__s1WrongSource;
      });
      assert.deepEqual(wrong, [], 'Delayed A must never replace B, even briefly');

      await selectSnapshot(args.a);
      await content(args.before, args.a, args.project, false);
      await highlightedA();
      await selectSnapshot(args.b);
      await content(args.after, args.b, args.project, true);
      await expect(page.locator('.code-explorer-line')).toHaveCount(0);
      await navigate(codeUrl(args.otherSnapshot, args.path, args.otherProject));
      await content(args.otherAfter, args.otherSnapshot, args.otherProject, true);

      for (const [path, code] of [['missing.txt', 'SOURCE_UNAVAILABLE'], ['stale.txt', 'EVIDENCE_STALE']]) {
        await highlightedA();
        await navigate(codeUrl(args.a, path, args.project, '&line=1'));
        await unavailable(code);
      }
      await highlightedA();
      const requestsBefore = sourceRequests.length;
      await navigate(codeUrl(null, args.path, args.project, '&sourceContext=unknown&line=999'));
      await unavailable('SOURCE_CONTEXT_UNKNOWN');
      await renderFrames();
      assert.equal(sourceRequests.length, requestsBefore);
      await page.getByRole('button', { name: /Open current source/ }).click();
      await content(args.after, args.b, args.project, true);
      assert.equal(new URL(page.url()).searchParams.get('line'), null);

      const next = args.before.replace('AAAA', 'CCCC');
      await fs.writeFile(args.sourceFile, next);
      await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
      await page.getByRole('button', { name: '변경 사항 미리보기', exact: true }).click();
      await expect(page.getByRole('region', { name: '확인할 가져오기 미리보기', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '변경 확인 후 전체 재분석', exact: true }).click();
      await expect.poll(async () => (await api(`/api/projects/${args.project}`)).currentSnapshot.id,
        { timeout: 45000 }).not.toBe(args.b);
      const refreshed = (await api(`/api/projects/${args.project}`)).currentSnapshot.id;
      await content(next, refreshed, args.project, true);
      await navigate(codeUrl(args.a));
      await unavailable('SOURCE_UNAVAILABLE');
      const gone = await context.request.get(args.baseUrl + sourcePath(args.project, args.a), { headers: apiHeaders });
      assert.equal(gone.status(), 410);
      assert.equal((await gone.json()).code, 'SOURCE_UNAVAILABLE');
      console.log(`PASS ${args.path}: consumed delayed response, snapshot selector, exact models, distinct projects, highlights/errors, real refresh cache invalidation`);
    }
    assert.deepEqual(errors, [], 'No runtime page errors');
    assert.ok(sourceRequests.length > 0);
    await context.close();
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
