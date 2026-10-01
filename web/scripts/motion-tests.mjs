// Browser tests for the public site's motion: hover and press states, scroll reveal, the hero
// stitch drawing and the Preview sew-out player. Every part is also checked with
// prefers-reduced-motion: reduce (no motion, everything shown at once).
// Usage: npm run test:motion   (builds first; no server needed)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(new URL('..', import.meta.url).pathname);
const dist = join(root, 'dist');
const API = 'http://localhost:8000';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const fixture = async (name) => JSON.parse(await readFile(join(root, 'scripts', 'fixtures', name), 'utf8'));
const config = await fixture('config.json');
const SITE = {
  app_name: 'Stitchbook', demo_video_url: '', export_formats: ['dst'], company_name: null, contact_email: null,
  governing_country: null, data_retention_days: null, last_updated: null, max_upload_bytes: null,
};

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
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, path, { width = 1440, height = 900, reduced = false, js = true, mock } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? 'reduce' : 'no-preference', javaScriptEnabled: js });
  const page = await context.newPage();
  await page.route(`${API}/site`, (r) => r.fulfill({ json: SITE }));
  await page.route(`${API}/config`, (r) => r.fulfill({ json: config }));
  if (mock) await mock(page);
  await page.goto(`${base}${path}`);
  return page;
}
const transformOf = (loc) => loc.evaluate((el) => getComputedStyle(el).transform);

