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

import { clickAt, crossing } from './editor-helpers.mjs';

const web = resolve(new URL('..', import.meta.url).pathname);
const repo = resolve(web, '..');
const python = join(repo, '.venv', 'bin', 'python');
const shots = join(web, 'screenshots', 'e2e');
const fixtures = join(web, 'scripts', 'fixtures');
const API_PORT = 8765, WEB_PORT = 4173;
const API = `http://localhost:${API_PORT}`, WEB = `http://localhost:${WEB_PORT}`;
const BIRD = join(repo, 'digitizer', 'samples', 'bird.png'); // multi-colour sample (digitizer/samples/make_samples.py)
const IMAGES = [
  { file: 'cafe-luna.jpg', width: 80 },
  { file: 'fern-studio.png', width: 70 },
  { file: 'k-monogram-small.png', width: 40 },
  { file: 'bird.png', path: BIRD, width: 90, fixtures: true },
  // The same bird with the leaves and the branch unchecked under "Colours to keep".
  { file: 'bird.png', path: BIRD, width: 90, stem: 'bird-some-colours', drop: ['#5BAA46', '#7A4A2A'] },
];
const imagePath = (image) => image.path ?? join(web, 'scripts', 'test-images', image.file);
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
      const stem = image.stem ?? image.file.replace(/\.\w+$/, '');
      console.log(`-- ${stem}`);
      await page.goto(`${WEB}/upload`);
      await page.getByText('Drop your logo here').waitFor();
      const uploaded = page.waitForResponse((r) => r.url() === `${API}/designs` && r.request().method() === 'POST');
      await page.locator('input[type=file]').setInputFiles(imagePath(image));
      const created = await (await uploaded).json();
      await page.locator('.flow-checks li').first().waitFor();
      const shown = await page.locator('.flow-checks li').allInnerTexts();
      check(created.warnings.length === 0 ? shown.some((t) => t.includes('No problems found'))
        : created.warnings.every((w) => shown.some((t) => t.includes(w.message))), `upload shows the API's quality messages (${created.warnings.map((w) => w.code).join(', ') || 'none'})`);
      // Colours to keep: every detected colour, checked; unchecking updates the count.
      await page.locator('.flow-swatch').first().waitFor();
      const swatches = await page.locator('.flow-swatch').allInnerTexts();
      check(swatches.length === created.colours.length && created.colours.every((c, i) => swatches[i].startsWith(c.hex)),
        `Colours to keep lists the API's ${created.colours.length} detected colours (${created.colours.map((c) => c.hex).join(' ')}; background ${created.background ?? 'transparent'})`);
      for (const hex of image.drop ?? []) await page.locator('.flow-swatch', { hasText: hex }).locator('input').uncheck();
      const keptColours = created.colours.filter((c) => !(image.drop ?? []).includes(c.hex));
      check((await page.locator('.flow-colours__count').innerText()).startsWith(`${keptColours.length} of ${created.colours.length}`),
        `count shows ${keptColours.length} of ${created.colours.length} colours kept`);
      await page.fill('#width', String(image.width));
      const box = keptColours.map((c) => c.bounds_px).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
      const expectedHeight = (image.width * (box[3] - box[1])) / (box[2] - box[0]);
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
        && summary.includes(`${r.jumps}`) && summary.includes(`${s.color_count}`), `summary matches the API (${s.stitch_count} stitches, ${s.width_mm.toFixed(1)} × ${s.height_mm.toFixed(1)} mm, ${r.jumps} jumps, ${s.color_count} colours)`);
      check(preview.colours.map((c) => c.hex).join() === keptColours.map((c) => c.hex).join() && s.color_count === keptColours.length,
        `the preview sews exactly the kept colours (${preview.colours.length}, ${s.color_count - 1} colour changes)`);
      check(await page.locator('.flow-layer').count() === preview.layers.length && await page.locator('.flow-colour').count() === preview.colours.length,
        `layers list shows ${preview.layers.length} layers grouped under ${preview.colours.length} colours`);
      await page.locator('.flow-layer').first().click();
      await shot(`${stem}-preview`);

      if (vp.name === 'desktop') {
        // DST from the Download button == DST from the command line, byte for byte.
        const download = page.waitForEvent('download');
        await page.getByRole('link', { name: 'Download DST' }).click();
        const fromApi = await readFile(await (await download).path());
        const cli = join(storage, `cli-${stem}`);
        execFileSync(python, ['-m', 'digitizer.digitize', imagePath(image), '--out', cli,
          '--width-mm', String(image.width), '--test-run-values',
          ...(image.drop ? ['--colours', keptColours.map((c) => c.hex).join(',')] : [])], { cwd: repo });
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

        if (image.fixtures) {
          await writeFile(join(fixtures, 'config.json'), JSON.stringify(await (await fetch(`${API}/config`)).json(), null, 2));
          await writeFile(join(fixtures, 'upload.json'), JSON.stringify(created, null, 2));
          await writeFile(join(fixtures, 'design.json'), JSON.stringify(await (await fetch(`${API}/designs/${created.id}`)).json(), null, 2));
          await writeFile(join(fixtures, 'preview.json'), JSON.stringify(preview));
          execFileSync(python, [join(web, 'scripts', 'make-editor-fixture.py')], { cwd: repo, stdio: 'ignore' }); // editor.json
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
    await page.locator('.hero__facts strong', { hasText: 'DST' }).waitFor({ timeout: 10000 }).catch(() => {}); // after GET /site answers
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
      await page.locator('.traced__column').first().waitFor(); // drawn once the design's shapes have loaded
      check(await page.locator('.traced__column').count() === columns, 'leaving and reopening the design restores "Traced"');

      await page.locator('.manual__row', { hasText: 'Split' }).click();
      check(await page.locator('.manual__row', { hasText: 'Split' }).getAttribute('aria-pressed') === 'true'
        && (await page.locator('.tool-hint').innerText()).includes('Split: click a point on one edge'), 'Split row activates the Split tool');
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
      await page.locator('.traced__column').first().waitFor({ timeout: 60000 }); // drawn once the editor state has loaded
      check(await page.locator('.traced__column').count() === columns, 'Redis back: Retry restores the traced result');
    }

    // ---------- editor tools on the real engine ----------
    console.log('-- editor tools');
    {
      const uploadSample = async (name, width) => {
        const f = new FormData();
        f.append('file', new Blob([await readFile(join(repo, 'digitizer', 'samples', name))]), name);
        f.append('settings', JSON.stringify({ width_mm: width }));
        return (await (await fetch(`${API}/designs`, { method: 'POST', body: f })).json()).id;
      };
      const dst = async (id) => Buffer.from(await (await fetch(`${API}/designs/${id}/download?format=dst`)).arrayBuffer());
      const footerCount = async () => Number((await page.locator('.stats strong').first().innerText()).replace(/,/g, ''));
      const saved = () => page.waitForFunction(() => document.querySelector('.file__state')?.textContent === 'Saved', null, { timeout: 60000 });
      const bird = await uploadSample('bird.png', 90);
      await page.goto(`${WEB}/editor?design=${bird}`);
      await page.locator('.stitch-line').first().waitFor({ timeout: 60000 });
      const bounds = (await (await fetch(`${API}/designs/${bird}/shapes`)).json()).bounds_mm;
      const plainCount = await footerCount();
      const plainDst = await dst(bird);
      await shot('editor-real-open');

      // Stitch type: the stitches, the downloaded file and Preview all change; Undo and Redo work.
      await page.getByRole('button', { name: /^Shape 1 / }).click();
      await page.getByRole('radio', { name: 'Running' }).click();
      await page.getByRole('button', { name: 'Undo: Change a shape to Running' }).waitFor({ timeout: 60000 });
      const runningCount = await footerCount();
      const runningDst = await dst(bird);
      check(runningCount !== plainCount && Buffer.compare(runningDst, plainDst) !== 0,
        `type Fill -> Running changes the stitches (${plainCount} -> ${runningCount}) and the downloaded DST`);
      await shot('editor-real-running');
      await page.getByRole('button', { name: /^Undo:/ }).click();
      await page.getByRole('button', { name: 'Redo: Change a shape to Running' }).waitFor({ timeout: 60000 });
      check(await footerCount() === plainCount && Buffer.compare(await dst(bird), plainDst) === 0, 'Undo restores the stitches and the exact DST');
      await page.getByRole('button', { name: /^Redo:/ }).click();
      await page.getByRole('button', { name: 'Undo: Change a shape to Running' }).waitFor({ timeout: 60000 });
      check(await footerCount() === runningCount && Buffer.compare(await dst(bird), runningDst) === 0, 'Redo puts the change back, DST included');

      // Pull compensation on the satin branch.
      await page.getByRole('button', { name: /^Shape 7 / }).click();
      await page.locator('#pull').fill('0.8');
      const beforePull = await dst(bird);
      await page.getByRole('button', { name: 'Apply' }).click();
      await page.getByRole('button', { name: /Use the default/ }).waitFor({ timeout: 60000 });
      check(Buffer.compare(await dst(bird), beforePull) !== 0, 'pull compensation 0.8 mm on the branch changes the DST');
      await shot('editor-real-pull');

      // Split the branch.
      const state = await (await fetch(`${API}/designs/${bird}/shapes`)).json();
      const [a, b] = crossing(state.shapes.find((s) => s.number === 7), -30);
      const shapesBefore = await page.locator('.layers .layer').count();
      await page.getByRole('button', { name: /^Split/ }).click();
      await clickAt(page, bounds, a);
      await clickAt(page, bounds, b);
      await page.getByText('Saved: Split a satin shape.').waitFor({ timeout: 60000 });
      check(await page.locator('.layers .layer').count() === shapesBefore + 1, 'Split: the branch becomes two satin shapes');
      await shot('editor-real-split');

      // Draw edges: a new satin column between two drawn sides.
      const columnsText = async () => (await page.locator('.stats').innerText()).match(/(\d+) satin column/)[1];
      const columnsBefore = Number(await columnsText());
      await page.getByRole('button', { name: /^Draw edges/ }).first().click();
      for (const p of [[-40, -27], [-32, -27.5], [-25, -27]]) await clickAt(page, bounds, p);
      await page.getByRole('button', { name: 'Finish edge' }).click();
      for (const p of [[-40, -24], [-32, -24.5], [-25, -24]]) await clickAt(page, bounds, p);
      await page.getByRole('button', { name: 'Finish edge' }).click();
      await page.getByText('Saved: Satin column from drawn edges.').waitFor({ timeout: 60000 });
      check(Number(await columnsText()) === columnsBefore + 1, `Draw edges adds a satin column (${columnsBefore} -> ${columnsBefore + 1})`);
      await shot('editor-real-draw');

      // A failed save: plain message, Retry sends it again.
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: /^Shape 1 / }).click();
      await page.route(`${API}/designs/${bird}/edits`, (r) => r.abort());
      await page.getByRole('radio', { name: 'Satin' }).click();
      await page.locator('.edit-error').waitFor();
      check((await page.locator('.edit-error').innerText()).includes("Can't reach the Stitchbook server"), 'no connection: "Not saved" with the reason');
      await shot('editor-real-error');
      await page.unroute(`${API}/designs/${bird}/edits`);
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.locator('.edit-error').waitFor({ state: 'detached', timeout: 60000 });
      await saved();
      check((await page.locator('.segmented[aria-labelledby="stitch-type"] [aria-checked="true"]').innerText()) === 'Satin', 'Retry saves it');

      // Preview and Download reflect every change.
      const editorCount = await footerCount();
      await page.goto(`${WEB}/preview/${bird}`);
      await page.getByRole('heading', { name: 'Summary' }).waitFor({ timeout: 60000 });
      check((await page.locator('.flow-summary').innerText()).includes(editorCount.toLocaleString('en')),
        `Preview shows the edited design (${editorCount} stitches)`);
      await shot('editor-real-preview');

      // Select Satin Columns on a ring: its outline and its hole become one column.
      const ring = await uploadSample('thin_ring.png', 40);
      await page.goto(`${WEB}/editor?design=${ring}`);
      await page.locator('.stitch-line').first().waitFor({ timeout: 60000 });
      await page.getByRole('button', { name: /^Select Satin Columns/ }).click();
      await page.getByRole('button', { name: 'Outline of shape 1' }).dispatchEvent('click');
      await shot('editor-real-columns-pick');
      await page.getByRole('button', { name: 'Hole 1 of shape 1' }).dispatchEvent('click');
      await page.getByText('Saved: Satin column from two outlines.').waitFor({ timeout: 60000 });
      check((await page.locator('.layer__kind').first().innerText()) === 'Satin column', 'Select Satin Columns: the ring is now one satin column');
      await shot('editor-real-columns');
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
