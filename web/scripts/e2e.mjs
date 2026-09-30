// End-to-end: real API (stand-in TEST_RUN values) + built web app + Chromium, three real image
// files at desktop and phone width. Checks the screens show the API's numbers, the downloaded DST
// equals the command-line DST byte for byte, and every loading / error / empty state renders.
// Also records API responses for the screenshot audit's fixtures.
// Usage: npm run e2e   (needs `make setup` done: it uses ../.venv)
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const web = resolve(new URL('..', import.meta.url).pathname);
const repo = resolve(web, '..');
const python = join(repo, '.venv', 'bin', 'python');
const shots = join(web, 'screenshots', 'e2e');
const fixtures = join(web, 'scripts', 'fixtures');
const API_PORT = 8765, WEB_PORT = 4173;
const API = `http://localhost:${API_PORT}`, WEB = `http://localhost:${WEB_PORT}`;
const IMAGES = [
  { file: 'cafe-luna.jpg', width: 80 },
  { file: 'fern-studio.png', width: 70 },
  { file: 'k-monogram-small.png', width: 40 },
];
const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }];

const failures = [];
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

// ---------- start the API and the built web app ----------
const storage = await mkdtemp(join(tmpdir(), 'stitchbook-e2e-'));
// Background jobs: a private Redis, and (started later) a worker. The API runs the test-only slow
// trace so the queued and running states last long enough to see and cancel.
const REDIS_PORT = 6391;
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}/0`;
const startRedis = () => spawn('redis-server', ['--port', String(REDIS_PORT), '--save', '', '--appendonly', 'no', '--dir', storage], { stdio: 'ignore' });
let redisProc = startRedis();
let workerProc = null;
const startWorker = () => {
  workerProc = spawn(python, ['-m', 'stitchbook_worker.main'], {
    cwd: repo, env: { ...process.env, REDIS_URL, RQ_QUEUE: 'digitize', LOG_LEVEL: 'warning' }, stdio: 'ignore',
  });
};
const apiProc = spawn(python, ['-m', 'uvicorn', 'stitchbook_api.main:app', '--port', String(API_PORT)], {
  cwd: repo,
  env: { ...process.env, STITCHBOOK_TEST_RUN_VALUES: '1', STORAGE_DIR: storage, CORS_ORIGIN: WEB, REDIS_URL,
         STITCHBOOK_TRACE_JOB: 'stitchbook_worker.testing.slow_trace_design' },
  stdio: 'ignore',
});
execFileSync('npx', ['vite', 'build'], { cwd: web, env: { ...process.env, VITE_API_URL: API }, stdio: 'ignore' });
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    const body = await readFile(join(web, 'dist', path));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(body);
  } catch {
    if (extname(path)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(join(web, 'dist', 'index.html')));
  }
});
await new Promise((r) => server.listen(WEB_PORT, r));
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}

await mkdir(shots, { recursive: true });
await mkdir(fixtures, { recursive: true });
const browser = await chromium.launch();

try {
  for (const vp of VIEWPORTS) {
    console.log(`\n== ${vp.name}`);
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, acceptDownloads: true });
    const shot = (name) => page.screenshot({ path: join(shots, `${name}-${vp.name}.png`), fullPage: true });

    for (const image of IMAGES) {
      const stem = image.file.replace(/\.\w+$/, '');
      console.log(`-- ${image.file}`);
      await page.goto(`${WEB}/upload`);
      await page.getByText('Drop your logo here').waitFor();
      const uploaded = page.waitForResponse((r) => r.url() === `${API}/designs` && r.request().method() === 'POST');
      await page.locator('input[type=file]').setInputFiles(join(web, 'scripts', 'test-images', image.file));
      const created = await (await uploaded).json();
      await page.locator('.flow-checks li').first().waitFor();
      const shown = await page.locator('.flow-checks li').allInnerTexts();
      check(created.warnings.length === 0 ? shown.some((t) => t.includes('No problems found'))
        : created.warnings.every((w) => shown.some((t) => t.includes(w.message))), `upload shows the API's quality messages (${created.warnings.map((w) => w.code).join(', ') || 'none'})`);
      await page.fill('#width', String(image.width));
      const expectedHeight = (image.width * created.logo_height_px) / created.logo_width_px;
      check((await page.locator('#width-help').innerText()).includes(`Height: ${expectedHeight.toFixed(1)} mm`), `height follows the logo (${expectedHeight.toFixed(1)} mm)`);
      await page.locator('.flow-swatch').first().waitFor();
      await shot(`${stem}-upload`);

      const previewed = page.waitForResponse((r) => r.url().endsWith('/preview'));
      await page.getByRole('button', { name: 'Continue to preview' }).click();
      const preview = await (await previewed).json();
      await page.getByRole('heading', { name: 'Summary' }).waitFor();
      const summary = await page.locator('.flow-summary').innerText();
      const s = preview.stats, r = preview.report;
      check(summary.includes(s.stitch_count.toLocaleString('en')) && summary.includes(`${s.width_mm.toFixed(1)} × ${s.height_mm.toFixed(1)}`)
        && summary.includes(`${r.jumps}`) && summary.includes(`${s.color_count}`), `summary matches the API (${s.stitch_count} stitches, ${s.width_mm.toFixed(1)} × ${s.height_mm.toFixed(1)} mm, ${r.jumps} jumps, ${s.color_count} colour)`);
      check(await page.locator('.flow-layer').count() === preview.layers.length, `layers list shows ${preview.layers.length} layers`);
      await page.locator('.flow-layer').first().click();
      await shot(`${stem}-preview`);

      if (vp.name === 'desktop') {
        // DST from the Download button == DST from the command line, byte for byte.
        const download = page.waitForEvent('download');
        await page.getByRole('link', { name: 'Download DST' }).click();
        const fromApi = await readFile(await (await download).path());
        const cli = join(storage, `cli-${stem}`);
        execFileSync(python, ['-m', 'digitizer.digitize', join(web, 'scripts', 'test-images', image.file), '--out', cli,
          '--width-mm', String(image.width), '--test-run-values'], { cwd: repo });
        check(Buffer.compare(fromApi, await readFile(join(cli, 'out.dst'))) === 0, 'downloaded DST equals the command-line DST');
        console.log('     readback: ' + execFileSync(python, ['-m', 'digitizer.readback', join(cli, 'out.dst')], { cwd: repo }).toString().trim().split('\n').slice(0, 2).join(' | ').replace(/^.*out\.dst: /, ''));

        // Changing fill density digitizes again with the new spacing.
        const before = s.stitch_count;
        const again = page.waitForResponse((resp) => resp.url().endsWith('/preview'));
        await page.fill('#pv-spacing', '0.3');
        await page.getByRole('button', { name: 'Update preview' }).click();
        const denser = await (await again).json();
        await page.getByRole('button', { name: 'Update preview' }).isDisabled();
        check(denser.stats.stitch_count > before && (await page.locator('.flow-summary').innerText()).includes(denser.stats.stitch_count.toLocaleString('en')),
          `denser fill updates the preview (${before} -> ${denser.stats.stitch_count} stitches)`);

        if (image.file === 'cafe-luna.jpg') {
          await writeFile(join(fixtures, 'config.json'), JSON.stringify(await (await fetch(`${API}/config`)).json(), null, 2));
          await writeFile(join(fixtures, 'upload.json'), JSON.stringify(created, null, 2));
          await writeFile(join(fixtures, 'design.json'), JSON.stringify(await (await fetch(`${API}/designs/${created.id}`)).json(), null, 2));
          await writeFile(join(fixtures, 'preview.json'), JSON.stringify(preview));
          await writeFile(join(fixtures, 'shapes.json'), JSON.stringify(await (await fetch(`${API}/designs/${created.id}/shapes`)).json()));
        }

        // The editor button opens the editor screen.
        await page.getByRole('button', { name: 'Fix stitches in the editor' }).click();
        await page.waitForURL(/\/editor\?design=/);
        await page.locator('.hoop-canvas').waitFor();
        check(await page.evaluate(() => document.body.className) === 'editor', 'Fix stitches in the editor opens the editor');
      }
    }

    // ---------- landing ----------
    console.log('-- landing');
    await page.goto(`${WEB}/`);
    await page.getByText('machine file', { exact: true }).waitFor();
    check((await page.locator('.hero__facts').innerText()).startsWith('DST'), 'landing lists the formats from the API (DST)');
    check(await page.getByText('[Demo video]').isVisible(), 'empty demo_video_url shows the [Demo video] poster');
    const handedOff = page.waitForResponse((r) => r.url() === `${API}/designs` && r.request().method() === 'POST');
    await page.locator('.hero-drop input[type=file]').setInputFiles(join(web, 'scripts', 'test-images', 'cafe-luna.jpg'));
    await page.waitForURL(`${WEB}/upload`);
    check((await handedOff).status() === 201, 'a file chosen in the hero upload box opens Upload and is uploaded');
    await page.locator('.flow-checks li').first().waitFor();
    await page.locator('.flow-drop__image').waitFor();
    check((await page.locator('.flow-drop__file').innerText()).startsWith('cafe-luna.jpg'), 'Upload shows the handed-off file');
    await page.route(`${API}/site`, (r) => r.fulfill({ json: { app_name: 'Stitchbook', demo_video_url: 'https://example.com/demo.mp4', export_formats: ['dst'] } }));
    await page.goto(`${WEB}/`);
    await page.locator('video.demo__video').waitFor();
    check(await page.getAttribute('video.demo__video', 'src') === 'https://example.com/demo.mp4', 'a configured video URL renders a player with that URL');
    await page.unroute(`${API}/site`);

    // ---------- editor: Create satin columns (real Redis + worker) ----------
    if (vp.name === 'desktop') {
      console.log('-- create satin columns');
      const form = new FormData();
      form.append('file', new Blob([await readFile(join(web, 'scripts', 'test-images', 'cafe-luna.jpg'))]), 'cafe-luna.jpg');
      form.append('settings', JSON.stringify({ width_mm: 80 }));
      const traceDesign = (await (await fetch(`${API}/designs`, { method: 'POST', body: form })).json()).id;
      const editorUrl = `${WEB}/editor?design=${traceDesign}`;
      const card = () => page.locator('.trace-card').innerText();
      await page.goto(editorUrl);
      await page.locator('[data-state=idle]').waitFor();
      const apiShapes = await (await fetch(`${API}/designs/${traceDesign}/shapes`)).json();
      await page.locator('.design-shape').first().waitFor();
      check(await page.locator('.design-shape').count() === apiShapes.shapes.length && await page.locator('.layers .layer').count() === apiShapes.shapes.length
        && await page.locator('.hoop-ring').count() === 0, `the canvas and Layers show the uploaded design's ${apiShapes.shapes.length} shapes (no demo ring)`);
      await page.getByRole('button', { name: 'Trace', exact: true }).click();
      await page.locator('[data-state=queued]').waitFor();
      await shot('editor-trace-queued');
      await page.getByRole('button', { name: 'Cancel job' }).click();
      await page.locator('[data-state=cancelled]').waitFor();
      const firstJob = (await (await fetch(`${API}/designs/${traceDesign}`)).json()).trace_job_id;
      check((await (await fetch(`${API}/jobs/${firstJob}`)).json()).status === 'cancelled', 'cancel while queued: the server job is cancelled');

      startWorker();
      await page.getByRole('button', { name: 'Trace', exact: true }).click();
      await page.getByText('Getting your layer ready').waitFor({ timeout: 30000 });
      await page.waitForTimeout(2200);
      const elapsedBefore = (await card()).match(/Time elapsed (\d+):(\d+)/);
      await shot('editor-trace-running');
      await page.reload();
      await page.getByText('Getting your layer ready').waitFor({ timeout: 10000 });
      const elapsedAfter = (await card()).match(/Time elapsed (\d+):(\d+)/);
      const secs = (m) => m ? Number(m[1]) * 60 + Number(m[2]) : -1;
      check(secs(elapsedAfter) >= secs(elapsedBefore) && secs(elapsedBefore) >= 2,
        `reload during a running job resumes the card (elapsed ${elapsedBefore?.[0]} -> ${elapsedAfter?.[0]}, from the server's start time)`);
      await page.getByRole('button', { name: 'Cancel job' }).click();
      await page.locator('[data-state=cancelled]').waitFor({ timeout: 20000 });
      const secondJob = (await (await fetch(`${API}/designs/${traceDesign}`)).json()).trace_job_id;
      check((await (await fetch(`${API}/jobs/${secondJob}`)).json()).status === 'cancelled', 'cancel while running: the worker stops the job');
      await shot('editor-trace-cancelled');

      await page.getByRole('button', { name: 'Trace', exact: true }).click();
      await page.locator('[data-state=done]').waitFor({ timeout: 60000 });
      const columns = await page.locator('.traced__column').count();
      check(columns > 0 && (await card()).includes(`${columns} satin columns`), `done: card collapses to "Traced" and ${columns} numbered columns appear`);
      await shot('editor-trace-done');
      await page.goto(`${WEB}/`);
      await page.goto(editorUrl);
      await page.locator('[data-state=done]').waitFor();
      check(await page.locator('.traced__column').count() === columns, 'leaving and reopening the design restores "Traced"');

      await page.locator('.manual__row', { hasText: 'Split' }).click();
      check(await page.locator('.manual__row', { hasText: 'Split' }).getAttribute('aria-pressed') === 'true'
        && (await page.locator('.stats').innerText()).includes('Split tool on'), 'Split row activates the Split tool');
      await page.locator('.manual__row', { hasText: 'Select Satin Columns' }).click();
      check(await page.locator('.manual__row', { hasText: 'Select Satin Columns' }).getAttribute('aria-pressed') === 'true',
        'Select Satin Columns row activates that tool');

      // Redis stops: the card says so plainly and offers Retry; Retry works once it is back.
      redisProc.kill();
      await new Promise((r) => redisProc.once('exit', r));
      await page.goto(editorUrl);
      await page.locator('[data-state=unavailable]').waitFor({ timeout: 15000 });
      check((await card()).includes('Background jobs are not running, so satin columns cannot be traced right now.') && (await card()).includes('Retry'),
        'Redis stopped: "Background jobs are not running…" with Retry (no endless Loading…)');
      await shot('editor-trace-unavailable');
      redisProc = startRedis();
      for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`${API}/jobs/health`)).ok) break; } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.locator('[data-state=done]').waitFor({ timeout: 15000 });
      check(await page.locator('.traced__column').count() === columns, 'Redis back: Retry restores the traced result');
    }

    // ---------- states ----------
    console.log('-- states');
    await page.goto(`${WEB}/upload`);
    await page.getByText('Drop your logo here').waitFor();
    await shot('state-upload-empty');
    await page.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
    await page.getByText("This file can't be used").waitFor();
    check((await page.locator('[role=alert]').innerText()).includes('not a PNG, JPG or SVG'), 'upload error shows the API message');
    check(await page.getByRole('button', { name: 'Try again' }).isVisible(), 'upload error has Try again');
    await shot('state-upload-error');

    await page.route(`${API}/designs`, (route) => route.abort());
    await page.locator('input[type=file]').setInputFiles(join(web, 'scripts', 'test-images', 'cafe-luna.jpg'));
    await page.getByText("Can't reach the Stitchbook server").waitFor();
    await page.unroute(`${API}/designs`);
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.locator('.flow-checks li').first().waitFor();
    check(true, 'upload retry after a network failure succeeds');

    await page.route(`${API}/config`, (route) => route.abort());
    await page.goto(`${WEB}/upload`);
    await page.getByText("The upload page can't start").waitFor();
    await shot('state-upload-config-error');
    await page.unroute(`${API}/config`);
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByText('Drop your logo here').waitFor();
    check(true, 'upload page recovers when the server comes back');

    await page.goto(`${WEB}/preview`);
    await page.getByText('No design to preview yet').waitFor();
    await shot('state-preview-empty');

    await page.goto(`${WEB}/preview/${'0'.repeat(32)}`);
    await page.getByText("The preview couldn't be made").waitFor();
    check((await page.locator('[role=alert]').innerText()).includes('No design with id'), 'preview error shows the API message');
    await shot('state-preview-error');

    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/preview', async (route) => { await gate; await route.continue(); });
    const design = await (await fetch(`${API}/designs`, { method: 'POST', body: (() => {
      const f = new FormData(); f.append('file', new Blob([execFileSync('cat', [join(web, 'scripts', 'test-images', 'cafe-luna.jpg')])]), 'cafe-luna.jpg'); return f;
    })() })).json();
    await page.goto(`${WEB}/preview/${design.id}?width=80`);
    await page.getByText('Turning your logo into stitches').waitFor();
    await shot('state-preview-loading');
    release();
    await page.getByRole('heading', { name: 'Summary' }).waitFor();
    await page.unroute('**/preview');
    check(true, 'preview loading state then result');
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
  apiProc.kill();
  workerProc?.kill();
  redisProc.kill();
}

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : 'all checks passed'}. Screenshots in web/screenshots/e2e/`);
process.exitCode = failures.length ? 1 : 0;
