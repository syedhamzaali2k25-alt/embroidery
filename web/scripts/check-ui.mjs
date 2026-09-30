// Screenshots every screen at desktop and phone width, then audits:
//  - text contrast against the effective background (WCAG 2.x ratios)
//  - the "white text only on ink" rule
//  - clipped or overflowing text, and horizontal page scroll
// Usage: npm run check:ui   (builds the app, then serves dist/ with a fallback to index.html)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const outDir = join(root, 'screenshots');
const dist = join(root, 'dist');
// API responses recorded from the real API by `npm run e2e` (scripts/fixtures), so the audit
// needs no running server. The Upload and Preview screens are audited in every state.
const fixture = async (name) => JSON.parse(await readFile(join(root, 'scripts', 'fixtures', name), 'utf8'));
const fx = { config: await fixture('config.json'), upload: await fixture('upload.json'), design: await fixture('design.json'), preview: await fixture('preview.json'), shapes: await fixture('shapes.json') };
const testImage = join(root, 'scripts', 'test-images', 'cafe-luna.jpg');
const traceResult = await fixture('trace-result.json');

// Editor "Create satin columns" card: one mocked job per state (the done state uses a real trace).
const JOB_ID = 'b'.repeat(32);
function jobFor(status) {
  const now = new Date();
  const started = new Date(now.getTime() - 83_000).toISOString();
  return {
    id: JOB_ID, design_id: fx.upload.id, kind: 'trace', status, created_at: started,
    started_at: status === 'queued' ? null : started, finished_at: null, server_time: now.toISOString(),
    progress: status === 'running' ? 0.42 : status === 'done' ? 1 : null, cancel_requested: false,
    error: status === 'failed' ? 'The logo could not be traced (no logo found after thresholding and speck removal). Use a dark logo on a plain light background, or a transparent PNG.' : null,
    result: status === 'done' ? traceResult : null,
  };
}
const QUEUE_DOWN = 'Background jobs are not running, so satin columns cannot be traced right now.';
/** status: a job state, or 'idle' (no job yet), 'unavailable' (Redis down), 'loading' / 'timeout' (no answer). */
async function mockEditor(page, status, estimate = null) {
  const timeout = status === 'timeout' ? 1 : 10;
  await page.route(`${API}/config`, (r) => r.fulfill({ json: { ...fx.config, trace_estimate_minutes: estimate, poll_start_s: 2, poll_max_s: 15, poll_backoff_factor: 2, status_timeout_s: timeout } }));
  await page.route(`${API}/designs/${fx.upload.id}`, (r) => r.fulfill({ json: { ...fx.design, trace_job_id: status === 'idle' ? null : JOB_ID } }));
  await page.route(`${API}/designs/${fx.upload.id}/shapes`, (r) => r.fulfill({ json: fx.shapes }));
  await page.route(`${API}/jobs/health`, (r) => {
    if (status === 'unavailable') return r.fulfill({ status: 503, json: { error: QUEUE_DOWN } });
    if (status === 'loading' || status === 'timeout') return; // never answers
    return r.fulfill({ json: { status: 'ok', workers: 1 } });
  });
  await page.route(`${API}/jobs/${JOB_ID}`, (r) => r.fulfill({ json: jobFor(status) }));
}
const editorRoute = `/editor?design=${fx.upload.id}`;

// The app is built with the default API address; only requests to it are mocked (not the
// app's own /preview page).
const API = 'http://localhost:8000';

async function mockApi(page, { upload = 'ok', preview = 'ok' } = {}) {
  // Landing: product values (no demo video yet, DST only).
  await page.route(`${API}/site`, (r) => r.fulfill({ json: { app_name: 'Stitchbook', demo_video_url: '', export_formats: ['dst'] } }));
  await page.route(`${API}/config`, (r) => r.fulfill({ json: fx.config }));
  await page.route(`${API}/designs`, (r) => upload === 'ok'
    ? r.fulfill({ status: 201, json: fx.upload })
    : r.fulfill({ status: 415, json: { error: 'This file is not a PNG, JPG or SVG image. Export your logo in one of those formats and upload it again.' } }));
  await page.route(new RegExp(`^${API}/designs/[0-9a-f]{32}$`), (r) => r.fulfill({ json: fx.design }));
  await page.route(`${API}/designs/*/preview`, (r) => {
    if (preview === 'ok') return r.fulfill({ json: fx.preview });
    if (preview === 'error') return r.fulfill({ status: 404, json: { error: `No design with id ${fx.upload.id}. Upload the image again with POST /designs.` } });
    // 'loading': never answer
  });
}

