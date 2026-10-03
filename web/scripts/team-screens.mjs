// Screenshots and checks on the REAL stack (Step 13b): the real API code on the real SQL (a
// throwaway local Postgres, api/tests/team_stack.py), payments through the FakeProvider, and four
// users made the way real ones are (signed webhooks, an invite accepted through the API): Free,
// Pro, Business owner and Business member. Only Supabase Auth itself is a stand-in (its signing
// keys in the API; its endpoints a small local HTTP server here). Each page is audited at 1366 and
// 360 px.
// No page.route() anywhere: with request interception on, the browser does not enforce CORS
// preflights, which is how a DELETE missing from the API's CORS list went unseen. Here every
// request is a real cross-origin request (web :4180 -> API 127.0.0.1:8765, Supabase stand-in :4181). Screenshots go to docs/screenshots/real-<user>-<page>-<width>.png.
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
const SUPABASE_PORT = 4181;
const SUPABASE = `http://localhost:${SUPABASE_PORT}`;  // storage key: sb-localhost-auth-token
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

// A server left on the port by an earlier run would answer instead of this one: refuse to go on.
try {
  await fetch(`${API}/health`);
  console.log(`FAIL something already answers on ${API}; stop it first (an earlier run left it?)`);
  process.exit(1);
} catch { /* free: good */ }
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

// The stand-in Supabase Auth: who is asking comes from the bearer token (or the refresh token).
const sessions = new Map();
const auth = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const path = new URL(req.url, 'http://x').pathname;
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    let who = [...sessions.values()].find((s) => s.access_token === bearer);
    try { who ??= sessions.get(JSON.parse(body || '{}').refresh_token); } catch { /* not JSON */ }
    if (path === '/auth/v1/logout') return res.writeHead(204, cors).end();
    if (!who) return res.writeHead(401, { ...cors, 'content-type': 'application/json' }).end('{"msg":"not signed in"}');
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(path === '/auth/v1/user' ? who.user : who));
  });
});
await new Promise((done) => auth.listen(SUPABASE_PORT, done));

async function open(who, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const session = sessionFor(users[who]);
  session.refresh_token = `refresh-${who}`;
  sessions.set(session.refresh_token, session);
  await page.addInitScript((value) => { try { localStorage.setItem('sb-localhost-auth-token', value); } catch { /* none */ } }, JSON.stringify(session));
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

  // The owner's changes, through the browser's own CORS checks (cross-origin: the web app and the
  // API are on different ports, as in production): invite, Cancel invite, Remove -> Yes, remove.
  // These send DELETE, which the CORS list once refused ("Can't reach the Stitchbook server").
  if (teams) {
    console.log('-- owner: invite, Cancel invite, Remove (real API, real CORS)');
    const { context, page } = await open('owner', 1366, 768);
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    page.on('requestfailed', (r) => problems.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
    const deletes = [];
    page.on('response', (r) => { if (r.request().method() === 'DELETE') deletes.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    await page.goto(`${ORIGIN}/team`);
    await ready(page, '.team__list');
    await page.getByLabel('Email address').fill('later@example.com');
    await page.getByRole('button', { name: 'Make invite link' }).click();
    await ready(page, '.team__url');
    await page.getByRole('button', { name: 'Cancel invite' }).waitFor();
    await shot(page, 'real-owner-team-invited-1366');
    // Wait for the real answer (the button turns into "Cancelling…" at once), or the page's error.
    const answered = async (pathPart, name, click) => {
      const response = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(pathPart), { timeout: 10000 });
      await click();
      const outcome = await Promise.race([response.then(() => 'answered'),
        page.locator('.billing__error').waitFor({ timeout: 10000 }).then(() => 'error')]).catch(() => 'nothing');
      if (outcome === 'answered') return;
      const shown = (await page.locator('.billing__error').allInnerTexts()).join(' ') || 'no answer';
      await page.screenshot({ path: join(shots, `real-owner-team-${name}-failed-1366.png`), fullPage: true });
      check(false, `${name}: the DELETE never reached the API; the page says "${shown}" (${problems.join(' | ')})`);
      throw new Error(`${name} failed`);
    };
    await answered('/team/invites/', 'cancel-invite', () => page.getByRole('button', { name: 'Cancel invite' }).click());
    await page.getByText('Open until').waitFor({ state: 'detached', timeout: 10000 });
    check(deletes.some((d) => /^200 \/team\/invites\//.test(d)), `Cancel invite: DELETE answered (${deletes.join(', ')})`);
    await shot(page, 'real-owner-team-invite-cancelled-1366');
    await page.getByRole('button', { name: 'Remove' }).click();
    await shot(page, 'real-owner-team-remove-confirm-1366');
    await answered('/team/members/', 'remove', () => page.getByRole('button', { name: 'Yes, remove' }).click());
    await page.getByText('No members yet.').waitFor({ timeout: 10000 });
    check(deletes.some((d) => /^200 \/team\/members\//.test(d)), `Remove -> Yes, remove: DELETE answered (${deletes.join(', ')})`);
    await shot(page, 'real-owner-team-removed-1366');
    const text = await page.locator('main').innerText();
    check(!text.includes("Can't reach") && !(await page.locator('.billing__error').count()), 'no error shown on the page');
    check(problems.length === 0, `no failed request or console error in the browser (${problems.join(' | ') || 'none'})`);
    const left = await page.evaluate(async ([api, token]) => (await (await fetch(`${api}/team`, { headers: { Authorization: `Bearer ${token}` } })).json()),
      [API, users.owner.token]);
    check(left.members.length === 0 && left.invites.length === 0 && left.seats.used === 1, 'the real API agrees: no members, no open invites, 1 of 4 seats');
    await context.close();
  }
} finally {
  await browser.close();
  web.close();
  auth.close();
  server.kill('SIGTERM');
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall team screen checks passed (real API and SQL)');
process.exit(failures ? 1 : 0);
