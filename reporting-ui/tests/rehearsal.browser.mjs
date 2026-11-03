// Optional browser check: needs an installed Playwright and Chromium.
// Start `npm run preview:rehearsal` first. No app server or provider is used.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'http://127.0.0.1:4174';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [], forbiddenRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin || url.pathname.startsWith('/api/') || route.request().method() !== 'GET') {
    forbiddenRequests.push(route.request().url()); return route.abort();
  }
  return route.continue();
});
await context.addInitScript(() => {
  const forbidden = () => { throw new Error('Rehearsal attempted a live transport'); };
  window.fetch = forbidden; window.EventSource = forbidden; window.WebSocket = forbidden;
  window.RTCPeerConnection = forbidden;
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = forbidden;
});
const phase = async expected => assert.equal(await page.locator('#caption').getAttribute('data-phase'), expected);
const next = async () => page.locator('#next').click();
const identity = async () => { await page.locator('#identity-code').fill('DEMO-484'); await page.getByRole('button', { name: 'Confirm demo identity', exact: true }).click(); };
const select = async value => { await page.locator('#scenario').selectOption(value); await phase('ready'); assert.equal(await page.locator('#context-content').isVisible(), false); };
async function intake() {
  await next(); await phase('intake');
  await identity(); await phase('identity_confirmed');
  assert.equal(await page.locator('#context-content').isVisible(), false);
  await next(); await phase('context_ready');
  assert.equal(await page.locator('#context-content').isVisible(), true);
  await next();
}
async function toPlaced(scenario) {
  await select(scenario); await intake(); await phase('queued');
  await next(); await phase('working');
  await next(); await phase('callback_requested');
  assert.equal(await page.locator('#callback-status').textContent(), 'Callback requested');
  await next(); await phase('result_ready');
  await next(); await phase('call_placed');
  assert.equal(await page.locator('#callback-status').textContent(), 'Call placed · outcome unknown');
  assert.match(await page.locator('#case-status').textContent(), /Case open/);
}
async function noOverflow() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'horizontal overflow');
}
try {
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await page.goto(`${origin}/rehearsal.html`);
  await phase('ready');
  await next();
  await page.locator('#identity-code').fill('wrong');
  await page.getByRole('button', { name: 'Confirm demo identity', exact: true }).click();
  await phase('intake');
  assert.equal(await page.locator('#identity-error').isVisible(), true);
  assert.equal(await page.locator('#context-content').isVisible(), false);
  await page.locator('#reset').click();
  await intake(); await phase('solution_proposed');
  await noOverflow();
  await page.screenshot({ path: new URL('../test-results/rehearsal-solution.png', import.meta.url).pathname, fullPage: true });
  await next(); await phase('completed');
  assert.match(await page.locator('#task-detail').textContent(), /No new specialist task/);
  assert.equal(await page.locator('#callback-status').textContent(), 'Not requested');
  for (const scenario of ['it', 'maintenance']) {
    await toPlaced(scenario);
    await noOverflow();
    if (scenario === 'it') await page.screenshot({ path: new URL('../test-results/rehearsal-desktop.png', import.meta.url).pathname, fullPage: true });
    await next(); await phase('callback_identity');
    await identity(); await phase('callback_connected');
    assert.match(await page.locator('#speaker').textContent(), /specialist/);
    await next(); await phase('completed');
    assert.match(await page.locator('#callback-status').textContent(), /^Completed/);
  }
  await toPlaced('it');
  await page.locator('#alternative').click(); await phase('callback_unanswered');
  assert.match(await page.locator('#case-status').textContent(), /Case open/);
  assert.equal(await page.locator('#completion').isVisible(), false);
  await next(); await phase('result_ready'); await next(); await phase('call_placed');
  assert.match(await page.locator('#callback-detail').textContent(), /Attempts: 2/);
  await select('maintenance'); await intake(); await next();
  await page.locator('#alternative').click(); await phase('no_callback');
  await next(); await phase('no_callback_result');
  assert.equal(await page.locator('#callback-status').textContent(), 'Not requested');
  await page.setViewportSize({ width: 390, height: 844 });
  await toPlaced('maintenance'); await noOverflow();
  await page.screenshot({ path: new URL('../test-results/rehearsal-mobile.png', import.meta.url).pathname, fullPage: true });
  await page.setViewportSize({ width: 720, height: 450 });
  await noOverflow();
  await select('solution'); await intake();
  await page.locator('#alternative').click(); await phase('queued');
  await page.locator('#reset').click();
  assert.equal(await page.locator('#timeline > li').count(), 0);
  assert.equal(await page.locator('#context-content').isVisible(), false);
  // Check the full identity step by keyboard, including focus after form removal.
  await page.locator('#next').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#identity-code').evaluate(el => el === document.activeElement), true);
  await page.keyboard.type('DEMO-484'); await page.keyboard.press('Enter');
  await phase('identity_confirmed');
  assert.equal(await page.locator('#next').evaluate(el => el === document.activeElement), true);
  await page.reload(); await phase('ready');
  assert.equal(await page.locator('#context-content').isVisible(), false);
  assert.deepEqual(forbiddenRequests, []);
  assert.deepEqual(errors, []);
  console.log('Browser rehearsal passed: all branches, identity, no-answer/retry, no consent, reset, keyboard focus, 1440/390/720 widths; zero API/provider requests or console errors.');
} finally { await browser.close(); }
