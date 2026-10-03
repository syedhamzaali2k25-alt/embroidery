// The public home page (Step 14b), as visitors get it: a PRODUCTION build with sign-in (stand-in
// Supabase and API, answered by Playwright, as in auth-tests.mjs), signed out and signed in, at
// 1366, 768 and 360 px. Screenshots of the top of the page, every section and the footer go to
// docs/screenshots/landing-<state>-<width>-<part>.png, each audited (contrast, clipping, overflow).
// Also: the hero (one promise, one primary and one secondary button, the cost line from config,
// the before/after with alt text), the plan buttons in both states and with a payment provider,
// no owner-decision placeholders in production (but in a test build), headings, touch targets,
// focus rings, the sticky header and anchored sections, the mobile menu by keyboard, reduced
// motion, the lazy demo video, preloaded fonts and layout shift.
// Usage: npm run test:landing   (builds dist-landing-fixture/ and dist-landing-dev/)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

import { audit } from './audit.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const repo = resolve(root, '..');
const shots = join(repo, 'docs', 'screenshots');
const API = 'http://localhost:8000';
const SUPABASE = 'https://stub.supabase.test';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const VIEWPORTS = [['1366', 1366, 768], ['768', 768, 1024], ['360', 360, 780]];
const config = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'config.json'), 'utf8'));

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