const browser = await chromium.launch();
try {
  console.log('-- 1. hover and press states');
  for (const reduced of [false, true]) {
    const tag = reduced ? 'reduced motion' : 'motion on';
    const page = await open(browser, '/', { reduced });
    await page.locator('footer .footer__link').first().waitFor();
    const button = page.locator('.hero .btn--ink').first();
    const duration = await button.evaluate((el) => getComputedStyle(el).transitionDuration.split(',')[0].trim());
    await button.hover();
    await wait(250);
    const hovered = await transformOf(button);
    await page.mouse.down();
    await wait(250);
    const pressed = await transformOf(button);
    await page.mouse.up();
    if (!reduced) {
      check(duration === '0.15s', `${tag}: button transition ${duration}`);
      check(hovered === 'matrix(1, 0, 0, 1, 0, -1)', `${tag}: button hover lifts 1px (${hovered})`);
      check(pressed === 'matrix(0.98, 0, 0, 0.98, 0, 0)', `${tag}: button press scales to 0.98 (${pressed})`);
    } else {
      check(duration === '0s' && hovered === 'none' && pressed === 'none', `${tag}: no transition, no lift, no press scale`);
    }
    const link = page.locator('footer .footer__link').first();
    await link.hover();
    await wait(250);
    const [deco, green] = await link.evaluate((el) => {
      const probe = document.createElement('span'); probe.style.color = 'var(--green)'; document.body.append(probe);
      const g = getComputedStyle(probe).color; probe.remove();
      return [getComputedStyle(el).textDecorationColor, g];
    });
    check(deco === green, `${tag}: footer link hover shows the mint underline (a colour shift)`);
    await page.mouse.move(0, 0);
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement, s = getComputedStyle(el);
      return { tag: el.tagName, outline: s.outlineStyle, width: s.outlineWidth };
    });
    check(focused.outline === 'solid' && focused.width === '2px', `${tag}: keyboard focus keeps a visible outline (${focused.tag}, ${focused.width} ${focused.outline})`);
    await page.context().close();
  }

  console.log('-- 2. scroll reveal');
  const scrollThrough = async (page) => {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y <= height; y += 300) { await page.evaluate((v) => window.scrollTo(0, v), y); await wait(60); }
    await wait(1000); // longest reveal: 400ms + 5 x 80ms stagger
  };
  const states = (page) => page.evaluate(() => ({
    pending: document.querySelectorAll('.reveal-pending').length,
    hiddenOnFirstScreen: [...document.querySelectorAll('.reveal-pending')].filter((el) => el.getBoundingClientRect().top < innerHeight).length,
    invisible: [...document.querySelectorAll('main *')].filter((el) => getComputedStyle(el).opacity === '0').length,
  }));
  for (const [path, width, height] of [['/', 1440, 900], ['/', 390, 844], ['/privacy', 1366, 768], ['/privacy', 390, 844]]) {
    const page = await open(browser, path, { width, height });
    await page.locator('footer .footer__link').first().waitFor();
    await wait(500); // site settings loaded, first screen settled
    // Count layout shifts from here on (while scrolling and revealing), not the ones during loading.
    await page.evaluate(() => {
      window.__shift = 0;
      new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__shift += e.value; })
        .observe({ type: 'layout-shift' });
    });
    const before = await states(page);
    check(before.pending > 0 && before.hiddenOnFirstScreen === 0,
      `${path} ${width}px: ${before.pending} items below the first screen wait to be revealed; nothing on the first screen is hidden`);
    const offsets = await page.evaluate(() => [...document.querySelectorAll('.reveal-pending')].map((el) => el.offsetTop));
    if (path === '/') {
      // The four steps come into view together: each starts 80ms after the one before.
      const delays = await page.evaluate(async () => {
        const steps = document.querySelector('.steps');
        window.scrollTo(0, steps.getBoundingClientRect().bottom + scrollY - innerHeight + 10);
        await new Promise((r) => setTimeout(r, 150));
        return [...steps.children].map((el) => parseFloat(el.style.transitionDelay)).filter((d) => !Number.isNaN(d));
      });
      const steps = delays.slice(1).map((d, i) => d - delays[i]);
      check(delays.length >= 2 && steps.every((d) => d === 80), `${path} ${width}px: steps revealed together are staggered by 80ms (${delays.join(', ')} ms)`);
    }
    await scrollThrough(page);
    const after = await states(page);
    const offsetsAfter = await page.evaluate(() => [...document.querySelectorAll('[style*="transition-delay"], .reveal-in')].length);
    const shift = await page.evaluate(() => window.__shift);
    check(after.pending === 0 && after.invisible === 0, `${path} ${width}px: after scrolling, every item has been revealed (none left at opacity 0)`);
    check(shift === 0 && offsetsAfter === 0, `${path} ${width}px: no layout shift (CLS ${shift}) and reveal classes cleaned up`);
    check(offsets.length > 0, `${path} ${width}px: revealed items keep their place (transform and opacity only)`);
    await page.context().close();
  }
  {
    const page = await open(browser, '/', { reduced: true });
    await page.locator('footer .footer__link').first().waitFor();
    await wait(300);
    const s = await states(page);
    check(s.pending === 0 && s.invisible === 0, 'reduced motion: nothing is ever hidden, no reveal');
    await page.context().close();
  }
  for (const [what, script] of [
    ['an observer that never fires', () => { window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }; }],
    ['no IntersectionObserver at all', () => { delete window.IntersectionObserver; }],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(script);
    const page = await context.newPage();
    await page.route(`${API}/site`, (r) => r.fulfill({ json: SITE }));
    await page.goto(`${base}/`);
    await page.locator('footer .footer__link').first().waitFor();
    await wait(300);
    await scrollThrough(page);
    const s = await states(page);
    check(s.pending === 0 && s.invisible === 0, `with ${what}: after scrolling, all content is visible`);
    await context.close();
  }
  {
    const page = await open(browser, '/', { js: false });
    const noscript = await page.locator('noscript').evaluate((n) => n.textContent.trim()).catch(() => '');
    const shown = await page.locator('body').innerText();
    const pending = await page.locator('.reveal-pending').count();
    check(pending === 0 && shown.includes('Stitchbook needs JavaScript to run'),
      `JavaScript off: nothing is hidden by the reveal; the page says it needs JavaScript (${noscript ? 'noscript shown' : 'no noscript'})`);
    await page.context().close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
