// Browser tests for the editor's "Create satin columns" card with a mocked API and Playwright's
// fake clock: every state renders, polling backs off 2 s -> 15 s, polling stops while the tab is
// hidden, the estimate appears only when configured, and Cancel job calls the API. Also: the card
// never stays on loading (queue down, no answer in time), the canvas and Layers show the real
// design's shapes, thread names are placeholders, and column numbers never overlap.
// Usage: npm run test:trace   (builds first; no server needed)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const dist = join(root, 'dist');
const API = 'http://localhost:8000';
const DESIGN = 'a'.repeat(32), JOB = 'b'.repeat(32);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const result = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'trace-result.json'), 'utf8'));
const config = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'config.json'), 'utf8'));
const design = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'design.json'), 'utf8'));
const shapes = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'shapes.json'), 'utf8'));
const QUEUE_DOWN = 'Background jobs are not running, so satin columns cannot be traced right now.';

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    const body = await readFile(join(dist, path));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(body);
  } catch {
    if (extname(path)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(join(dist, 'index.html')));
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

function job(status, extra = {}) {
  const now = new Date().toISOString();
  return {
    id: JOB, design_id: DESIGN, kind: 'trace', status, created_at: now, started_at: status === 'queued' ? null : now,
    finished_at: null, server_time: now, progress: status === 'running' ? 0.3 : null, cancel_requested: false,
    error: status === 'failed' ? 'The logo could not be traced (no logo found). Use a dark logo on a plain light background, or a transparent PNG.' : null,
    result: status === 'done' ? result : null, ...extra,
  };
}

/**
 * Opens the editor with a mocked API; `state.status` is what GET /jobs returns ('missing' = 404,
 * 'silent' = never answers), `state.health` what GET /jobs/health does ('ok', 'down', 'silent').
 */
async function open(browser, { status = 'running', traceJob = JOB, estimate = null, clock = false, health = 'ok', timeout = 10, viewport } = {}) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  const state = { status, health, jobGets: [], cancels: 0, traces: 0, healthGets: 0 };
  if (clock) await page.clock.install();
  // Record (fake-clock) time at the moment the app asks for the job, inside the page.
  await page.addInitScript(() => {
    window.__jobPolls = [];
    const real = window.fetch;
    window.fetch = (input, init) => {
      const url = String(input);
      if (url.includes('/jobs/') && !url.endsWith('/cancel') && !url.endsWith('/health')) window.__jobPolls.push(Date.now());
      return real(input, init);
    };
  });
  await page.route(`${API}/config`, (r) => r.fulfill({ json: { ...config, trace_estimate_minutes: estimate, poll_start_s: 2, poll_max_s: 15, poll_backoff_factor: 2, status_timeout_s: timeout } }));
  await page.route(`${API}/designs/${DESIGN}/shapes`, (r) => r.fulfill({ json: { ...shapes, id: DESIGN } }));
  await page.route(`${API}/jobs/health`, (r) => {
    state.healthGets++;
    if (state.health === 'down') return r.fulfill({ status: 503, json: { error: QUEUE_DOWN } });
    if (state.health === 'silent') return; // never answers
    return r.fulfill({ json: { status: 'ok', workers: 1 } });
  });
  await page.route(`${API}/designs/${DESIGN}`, (r) => r.fulfill({ json: { ...design, id: DESIGN, trace_job_id: traceJob } }));
  await page.route(`${API}/designs/${DESIGN}/trace`, (r) => { state.traces++; state.status = 'queued'; return r.fulfill({ status: 202, json: job('queued') }); });
  await page.route(`${API}/jobs/${JOB}`, async (r) => {
    state.jobGets.push(await page.evaluate(() => Date.now()));
    if (state.status === 'silent') return;
    if (state.status === 'missing') return r.fulfill({ status: 404, json: { error: 'This job no longer exists. Start it again from the editor.' } });
    return r.fulfill({ json: job(state.status) });
  });
  await page.route(`${API}/jobs/${JOB}/cancel`, (r) => { state.cancels++; state.status = 'cancelled'; return r.fulfill({ json: job('cancelled') }); });
  await page.goto(`${base}/editor?design=${DESIGN}`);
  return { page, state };
}

