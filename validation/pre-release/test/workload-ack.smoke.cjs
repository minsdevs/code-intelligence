'use strict';
// Explicit runner smoke: fresh headless Chromium context, no packaged app or user profile.
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium } = require('../../../frontend/node_modules/playwright');
const { installWorkloadClick, installWorkloadWatch, describeSmoke } = require('../workload-metrics.cjs');

test('real renderer clicks acknowledge only the matching post-action DOM mutation', async t => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const label of ['Cancelling…', 'Inspecting…', '검사 중…']) {
      await page.setContent('<button aria-label="Icon"></button><button id="action">Start</button>');
      await page.evaluate(label => {
        document.querySelector('#action').onclick = event => {
          setTimeout(() => { event.target.textContent = label; }, 30);
        };
      }, label);
      await page.evaluate(installWorkloadClick, 'click');
      await page.evaluate(installWorkloadWatch, { name: 'ack', condition: { kind: 'button', text: [label], after: 'click' } });
      assert.equal(await page.evaluate(() => window.__workload.marks.ack), undefined);
      await page.locator('#action').click();
      await page.waitForFunction(() => Number.isFinite(window.__workload.marks.ack));
      const marks = await page.evaluate(() => ({ ...window.__workload.marks }));
      const duration = marks.ack - marks.click;
      assert.ok(duration >= 0, JSON.stringify(marks));
      const observation = describeSmoke('cancel.medium', [{ status: 'PASS', metrics: { cancelUiAckMs: duration, cancelReleaseMs: duration } }]);
      assert.deepEqual(observation.observations[0].values.cancelUiAckMs.values, [duration]);
      t.diagnostic(JSON.stringify({ label, click: marks.click, acknowledgement: marks.ack, duration }));
    }
  } finally { await browser.close(); }
});
