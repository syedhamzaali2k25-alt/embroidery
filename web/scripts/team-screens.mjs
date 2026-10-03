// Screenshots and checks on the REAL stack (Step 13b): the real API code on the real SQL (a
// throwaway local Postgres, api/tests/team_stack.py), payments through the FakeProvider, and four
// users made the way real ones are (signed webhooks, an invite accepted through the API): Free,
// Pro, Business owner and Business member. Only Supabase Auth itself is a stand-in (its signing
// keys in the API; its endpoints here, answered by Playwright). Each page is audited at 1366 and
// 360 px. Screenshots go to docs/screenshots/real-<user>-<page>-<width>.png.
// Usage: npm run test:teams   (builds its own copy into dist-team-fixture/)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

import { audit } from './audit.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const repo = resolve(root, '..');
const dist = join(root, 'dist-team-fixture');
const shots = join(repo, 'docs', 'screenshots');
const SUPABASE = 'https://stub.supabase.test';
const API_PORT = 8765, WEB_PORT = 4180;
const API = `http://127.0.0.1:${API_PORT}`;
const ORIGIN = `http://localhost:${WEB_PORT}`;
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const teams = process.argv.includes('--teams');  // Business offers teams (the API's config); see below

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

console.log('-- building with sign-in on, pointed at the local real API');
execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, SUPABASE_URL: SUPABASE, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_stub', VITE_API_URL: API, VITE_GOOGLE_CLIENT_ID: '' },
});

console.log('-- starting the real API on local Postgres; making Free, Pro, Business owner and member');
const python = [join(repo, '.venv', 'bin', 'python'), join(repo, '.venv', 'Scripts', 'python.exe')].find(existsSync) ?? 'python3';
const server = spawn(python, [join(repo, 'api', 'tests', 'team_stack.py'), String(API_PORT), ORIGIN, ...(teams ? ['--teams'] : [])],
  { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let errText = '';
const stop = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
process.on('uncaughtException', (err) => { console.error(err); stop(); process.exit(1); });
server.stderr.on('data', (d) => { errText += d; });
const users = await new Promise((done, fail) => {
  let out = '';
  server.stdout.on('data', (d) => {
    out += d;
    const line = out.split('\n').find((l) => l.startsWith('READY '));
    if (line) done(JSON.parse(line.slice(6)).users);
  });
  server.on('exit', (code) => fail(new Error(`the API stopped (${code}):\n${errText.slice(-2000)}`)));
});
for (let i = 0; i < 50; i++) {  // until uvicorn answers
  try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 200));
}

const web = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    const body = await readFile(join(dist, path));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(body);
  } catch {
    if (extname(path)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(join(dist, 'index.html')));
  }
});
await new Promise((done) => web.listen(WEB_PORT, done));
await mkdir(shots, { recursive: true });
const browser = await chromium.launch();

function sessionFor(u) {
  const user = { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' },
    user_metadata: {}, created_at: '2026-10-01T00:00:00Z' };
  return { access_token: u.token, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'refresh-stub', user };
}