// name -> route (+ API mocks, an action, and what to wait for). Screenshot files for the first
// three keep the names used by the static site.
const previewRoute = `/preview/${fx.upload.id}?width=80`;
const pages = {
  index: { route: '/', api: {}, ready: 'text=machine file' },
  'index-faq-open': { route: '/', api: {}, ready: 'text=machine file', click: '.faq__row summary' },
  home: { route: '/home' },
  editor: { route: '/editor' },
  upload: { route: '/upload', api: {}, ready: 'text=Drop your logo here' },
  'upload-checked': { route: '/upload', api: {}, file: true, ready: '.flow-swatch' },
  'upload-error': { route: '/upload', api: { upload: 'error' }, file: true, ready: "text=This file can't be used" },
  preview: { route: previewRoute, api: {}, ready: 'text=Summary' },
  'preview-loading': { route: previewRoute, api: { preview: 'loading' }, ready: 'text=Turning your logo into stitches' },
  'preview-error': { route: previewRoute, api: { preview: 'error' }, ready: "text=The preview couldn't be made" },
  'preview-empty': { route: '/preview', api: {}, ready: 'text=No design to preview yet' },
  'editor-trace-loading': { route: editorRoute, editor: ['loading'], ready: '[data-state=loading]' },
  'editor-trace-unavailable': { route: editorRoute, editor: ['unavailable'], ready: '[data-state=unavailable]' },
  'editor-trace-timeout': { route: editorRoute, editor: ['timeout'], ready: '[data-state=unavailable]' },
  'editor-trace-idle': { route: editorRoute, editor: ['idle'], ready: '[data-state=idle]' },
  'editor-trace-queued': { route: editorRoute, editor: ['queued', 3], ready: '[data-state=queued]' },
  'editor-trace-running': { route: editorRoute, editor: ['running', 3], ready: 'text=Getting your layer ready' },
  'editor-trace-done': { route: editorRoute, editor: ['done'], ready: '.traced__column' },
  'editor-trace-failed': { route: editorRoute, editor: ['failed'], ready: '[data-state=failed]' },
  'editor-trace-cancelled': { route: editorRoute, editor: ['cancelled'], ready: '[data-state=cancelled]' },
};
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    const body = await readFile(join(dist, path));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    if (extname(path)) return res.writeHead(404).end();
    // Client-side routes (/home, /preview/<id>) all load the app shell.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(join(dist, 'index.html')));
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const report = [];

