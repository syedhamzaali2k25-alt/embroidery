// The web app sends one preview (and one editor load) per design at a time. In development React
// StrictMode runs every effect twice, which used to send two POST /designs/{id}/preview at once
// (on Windows the second one could hit a locked preview.png). Runs the Vite dev server, where
// StrictMode is active, with a mocked API, and counts the requests.
// Usage: npm run test:once
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { editorFixture } from './editor-helpers.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const fixture = async (name) => JSON.parse(await readFile(join(root, 'scripts', 'fixtures', name), 'utf8'));
const [config, design, preview] = await Promise.all(['config.json', 'design.json', 'preview.json'].map(fixture));
const API = 'http://localhost:8000';
const ID = 'd'.repeat(32);
const PORT = 5199;

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
const base = `http://localhost:${PORT}`;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const counts = { preview: 0, editor: 0 };
  await page.route(`${API}/config`, (r) => r.fulfill({ json: config }));
  await page.route(`${API}/site`, (r) => r.fulfill({ json: { app_name: 'Stitchbook', demo_video_url: '', export_formats: ['dst'] } }));
  await page.route(`${API}/designs/${ID}`, (r) => r.fulfill({ json: { ...design, id: ID, trace_job_id: null } }));
  await page.route(`${API}/jobs/health`, (r) => r.fulfill({ json: { status: 'ok', workers: 1 } }));
  await page.route(`${API}/designs/${ID}/preview`, async (r) => {
    counts.preview++;
    await new Promise((done) => setTimeout(done, 500)); // still running when the second effect fires
    return r.fulfill({ json: { ...preview, id: ID } });
  });
  await page.route(`${API}/designs/${ID}/editor`, async (r) => {
    counts.editor++;
    await new Promise((done) => setTimeout(done, 500));
    return r.fulfill({ json: { ...editorFixture, id: ID } });
  });

  await page.goto(`${base}/preview/${ID}?width=90`);
  await page.getByRole('heading', { name: 'Summary' }).waitFor({ timeout: 60000 });
  check(counts.preview === 1, `Preview page (StrictMode, dev server): ${counts.preview} preview request(s), expected 1`);

  await page.goto(`${base}/editor?design=${ID}`);
  await page.locator('.stitch-line').first().waitFor({ timeout: 60000 });
  check(counts.editor === 1, `Editor (StrictMode, dev server): ${counts.editor} editor load(s), expected 1`);

  // A new preview after the first has finished is sent (the guard is only for one at a time).
  await page.goto(`${base}/preview/${ID}?width=90`);
  await page.getByRole('heading', { name: 'Summary' }).waitFor({ timeout: 60000 });
  check(counts.preview === 2, 'opening Preview again later sends a new request');
} finally {
  await browser.close();
  vite.kill();
}
console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
