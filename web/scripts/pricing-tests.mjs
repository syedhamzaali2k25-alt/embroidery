// Browser tests for plans and pricing: /pricing and the home page's Pricing section show the
// same plan data, all of it from GET /plans (config.py via the real API code: the mock answers
// with what stitchbook_api.plans computes from config.py), the Monthly | Yearly switch, the
// computed yearly prices, no invented claims, links to Pricing, smooth scroll only with motion,
// the audit at 1366 and 360 px, and a source scan that fails if a price or credit amount is
// typed into the pricing components. Screenshots go to docs/screenshots/.
// Usage: npm run test:pricing   (builds the offline app first)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

import { audit } from './audit.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const repo = resolve(root, '..');
const dist = join(root, 'dist');
const shots = join(repo, 'docs', 'screenshots');
const API = 'http://localhost:8000';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const config = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'config.json'), 'utf8'));

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

// What the API serves for GET /plans, computed by the real code from config.py (overrides optional).
const python = [join(repo, '.venv', 'bin', 'python'), join(repo, '.venv', 'Scripts', 'python.exe')].find(existsSync) ?? 'python3';
function plansFromConfig(overrides = {}) {
  const code = `import json,sys
from digitizer.config import load_config
from stitchbook_api.plans import plans
c = load_config().with_overrides(json.loads(sys.argv[1]))
print(json.dumps({**plans(c), "payments_available": False}))`;
  return JSON.parse(execFileSync(python, ['-c', code, JSON.stringify(overrides)], { cwd: repo }).toString());
}
const PLANS = plansFromConfig();

console.log('-- source: no price or credit amount typed into the pricing components');
{
  const numbers = new Set();
  for (const p of PLANS.plans) for (const v of [p.price_monthly, p.price_yearly, p.price_yearly_per_month, p.credits]) if (v !== null && Number(v) > 0) numbers.add(Number(v));
  for (const v of [PLANS.yearly_discount_percent, ...Object.values(PLANS.credit_costs)]) if (v) numbers.add(Number(v));
  const files = ['src/lib/PlanCards.tsx', 'src/pages/Pricing.tsx', 'src/pages/Billing.tsx', 'src/lib/credits.ts', 'src/lib/AccountMenu.tsx'];
  const landing = await readFile(join(root, 'src/pages/Landing.tsx'), 'utf8');
  const sources = await Promise.all(files.map(async (f) => [f, await readFile(join(root, f), 'utf8')]));
  sources.push(['src/pages/Landing.tsx (pricing section)', landing.slice(landing.indexOf('id="pricing"'), landing.indexOf('className="cta"'))]);
  for (const [file, text] of sources) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    const found = [...code.matchAll(/(?<![\w.#$-])(\d+(?:\.\d+)?)(?![\w-])/g)].map((m) => Number(m[1])).filter((n) => numbers.has(n));
    const money = code.match(/[$€£]\s?\d|\d+\s?(credits|%)\b/);
    check(found.length === 0 && !money, `${file}: no configured price/credit literal${found.length ? ` (found ${found.join(', ')})` : ''}${money ? ` (found "${money[0]}")` : ''}`);
  }
}

function serve() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try {
      const body = await readFile(join(dist, path));
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(body);
    } catch {
      if (extname(path)) return res.writeHead(404).end();
      const shell = await readFile(join(dist, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html' }).end(shell);
    }
  });
  return new Promise((done) => server.listen(0, () => done(server)));
}

const browser = await chromium.launch();
const server = await serve();
const base = `http://localhost:${server.address().port}`;
await mkdir(shots, { recursive: true });

async function open(path, { width = 1366, height = 768, plans = PLANS, motion = 'reduce' } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: motion });
  await page.route(`${API}/plans`, (r) => r.fulfill({ json: plans }));
  await page.route(`${API}/config`, (r) => r.fulfill({ json: { ...config, billing: plans } }));
  await page.route(`${API}/site`, (r) => r.fulfill({ json: { app_name: 'Stitchbook', demo_video_url: '', export_formats: ['dst'], company_name: null,
    contact_email: null, governing_country: null, data_retention_days: null, last_updated: null, max_upload_bytes: null } }));
  await page.route(`${API}/formats`, (r) => r.fulfill({ json: { formats: ['dst'], labels: {}, unavailable: [] } }));
  await page.goto(`${base}${path}`);
  return page;
}
const cards = (page, scope = 'body') => page.locator(`${scope} .plan`).evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const FORBIDDEN = /unlimited|cheapest|\bteam\b|multiple accounts|testimonial|best value|\bseats?\b|most popular/i;