function audit() {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const same = (a, b) => a.r === b.r && a.g === b.g && a.b === b.b;
  const css = getComputedStyle(document.documentElement);
  const tok = (n) => { const d = document.createElement('div'); d.style.color = css.getPropertyValue(n); document.body.append(d); const c = parse(getComputedStyle(d).color); d.remove(); return c; };
  const ink = tok('--ink'), white = tok('--white');

  // Background candidates behind an element: first opaque colour, or every stop of a gradient.
  const backgrounds = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      const bg = parse(s.backgroundColor);
      if (bg && bg.a > 0.5) return [bg];
      if (s.backgroundImage.includes('linear-gradient')) {
        return [...s.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0]));
      }
    }
    return [white];
  };

  const issues = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent.trim();
    const el = node.parentElement;
    if (!text || seen.has(el)) continue;
    seen.add(el);
    const s = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (s.visibility === 'hidden' || rect.width === 0 || el.closest('.visually-hidden,[hidden]')) continue;

    const size = parseFloat(s.fontSize), weight = Number(s.fontWeight);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const fg = parse(s.color);
    const bgs = backgrounds(el);
    const worst = Math.min(...bgs.map((b) => ratio(fg, b)));
    const label = `<${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''}> "${text.slice(0, 40)}"`;
    if (worst < need) issues.push({ kind: 'contrast', label, ratio: +worst.toFixed(2), need, fontSize: size });
    if (same(fg, white) && !bgs.every((b) => same(b, ink))) issues.push({ kind: 'white-text-off-ink', label });

    // Clipping: content wider/taller than a clipping box, or pushed off-screen.
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const ns = getComputedStyle(n);
      const clipsX = ns.overflowX !== 'visible', clipsY = ns.overflowY !== 'visible';
      if ((clipsX && n.scrollWidth > n.clientWidth + 1 && ns.overflowX === 'hidden') ||
          (clipsY && n.scrollHeight > n.clientHeight + 1 && ns.overflowY === 'hidden')) {
        const nr = n.getBoundingClientRect();
        if (rect.right > nr.right + 1 || rect.bottom > nr.bottom + 1 || rect.left < nr.left - 1 || rect.top < nr.top - 1) {
          issues.push({ kind: 'clipped', label, by: n.className || n.tagName });
        }
        break;
      }
    }
    if (el.scrollWidth > el.clientWidth + 1 && s.overflowX !== 'visible') issues.push({ kind: 'clipped', label, by: 'self' });
    if (rect.right > innerWidth + 1 || rect.left < -1) issues.push({ kind: 'off-screen', label });
  }
  if (document.documentElement.scrollWidth > innerWidth) {
    issues.push({ kind: 'horizontal-scroll', label: `page is ${document.documentElement.scrollWidth}px wide` });
  }
  // A face counts only if it actually finished loading (fonts.check() is true for undeclared families).
  const loaded = (family) => [...document.fonts].some((f) => f.family.replace(/"/g, '') === family && f.status === 'loaded');
  const usesSerif = !!document.querySelector('.accent');
  const fonts = { sans: loaded('DM Sans'), serif: usesSerif ? loaded('DM Serif Display') : 'unused' };
  if (!fonts.sans || fonts.serif === false) issues.push({ kind: 'font-not-loaded', label: JSON.stringify(fonts) });
  return { issues, fonts };
}

for (const vp of viewports) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  for (const [name, spec] of Object.entries(pages)) {
    await page.unrouteAll();
    if (spec.api) await mockApi(page, spec.api);
    if (spec.editor) await mockEditor(page, ...spec.editor);
    await page.goto(`${base}${spec.route}`, { waitUntil: spec.ready ? 'load' : 'networkidle' });
    if (spec.file) await page.locator('input[type=file]').setInputFiles(testImage);
    if (spec.ready) await page.locator(spec.ready).first().waitFor();
    if (spec.editor) await page.locator('.design-shape').first().waitFor(); // the design's shapes are drawn
    if (spec.click) for (const el of await page.locator(spec.click).all()) await el.click();
    await page.evaluate(() => document.fonts.ready);
    const file = join(outDir, `${name}-${vp.name}.png`);
    await page.screenshot({ path: file, fullPage: !name.startsWith('editor') || vp.name === 'phone' });
    const { issues, fonts } = await page.evaluate(audit);
    report.push({ page: name, viewport: vp.name, fonts, issues });
  }
  await page.close();
}

await browser.close();
server.close();
await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

let failures = 0;
for (const r of report) {
  console.log(`\n${r.page} @ ${r.viewport}  fonts: sans=${r.fonts.sans} serif=${r.fonts.serif}`);
  if (!r.issues.length) console.log('  ok');
  for (const i of r.issues) {
    failures++;
    console.log(`  ${i.kind.padEnd(18)} ${i.label}${i.ratio ? `  ${i.ratio}:1 (needs ${i.need}:1, ${i.fontSize}px)` : ''}${i.by ? `  by ${i.by}` : ''}`);
  }
}
console.log(`\n${failures} issue(s). Screenshots in web/screenshots/`);
process.exitCode = failures ? 1 : 0;
