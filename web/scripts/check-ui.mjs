// Screenshots every screen at desktop and phone width, then audits:
//  - text contrast against the effective background (WCAG 2.x ratios)
//  - the "white text only on ink" rule
//  - clipped or overflowing text, and horizontal page scroll
// Usage: npm run check:ui   (serves the folder on a local port)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const outDir = join(root, 'screenshots');
const pages = ['index', 'home', 'editor'];
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    const body = await readFile(join(root, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
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
  for (const name of pages) {
    await page.goto(`${base}/${name}.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const file = join(outDir, `${name}-${vp.name}.png`);
    await page.screenshot({ path: file, fullPage: name !== 'editor' || vp.name === 'phone' });
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