try {
  console.log('-- /pricing: every number from config, monthly and yearly');
  {
    const page = await open('/pricing');
    await page.locator('.plan').first().waitFor();
    const monthly = await cards(page);
    const [free, pro, business] = monthly;
    check(monthly.length === 3 && free.startsWith('Free') && pro.startsWith('Pro') && business.startsWith('Business'), 'three cards: Free, Pro, Business (names from config)');
    check(free.includes('$0.00') && free.includes('30 credits when you sign up, not renewed'), `Free: $0.00, 30 credits once ("${free}")`);
    check(pro.includes('$12.00 per month') && pro.includes('5,000 credits per month') && pro.includes('Dashboard'), `Pro monthly ("${pro}")`);
    check(business.includes('$25.00 per month') && business.includes('10,000 credits per month') && business.includes('Features not chosen yet'),
      `Business monthly, features a visible placeholder ("${business}")`);
    check((await page.locator('.plans__note').innerText()).includes('1 export = 10 credits'), '"1 export = 10 credits" from credit_costs.export');
    const fills = await page.locator('.plan').evaluateAll((els) => els.map((e) => [...e.classList].find((c) => c.startsWith('card--'))));
    check(fills.join() === 'card--lavender,card--lime,card--pink', 'fills: lavender, lime, pink');
    await page.screenshot({ path: join(shots, 'pricing-monthly-1366.png'), fullPage: true });
    const monthlyAudit = (await page.evaluate(audit)).issues;
    await page.getByRole('radio', { name: /Yearly/ }).click();
    check(await page.getByRole('radio', { name: /Yearly/ }).getAttribute('aria-checked') === 'true', 'the toggle switches to Yearly');
    const yearly = await cards(page);
    check(yearly[1].includes('$129.60 per year') && yearly[1].includes('That is $10.80 per month') && yearly[1].includes('5,000 credits per month'),
      `Pro yearly: computed $129.60, $10.80/month, same monthly credits ("${yearly[1]}")`);
    check(yearly[2].includes('$270.00 per year') && yearly[2].includes('That is $22.50 per month'), `Business yearly: $270.00 ("${yearly[2]}")`);
    check((await page.locator('.plans__badge').innerText()) === '10% off', 'the "10% off" badge comes from yearly_discount_percent');
    const text = await page.locator('main').innerText();
    check(!FORBIDDEN.test(text), `no invented claims (${text.match(FORBIDDEN)?.[0] ?? 'none'})`);
    for (const phrase of ['Credits are set aside when an export starts, and used only if it succeeds.', 'If it fails or is cancelled, the credits come back.',
      'Previewing and editing a design is free.', 'do not carry over', '[Refund policy]']) {
      check(text.includes(phrase), `says: "${phrase}"`);
    }
    check(await page.getByRole('button', { name: 'Payments are not available yet' }).count() === 2, 'offline build: paid plans say "Payments are not available yet" (disabled)');
    await page.screenshot({ path: join(shots, 'pricing-yearly-1366.png'), fullPage: true });
    const yearlyAudit = (await page.evaluate(audit)).issues;
    check(monthlyAudit.length === 0 && yearlyAudit.length === 0, `audit: ${JSON.stringify([...monthlyAudit, ...yearlyAudit]) || 'no issues'}`);
    await page.close();
  }

  console.log('-- a changed config value changes the page (nothing is typed in)');
  {
    const page = await open('/pricing', { plans: plansFromConfig({ 'billing.plans.pro.price_monthly': 20, 'billing.credit_costs.export': 15 }) });
    await page.locator('.plan').first().waitFor();
    await page.getByRole('radio', { name: /Yearly/ }).click();
    const pro = (await cards(page))[1];
    check(pro.includes('$216.00 per year') && (await page.locator('.plans__note').innerText()).includes('1 export = 15 credits'),
      `Pro at 20/month -> $216.00/year; export cost 15 ("${pro}")`);
    await page.close();
  }

  console.log('-- home page Pricing section = /pricing (same component, same data)');
  {
    const page = await open('/');
    await page.locator('#pricing .plan').first().waitFor();
    const pricing = await open('/pricing');
    await pricing.locator('.plan').first().waitFor();
    check(JSON.stringify(await cards(page, '#pricing')) === JSON.stringify(await cards(pricing)), 'monthly cards identical');
    await page.locator('#pricing').getByRole('radio', { name: /Yearly/ }).click();
    await pricing.getByRole('radio', { name: /Yearly/ }).click();
    check(JSON.stringify(await cards(page, '#pricing')) === JSON.stringify(await cards(pricing)), 'yearly cards identical');
    await page.locator('#pricing').getByRole('radio', { name: /Monthly/ }).click();
    check(await page.locator('#pricing').getByRole('link', { name: 'See full pricing' }).getAttribute('href') === '/pricing', '"See full pricing" links to /pricing');
    check(await page.locator('.nav__links').getByRole('link', { name: 'Pricing' }).getAttribute('href') === '#pricing', 'home header: Pricing -> #pricing');
    check(await page.locator('footer').getByRole('link', { name: 'Pricing' }).getAttribute('href') === '/#pricing', 'home footer: Pricing -> #pricing');
    check(await pricing.locator('footer').getByRole('link', { name: 'Pricing' }).getAttribute('href') === '/pricing', 'other pages: footer Pricing -> /pricing');
    check(await pricing.locator('header').getByRole('link', { name: 'Pricing' }).getAttribute('href') === '/pricing', 'other pages: header Pricing -> /pricing');
    const sections = await page.locator('main > section').evaluateAll((els) => els.map((e) => e.id || e.className));
    check(sections.indexOf('pricing') > sections.indexOf('features') && sections.at(-1) === 'cta', `section order: ${sections.join(', ')}`);
    check(!FORBIDDEN.test(await page.locator('#pricing').innerText()), 'home pricing: no invented claims');
    const section = page.locator('#pricing');
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: join(shots, 'home-pricing-1366.png') });
    const { issues } = await page.evaluate(audit);
    check(issues.length === 0, `home audit: ${issues.length ? JSON.stringify(issues) : 'no issues'}`);
    check(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior) === 'auto', 'reduced motion: no smooth scroll');
    await page.close();
    await pricing.close();
    const moving = await open('/', { motion: 'no-preference' });
    check(await moving.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior) === 'smooth', 'with motion: smooth scroll to #pricing');
    await moving.close();
    const elsewhere = await open('/pricing', { motion: 'no-preference' });
    await elsewhere.locator('.plan').first().waitFor();
    check(await elsewhere.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior) === 'auto',
      'other pages keep immediate scrolling (the editor relies on it)');
    await elsewhere.close();
  }

  console.log('-- 360 px wide: no sideways scroll, audit');
  for (const path of ['/pricing', '/', '/billing']) {
    const page = await open(path, { width: 360, height: 780 });
    await page.locator(path === '/billing' ? 'h1' : '.plan').first().waitFor();
    check(await noSideScroll(page), `${path} at 360 px: no horizontal scroll`);
    const { issues } = await page.evaluate(audit);
    check(issues.length === 0, `${path} at 360 px audit: ${issues.length ? JSON.stringify(issues) : 'no issues'}`);
    if (path === '/pricing') await page.screenshot({ path: join(shots, 'pricing-360.png'), fullPage: true });
    if (path === '/') {
      await page.locator('#pricing').scrollIntoViewIfNeeded();
      await page.locator('#pricing').screenshot({ path: join(shots, 'home-pricing-360.png') });
    }
    const headings = await page.locator('h1, h2, h3').evaluateAll((els) => els.map((e) => Number(e.tagName[1])));
    check(headings[0] === 1 && headings.every((h, i) => i === 0 || h <= headings[i - 1] + 1), `${path}: heading order ${headings.join(' ')}`);
    await page.close();
  }

  console.log('-- keyboard: the toggle and buttons show focus');
  {
    const page = await open('/pricing');
    await page.locator('.plan').first().waitFor();
    await page.getByRole('radio', { name: /Monthly/ }).focus();
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' || s.boxShadow !== 'none'; });
    check(ring, 'a focused toggle option shows a focus ring');
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall pricing checks passed');
process.exit(failures ? 1 : 0);
