// Browser tests for sign-in: Log in, Sign up, Log out, "My designs", and logged-out visitors being
// sent to log in before saving. The app is built with sign-in on, pointed at a stand-in Supabase
// (https://stub.supabase.test, answered here by Playwright; no real project is contacted), and the
// API is mocked to answer 401 without the right token, as the real one does.
// Also screenshots and audits the auth screens (same audit as check:ui), and checks the bundle
// secret check catches a leaked key.
// Usage: npm run test:auth   (builds its own copy into dist-auth-fixture/)
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

import { audit } from './audit.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const dist = join(root, 'dist-auth-fixture');
const shots = join(root, 'screenshots');
const API = 'http://localhost:8000';
const SUPABASE = 'https://stub.supabase.test';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const config = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'config.json'), 'utf8'));
const upload = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'upload.json'), 'utf8'));
const design = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'design.json'), 'utf8'));
const preview = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'preview.json'), 'utf8'));
const testImage = join(root, '..', 'digitizer', 'samples', 'bird.png');

console.log('-- building with sign-in on (stand-in Supabase URL and publishable key)');
execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, SUPABASE_URL: SUPABASE, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_stub', SUPABASE_SECRET_KEY: 'sb_secret_must_never_ship' },
});

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

// ---------- the stand-in Supabase Auth ----------
const USER = { id: '0b5f2c1e-8a39-4c1d-9a51-2f0e6c7d8b90', email: 'a@example.com' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const accessToken = (exp = Math.floor(Date.now() / 1000) + 3600) =>
  `${b64({ alg: 'ES256', typ: 'JWT', kid: 'stub' })}.${b64({ sub: USER.id, email: USER.email, role: 'authenticated', aud: 'authenticated', exp, iss: `${SUPABASE}/auth/v1` })}.c2lnbmF0dXJl`;
const TOKEN = accessToken();
const user = { ...USER, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' };
const session = () => ({ access_token: TOKEN, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-stub', user });

async function stubSupabase(page, calls) {
  await page.route(`${SUPABASE}/auth/v1/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(`${req.method()} ${url.pathname}${url.search}`);
    const body = req.postDataJSON?.() ?? null;
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      if (body?.email === USER.email && body?.password === 'right-password') return route.fulfill({ json: session() });
      return route.fulfill({ status: 400, json: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } });
    }
    if (url.pathname === '/auth/v1/token') return route.fulfill({ json: session() }); // refresh
    if (url.pathname === '/auth/v1/signup') {
      if (body?.email === USER.email) return route.fulfill({ status: 422, json: { code: 422, error_code: 'user_already_exists', msg: 'User already registered' } });
      return route.fulfill({ json: { ...user, id: '1c6a3d2f-9b4a-4d2e-8b62-3a1f7d8e9ca1', email: body?.email, confirmation_sent_at: new Date().toISOString() } });
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
    if (url.pathname === '/auth/v1/user') return route.fulfill({ json: user });
    return route.fulfill({ status: 404, json: { msg: 'not stubbed' } });
  });
}

// ---------- the API, as the real one behaves: 401 without the signed-in user's token ----------
const DESIGNS = [{ id: upload.id, filename: 'bird.png', type: 'png', status: 'digitized', created_at: '2026-10-01T09:00:00Z',
  colour_count: 2, stitch_count: 3150, width_mm: 80, height_mm: 60 }];
async function stubApi(page, seen) {
  const signedIn = (req) => req.headers().authorization === `Bearer ${TOKEN}`;
  const deny = (route) => route.fulfill({ status: 401, json: { error: 'Sign in to continue: this request has no sign-in token.' } });
  await page.route(`${API}/config`, (r) => r.fulfill({ json: config }));
  await page.route(`${API}/site`, (r) => r.fulfill({ json: { app_name: 'Stitchbook', demo_video_url: '', export_formats: ['dst'], company_name: null,
    contact_email: null, governing_country: null, data_retention_days: null, last_updated: null, max_upload_bytes: null } }));
  await page.route(`${API}/formats`, (r) => r.fulfill({ json: { formats: ['dst'], labels: {}, unavailable: [] } }));
  await page.route(`${API}/designs`, (route) => {
    const req = route.request();
    seen.push(`${req.method()} /designs ${signedIn(req) ? 'with token' : 'no token'}`);
    if (!signedIn(req)) return deny(route);
    return req.method() === 'GET' ? route.fulfill({ json: DESIGNS }) : route.fulfill({ status: 201, json: upload });
  });
  await page.route(new RegExp(`^${API}/designs/[0-9a-f]{32}/download-url`), (route) => {
    seen.push(`download-url ${signedIn(route.request()) ? 'with token' : 'no token'}`);
    if (!signedIn(route.request())) return deny(route);
    return route.fulfill({ json: { url: `${SUPABASE}/storage/v1/object/sign/exports/${USER.id}/x/out.dst?token=signed&download=bird.dst`,
      filename: 'bird.dst', expires_in_s: 60, signed: true } });
  });
}

function serve() {
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
  return new Promise((done) => server.listen(0, () => done(server)));
}

const browser = await chromium.launch();
const server = await serve();
const base = `http://localhost:${server.address().port}`;
async function fresh({ width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const calls = [], seen = [];
  await stubSupabase(page, calls);
  await stubApi(page, seen);
  return { context, page, calls, seen };
}
const logInWith = async (page, password) => {
  await page.getByLabel('Email').fill(USER.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
};

try {
  console.log('-- logged out: My designs sends you to log in, and back');
  {
    const { context, page, seen } = await fresh();
    await page.goto(`${base}/home`);
    await page.waitForURL(/\/login\?next=%2Fhome$/);
    check(true, '/home -> /login?next=/home');
    await logInWith(page, 'wrong-password');
    const error = await page.getByRole('alert').innerText();
    check(/don't match an account/.test(error), `wrong password: plain message ("${error}")`);
    await logInWith(page, 'right-password');
    await page.waitForURL(`${base}/home`);
    await page.locator('.design').first().waitFor();
    check(await page.locator('.design__name').innerText() === 'bird.png', 'logged in: back on My designs, the list shows the design');
    check(seen.includes('GET /designs with token') && !seen.includes('GET /designs no token'), 'the list was asked for with the access token only');
    check(await page.getByText(`Logged in as ${USER.email}`).isVisible(), 'the sidebar says who is logged in');
    await context.close();
  }

  console.log('-- logged out: choosing a file to upload asks you to log in before it is saved');
  {
    const { context, page, seen } = await fresh();
    await page.goto(`${base}/upload`);
    await page.getByText('Drop your logo here').waitFor();
    await page.locator('input[type=file]').setInputFiles(testImage);
    await page.waitForURL(/\/login\?next=%2Fupload$/);
    check(!seen.some((s) => s.startsWith('POST')), 'nothing was sent to the API before logging in');
    check(await page.getByText('Log in to save your design').waitFor({ timeout: 5000 }).then(() => true, () => false), 'the log-in page says why');
    await logInWith(page, 'right-password');
    await page.waitForURL(`${base}/upload`);
    await page.locator('.flow-swatch').first().waitFor();
    check(seen.includes('POST /designs with token'), 'after logging in, the same file was uploaded with the token');
    await context.close();
  }

  console.log('-- Download asks the API for a signed, short-lived link (no public file address)');
  {
    const { context, page, seen } = await fresh();
    await page.route(new RegExp(`^${API}/designs/[0-9a-f]{32}$`), (r) => r.fulfill({ json: design }));
    await page.route(`${API}/designs/*/preview`, (r) => r.fulfill({ json: preview }));
    await page.goto(`${base}/login`);
    await logInWith(page, 'right-password');
    await page.waitForURL(`${base}/home`);
    let opened = null;
    await page.route(`${SUPABASE}/storage/v1/**`, (r) => { opened = r.request().url(); return r.fulfill({ body: 'dst' }); });
    await page.goto(`${base}/preview/${upload.id}?width=80`);
    const download = page.getByRole('button', { name: 'Download DST' });
    await download.waitFor();
    await download.click();
    await page.waitForURL(/\/storage\/v1\/object\/sign\//);
    check(seen.includes('download-url with token'), 'Download DST asked /download-url with the access token');
    check(opened?.includes('/object/sign/') && opened.includes('token=') && !opened.includes('/object/public/'),
      'the browser opened the signed Storage link, not a public one');
    await context.close();
  }

  console.log('-- sign up');
  {
    const { context, page } = await fresh();
    await page.goto(`${base}/signup`);
    await page.getByLabel('Email').fill('new@example.com');
    await page.getByLabel('Password').fill('a-long-password');
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await page.getByText('Check your email').waitFor();
    check(true, 'with email confirmation on: "Check your email", no session');
    await page.goto(`${base}/signup`);
    await page.getByLabel('Email').fill(USER.email);
    await page.getByLabel('Password').fill('a-long-password');
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    const error = await page.getByRole('alert').innerText();
    check(/already exists/.test(error), `an existing email: plain message ("${error}")`);
    await context.close();
  }

  console.log('-- log out');
  {
    const { context, page, calls } = await fresh();
    await page.goto(`${base}/login`);
    await logInWith(page, 'right-password');
    await page.waitForURL(`${base}/home`);
    await page.getByRole('link', { name: 'Log out' }).click();
    await page.getByText("You're logged out").waitFor();
    check(calls.some((c) => c.startsWith('POST /auth/v1/logout')), 'Log out tells Supabase Auth');
    check(await page.locator('.nav').getByRole('link', { name: 'Log in' }).isVisible(), 'the header offers Log in again');
    await page.goto(`${base}/home`);
    await page.waitForURL(/\/login\?next=%2Fhome$/);
    check(true, 'after logging out, My designs asks to log in again');
    await context.close();
  }

  console.log('-- only same-site addresses are followed after logging in');
  {
    const { context, page } = await fresh();
    await page.goto(`${base}/login?next=${encodeURIComponent('https://evil.example/')}`);
    await logInWith(page, 'right-password');
    await page.waitForURL(`${base}/home`);
    check(true, 'next=https://evil.example/ -> /home');
    await page.goto(`${base}/logout`);
    await page.getByText("You're logged out").waitFor();
    await page.goto(`${base}/login?next=${encodeURIComponent('//evil.example/')}`);
    await logInWith(page, 'right-password');
    await page.waitForURL(`${base}/home`);
    check(true, 'next=//evil.example/ -> /home');
    await context.close();
  }

  console.log('-- Privacy and Terms describe the sign-in build (accounts, Supabase, local storage)');
  {
    const { context, page } = await fresh();
    await page.goto(`${base}/privacy`);
    await page.locator('footer .footer__cols').waitFor();
    const privacy = await page.locator('main').innerText();
    for (const phrase of ['Supabase Auth', 'private folders named by your account', 'Only you, when you are logged in',
      'local storage keeps your sign-in session', 'Not stated yet', 'The only email is the one that confirms your address']) {
      check(privacy.includes(phrase), `Privacy says: "${phrase}"`);
    }
    for (const gone of ['There are no accounts yet', 'Browser storage (local storage, session storage): none', 'STORAGE_DIR', 'No accounts, no payments']) {
      check(!privacy.includes(gone), `Privacy no longer says: "${gone}"`);
    }
    await page.goto(`${base}/terms`);
    await page.locator('footer .footer__cols').waitFor();
    const terms = await page.locator('main').innerText();
    check(terms.includes('You need an account to save designs') && !terms.includes('There are no accounts'), 'Terms: accounts are described as they are');
    await context.close();
  }

  console.log('-- screenshots and audit: log in, sign up, log out, My designs (1440, 1366, 390)');
  await mkdir(shots, { recursive: true });
  for (const [vp, width, height] of [['desktop', 1440, 900], ['laptop-1366x768', 1366, 768], ['phone', 390, 844]]) {
    const screens = [
      ['login', '/login', 'h1'],
      ['login-error', '/login', 'error'],
      ['signup', '/signup', 'h1'],
      ['signup-sent', '/signup', 'sent'],
      ['logout', '/logout', 'out'],
      ['home-signed-in', '/home', 'home'],
      ['privacy', '/privacy', 'h1'],
      ['terms', '/terms', 'h1'],
    ];
    for (const [name, path, state] of screens) {
      const { context, page } = await fresh({ width, height });
      if (state === 'home' || state === 'out') {
        await page.goto(`${base}/login`);
        await logInWith(page, 'right-password');
        await page.waitForURL(`${base}/home`);
      }
      await page.goto(`${base}${path}`);
      if (state === 'error') await logInWith(page, 'wrong-password');
      if (state === 'sent') {
        await page.getByLabel('Email').fill('new@example.com');
        await page.getByLabel('Password').fill('a-long-password');
        await page.getByRole('button', { name: 'Sign up', exact: true }).click();
      }
      const ready = { h1: 'h1', error: '[role=alert]', sent: 'text=Check your email', out: "text=You're logged out", home: '.design' }[state];
      await page.locator(ready).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: join(shots, `auth-${name}-${vp}.png`), fullPage: true });
      const { issues } = await page.evaluate(audit);
      check(issues.length === 0, `${name} @ ${vp}: ${issues.length ? JSON.stringify(issues) : 'no contrast, clipping or overflow issues'}`);
      await context.close();
    }
  }

  console.log('-- bundle: the secret key never ships');
  {
    const run = (dir, env) => spawnSync('node', [join(root, 'scripts', 'check-bundle-secrets.mjs'), dir], { env: { ...process.env, ...env }, encoding: 'utf8' });
    const clean = run('dist-auth-fixture', { SUPABASE_SECRET_KEY: 'sb_secret_must_never_ship' });
    check(clean.status === 0, 'the sign-in build passes the secret check (built with a secret key present in its environment)');
    const leaky = join(root, 'dist-leak-test');
    await rm(leaky, { recursive: true, force: true });
    await cp(dist, leaky, { recursive: true });
    await writeFile(join(leaky, 'assets', 'leak.js'), 'const k = "a-made-up-secret-value-1234";');
    const caught = run('dist-leak-test', { SUPABASE_SECRET_KEY: 'a-made-up-secret-value-1234' });
    check(caught.status === 1 && !caught.stdout.includes('a-made-up-secret-value-1234'), 'a planted copy of the secret is caught, and not printed');
    await rm(leaky, { recursive: true, force: true });
    const publishable = (await readFile(join(dist, 'index.html'), 'utf8')) + '';
    check(!publishable.includes('sb_secret'), 'index.html has no secret');
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall auth checks passed');
process.exit(failures ? 1 : 0);
