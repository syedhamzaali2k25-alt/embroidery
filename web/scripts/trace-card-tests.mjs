// Browser tests for the editor's "Create satin columns" card with a mocked API and Playwright's
// fake clock: every state renders, polling backs off 2 s -> 15 s, polling stops while the tab is
// hidden, the estimate appears only when configured, and Cancel job calls the API.
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

/** Opens the editor with a mocked API; `state.status` is what GET /jobs returns. */
async function open(browser, { status = 'running', traceJob = JOB, estimate = null, clock = false } = {}) {
  const page = await browser.newPage();
  const state = { status, jobGets: [], cancels: 0, traces: 0 };
  if (clock) await page.clock.install();
  // Record (fake-clock) time at the moment the app asks for the job, inside the page.
  await page.addInitScript(() => {
    window.__jobPolls = [];
    const real = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).includes('/jobs/') && !String(input).endsWith('/cancel')) window.__jobPolls.push(Date.now());
      return real(input, init);
    };
  });
  await page.route(`${API}/config`, (r) => r.fulfill({ json: { ...config, trace_estimate_minutes: estimate, poll_start_s: 2, poll_max_s: 15, poll_backoff_factor: 2 } }));
  await page.route(`${API}/designs/${DESIGN}`, (r) => r.fulfill({ json: { ...design, id: DESIGN, trace_job_id: traceJob } }));
  await page.route(`${API}/designs/${DESIGN}/trace`, (r) => { state.traces++; state.status = 'queued'; return r.fulfill({ status: 202, json: job('queued') }); });
  await page.route(`${API}/jobs/${JOB}`, async (r) => {
    state.jobGets.push(await page.evaluate(() => Date.now()));
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