const browser = await chromium.launch();
try {
  console.log('-- each state renders');
  for (const [status, text] of [
    ['queued', 'Queued: waiting for a free worker.'], ['running', 'Getting your layer ready'], ['done', 'Traced'],
    ['failed', 'The logo could not be traced'], ['cancelled', 'Tracing was cancelled'],
  ]) {
    const { page } = await open(browser, { status });
    await page.locator(`[data-state=${status}]`).waitFor();
    const card = await page.locator('.trace-card').innerText();
    const buttons = { queued: 'Cancel job', running: 'Cancel job', failed: 'Retry', cancelled: 'Trace' }[status];
    check(card.includes(text) && (!buttons || card.includes(buttons)), `${status}: "${text}"${buttons ? ` + ${buttons}` : ''}`);
    if (status === 'running') check(card.includes('Time elapsed') && await page.locator('[role=progressbar][aria-valuenow="30"]').count() === 1, 'running: progress bar at 30% and time elapsed');
    if (status === 'done') check(await page.locator('.traced__column').count() === result.columns.length && await page.locator('.traced__point').count() > 0, `done: ${result.columns.length} numbered columns with edit points on the canvas`);
    await page.close();
  }
  {
    const { page } = await open(browser, { traceJob: null });
    await page.locator('[data-state=idle]').waitFor();
    check((await page.locator('.trace-card').innerText()).includes('Trace'), 'idle: Trace button');
    await page.getByRole('button', { name: 'Trace', exact: true }).click();
    await page.locator('[data-state=queued]').waitFor();
    check(true, 'Trace starts a job and shows queued');
    await page.close();
  }

  console.log('-- never stuck on loading');
  {
    const { page, state } = await open(browser, { health: 'down' });
    await page.locator('[data-state=unavailable]').waitFor();
    const card = await page.locator('.trace-card').innerText();
    check(card.includes(QUEUE_DOWN) && card.includes('Retry'), `queue down: "${QUEUE_DOWN}" + Retry`);
    state.health = 'ok';
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.locator('[data-state=running]').waitFor();
    check(state.healthGets === 2, 'Retry checks again and picks up the running job once jobs are back');
    await page.close();
  }
  for (const [what, opts] of [['health check', { health: 'silent' }], ['first job status', { status: 'silent' }]]) {
    const { page } = await open(browser, { ...opts, timeout: 1 });
    const started = Date.now();
    await page.locator('[data-state=loading]').waitFor();
    await page.locator('[data-state=unavailable]').waitFor({ timeout: 5000 });
    const took = Date.now() - started;
    const card = await page.locator('.trace-card').innerText();
    check(card.includes('did not answer within 1 second.') && card.includes('Retry') && took < 3000,
      `no answer to the ${what}: plain message + Retry after the 1 s timeout (took ${took} ms)`);
    await page.close();
  }
  {
    const { page } = await open(browser, { status: 'missing' });
    await page.locator('[data-state=idle]').waitFor();
    check(true, 'a job that no longer exists (404) shows Trace, not loading');
    await page.close();
  }
  {
    const { page, state } = await open(browser, { traceJob: null });
    await page.locator('[data-state=idle]').waitFor();
    state.health = 'down';
    await page.route(`${API}/designs/${DESIGN}/trace`, (r) => r.fulfill({ status: 503, json: { error: QUEUE_DOWN } }));
    await page.getByRole('button', { name: 'Trace', exact: true }).click();
    await page.locator('[data-state=unavailable]').waitFor();
    check((await page.locator('.trace-card').innerText()).includes(QUEUE_DOWN), 'Trace while the queue is down: the same message + Retry');
    await page.close();
  }
  {
    const { page } = await open(browser, { status: 'running' });
    await page.locator('[data-state=running]').waitFor();
    await page.route(`${API}/jobs/${JOB}`, (r) => r.fulfill({ status: 503, json: { error: QUEUE_DOWN } }));
    await page.locator('[data-state=unavailable]').waitFor({ timeout: 10_000 });
    check(true, 'the queue going down while polling shows the message + Retry (polling stops)');
    await page.close();
  }

  console.log('-- the real design');
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const { page } = await open(browser, { status: 'done', viewport });
    await page.locator('.traced__column').first().waitFor();
    const drawn = await page.locator('.design-shape').count();
    const layers = await page.locator('.layers .layer').count();
    check(drawn === shapes.shapes.length && layers === shapes.shapes.length,
      `${viewport.width}px: ${drawn} shapes on the canvas and ${layers} layers, from the API's ${shapes.shapes.length} shapes`);
    check(await page.locator('.hoop-ring').count() === 0, `${viewport.width}px: no demo hoop ring`);
    const body = await page.locator('body').innerText();
    check(!/1001|1049|Petals|Leaves/.test(body) && body.includes('[Thread name]') && body.includes('not chosen yet'),
      `${viewport.width}px: no invented thread names or demo layers; thread colour is a labelled placeholder`);
    // Column numbers: no two label circles overlap on screen.
    const circles = await page.locator('.traced__label > circle:not(.traced__anchor)').evaluateAll((els) =>
      els.map((el) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.width / 2]; }));
    let overlaps = 0;
    for (let i = 0; i < circles.length; i++) for (let j = i + 1; j < circles.length; j++) {
      const [x1, y1, r1] = circles[i], [x2, y2, r2] = circles[j];
      if (Math.hypot(x1 - x2, y1 - y2) < r1 + r2 - 0.01) overlaps++;
    }
    check(circles.length === result.columns.length && overlaps === 0,
      `${viewport.width}px: ${circles.length} column numbers, none overlapping (${await page.locator('.traced__label[data-moved]').count()} moved aside with a leader line)`);
    // Hiding a layer hides its shape and its columns.
    const first = shapes.shapes[0].number;
    const columnsOfFirst = result.columns.filter((c) => c.shape === first).length;
    await page.getByRole('button', { name: `Hide Shape ${first}`, exact: true }).click();
    check(await page.locator('.design-shape').count() === shapes.shapes.length - 1
      && await page.locator('.traced__column').count() === result.columns.length - columnsOfFirst,
      `${viewport.width}px: hiding Shape ${first} hides it and its ${columnsOfFirst} columns`);
    await page.getByRole('button', { name: new RegExp(`^Shape ${first + 1} `) }).click();
    check((await page.locator('.panel__title').innerText()) === `Shape ${first + 1}`, `${viewport.width}px: picking a layer selects that shape`);
    await page.close();
  }
  {
    const page = await browser.newPage();
    await page.goto(`${base}/editor`);
    await page.locator('.hoop-canvas').waitFor();
    const body = await page.locator('body').innerText();
    check(!/1001|1049/.test(body) && body.includes('[Thread colour 1]'), 'mock-up editor: thread names are placeholders too');
    await page.close();
  }

  console.log('-- estimate');
  for (const [estimate, expected] of [[null, false], [3, true]]) {
    const { page } = await open(browser, { status: 'running', estimate });
    await page.getByText('Getting your layer ready').waitFor();
    const text = await page.locator('.trace-card').innerText();
    check(text.includes('Usually about 3 minutes') === expected && text.includes('estimate') === expected,
      estimate === null ? 'no estimate in config: nothing shown' : 'estimate in config: "Usually about 3 minutes" labelled estimate');
    await page.close();
  }

  console.log('-- polling');
  {
    const { page, state } = await open(browser, { status: 'running', clock: true });
    await page.getByText('Getting your layer ready').waitFor();
    // Small steps, so each mocked response arrives before the fake clock moves much further.
    for (let i = 0; i < 500; i++) {
      await page.clock.runFor(100);
      await page.waitForTimeout(4);
    }
    const polls = await page.evaluate(() => window.__jobPolls);
    const gaps = polls.slice(1).map((t, i) => t - polls[i]).slice(0, 5);
    const expected = [2000, 4000, 8000, 15000, 15000];
    check(gaps.length === 5 && gaps.every((g, i) => Math.abs(g - expected[i]) <= 300), // fake-clock steps + mocked network add jitter either way
      `waits grow 2 s -> 4 -> 8 -> 15 s, then stay at 15 s (measured ${gaps.join(', ')} ms)`);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const before = state.jobGets.length;
    await page.clock.runFor(120_000);
    await page.waitForTimeout(50);
    check(state.jobGets.length === before, 'no polling for 2 minutes while the tab is hidden');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(100);
    check(state.jobGets.length === before + 1, 'checks once, straight away, when the tab is shown again');
    state.status = 'done';
    await page.clock.runFor(2_000);
    await page.locator('[data-state=done]').waitFor();
    const settled = state.jobGets.length;
    await page.clock.runFor(120_000);
    await page.waitForTimeout(50);
    check(state.jobGets.length === settled, 'polling stops once the job is done');
    await page.close();
  }

  console.log('-- cancel');
  for (const status of ['queued', 'running']) {
    const { page, state } = await open(browser, { status });
    await page.locator(`[data-state=${status}]`).waitFor();
    await page.getByRole('button', { name: 'Cancel job' }).click();
    await page.locator('[data-state=cancelled]').waitFor();
    check(state.cancels === 1, `Cancel job while ${status} calls POST /jobs/{id}/cancel and shows cancelled`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