console.log('-- building: production with sign-in, and a test build (placeholders shown)');
const prod = join(root, 'dist-landing-fixture');
const dev = join(root, 'dist-landing-dev');
const env = { ...process.env, SUPABASE_URL: SUPABASE, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_stub', VITE_GOOGLE_CLIENT_ID: '' };
execFileSync('npx', ['vite', 'build', '--outDir', prod, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit', env });
execFileSync('npx', ['vite', 'build', '--mode', 'offline', '--outDir', dev, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit', env });

// What the API answers, computed by the real code from config.py.
const python = [join(repo, '.venv', 'bin', 'python'), join(repo, '.venv', 'Scripts', 'python.exe')].find(existsSync) ?? 'python3';
const fromPython = (code) => JSON.parse(execFileSync(python, ['-c', code], { cwd: repo }).toString());
const PLANS = { ...fromPython('import json\nfrom digitizer.config import load_config\nfrom stitchbook_api.plans import plans\nprint(json.dumps(plans(load_config())))'), payments_available: false };
const APP = fromPython('import json\nfrom digitizer.config import load_config\nprint(json.dumps(load_config().get("app.name")))');
const SITE = { app_name: APP, demo_video_url: '', export_formats: ['dst'], company_name: null, contact_email: null, governing_country: null,
  data_retention_days: null, last_updated: null, max_upload_bytes: null };
const EXPORT_COST = PLANS.credit_costs.export;

// ---------- stand-in Supabase session (as auth-tests.mjs) ----------
const USER = { id: '0b5f2c1e-8a39-4c1d-9a51-2f0e6c7d8b90', email: 'a@example.com' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({ sub: USER.id, email: USER.email, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
const user = { ...USER, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' };
const session = { access_token: TOKEN, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user };
const ACCOUNT = { enabled: true, plan: 'free', plan_name: 'Free', interval: null, status: 'active', available: 30, team: null,
  balances: { plan: { available: 30, reserved: 0, consumed: 0 }, purchased: { available: 0, reserved: 0, consumed: 0 } },
  costs: { export: EXPORT_COST }, history: [] };

function serve(dir) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try {
      const body = await readFile(join(dir, path));
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(body);
    } catch {
      if (extname(path)) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(join(dir, 'index.html')));
    }
  });
  return new Promise((done) => server.listen(0, () => done(server)));
}

const browser = await chromium.launch();
const prodServer = await serve(prod), devServer = await serve(dev);
const PROD = `http://localhost:${prodServer.address().port}`, DEV = `http://localhost:${devServer.address().port}`;
await mkdir(shots, { recursive: true });

async function open(base, { width = 1366, height = 768, signedIn = false, plans = PLANS, site = SITE, motion = 'reduce' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion });
  const page = await context.newPage();
  if (signedIn) await page.addInitScript((v) => localStorage.setItem('sb-stub-auth-token', v), JSON.stringify(session));
  await page.route(`${SUPABASE}/auth/v1/**`, (r) => r.fulfill({ json: new URL(r.request().url()).pathname.endsWith('/user') ? user : session }));
  await page.route(`${API}/plans`, (r) => r.fulfill({ json: plans }));
  await page.route(`${API}/site`, (r) => r.fulfill({ json: site }));
  await page.route(`${API}/config`, (r) => r.fulfill({ json: { ...config, billing: plans } }));
  await page.route(`${API}/me/credits`, (r) => r.fulfill({ json: ACCOUNT }));
  await page.goto(`${base}/`);
  await page.locator('.plan').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

async function audited(page, name, locator = null) {
  await page.mouse.move(0, 0);
  const path = join(shots, `${name}.png`);
  if (locator) { await locator.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await locator.screenshot({ path }); }
  else await page.screenshot({ path });
}

try {
  console.log('-- every width, signed out and signed in (production build)');
  for (const [vp, width, height] of VIEWPORTS) {
    for (const state of ['out', 'in']) {
      const tag = `${state === 'in' ? 'signed-in' : 'signed-out'} @ ${vp}`;
      const { context, page } = await open(PROD, { width, height, signedIn: state === 'in' });
      if (state === 'in') await page.locator('header .acct[data-state="in"]').waitFor();
      else await page.locator('header .acct[data-state="out"]').waitFor();
      // Reveal everything (as scrolling would), then audit the whole page once.
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); } scrollTo(0, 0); });
      await page.waitForTimeout(400);
      const { issues } = await page.evaluate(audit);
      check(issues.length === 0, `${tag}: audit of the whole page: ${issues.length ? JSON.stringify(issues).slice(0, 600) : 'no contrast, clipping or overflow issues'}`);
      const name = (part) => `landing-${state === 'in' ? 'signed-in' : 'signed-out'}-${vp}-${part}`;
      await audited(page, name('top'));
      for (const id of ['features', 'how', 'faq', 'pricing']) await audited(page, name(id), page.locator(`#${id}`));
      await audited(page, name('cta'), page.locator('section.cta'));
      await audited(page, name('footer'), page.locator('footer'));

      // Headings: one h1, no level skipped.
      const levels = await page.locator('h1, h2, h3, h4').evaluateAll((hs) => hs.map((h) => Number(h.tagName[1])));
      const skips = levels.some((l, i) => i > 0 && l > levels[i - 1] + 1);
      check(levels.filter((l) => l === 1).length === 1 && levels[0] === 1 && !skips, `${tag}: one h1, heading order ${levels.join('')}`);
      // Images: alt text and width/height (no layout shift).
      const imgs = await page.locator('main img').evaluateAll((is) => is.map((i) => ({ alt: i.getAttribute('alt'), w: i.getAttribute('width'), h: i.getAttribute('height') })));
      check(imgs.length > 0 && imgs.every((i) => i.alt && i.w && i.h), `${tag}: every image has alt text, width and height (${imgs.length})`);
      // Touch targets: every visible link and button in the header and main is at least 44px tall
      // (links inside running text excepted).
      const small = await page.evaluate(() => [...document.querySelectorAll('header a, header button, main a.btn, main button, main summary, footer a')]
        .filter((el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden')
        .map((el) => [el.textContent.trim().slice(0, 30), Math.round(el.getBoundingClientRect().height)])
        .filter(([, h]) => h > 0 && h < 44));
      check(small.length === 0, `${tag}: touch targets at least 44px (${small.length ? JSON.stringify(small) : 'all'})`);
      // No owner-decision placeholder anywhere on the public page in production.
      const text = await page.locator('body').innerText();
      check(await page.locator('.not-chosen').count() === 0 && !/\[[A-Z][^\]]*\]|Not chosen yet|owner to confirm/i.test(text),
        `${tag}: no placeholders in production`);
      check((await page.locator('footer .footer__copy').innerText()).replace(/\s+/g, ' ').trim() === `© ${new Date().getFullYear()} ${APP}`,
        `${tag}: footer "© ${new Date().getFullYear()} ${APP}" (brand from config, the year)`);

      // Hero: one promise, one primary and one secondary button, the cost line from config.
      check(await page.locator('.hero h1').innerText() === 'Turn your logo into stitches', `${tag}: hero promise`);
      const ctas = await page.locator('.hero__cta a').evaluateAll((as) => as.map((a) => [a.textContent.trim(), a.className.includes('btn--ink') ? 'primary' : 'secondary', a.getAttribute('href')]));
      check(JSON.stringify(ctas) === JSON.stringify([['Upload a logo', 'primary', '/upload'], ['See how it works', 'secondary', '#how']]), `${tag}: hero buttons ${JSON.stringify(ctas)}`);
      check(await page.locator('.hero__note').innerText() === `Preview is free. 1 export = ${EXPORT_COST} credits.`, `${tag}: "Preview is free. 1 export = ${EXPORT_COST} credits." (cost from config)`);

      // Plan buttons.
      const free = page.locator('.plan[data-plan="free"] .plan__action a');
      if (state === 'out') {
        check(await free.innerText() === 'Start free' && await free.getAttribute('href') === '/signup?next=%2Fupload', `${tag}: Free card "Start free" -> sign up`);
      } else {
        check(await free.innerText() === 'Open editor' && await free.getAttribute('href') === '/upload', `${tag}: Free card "Open editor"`);
      }
      const paid = await page.locator('.plan[data-plan="pro"] .plan__action button, .plan[data-plan="business"] .plan__action button')
        .evaluateAll((bs) => bs.map((b) => [b.textContent.trim(), b.disabled, getComputedStyle(b).borderStyle]));
      check(paid.length === 2 && paid.every(([t, d, s]) => t === 'Payments are not available yet' && d && s === 'solid'),
        `${tag}: Pro and Business: a clean disabled pill while no payment provider is set (${JSON.stringify(paid)})`);
      await context.close();
    }
  }

  console.log('-- with a payment provider (fake, local): the real action');
  {
    const { context, page } = await open(PROD, { signedIn: true, plans: { ...PLANS, payments_available: true } });
    await page.locator('header .acct[data-state="in"]').waitFor();
    const pro = page.locator('.plan[data-plan="pro"] .plan__action button');
    check(await pro.innerText() === 'Upgrade' && !(await pro.isDisabled()), 'signed in, provider set: Pro shows "Upgrade" (enabled)');
    await context.close();
    const out = await open(PROD, { plans: { ...PLANS, payments_available: true } });
    await out.page.locator('header .acct[data-state="out"]').waitFor();
    check(await out.page.locator('.plan[data-plan="business"] .plan__action a').innerText() === 'Sign up', 'signed out, provider set: Business shows "Sign up"');
    await out.context.close();
  }

  console.log('-- placeholders: only in a test/dev build');
  {
    const { context, page } = await open(DEV);
    await page.locator('.faq__row').first().waitFor();
    const text = await page.locator('body').textContent();  // includes closed FAQ answers
    check(text.includes('[Fill in your trial terms]') && text.includes('[Demo video]') && text.includes('Not chosen yet'),
      'test build: "[Fill in your trial terms]", "[Demo video]" and the footer "Not chosen yet" are visible');
    await page.goto(`${DEV}/pricing`);
    await page.locator('.plan').first().waitFor();
    check((await page.locator('main').innerText()).includes('[Owner to confirm]'), 'test build /pricing: "[Owner to confirm]" visible');
    await context.close();
    const p = await open(PROD);
    await p.page.goto(`${PROD}/pricing`);
    await p.page.locator('.plan').first().waitFor();
    const pricing = await p.page.locator('body').innerText();
    check(!/\[[A-Z][^\]]*\]|Not chosen yet|owner to confirm/i.test(pricing) && await p.page.locator('.not-chosen').count() === 0,
      'production /pricing: no placeholders ("[Refund policy]", "[Owner to confirm]" left out)');
    check(await p.page.locator('#demo').count() === 0, 'production, no demo video set: the demo section is left out (no "[Demo video]")');
    await p.context.close();
  }

  console.log('-- demo video: lazy, poster, size');
  {
    const { context, page } = await open(PROD, { site: { ...SITE, demo_video_url: 'https://example.com/demo.mp4' } });
    let fetched = false;
    page.on('request', (r) => { if (r.url().includes('demo.mp4')) fetched = true; });
    const v = await page.locator('video.demo__video').evaluate((el) => ({ preload: el.getAttribute('preload'), poster: el.getAttribute('poster'), w: el.getAttribute('width'), h: el.getAttribute('height') }));
    check(v.preload === 'none' && v.poster && v.w && v.h, `video: preload none, a poster, width and height (${JSON.stringify(v)})`);
    await page.waitForTimeout(500);
    check(!fetched, 'the video file is not fetched until it is played');
    await context.close();
  }

  console.log('-- header: sticky, anchored sections not covered, mobile menu by keyboard');
  {
    const { context, page } = await open(PROD);
    await page.locator('.nav__links a', { hasText: 'Pricing' }).click();
    await page.waitForTimeout(300);
    const [navBottom, top, pos] = await page.evaluate(() => [document.querySelector('.nav').getBoundingClientRect().bottom,
      document.getElementById('pricing').getBoundingClientRect().top, getComputedStyle(document.querySelector('.nav')).position]);
    check(pos === 'sticky' && top >= navBottom - 1, `desktop: the header is sticky and #pricing starts below it (${Math.round(top)} >= ${Math.round(navBottom)})`);
    // Focus ring: Tab to the first link.
    await page.evaluate(() => scrollTo(0, 0));
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return [document.activeElement.textContent.trim(), s.outlineStyle, s.outlineWidth]; });
    check(ring[1] !== 'none' && parseFloat(ring[2]) >= 2, `keyboard focus shows a ring (${ring.join(', ')})`);
    await context.close();

    const m = await open(PROD, { width: 360, height: 780 });
    const btn = m.page.getByRole('button', { name: 'Menu' });
    check(await btn.isVisible() && await m.page.locator('.nav__links').isHidden(), 'phone: a Menu button instead of the links');
    await btn.focus();
    await m.page.keyboard.press('Enter');
    await m.page.locator('.nav__menu:not([hidden])').waitFor();
    const focused = await m.page.evaluate(() => document.activeElement?.textContent.trim());
    check(await m.page.getByRole('button', { name: 'Close' }).getAttribute('aria-expanded') === 'true' && focused === 'Features',
      `Enter opens the menu, focus moves to its first link (${focused})`);
    await audited(m.page, 'landing-signed-out-360-menu-open');
    const { issues } = await m.page.evaluate(audit);
    check(issues.length === 0, `menu open, audit: ${issues.length ? JSON.stringify(issues) : 'no issues'}`);
    await m.page.keyboard.press('Escape');
    check(await m.page.locator('.nav__menu').isHidden() && await m.page.evaluate(() => document.activeElement?.textContent.trim()) === 'Menu',
      'Escape closes it and focus returns to the Menu button');
    await m.page.keyboard.press('Enter');
    await m.page.locator('.nav__menu-link', { hasText: 'FAQ' }).click();
    await m.page.waitForTimeout(400);
    const [nb, ft] = await m.page.evaluate(() => [document.querySelector('.nav').getBoundingClientRect().bottom, document.getElementById('faq').getBoundingClientRect().top]);
    check(await m.page.locator('.nav__menu').isHidden() && ft >= nb - 1, `choosing FAQ closes the menu and the section starts below the header (${Math.round(ft)} >= ${Math.round(nb)})`);
    await m.context.close();
  }

  console.log('-- motion, fonts, layout shift');
  {
    const r = await open(PROD, { motion: 'reduce' });
    check(await r.page.locator('.hero-stitches').getAttribute('data-state') === 'done' && await r.page.locator('.hero-stitches__replay').count() === 0,
      'reduced motion: the hero stitches are drawn at once, no Replay');
    await r.context.close();
    const html = await readFile(join(prod, 'index.html'), 'utf8');
    const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+\.woff2)" as="font"/g)].map((m) => m[1]);
    check(preloads.length === 2 && html.includes(`<title>${APP}</title>`), `index.html preloads both fonts (${preloads.join(', ')}) and its title comes from config`);
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
        .observe({ type: 'layout-shift', buffered: true });
    });
    for (const [path, json] of [['/plans', PLANS], ['/site', SITE], ['/config', { ...config, billing: PLANS }]]) await page.route(`${API}${path}`, (r) => r.fulfill({ json }));
    await page.route(`${SUPABASE}/auth/v1/**`, (r) => r.fulfill({ json: session }));
    await page.goto(`${PROD}/`);
    await page.locator('.plan').first().waitFor();
    await page.waitForTimeout(1500);
    const cls = await page.evaluate(() => window.__cls);
    check(cls < 0.05, `layout shift while loading: ${cls.toFixed(4)} (below 0.05)`);
    await context.close();
  }
} finally {
  await browser.close();
  prodServer.close();
  devServer.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall landing checks passed');
process.exit(failures ? 1 : 0);
