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
  for (const v of [PLANS.team.extra_seat_price, PLANS.team.extra_seat_credits]) if (v) numbers.add(Number(v));
  const files = ['src/lib/PlanCards.tsx', 'src/pages/Pricing.tsx', 'src/pages/Billing.tsx', 'src/lib/credits.ts', 'src/lib/AccountMenu.tsx',
    'src/pages/Team.tsx', 'src/pages/TeamJoin.tsx'];
  const landing = await readFile(join(root, 'src/pages/Landing.tsx'), 'utf8');
  const sources = await Promise.all(files.map(async (f) => [f, await readFile(join(root, f), 'utf8')]));
  sources.push(['src/pages/Landing.tsx (pricing section)', landing.slice(landing.indexOf('id="pricing"'), landing.indexOf('className="cta"'))]);
  const featureNames = [...new Set(PLANS.plans.flatMap((p) => (p.features || []).map((f) => f.name)))];
  for (const [file, text] of sources) {
    const plain = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const typed = featureNames.filter((n) => plain.includes(`"${n}"`) || plain.includes(`'${n}'`) || plain.includes(`>${n}<`));
    // Plan cards and pricing only (the Billing page has its own "Credit usage" heading).
    if (/PlanCards|Pricing|Landing/.test(file)) check(typed.length === 0, `${file}: no feature text typed in${typed.length ? ` (found ${typed.join(', ')})` : ''}`);
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\*\s*1000\b/g, '* MS');  // seconds -> milliseconds: a unit, not a price or a credit amount
    const found = [...code.matchAll(/(?<![\w.#$-])(\d+(?:\.\d+)?)(?![\w-])/g)].map((m) => Number(m[1])).filter((n) => numbers.has(n));
    const money = code.match(/[$€£]\s?\d|\d+\s?(credits|%)\b/);
    check(found.length === 0 && !money, `${file}: no configured price/credit literal${found.length ? ` (found ${found.join(', ')})` : ''}${money ? ` (found "${money[0]}")` : ''}`);
  }
}

// Payment-provider claims stay placeholders until the owner confirms them (docs/payments-whop.md).
const PROVIDER_CLAIM = /whop|handles? (the )?(tax|vat|invoices?)|processed by|merchant of record|secure(ly)? (payments?|checkout)/i;
console.log('-- source: no payment-provider or tax claims in the app');
{
  const { readdir } = await import('node:fs/promises');
  const walk = async (dir) => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))).flat();
  const files = (await walk(join(root, 'src'))).filter((f) => /\.(tsx?|css|html)$/.test(f));
  const hits = [];
  for (const f of files) {
    const code = (await readFile(f, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const m = code.match(PROVIDER_CLAIM);
    if (m) hits.push(`${f.slice(root.length + 1)}: "${m[0]}"`);
  }
  check(hits.length === 0, `no "Whop", "handles tax", "processed by" etc. in web/src (${hits.join('; ') || 'none'})`);
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
// Text that comes from config.py (the owner's own feature names) is allowed; everything else on
// the page is checked against FORBIDDEN.
// The extra-seat line, as config.py makes it (null while a value is not chosen or no plan offers teams).
const seatText = (plans) => {
  const t = plans.team;
  const teams = plans.plans.some((p) => (p.features || []).some((f) => f.key === 'teams' && f.status === 'available'));
  if (!teams || t.extra_seat_price === null || t.extra_seat_credits === null) return null;
  const price = Number(t.extra_seat_price);
  const money = new Intl.NumberFormat('en', { style: 'currency', currency: t.currency, minimumFractionDigits: Number.isInteger(price) ? 0 : 2 }).format(price);
  return `Extra seat: ${money}/month, adds 1 seat and ${Number(t.extra_seat_credits).toLocaleString('en')} credits to the shared pool`;
};
const fromConfigRemoved = (text) => [...PLANS.plans.flatMap((p) => (p.features || []).map((f) => f.name)), seatText(PLANS) ?? '\u0000']
  .reduce((t, name) => t.split(name).join(' '), text);
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
    check(pro.includes('$12.00 per month') && pro.includes('5,000 credits per month'), `Pro monthly ("${pro}")`);
    check(business.includes('$25.00 per month') && business.includes('10,000 credits per month'), `Business monthly ("${business}")`);
    // Features: exactly the names in config.py, in order; a "coming_soon" one carries the tag.
    for (const plan of PLANS.plans) {
      const items = await page.locator(`.plan[data-plan="${plan.id}"] .plan__features li`).allInnerTexts();
      const want = plan.features.map((f) => f.name + (f.status === 'coming_soon' ? 'Coming soon' : ''));
      check(items.map((t) => t.replace(/\s+/g, '')).join('|') === want.map((t) => t.replace(/\s+/g, '')).join('|'),
        `${plan.id} features from config: ${items.join(' / ')}`);
    }
    const soon = PLANS.plans.flatMap((p) => p.features.filter((f) => f.status === 'coming_soon').map((f) => f.name));
    check(await page.locator('.plan__soon').count() === soon.length, `"Coming soon" tags only on ${soon.join(', ') || 'nothing'}`);
    const all = await page.locator('main').innerText();
    check(!all.includes('Dashboard') && !all.includes('Features not chosen yet'), 'no "Dashboard" and no "Features not chosen yet"');
    check((await page.locator('.plans__note').first().innerText()).includes('1 export = 10 credits'), '"1 export = 10 credits" from credit_costs.export');
    const seat = seatText(PLANS);
    const shown = await page.locator('.plans__seat').allInnerTexts();
    check(seat ? shown.join() === seat : shown.length === 0, `the extra-seat line comes from config: "${shown.join() || 'not shown'}"`);
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
    check(!FORBIDDEN.test(fromConfigRemoved(text)), `no invented claims (${fromConfigRemoved(text).match(FORBIDDEN)?.[0] ?? 'none'})`);
    check(!PROVIDER_CLAIM.test(text), `no payment-provider or tax claim on the page (${text.match(PROVIDER_CLAIM)?.[0] ?? 'none'})`);
    for (const phrase of ['Credits are set aside when an export starts, and used only if it succeeds.', 'If it fails or is cancelled, the credits come back.',
      'Previewing and editing a design is free.', 'do not carry over', '[Refund policy]', 'Who handles payments, tax and invoices?', '[Owner to confirm]']) {
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
    check(pro.includes('$216.00 per year') && (await page.locator('.plans__note').first().innerText()).includes('1 export = 15 credits'),
      `Pro at 20/month -> $216.00/year; export cost 15 ("${pro}")`);
    await page.close();
    const seatPage = await open('/pricing', { plans: plansFromConfig({ 'billing.team.extra_seat_price': 12.5, 'billing.team.extra_seat_credits': 2500 }) });
    await seatPage.locator('.plans__seat').waitFor();
    check(await seatPage.locator('.plans__seat').innerText() === 'Extra seat: $12.50/month, adds 1 seat and 2,500 credits to the shared pool',
      'a changed seat price and seat credits change the extra-seat line');
    await seatPage.close();
    const unset = await open('/pricing', { plans: plansFromConfig({ 'billing.team.extra_seat_price': '__CHOOSE__' }) });
    await unset.locator('.plan').first().waitFor();
    check(await unset.locator('.plans__seat').count() === 0, 'seat price not chosen: no extra-seat line (nothing invented)');
    await unset.close();
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
    check(!FORBIDDEN.test(fromConfigRemoved(await page.locator('#pricing').innerText())), 'home pricing: no invented claims');
    const section = page.locator('#pricing');
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: join(shots, 'home-pricing-1366.png') });
    const { issues } = await page.evaluate(audit);
    check(issues.length === 0, `home audit: ${issues.length ? JSON.stringify(issues) : 'no issues'}`);
    // Following "Pricing" in the header: immediate with reduced motion, smooth (still moving a moment later) without.
    const jumpTo = async (pg) => {
      await pg.evaluate(() => window.scrollTo(0, 0));
      await pg.locator('.nav__links').getByRole('link', { name: 'Pricing' }).click();
      const soon = await pg.evaluate(() => new Promise((r) => setTimeout(() => r(scrollY), 40)));
      await pg.waitForFunction(() => Math.abs(document.getElementById('pricing').getBoundingClientRect().top) < 2, null, { timeout: 5000 });
      return { soon, end: await pg.evaluate(() => scrollY), hash: await pg.evaluate(() => location.hash) };
    };
    const still = await jumpTo(page);
    check(still.soon === still.end && still.hash === '#pricing', `reduced motion: the jump to #pricing is immediate (${still.soon} = ${still.end})`);
    await page.close();
    await pricing.close();
    const moving = await open('/', { motion: 'no-preference' });
    await moving.locator('#pricing .plan').first().waitFor();
    const glide = await jumpTo(moving);
    check(glide.soon < glide.end && glide.hash === '#pricing', `with motion: a smooth scroll to #pricing (${glide.soon} on the way to ${glide.end})`);
    check(await moving.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior) === 'auto',
      'no global smooth scrolling (programmatic scrolling stays immediate)');
    await moving.close();
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