async function open(who, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const session = sessionFor(users[who]);
  await page.addInitScript((value) => { try { localStorage.setItem('sb-stub-auth-token', value); } catch { /* none */ } }, JSON.stringify(session));
  await page.route(`${SUPABASE}/auth/v1/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/v1/user') return route.fulfill({ json: session.user });
    if (path === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ json: session });
  });
  return { context, page };
}

async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  const { issues } = await page.evaluate(audit);
  check(issues.length === 0, `${name} audit: ${issues.length ? JSON.stringify(issues) : 'no issues'}`);
}

const ready = (page, selector) => page.locator(selector).first().waitFor({ timeout: 15000 });

try {
  for (const [vp, width, height] of [['1366', 1366, 768], ['360', 360, 780]]) {
    console.log(`-- ${vp} px`);
    // Free: header balance and its own history; calm notes for the paid features.
    {
      const { context, page } = await open('free', width, height);
      await page.goto(`${ORIGIN}/billing`);
      await ready(page, '.usage .upgrade-note');
      check((await page.locator('header .acct__credits').innerText()).includes('credits') && await page.locator('.billing__table tbody tr').count() === 1,
        `Free @ ${vp}: header balance and its own export in History`);
      await shot(page, `real-free-billing-${vp}`);
      await page.goto(`${ORIGIN}/exports`);
      await ready(page, '.upgrade-note');
      check((await page.locator('.upgrade-note').innerText()).includes('Export history comes with the Pro plan.'), `Free @ ${vp}: /exports is the upgrade note`);
      await shot(page, `real-free-exports-${vp}`);
      await context.close();
    }
    // Pro: the export list and Credit usage; no Team page.
    {
      const { context, page } = await open('pro', width, height);
      await page.goto(`${ORIGIN}/exports`);
      await ready(page, '.billing__table tbody tr');
      check(await page.locator('.billing__table tbody tr').count() === 1 && (await page.locator('main').innerText()).includes('two.png'),
        `Pro @ ${vp}: its one export, by design name`);
      await shot(page, `real-pro-exports-${vp}`);
      await page.goto(`${ORIGIN}/billing`);
      await ready(page, '.usage tbody tr');
      const usage = await page.locator('.usage').innerText();
      check(usage.includes('Monthly plan credits') && usage.includes('−10') && usage.includes('Spent this month'), `Pro @ ${vp}: Credit usage from the real ledger`);
      await shot(page, `real-pro-billing-${vp}`);
      await page.goto(`${ORIGIN}/team`);
      await ready(page, '.upgrade-note');
      check((await page.locator('.upgrade-note').innerText()).includes('Business'), `Pro @ ${vp}: /team is a calm note (Business only)`);
      await context.close();
    }
    // Business owner: the team with the member who joined, seats, and who spent.
    {
      const { context, page } = await open('owner', width, height);
      await page.goto(`${ORIGIN}/team`);
      if (teams) {
        await ready(page, '.team__list');
        const text = await page.locator('main').innerText();
        check(text.includes(users.member.email) && text.includes('2 of 4') && text.includes('Extra seat:'),
          `Business owner @ ${vp}: the member who joined, 2 of 4 seats, the extra-seat line`);
        await shot(page, `real-owner-team-${vp}`);
      }
      await page.goto(`${ORIGIN}/billing`);
      await ready(page, '.usage tbody tr');
      const usage = await page.locator('.usage').innerText();
      check(usage.includes(`by ${users.member.email}`), `Business owner @ ${vp}: Credit usage says the member spent 10`);
      await shot(page, `real-owner-billing-${vp}`);
      await context.close();
    }
    // Business member: credits come from the team; own export history; no plan cards.
    {
      const { context, page } = await open('member', width, height);
      for (const path of ['/billing', '/pricing', '/team']) {
        await page.goto(`${ORIGIN}${path}`);
        await ready(page, '.member-note');
        check((await page.locator('.member-note').innerText()).includes('Credits are provided by your team'), `Business member @ ${vp}: ${path}`);
        await shot(page, `real-member-${path.slice(1)}-${vp}`);
      }
      await page.goto(`${ORIGIN}/exports`);
      await ready(page, '.billing__table tbody tr');
      check(await page.locator('.billing__table tbody tr').count() === 1, `Business member @ ${vp}: only their own export`);
      const usage = await page.evaluate(async ([api, token]) => (await fetch(`${api}/credits/usage`, { headers: { Authorization: `Bearer ${token}` } })).status,
        [API, users.member.token]);
      check(usage === 403, `Business member @ ${vp}: the API refuses them the team's Credit usage (403)`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  web.close();
  server.kill('SIGTERM');
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall team screen checks passed (real API and SQL)');
process.exit(failures ? 1 : 0);
