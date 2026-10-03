// Browser tests for sign-in: Log in, Sign up, Log out, "My designs", and logged-out visitors being
// sent to log in before saving. The app is built with sign-in on, pointed at a stand-in Supabase
// (https://stub.supabase.test, answered here by Playwright; no real project is contacted), and the
// API is mocked to answer 401 without the right token, as the real one does.
// Also screenshots and audits the auth screens (same audit as check:ui), and checks the bundle
// secret check catches a leaked key.
// Google: "Continue with Google" (redirect, PKCE) and One Tap are tested against a stand-in
// Google Identity Services script and the stand-in Supabase; no real Google call is made.
// Usage: npm run test:auth   (builds its own copies into dist-auth-fixture/ and dist-auth-noclient/)
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

import { audit } from './audit.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const dist = join(root, 'dist-auth-fixture');
const distNoClient = join(root, 'dist-auth-noclient'); // no Google client ID: no One Tap
const GOOGLE_ID = 'stub-client-id.apps.googleusercontent.com';
const shots = join(root, 'screenshots');
const API = 'http://localhost:8000';
const SUPABASE = 'https://stub.supabase.test';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const config = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'config.json'), 'utf8'));
const upload = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'upload.json'), 'utf8'));
const design = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'design.json'), 'utf8'));
const preview = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'preview.json'), 'utf8'));
const testImage = join(root, '..', 'digitizer', 'samples', 'bird.png');

console.log('-- building with sign-in on (stand-in Supabase URL and publishable key; with and without a Google client ID)');
for (const [out, clientId] of [[dist, GOOGLE_ID], [distNoClient, '']]) {
  execFileSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, SUPABASE_URL: SUPABASE, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_stub', SUPABASE_SECRET_KEY: 'sb_secret_must_never_ship',
      VITE_GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: 'GOCSPX-made-up-test-secret' },
  });
}

// GET /plans: what the real API code computes from config.py.
const pythonBin = [join(root, '..', '.venv', 'bin', 'python'), join(root, '..', '.venv', 'Scripts', 'python.exe')].find((p) => existsSync(p)) ?? 'python3';
const PLANS = { ...JSON.parse(execFileSync(pythonBin, ['-c', 'import json\nfrom digitizer.config import load_config\nfrom stitchbook_api.plans import plans\nprint(json.dumps(plans(load_config())))'],
  { cwd: join(root, '..') }).toString()), payments_available: false };

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

const googleUser = { ...USER, email: 'g@example.com', aud: 'authenticated', role: 'authenticated',
  app_metadata: { provider: 'google', providers: ['google'] },
  user_metadata: { email: 'g@example.com', full_name: 'Test Person', picture: 'https://example.com/p.png' }, created_at: '2026-10-01T00:00:00Z' };
const sha256hex = (text) => createHash('sha256').update(text).digest('hex');
const jwtPayload = (jwt) => JSON.parse(Buffer.from(String(jwt).split('.')[1] ?? '', 'base64url').toString() || '{}');

/** authorize: what Supabase does at /authorize: 'ok' (back with a code), 'cancel' (back with access_denied), 'off' (provider disabled). */
async function stubSupabase(page, calls, { authorize = 'ok' } = {}) {
  await page.route(`${SUPABASE}/auth/v1/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(`${req.method()} ${url.pathname}${url.search}`);
    const body = req.postDataJSON?.() ?? null;
    if (url.pathname === '/auth/v1/authorize') {
      const back = url.searchParams.get('redirect_to');
      calls.authorize = { provider: url.searchParams.get('provider'), redirectTo: back, challenge: url.searchParams.get('code_challenge') };
      if (authorize === 'off') {
        return route.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*' },
          json: { code: 400, error_code: 'validation_failed', msg: 'Unsupported provider: provider is not enabled' } });
      }
      // (the real one goes to Google first; Google then returns to Supabase, which returns here)
      const to = authorize === 'cancel'
        ? `${back}?error=access_denied&error_code=access_denied&error_description=The+user+denied+the+request`
        : `${back}?code=stub-auth-code`;
      return route.fulfill({ status: 302, headers: { location: to, 'access-control-allow-origin': '*' } });
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
      calls.pkce = body;
      if (body?.auth_code === 'stub-auth-code' && body?.code_verifier) return route.fulfill({ json: { ...session(), user: googleUser } });
      return route.fulfill({ status: 400, json: { code: 400, error_code: 'bad_code_verifier', msg: 'code challenge does not match previously saved code verifier' } });
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'id_token') {
      // As Supabase does: the token's nonce claim must be the SHA-256 of the raw nonce sent here.
      calls.idToken = { body, claims: jwtPayload(body?.id_token) };
      if (body?.provider === 'google' && body?.nonce && sha256hex(body.nonce) === calls.idToken.claims.nonce) {
        return route.fulfill({ json: { ...session(), user: googleUser } });
      }
      return route.fulfill({ status: 400, json: { code: 400, error_code: 'bad_jwt', msg: 'Nonces mismatch' } });
    }
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
// GET /me/credits as the API answers it (numbers are test values, not product values).
const accountWith = (available, extra = {}) => ({
  enabled: true, plan: 'pro', plan_name: 'Pro', interval: 'year', status: 'active', available,
  balances: { plan: { available, reserved: 0, consumed: 20 }, purchased: { available: 0, reserved: 0, consumed: 0 } },
  costs: { export: 10, satin_columns: 0, auto_digitize: 0 },
  history: [
    { job_id: 'j2', design_id: '0b5f2c1e-8a39-4c1d-9a51-2f0e6c7d8b90', operation: 'export', format: 'dst', status: 'succeeded', credits: 10,
      created_at: '2026-10-01T09:30:00Z', finished_at: '2026-10-01T09:30:02Z', error: null },
    { job_id: 'j1', design_id: '0b5f2c1e-8a39-4c1d-9a51-2f0e6c7d8b90', operation: 'export', format: 'dst', status: 'failed', credits: 10,
      created_at: '2026-10-01T09:00:00Z', finished_at: '2026-10-01T09:00:01Z', error: 'the file could not be read' },
  ],
  ...extra,
});
let ACCOUNT = accountWith(5030);

async function stubApi(page, seen, { account = () => ACCOUNT, downloadUrl = null } = {}) {
  const signedIn = (req) => req.headers().authorization === `Bearer ${TOKEN}`;
  const deny = (route) => route.fulfill({ status: 401, json: { error: 'Sign in to continue: this request has no sign-in token.' } });
  await page.route(`${API}/me/credits`, (r) => (signedIn(r.request()) ? r.fulfill({ json: account() }) : deny(r)));
  await page.route(`${API}/plans`, (r) => r.fulfill({ json: PLANS }));
  // Export history / Credit usage: "not used on this server" unless a test stubs them itself.
  await page.route(new RegExp(`^${API}/(exports|credits/usage)\\?`), (r) => (signedIn(r.request()) ? r.fulfill({ json: { enabled: false } }) : deny(r)));
  await page.route(`${API}/team`, (r) => (signedIn(r.request()) ? r.fulfill({ json: { enabled: false } }) : deny(r)));
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
    if (downloadUrl) return downloadUrl(route);
    seen.push(`download-url ${signedIn(route.request()) ? 'with token' : 'no token'}`);
    if (!signedIn(route.request())) return deny(route);
    return route.fulfill({ json: { url: `${SUPABASE}/storage/v1/object/sign/exports/${USER.id}/x/out.dst?token=signed&download=bird.dst`,
      filename: 'bird.dst', expires_in_s: 60, signed: true } });
  });
}

function serve(dir = dist) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try {
      const body = await readFile(join(dir, path));
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(body);
    } catch {
      if (extname(path)) return res.writeHead(404).end();
      const shell = await readFile(join(dir, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html' }).end(shell);
    }
  });
  return new Promise((done) => server.listen(0, () => done(server)));
}

const browser = await chromium.launch();
const server = await serve();
const serverNoClient = await serve(distNoClient);
const baseNoClient = `http://localhost:${serverNoClient.address().port}`;
const base = `http://localhost:${server.address().port}`;
// ---------- a stand-in for Google Identity Services (https://accounts.google.com/gsi/client) ----------
// mode: 'dismissed' (the visitor closes the popup), 'success' (picks an account: an ID token with the
// nonce Google was given), 'mismatch' (an ID token whose nonce is not ours), 'blocked' (script fails).
const GSI = `(() => {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_');
  const log = (window.__gis = { initialized: null, prompts: 0, cancels: 0 });
  window.google = { accounts: { id: {
    initialize(options) { log.initialized = options; },
    prompt() {
      log.prompts++;
      const mode = localStorage.getItem('gis-mode') || 'dismissed';
      if (mode !== 'success' && mode !== 'mismatch') return;
      const nonce = mode === 'success' ? log.initialized.nonce : 'f'.repeat(64);
      const token = [b64({ alg: 'RS256', kid: 'google' }), b64({ iss: 'https://accounts.google.com', aud: log.initialized.client_id,
        sub: '1234567890', email: 'g@example.com', name: 'Test Person', picture: 'https://example.com/p.png', nonce }), 'c2ln'].join('.');
      setTimeout(() => log.initialized.callback({ credential: token, select_by: 'user' }), 50);
    },
    cancel() { log.cancels++; },
    disableAutoSelect() {},
  } } };
})();`;

/** A session already stored in the browser, as after an earlier log-in (supabase-js's own key). */
const storedSession = (u = user) => ({ ...session(), user: u });

async function fresh({ width = 1440, height = 900, gis = 'dismissed', authorize = 'ok', signedInAs = null, api = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const calls = [], seen = [], gisLoads = [];
  if (signedInAs) {
    await page.addInitScript((value) => { try { localStorage.setItem('sb-stub-auth-token', value); } catch {} },
      JSON.stringify(storedSession(signedInAs)));
  }
  // Every state the account slot shows, in order, with its width (to catch flicker and jumps).
  await page.addInitScript(() => {
    window.__acct = [];
    const note = () => {
      const el = document.querySelector('.nav .acct, .flow-bar .acct, .bar .acct, .topbar .acct');
      const last = window.__acct[window.__acct.length - 1];
      const now = el ? `${el.dataset.state}` : 'none';
      if (!last || last.state !== now) window.__acct.push({ state: now, width: el ? Math.round(el.getBoundingClientRect().width) : 0 });
    };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  });
  await page.addInitScript((mode) => { try { localStorage.setItem('gis-mode', mode); } catch {} }, gis);
  await page.route('https://accounts.google.com/gsi/client', (r) => {
    gisLoads.push(page.url());
    return gis === 'blocked' ? r.abort('blockedbyclient') : r.fulfill({ contentType: 'text/javascript', body: GSI });
  });
  await stubSupabase(page, calls, { authorize });
  await stubApi(page, seen, api);
  return { context, page, calls, seen, gisLoads };
}
const logOutViaMenu = async (page) => {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
};
const logInWith = async (page, password) => {
  await page.getByLabel('Email').fill(USER.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
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
    await page.getByRole('button', { name: 'Account menu' }).click();
    check(await page.getByRole('menu').getByText(USER.email).isVisible(), 'the account menu says who is logged in');
    await page.keyboard.press('Escape');
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
    await page.getByLabel('Password', { exact: true }).fill('a-long-password');
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await page.getByText('Check your email').waitFor();
    check(true, 'with email confirmation on: "Check your email", no session');
    await page.goto(`${base}/signup`);
    await page.getByLabel('Email').fill(USER.email);
    await page.getByLabel('Password', { exact: true }).fill('a-long-password');
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
    await logOutViaMenu(page);
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

  const google = (page) => page.getByRole('button', { name: 'Continue with Google' });
  const gisState = (page) => page.evaluate(() => window.__gis ? { prompts: window.__gis.prompts, cancels: window.__gis.cancels,
    nonce: window.__gis.initialized?.nonce, clientId: window.__gis.initialized?.client_id } : null);
  const waitPrompt = (page) => page.waitForFunction(() => (window.__gis?.prompts ?? 0) > 0, null, { timeout: 5000 }).then(() => true, () => false);

  console.log('-- Continue with Google (redirect through Supabase, PKCE), back to the saved page');
  {
    const { context, page, calls, seen } = await fresh();
    await page.goto(`${base}/login?next=${encodeURIComponent('/home')}`);
    await google(page).click();
    await page.waitForURL(`${base}/home`);
    await page.locator('.design').first().waitFor();
    check(calls.authorize?.provider === 'google' && calls.authorize?.redirectTo === `${base}/login`, 'asks Supabase for Google, coming back to /login');
    check(Boolean(calls.authorize?.challenge) && Boolean(calls.pkce?.code_verifier), 'PKCE: a code challenge going out, the verifier on the way back');
    check(seen.includes('GET /designs with token'), 'a Google user\'s token reaches the API like any other (My designs loads)');
    await logOutViaMenu(page);
    await page.getByText("You're logged out").waitFor();
    check(calls.some((c) => c.startsWith('POST /auth/v1/logout')), 'a Google user can log out');
    await page.goto(`${base}/home`);
    await page.waitForURL(/\/login\?next=%2Fhome$/);
    check(true, 'after logging out, My designs asks to log in again (the 401 / log-in redirect still works)');
    await context.close();
  }
  {
    const { context, page } = await fresh();
    await page.goto(`${base}/login?next=${encodeURIComponent('/upload')}`);
    await google(page).click();
    await page.waitForURL(`${base}/upload`);
    check(true, 'next=/upload: back on /upload after Google');
    await context.close();
  }
  {
    const { context, page } = await fresh();
    await page.goto(`${base}/login?next=${encodeURIComponent('https://evil.example/')}`);
    await google(page).click();
    await page.waitForURL(`${base}/home`);
    check(true, 'next=https://evil.example/: Google sign-in goes to /home, never another site');
    await context.close();
  }

  console.log('-- Google sign-in cancelled, or the provider turned off');
  {
    const { context, page } = await fresh({ authorize: 'cancel' });
    await page.goto(`${base}/login`);
    await google(page).click();
    await page.waitForURL(/\/login\?error=access_denied/);
    const msg = await page.getByRole('alert').innerText();
    check(/cancelled/.test(msg), `cancelled at Google: plain message ("${msg}")`);
    check(await page.getByLabel('Email').isVisible() && await google(page).isEnabled(), 'the email form and the Google button are still there');
    await context.close();
  }
  {
    const { context, page } = await fresh({ authorize: 'off' });
    await page.goto(`${base}/login`);
    await google(page).click();
    const msg = await page.getByRole('alert').innerText();
    check(/provider is not enabled/.test(msg) && page.url() === `${base}/login`, `provider off: Supabase's own message, still on Log in ("${msg}")`);
    await context.close();
  }

  console.log('-- Google One Tap (stand-in Google script)');
  {
    const { context, page, calls, gisLoads } = await fresh({ gis: 'success' });
    await page.goto(`${base}/login?next=${encodeURIComponent('/home')}`);
    await page.waitForURL(`${base}/home`);
    const { body, claims } = calls.idToken ?? {};
    check(gisLoads.length === 1 && gisLoads[0].startsWith(`${base}/login`), 'the Google script loads on Log in');
    check(/^[0-9a-f]{64}$/.test(claims?.nonce ?? '') && body?.nonce && body.nonce !== claims.nonce && sha256hex(body.nonce) === claims.nonce,
      'Google got the SHA-256 of the nonce; Supabase got the raw nonce, and they match');
    check(body?.provider === 'google' && claims?.aud === GOOGLE_ID, 'signInWithIdToken(provider google) with the configured client ID');
    await page.locator('.design').first().waitFor();
    check(true, 'success: signed in and on the saved page (My designs)');
    await logOutViaMenu(page);
    await page.getByText("You're logged out").waitFor();
    const after = await gisState(page);
    check(after && after.cancels > 0, 'One Tap is cancelled on log out');
    await context.close();
  }
  {
    const { context, page } = await fresh({ gis: 'success' });
    await page.goto(`${base}/signup`);
    await page.waitForURL(`${base}/home`);
    check(true, 'One Tap on Sign up signs in too');
    await context.close();
  }
  {
    const { context, page, calls } = await fresh({ gis: 'mismatch' });
    await page.goto(`${base}/login`);
    const msg = await page.getByRole('alert').innerText();
    check(calls.idToken && /could not be finished/.test(msg) && page.url() === `${base}/login`,
      `a token whose nonce is not ours is refused by Supabase; calm message, not signed in ("${msg}")`);
    await context.close();
  }
  for (const mode of ['dismissed', 'blocked']) {
    const { context, page } = await fresh({ gis: mode });
    await page.goto(`${base}/login`);
    const prompted = await waitPrompt(page);
    check(mode === 'blocked' ? !prompted : prompted, mode === 'blocked' ? 'script blocked: no popup' : 'the popup was offered');
    check(await page.getByRole('alert').count() === 0, `${mode}: nothing scary is shown`);
    await google(page).click();
    await page.waitForURL(`${base}/home`);
    check(true, `${mode}: "Continue with Google" still works`);
    await context.close();
  }
  {
    const { context, page, gisLoads } = await fresh({ gis: 'dismissed' });
    await page.goto(`${base}/login`);
    await logInWith(page, 'right-password');
    await page.waitForURL(`${base}/home`);
    const loadsBefore = gisLoads.length;
    await page.goto(`${base}/login`);
    await page.waitForURL(`${base}/home`);
    await page.goto(`${base}/signup`);
    await page.waitForTimeout(500);
    check(gisLoads.length === loadsBefore && await gisState(page) === null, 'already signed in: the Google script is not loaded and no popup is shown');
    await page.goto(`${base}/privacy`);
    await page.locator('footer .footer__cols').waitFor();
    check(gisLoads.length === loadsBefore, 'other pages never load the Google script');
    await context.close();
  }
  {
    const { context, page, gisLoads } = await fresh({ gis: 'success' });
    await page.goto(`${baseNoClient}/login?next=${encodeURIComponent('/home')}`);
    await google(page).waitFor();
    await page.waitForTimeout(500);
    check(gisLoads.length === 0, 'no client ID: the Google script is never loaded (no popup)');
    await google(page).click();
    await page.waitForURL(`${baseNoClient}/home`);
    check(true, 'no client ID: "Continue with Google" still works');
    await context.close();
  }

  console.log('-- Privacy and Terms describe the sign-in build (accounts, Supabase, local storage)');
  {
    const { context, page } = await fresh();
    await page.goto(`${base}/privacy`);
    await page.locator('footer .footer__cols').waitFor();
    const privacy = await page.locator('main').innerText();
    for (const phrase of ['Supabase Auth', 'private folders named by your account', 'Only you, when you are logged in',
      'local storage keeps your sign-in session', 'Not stated yet', 'The only email is the one that confirms your address',
      'your email address, your name and your profile picture', 'load a script from Google (accounts.google.com)']) {
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

  console.log('-- header: one account control on the right (no "Upload a logo" button)');
  {
    const header = (page) => page.locator('header').first();
    const { context, page } = await fresh();
    await page.goto(`${base}/`);
    await header(page).locator('.acct[data-state="out"]').waitFor();
    check(await header(page).getByRole('link', { name: 'Log in' }).isVisible() && await header(page).getByRole('link', { name: 'Sign up' }).isVisible(),
      'landing, signed out: Log in and Sign up in the header');
    check(await header(page).getByText('Upload a logo').count() === 0 && await page.locator('main').getByRole('link', { name: /Upload a logo/ }).first().isVisible(),
      'no "Upload a logo" in the header; the hero button stays');
    const classes = [await header(page).getByRole('link', { name: 'Log in' }).getAttribute('class'), await header(page).getByRole('link', { name: 'Sign up' }).getAttribute('class')];
    check(classes[0].includes('btn--ghost') && classes[1].includes('btn--ink'), 'Log in is the outline pill, Sign up the dark pill');
    for (const [path, shown, hidden] of [['/login', 'Sign up', 'Log in'], ['/signup', 'Log in', 'Sign up']]) {
      await page.goto(`${base}${path}`);
      await header(page).locator('.acct[data-state="out"]').waitFor();
      check(await header(page).getByRole('link', { name: shown }).isVisible() && await header(page).getByRole('link', { name: hidden }).count() === 0,
        `${path}: the header shows only "${shown}"`);
    }
    for (const path of ['/privacy', '/terms', '/contact', '/blog', '/upload', '/home', '/editor']) {
      await page.goto(`${base}${path}`);
      if (path === '/home') { await page.waitForURL(/\/login/); continue; } // signed out: sent to log in
      await page.locator('.acct[data-state="out"]').first().waitFor();
      check(await page.locator('header').getByText('Upload a logo').count() === 0 && await page.locator('header .acct').count() === 1,
        `${path}: one account control, no header Upload button`);
    }
    await context.close();
  }
  {
    const { context, page } = await fresh({ width: 390, height: 844 });
    await page.goto(`${base}/`);
    await page.locator('header .acct[data-state="out"]').waitFor();
    check(await page.locator('header').getByRole('link', { name: 'Log in' }).isVisible() && !await page.locator('header').getByRole('link', { name: 'Sign up' }).isVisible(),
      'phone, signed out: just "Log in"');
    await context.close();
  }
  {
    // Signed in with a Google picture: the picture; no "Log in" ever shown on the way (no flicker).
    const picture = { ...googleUser, id: '5d0c3b6e-1f2a-4b7c-9d8e-0a1b2c3d4e5f', user_metadata: { ...googleUser.user_metadata, avatar_url: 'https://pictures.example/me.png' } };
    const { context, page } = await fresh({ signedInAs: picture });
    await page.route('https://pictures.example/**', (r) => r.fulfill({ contentType: 'image/png', body: readFileSync(testImage) }));
    await page.goto(`${base}/`);
    await page.locator('header .acct[data-state="in"]').waitFor();
    const img = page.getByRole('button', { name: 'Account menu' }).locator('img');
    await page.waitForFunction(() => document.querySelector('.acct__img')?.complete);
    check(await img.getAttribute('src') === 'https://pictures.example/me.png' && await img.evaluate((i) => i.naturalWidth > 0), 'signed in: the Google picture in the avatar');
    const states = await page.evaluate(() => window.__acct);
    check(!states.some((x) => x.state === 'out') && states.at(-1).state === 'in', `no flicker: ${states.map((x) => x.state).join(' -> ')}`);
    const widths = [...new Set(states.filter((x) => x.state !== 'none').map((x) => x.width))];
    check(widths.length === 1, `the slot keeps its size while the session is checked (${widths.join(', ')} px)`);
    await context.close();
  }
  {
    // A picture that fails to load, and no picture at all: the first letter on a thumbnail colour.
    const broken = { ...googleUser, id: '7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b', user_metadata: { full_name: 'Ada Lovelace', avatar_url: 'https://pictures.example/gone.png' } };
    const { context, page } = await fresh({ signedInAs: broken });
    await page.route('https://pictures.example/**', (r) => r.fulfill({ status: 404, body: '' }));
    await page.goto(`${base}/privacy`);
    const letter = page.locator('header .acct__letter');
    await letter.waitFor();
    check(await letter.innerText() === 'A' && /acct__letter--[1-4]/.test(await letter.getAttribute('class')), 'picture fails to load: falls back to the letter "A"');
    await context.close();
    const plain = { ...user, id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', email: 'zoe@example.com', user_metadata: {} };
    const second = await fresh({ signedInAs: plain });
    await second.page.goto(`${base}/upload`);
    const l2 = second.page.locator('header .acct__letter');
    await l2.waitFor();
    const colour = Number((await l2.getAttribute('class')).match(/--(\d)/)[1]);
    const bg = await l2.evaluate((el) => getComputedStyle(el).backgroundColor);
    const ink = await l2.evaluate((el) => getComputedStyle(el).color);
    check(await l2.innerText() === 'Z' && colour >= 1 && colour <= 4 && bg !== 'rgba(0, 0, 0, 0)', `no picture: "Z" from the email on thumbnail colour ${colour}`);
    await second.page.reload();
    await l2.waitFor();
    check(Number((await l2.getAttribute('class')).match(/--(\d)/)[1]) === colour && ink === await l2.evaluate((el) => getComputedStyle(el).color),
      'the same colour every time for the same user; letter in ink');
    await second.context.close();
  }
  {
    // The menu: opens, keyboard, Escape, outside click, route change, Log out.
    const { context, page, calls } = await fresh({ signedInAs: { ...googleUser, user_metadata: { full_name: 'Test Person', email: 'g@example.com' } } });
    await page.goto(`${base}/`);
    const avatar = page.getByRole('button', { name: 'Account menu' });
    await avatar.waitFor();
    check(await avatar.getAttribute('aria-expanded') === 'false' && await avatar.getAttribute('aria-haspopup') === 'menu', 'avatar: aria-label "Account menu", a menu button');
    await avatar.click();
    const menu = page.getByRole('menu');
    const text = await menu.innerText();
    check(text.includes('Test Person') && text.includes('g@example.com') && await avatar.getAttribute('aria-expanded') === 'true',
      'open: name and email, then the items');
    const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim());
    check(await focused() === 'My designs', 'focus moves into the menu (My designs)');
    await page.keyboard.press('ArrowDown');
    check(await focused() === 'Credits and plan', 'ArrowDown: Credits and plan');
    await page.keyboard.press('ArrowDown');
    check(await focused() === 'Export history', 'ArrowDown again: Export history');
    await page.keyboard.press('ArrowDown');
    check(await focused() === 'Log out', 'ArrowDown again: Log out');
    await page.keyboard.press('Escape');
    check(await menu.count() === 0 && await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Account menu',
      'Escape closes it and returns focus to the avatar');
    await page.keyboard.press('Enter');
    check(await menu.isVisible(), 'Enter on the avatar opens it again (keyboard)');
    await page.mouse.click(10, 500);
    check(await menu.count() === 0, 'a click outside closes it');
    await avatar.click();
    await page.getByRole('menuitem', { name: 'My designs' }).click();
    await page.waitForURL(`${base}/home`);
    check(await page.getByRole('menu').waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false),
      'choosing My designs goes there and the menu closes (route change)');
    await logOutViaMenu(page);
    await page.getByText("You're logged out").waitFor();
    check(calls.some((c) => c.startsWith('POST /auth/v1/logout')), 'Log out in the menu logs out');
    await page.locator('header .acct[data-state="out"]').waitFor();
    check(await page.locator('header').getByRole('link', { name: 'Log in' }).isVisible(), 'after logging out the header offers Log in again');
    await context.close();
  }

  console.log('-- credits: header balance, plan in the menu, zero-credit message, 402, /billing');
  {
    const docs = join(root, '..', 'docs', 'screenshots');
    await mkdir(docs, { recursive: true });
    const { context, page } = await fresh({ width: 1366, height: 768, signedInAs: user });
    await page.goto(`${base}/`);
    const pill = page.locator('header .acct__credits');
    await pill.waitFor();
    check(await pill.innerText() === '5,030 credits' && await pill.getAttribute('href') === '/billing', 'header: "5,030 credits" next to the avatar, links to /billing');
    await page.getByRole('button', { name: 'Account menu' }).click();
    check(await page.getByRole('menu').getByText('Pro plan').isVisible(), 'the account menu shows the plan name');
    await page.locator('header').screenshot({ path: join(docs, 'header-with-balance.png') });
    await page.keyboard.press('Escape');
    const { issues } = await page.evaluate(audit);
    check(issues.length === 0, `landing signed in, audit: ${issues.length ? JSON.stringify(issues) : 'no issues'}`);
    await context.close();
  }
  {
    // Unavailable (no billing on this server): nothing shown, no crash.
    const { context, page } = await fresh({ signedInAs: user, api: { account: () => ({ enabled: false }) } });
    await page.goto(`${base}/`);
    await page.locator('header .acct[data-state="in"]').waitFor();
    await page.waitForTimeout(300);
    check(await page.locator('header .acct__credits').count() === 0, 'no billing: no balance in the header');
    await context.close();
  }
  {
    // Zero credits: the export button is disabled and says why, with a link to /pricing; preview untouched.
    const { context, page, seen } = await fresh({ width: 1366, height: 768, signedInAs: user, api: { account: () => accountWith(0) } });
    await page.route(new RegExp(`^${API}/designs/[0-9a-f]{32}$`), (r) => r.fulfill({ json: design }));
    await page.route(`${API}/designs/*/preview`, (r) => r.fulfill({ json: preview }));
    await page.goto(`${base}/preview/${upload.id}?width=80`);
    const button = page.getByRole('button', { name: 'Download DST' });
    await button.waitFor();
    const message = page.locator('.no-credits');
    await message.waitFor();
    check(await button.isDisabled() && (await message.innerText()).includes("You don't have enough credits for this.")
      && await message.getByRole('link', { name: 'See plans' }).getAttribute('href') === '/pricing',
      'zero credits: Download disabled, "You don\'t have enough credits for this." with a link to /pricing');
    check(await page.locator('.flow-summary').isVisible() && !seen.some((s) => s.startsWith('download-url')), 'the preview is untouched; nothing was requested');
    await message.scrollIntoViewIfNeeded();
    await page.locator('.flow-card', { has: message }).screenshot({ path: join(join(root, '..', 'docs', 'screenshots'), 'zero-credit-message.png') });
    const { issues } = await page.evaluate(audit);
    check(issues.length === 0, `zero-credit preview audit: ${issues.length ? JSON.stringify(issues) : 'no issues'}`);
    await context.close();
  }
  {
    // The balance said enough, but the server answers 402 (spent elsewhere meanwhile): same message, no crash.
    const { context, page } = await fresh({ signedInAs: user, api: {
      downloadUrl: (r) => r.fulfill({ status: 402, json: { error: "You don't have enough credits for this.", available: 0, needed: 10, plan: 'pro' } }) } });
    await page.route(new RegExp(`^${API}/designs/[0-9a-f]{32}$`), (r) => r.fulfill({ json: design }));
    await page.route(`${API}/designs/*/preview`, (r) => r.fulfill({ json: preview }));
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/preview/${upload.id}?width=80`);
    await page.getByRole('button', { name: 'Download DST' }).click();
    await page.locator('.no-credits').waitFor();
    check(errors.length === 0 && page.url().includes('/preview/'), 'a 402 shows the same message and nothing breaks');
    await context.close();
  }
  {
    const { context, page } = await fresh({ width: 1366, height: 768, signedInAs: user });
    await page.goto(`${base}/billing`);
    await page.locator('.billing__table').waitFor();
    const text = await page.locator('main').innerText();
    check(text.includes('Pro') && text.includes('Billed yearly') && text.includes('5,030') && text.includes('Failed (credits returned)'),
      '/billing: plan, balances and the operation history');
    const headers = await page.locator('.billing__table th').allInnerTexts();
    check(headers.join('|') === 'Time|Design|Operation|Status|Credits', `history columns: ${headers.join(', ')}`);
    await page.screenshot({ path: join(root, '..', 'docs', 'screenshots', 'billing-page.png'), fullPage: true });
    const { issues } = await page.evaluate(audit);
    check(issues.length === 0, `/billing audit: ${issues.length ? JSON.stringify(issues) : 'no issues'}`);
    await context.close();
    const out = await fresh();
    await out.page.goto(`${base}/billing`);
    await out.page.waitForURL(/\/login\?next=%2Fbilling$/);
    check(true, '/billing needs a log-in');
    await out.context.close();
  }
  {
    // Pricing buttons: signed out "Sign up" -> /signup?next=/pricing; signed in on Free "Upgrade"; current plan disabled.
    const { context, page } = await fresh();
    await page.goto(`${base}/pricing`);
    await page.locator('.plan').first().waitFor();
    const signUps = await page.locator('.plan').getByRole('link', { name: 'Sign up' }).evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    check(signUps.length === 3 && signUps.every((h) => h === '/signup?next=%2Fpricing'), `signed out: "Sign up" -> /signup?next=/pricing (${signUps.length})`);
    await context.close();
    PLANS.payments_available = true;
    const free = await fresh({ signedInAs: user, api: { account: () => accountWith(30, { plan: 'free', plan_name: 'Free', interval: null }) } });
    await free.page.route(`${API}/billing/checkout`, (r) => r.fulfill({ status: 503, json: { error: 'Payments are not available yet.' } }));
    await free.page.goto(`${base}/pricing`);
    await free.page.locator('header .acct__credits').waitFor();
    const current = free.page.locator('.plan[data-plan="free"]').getByRole('button', { name: 'Current plan' });
    check(await current.isDisabled(), 'signed in on Free: "Current plan" (disabled)');
    const upgrades = free.page.locator('.plan').getByRole('button', { name: 'Upgrade' });
    check(await upgrades.count() === 2, 'signed in on Free: "Upgrade" on Pro and Business');
    await upgrades.first().click();
    await free.page.locator('.plan__error').waitFor();
    check(await free.page.locator('.plan__error').innerText() === 'Payments are not available yet.', 'a 503 from checkout: "Payments are not available yet."');
    await free.context.close();
    PLANS.payments_available = false;
  }


  console.log('-- Export history and Credit usage: Free sees a calm upgrade note, Pro sees both');
  {
    const shotsDir = join(root, '..', 'docs', 'screenshots');
    const planRequiredRoute = (r) => r.fulfill({ status: 403, json: { error: 'plan_required', plan: 'pro' } });
    const exportsPage = (items, has_more = false, page = 1) => ({ enabled: true, items, page, page_size: 2, has_more });
    const EXPORTS = [
      { job_id: 'x2', design_id: upload.id, design_name: 'bird.png', format: 'dst', bytes: 18432, credits: 10, finished_at: '2026-10-02T10:00:00Z' },
      { job_id: 'x1', design_id: null, design_name: null, format: 'dst', bytes: null, credits: 10, finished_at: '2026-10-01T10:00:00Z' },
    ];
    const USAGE = (entries, has_more = false) => ({ enabled: true, available: 5030,
      balances: { plan: { available: 5030, reserved: 0, consumed: 20 }, purchased: { available: 0, reserved: 0, consumed: 0 } },
      renewal: { date: '2026-11-01T00:00:00Z', renews: true }, spent_this_month: 20,
      entries: { items: entries, page: 1, page_size: 2, has_more } });
    const ENTRIES = [
      { kind: 'spend', reason: 'export', amount: -10, bucket: null, at: '2026-10-02T10:00:00Z', operation: 'export', design_id: upload.id, acting_user: null },
      { kind: 'grant', reason: 'plan_grant', amount: 5000, bucket: 'plan', at: '2026-10-01T00:00:00Z', operation: null, design_id: null, acting_user: null },
    ];
    const free = () => accountWith(30, { plan: 'free', plan_name: 'Free', interval: null });
    for (const [vp, width, height] of [['1366', 1366, 768], ['360', 360, 780]]) {
      // Free: both are a calm note with a link to Pricing; the balance and designs stay.
      const f = await fresh({ width, height, signedInAs: user, api: { account: free } });
      await f.page.route(`${API}/exports?page=1`, planRequiredRoute);
      await f.page.route(`${API}/credits/usage?page=1`, planRequiredRoute);
      await f.page.goto(`${base}/exports`);
      const note = f.page.locator('.upgrade-note');
      await note.waitFor();
      check((await note.innerText()).includes('Export history comes with the Pro plan.')
        && await note.getByRole('link', { name: 'See plans' }).getAttribute('href') === '/pricing', `Free @ ${vp}: /exports shows a calm upgrade note linking to /pricing`);
      check(await f.page.locator('header .acct__credits').isVisible(), `Free @ ${vp}: the header balance is still there`);
      await f.page.screenshot({ path: join(shotsDir, `exports-free-${vp}.png`), fullPage: true });
      let a = (await f.page.evaluate(audit)).issues;
      check(a.length === 0, `Free /exports @ ${vp} audit: ${a.length ? JSON.stringify(a) : 'no issues'}`);
      await f.page.goto(`${base}/billing`);
      await f.page.locator('.usage .upgrade-note').waitFor();
      check((await f.page.locator('.usage').innerText()).includes('Credit usage comes with the Pro plan.')
        && await f.page.locator('.billing__table').count() === 1, `Free @ ${vp}: /billing keeps its history and shows the Credit usage note`);
      await f.page.screenshot({ path: join(shotsDir, `billing-free-${vp}.png`), fullPage: true });
      a = (await f.page.evaluate(audit)).issues;
      check(a.length === 0, `Free /billing @ ${vp} audit: ${a.length ? JSON.stringify(a) : 'no issues'}`);
      await f.context.close();

      // Pro: the export list (newest first, paged) and the usage section.
      const p = await fresh({ width, height, signedInAs: user });
      const pages = [];
      await p.page.route(new RegExp(`^${API}/exports\\?page=\\d+$`), (r) => {
        const n = Number(new URL(r.request().url()).searchParams.get('page'));
        pages.push(n);
        return r.fulfill({ json: n === 1 ? exportsPage(EXPORTS, true) : exportsPage([{ ...EXPORTS[0], job_id: 'x0' }], false, 2) });
      });
      await p.page.route(`${API}/credits/usage?page=1`, (r) => r.fulfill({ json: USAGE(ENTRIES) }));
      await p.page.goto(`${base}/exports`);
      await p.page.locator('.billing__table tbody tr').first().waitFor();
      const rows = await p.page.locator('.billing__table tbody tr').allInnerTexts();
      check(rows.length === 2 && rows[0].includes('bird.png') && rows[0].includes('DST') && rows[0].includes('18.0 KB') && rows[1].includes('Deleted design'),
        `Pro @ ${vp}: exports listed with name, format, size, credits, date`);
      check(await p.page.getByRole('button', { name: 'Download again' }).count() === 1, `Pro @ ${vp}: "Download again" only where the design still exists`);
      check((await p.page.locator('main').innerText()).includes('Downloading again makes a new export, so it uses 10 credits'),
        `Pro @ ${vp}: it says plainly that downloading again costs credits (the cost from the account)`);
      await p.page.screenshot({ path: join(shotsDir, `exports-pro-${vp}.png`), fullPage: true });
      a = (await p.page.evaluate(audit)).issues;
      check(a.length === 0, `Pro /exports @ ${vp} audit: ${a.length ? JSON.stringify(a) : 'no issues'}`);
      await p.page.getByRole('button', { name: 'Older' }).click();
      await p.page.getByText('Page 2').waitFor();
      check(pages.includes(2), `Pro @ ${vp}: Older asks for page 2`);
      await p.page.goto(`${base}/billing`);
      const usage = p.page.locator('.usage');
      await usage.locator('tbody tr').first().waitFor();
      const text = await usage.innerText();
      check(text.includes('Balance') && text.includes('5,030') && text.includes('November 1, 2026') && text.includes('Spent this month')
        && text.includes('Monthly plan credits') && text.includes('+5,000') && text.includes('−10'),
        `Pro @ ${vp}: Credit usage shows balance, renewal, this month's spend and the entries`);
      await p.page.screenshot({ path: join(shotsDir, `billing-pro-${vp}.png`), fullPage: true });
      a = (await p.page.evaluate(audit)).issues;
      check(a.length === 0, `Pro /billing @ ${vp} audit: ${a.length ? JSON.stringify(a) : 'no issues'}`);
      await p.context.close();
    }
    // A new Pro user: empty states.
    const n = await fresh({ signedInAs: user });
    await n.page.route(`${API}/exports?page=1`, (r) => r.fulfill({ json: exportsPage([]) }));
    await n.page.route(`${API}/credits/usage?page=1`, (r) => r.fulfill({ json: { ...USAGE([]), renewal: null, spent_this_month: 0 } }));
    await n.page.goto(`${base}/exports`);
    await n.page.getByText('No exports yet.').waitFor();
    await n.page.goto(`${base}/billing`);
    await n.page.getByText('No credit activity yet.').waitFor();
    check(true, 'a new user sees plain empty states on /exports and in Credit usage');
    await n.context.close();
  }


  console.log('-- teams: Business owner, member, invite link, Free and Pro');
  {
    const shotsDir = join(root, '..', 'docs', 'screenshots');
    const OFFER = { ...PLANS.team, available: true };
    const ownerTeam = (members, invites = [], seats = { used: members.length + 1, total: 4, included: 4, extra: 0 }) =>
      ({ enabled: true, role: 'owner', members, invites, seats, extra_seat: OFFER });
    const M1 = { user_id: '11111111-1111-4111-8111-111111111111', email: 'sam@example.com', role: 'member', joined_at: '2026-10-01T09:00:00Z' };
    const M2 = { user_id: '22222222-2222-4222-8222-222222222222', email: 'robin@example.com', role: 'member', joined_at: '2026-10-02T09:00:00Z' };
    const business = () => accountWith(10030, { plan: 'business', plan_name: 'Business', interval: 'month', team: { role: 'owner' } });
    const member = () => accountWith(9990, { plan: 'business', plan_name: 'Business', interval: null, team: { role: 'member' },
      balances: { plan: { available: 9990, reserved: 0, consumed: 0 }, purchased: { available: 0, reserved: 0, consumed: 0 } } });
    const seatLine = `Extra seat: $${Number(PLANS.team.extra_seat_price)}/month, adds 1 seat and ${Number(PLANS.team.extra_seat_credits).toLocaleString('en')} credits to the shared pool`;
    for (const [vp, width, height] of [['1366', 1366, 768], ['360', 360, 780]]) {
      // Business owner: members, seats, invite link to copy, remove (asks first), extra seat.
      const o = await fresh({ width, height, signedInAs: user, api: { account: business } });
      let team = ownerTeam([M1]);
      const calls = [];
      await o.page.route(`${API}/team`, (r) => r.fulfill({ json: team }));
      await o.page.route(`${API}/team/invites`, (r) => {
        calls.push(`invite ${r.request().postDataJSON().email}`);
        team = ownerTeam([M1], [{ id: 'inv1', email: 'robin@example.com', expires_at: '2026-10-04T09:00:00Z' }]);
        return r.fulfill({ json: { invite: { id: 'inv1', email: 'robin@example.com', expires_at: '2026-10-04T09:00:00Z' },
          token: 'tok_made_up_for_tests_0123456789abcdef', path: '/team/join#token=tok_made_up_for_tests_0123456789abcdef' } });
      });
      await o.page.route(`${API}/team/members/*`, (r) => { calls.push(`${r.request().method()} member`); team = ownerTeam([]); return r.fulfill({ json: { status: 'removed' } }); });
      await o.page.route(`${API}/team/seats`, (r) => { calls.push('seat'); return r.fulfill({ json: { url: 'https://checkout.example.test/seat' } }); });
      await o.page.route('https://checkout.example.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>provider</title>' }));
      await o.page.goto(`${base}/team`);
      await o.page.locator('.team__list').first().waitFor();
      const text = await o.page.locator('main').innerText();
      check(text.includes('2 of 4') && text.includes('sam@example.com') && text.includes(seatLine),
        `owner @ ${vp}: seats used/total, members, and "${seatLine}" (numbers from config)`);
      await o.page.getByLabel('Email address').fill('robin@example.com');
      await o.page.getByRole('button', { name: 'Make invite link' }).click();
      await o.page.locator('.team__url').waitFor();
      const url = await o.page.locator('.team__url').innerText();
      check(url === `${base}/team/join#token=tok_made_up_for_tests_0123456789abcdef` && calls.includes('invite robin@example.com'),
        `owner @ ${vp}: an invite makes a link to copy (no email is sent)`);
      check(await o.page.getByRole('button', { name: 'Copy link' }).isVisible() && (await o.page.locator('main').innerText()).includes('Cancel invite'),
        `owner @ ${vp}: Copy link, and the open invite with Cancel invite`);
      await o.page.screenshot({ path: join(shotsDir, `team-owner-${vp}.png`), fullPage: true });
      let a = (await o.page.evaluate(audit)).issues;
      check(a.length === 0, `owner /team @ ${vp} audit: ${a.length ? JSON.stringify(a) : 'no issues'}`);
      await o.page.getByRole('button', { name: 'Remove' }).click();
      check(!calls.some((c) => c.includes('member')), `owner @ ${vp}: Remove asks first`);
      await o.page.getByRole('button', { name: 'Yes, remove' }).click();
      await o.page.getByText('No members yet.').waitFor();
      check(calls.includes('DELETE member'), `owner @ ${vp}: confirmed, the member is removed`);
      await o.page.getByRole('button', { name: 'Add an extra seat' }).click();
      await o.page.waitForURL('https://checkout.example.test/**');
      check(calls.includes('seat'), `owner @ ${vp}: Add an extra seat opens the provider's checkout`);
      await o.context.close();

      // The owner's Credit usage says which member spent.
      const u = await fresh({ width, height, signedInAs: user, api: { account: business } });
      await u.page.route(`${API}/credits/usage?page=1`, (r) => r.fulfill({ json: { enabled: true, available: 10030,
        balances: { plan: { available: 10030, reserved: 0, consumed: 10 }, purchased: { available: 0, reserved: 0, consumed: 0 } },
        renewal: { date: '2026-11-01T00:00:00Z', renews: true }, spent_this_month: 10,
        entries: { items: [{ kind: 'spend', reason: 'export', amount: -10, bucket: null, at: '2026-10-02T10:00:00Z', operation: 'export',
          design_id: null, acting_user: { id: M1.user_id, email: 'sam@example.com' } }], page: 1, page_size: 20, has_more: false } } }));
      await u.page.goto(`${base}/billing`);
      await u.page.locator('.usage tbody tr').first().waitFor();
      check((await u.page.locator('.usage').innerText()).includes('by sam@example.com'), `owner @ ${vp}: Credit usage shows which member spent`);
      await u.page.screenshot({ path: join(shotsDir, `billing-business-owner-${vp}.png`), fullPage: true });
      a = (await u.page.evaluate(audit)).issues;
      check(a.length === 0, `owner /billing @ ${vp} audit: ${a.length ? JSON.stringify(a) : 'no issues'}`);
      await u.context.close();

      // Member: "Credits are provided by your team" on /team, /billing and instead of plan cards.
      const m = await fresh({ width, height, signedInAs: user, api: { account: member } });
      await m.page.route(`${API}/team`, (r) => r.fulfill({ json: { enabled: true, role: 'member' } }));
      for (const path of ['/team', '/billing', '/pricing']) {
        await m.page.goto(`${base}${path}`);
        await m.page.locator('.member-note').waitFor();
        check((await m.page.locator('.member-note').innerText()).includes('Credits are provided by your team'),
          `member @ ${vp}: ${path} says "Credits are provided by your team"`);
        if (path === '/pricing') check(await m.page.locator('.plan').count() === 0, `member @ ${vp}: no plan cards on /pricing`);
        if (path === '/billing') check(await m.page.getByRole('button', { name: 'Manage billing' }).count() === 0 && await m.page.locator('.usage').count() === 0,
          `member @ ${vp}: no billing actions and no Credit usage`);
        await m.page.screenshot({ path: join(shotsDir, `${path.slice(1)}-business-member-${vp}.png`), fullPage: true });
        a = (await m.page.evaluate(audit)).issues;
        check(a.length === 0, `member ${path} @ ${vp} audit: ${a.length ? JSON.stringify(a) : 'no issues'}`);
      }
      await m.context.close();

      // Free and Pro: no Team page, a calm note instead.
      for (const [who, acct] of [['free', () => accountWith(30, { plan: 'free', plan_name: 'Free', interval: null })], ['pro', () => ACCOUNT]]) {
        const f = await fresh({ width, height, signedInAs: user, api: { account: acct } });
        await f.page.route(`${API}/team`, (r) => r.fulfill({ status: 403, json: { error: 'plan_required', plan: 'business' } }));
        await f.page.goto(`${base}/team`);
        await f.page.locator('.upgrade-note').waitFor();
        check((await f.page.locator('.upgrade-note').innerText()).includes('A team comes with the Business plan.'), `${who} @ ${vp}: /team is a calm note`);
        await f.page.getByRole('button', { name: 'Account menu' }).click();
        check(await f.page.getByRole('menuitem', { name: 'Team' }).count() === 0, `${who} @ ${vp}: no Team item in the menu`);
        await f.page.keyboard.press('Escape');
        await f.page.screenshot({ path: join(shotsDir, `team-${who}-${vp}.png`), fullPage: true });
        await f.context.close();
      }
    }
    // The invite link: the token stays out of the address bar and the server; joining works once.
    {
      const free = () => accountWith(0, { plan: 'free', plan_name: 'Free', interval: null });
      const j = await fresh({ width: 1366, height: 768, signedInAs: user, api: { account: free } });
      let tries = 0, sent = null;
      await j.page.route(`${API}/team/invites/accept`, (r) => {
        sent = r.request().postDataJSON();
        return ++tries === 1 ? r.fulfill({ json: { status: 'joined' } })
          : r.fulfill({ status: 410, json: { error: 'This invite link has already been used or was cancelled.', code: 'invite_used' } });
      });
      await j.page.goto(`${base}/team/join#token=tok_made_up_for_tests_0123456789abcdef`);
      await j.page.getByRole('button', { name: 'Join the team' }).waitFor();
      check(!j.page.url().includes('tok_'), 'the token leaves the address bar');
      await j.page.screenshot({ path: join(shotsDir, 'team-join-1366.png'), fullPage: true });
      let a = (await j.page.evaluate(audit)).issues;
      check(a.length === 0, `/team/join audit: ${a.length ? JSON.stringify(a) : 'no issues'}`);
      await j.page.getByRole('button', { name: 'Join the team' }).click();
      await j.page.getByText('You joined the team.').waitFor();
      check(sent?.token === 'tok_made_up_for_tests_0123456789abcdef', 'Join sends the token in the request body');
      await j.page.goto(`${base}/pricing`);  // a fresh load (a fragment-only change would not reload)
      await j.page.goto(`${base}/team/join#token=tok_made_up_for_tests_0123456789abcdef`);
      await j.page.getByRole('button', { name: 'Join the team' }).click();
      await j.page.locator('.billing__error').waitFor();
      check((await j.page.locator('.billing__error').innerText()).includes('already been used'), 'a reused link: a plain message');
      await j.context.close();
      // Signed out: log in first; the token is kept in this tab and the page comes back.
      const out = await fresh();
      await out.page.goto(`${base}/team/join#token=tok_made_up_for_tests_0123456789abcdef`);
      await out.page.waitForURL(/\/login\?next=%2Fteam%2Fjoin$/);
      const kept = await out.page.evaluate(() => sessionStorage.getItem('stitchbook.invite'));
      check(kept === 'tok_made_up_for_tests_0123456789abcdef', 'signed out: to Log in and back, the token kept in this tab only');
      await out.context.close();
    }
  }

  console.log('-- payments: checkout, return from the payment page, past due, Manage billing, Cancel plan');
  const CHECKOUT_PAGE = 'https://checkout.example.test/pay';
  const MANAGE_PAGE = 'https://billing.example.test/manage';
  const outside = async (page) => {
    for (const u of [CHECKOUT_PAGE, MANAGE_PAGE]) await page.route(`${u}**`, (r) => r.fulfill({ contentType: 'text/html', body: '<title>provider</title>' }));
  };
  PLANS.payments_available = true;
  try {
    {
      // Upgrade opens the provider's checkout page returned by the API.
      const free = { plan: 'free', plan_name: 'Free', interval: null };
      const { context, page } = await fresh({ signedInAs: user, api: { account: () => accountWith(30, free) } });
      await outside(page);
      let asked = null;
      await page.route(`${API}/billing/checkout`, (r) => { asked = r.request().postDataJSON(); return r.fulfill({ json: { url: CHECKOUT_PAGE } }); });
      await page.goto(`${base}/pricing`);
      await page.locator('header .acct__credits').waitFor();
      await page.locator('.plan[data-plan="pro"]').getByRole('button', { name: 'Upgrade' }).click();
      await page.waitForURL(`${CHECKOUT_PAGE}**`);
      check(asked?.plan === 'pro' && !('user_id' in asked), `Upgrade asks the API for a checkout (${JSON.stringify(asked)}) and opens the page it returns`);
      await context.close();
    }
    {
      // Back from the payment page: polls /me/credits until the plan shows up.
      PLANS.checkout_return = { poll_s: 0.2, wait_s: 5 };
      let calls = 0;
      const account = () => (++calls >= 8 ? accountWith(5030) : accountWith(30, { plan: 'free', plan_name: 'Free', interval: null }));
      const { context, page } = await fresh({ width: 1366, height: 768, signedInAs: user, api: { account } });
      await page.goto(`${base}/billing?checkout=done`);
      await page.getByText('Checking for your payment…').waitFor();
      check(true, 'back from checkout: "Checking for your payment…"');
      await page.getByText('Your payment went through. Your plan is now Pro.').waitFor({ timeout: 5000 });
      check(calls >= 8, `it asked /me/credits again until the plan arrived (${calls} calls)`);
      await page.screenshot({ path: join(root, '..', 'docs', 'screenshots', 'billing-after-checkout.png'), fullPage: true });
      const { issues } = await page.evaluate(audit);
      check(issues.length === 0, `/billing after checkout, audit: ${issues.length ? JSON.stringify(issues) : 'no issues'}`);
      await context.close();
    }
    {
      // Never arrives within the wait: a plain message and Check again; polling stops.
      PLANS.checkout_return = { poll_s: 0.2, wait_s: 1 };
      let calls = 0;
      const account = () => { calls++; return accountWith(30, { plan: 'free', plan_name: 'Free', interval: null }); };
      const { context, page } = await fresh({ signedInAs: user, api: { account } });
      await page.goto(`${base}/billing?checkout=done`);
      await page.getByText('Your payment has not shown up here yet. It can take a few minutes.').waitFor({ timeout: 5000 });
      const after = calls;
      await page.waitForTimeout(700);
      check(calls === after, `after the wait it stops asking (${after} calls, then none)`);
      await page.getByRole('button', { name: 'Check again' }).click();
      await page.waitForTimeout(300);
      check(calls === after + 1, '"Check again" asks once more');
      await context.close();
      // Unchosen poll values: no automatic checks, only the button.
      PLANS.checkout_return = { poll_s: null, wait_s: null };
      const manual = await fresh({ signedInAs: user, api: { account: () => accountWith(30, { plan: 'free', plan_name: 'Free', interval: null }) } });
      await manual.page.goto(`${base}/billing?checkout=done`);
      await manual.page.getByRole('button', { name: 'Check again' }).waitFor();
      check(await manual.page.getByText('Checking for your payment…').count() === 0, 'poll values not chosen: no automatic checks, only "Check again"');
      await manual.context.close();
    }
    {
      // payment.failed -> past_due: shown on /billing.
      const { context, page } = await fresh({ width: 390, height: 844, signedInAs: user,
        api: { account: () => accountWith(5030, { plan: 'free', plan_name: 'Free', interval: null, status: 'past_due' }) } });
      await page.goto(`${base}/billing`);
      const alert = page.locator('.billing__notice[role=alert]');
      await alert.waitFor();
      check((await alert.innerText()).includes('Your last payment did not go through'), '/billing: past due is shown plainly');
      check(await page.getByText('[Payments, tax and invoices: owner to confirm]').isVisible(), '/billing: who handles payments and tax is a visible placeholder');
      await page.screenshot({ path: join(root, '..', 'docs', 'screenshots', 'billing-past-due-390.png'), fullPage: true });
      const { issues } = await page.evaluate(audit);
      check(issues.length === 0, `/billing past due at 390px, audit: ${issues.length ? JSON.stringify(issues) : 'no issues'}`);
      await context.close();
    }
    {
      // Manage billing: the provider's own page; failures are a plain message.
      const { context, page } = await fresh({ signedInAs: user });
      await outside(page);
      let answer = { status: 502, json: { error: 'The payment service did not answer. Try again in a minute.' } };
      await page.route(`${API}/billing/manage`, (r) => r.fulfill(answer));
      await page.goto(`${base}/billing`);
      await page.getByRole('button', { name: 'Manage billing' }).click();
      await page.locator('.billing__error').waitFor();
      check(await page.locator('.billing__error').innerText() === 'The payment service did not answer. Try again in a minute.', 'Manage billing failing: a plain message');
      answer = { json: { url: null } };
      await page.getByRole('button', { name: 'Manage billing' }).click();
      await page.getByText('There is no payment account to manage yet.').waitFor();
      check(true, 'Manage billing without a payment account: says so');
      answer = { json: { url: MANAGE_PAGE } };
      await page.getByRole('button', { name: 'Manage billing' }).click();
      await page.waitForURL(`${MANAGE_PAGE}**`);
      check(true, "Manage billing opens the provider's own page");
      await context.close();
    }
    {
      // Cancel plan: asks first, then stops renewal.
      const { context, page } = await fresh({ width: 1366, height: 768, signedInAs: user });
      let cancelled = 0;
      await page.route(`${API}/billing/cancel`, (r) => { cancelled++; return r.fulfill({ json: { status: 'cancel requested' } }); });
      await page.goto(`${base}/billing`);
      await page.getByRole('button', { name: 'Cancel plan' }).click();
      check(cancelled === 0 && await page.getByRole('group', { name: 'Cancel plan' }).isVisible(), 'Cancel plan asks first (nothing sent yet)');
      await page.screenshot({ path: join(root, '..', 'docs', 'screenshots', 'billing-cancel-confirm.png'), fullPage: true });
      const { issues } = await page.evaluate(audit);
      check(issues.length === 0, `/billing cancel confirm, audit: ${issues.length ? JSON.stringify(issues) : 'no issues'}`);
      await page.getByRole('button', { name: 'Keep my plan' }).click();
      check(cancelled === 0, '"Keep my plan" sends nothing');
      await page.getByRole('button', { name: 'Cancel plan' }).click();
      await page.getByRole('button', { name: 'Yes, stop renewal' }).click();
      await page.getByText('Renewal is stopped.').first().waitFor();
      check(cancelled === 1, 'confirmed: one cancel request, and a plain confirmation');
      await context.close();
    }
  } finally {
    PLANS.payments_available = false;
    PLANS.checkout_return = { poll_s: null, wait_s: null };
  }

  console.log('-- text fields: labels, field errors, Show / Hide password, input types');
  {
    const { context, page } = await fresh({ width: 390, height: 844 });
    await page.goto(`${base}/login`);
    const email = page.locator('#email'), password = page.locator('#password');
    await email.waitFor();
    const attrs = await email.evaluate((el) => ({ type: el.type, autocomplete: el.autocomplete, inputmode: el.inputMode,
      autocap: el.getAttribute('autocapitalize'), spell: el.spellcheck, placeholder: el.placeholder, size: parseFloat(getComputedStyle(el).fontSize) }));
    check(attrs.type === 'email' && attrs.autocomplete === 'email' && attrs.inputmode === 'email' && attrs.autocap === 'none' && !attrs.spell,
      'email: type, autocomplete, inputmode, no autocapitalize or spellcheck');
    check(attrs.placeholder === 'you@example.com' && attrs.size >= 16, 'email: an example placeholder; 16px text on a phone (no iOS zoom)');
    check(await password.getAttribute('autocomplete') === 'current-password', 'password: autocomplete current-password');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    const err = await email.evaluate((el) => {
      const ids = (el.getAttribute('aria-describedby') || '').split(' ');
      const msg = document.getElementById(ids.find((i) => i.endsWith('-error')) || '');
      return { invalid: el.getAttribute('aria-invalid'), role: msg?.getAttribute('role'), text: msg?.innerText, icon: !!msg?.querySelector('svg'), focused: document.activeElement === el };
    });
    check(err.invalid === 'true' && err.role === 'alert' && err.icon && /Enter your email address/.test(err.text ?? '') && err.focused,
      `empty submit: the email field is marked invalid, its message (icon + text, role=alert) is linked by aria-describedby, focus moves there ("${err.text}")`);
    check(await password.getAttribute('aria-invalid') === 'true', 'the password field is marked too');
    await email.fill('a@example.com');
    await password.fill('secret-123');
    const toggle = page.getByRole('button', { name: 'Show password' });
    const box = await toggle.boundingBox();
    check(box && box.width >= 44 && box.height >= 44, `Show password button is ${box?.width}x${box?.height} (44x44 or more)`);
    check(await toggle.getAttribute('aria-pressed') === 'false' && await password.getAttribute('type') === 'password', 'password hidden at first');
    await toggle.focus();
    await page.keyboard.press('Enter');
    const hide = page.getByRole('button', { name: 'Hide password' });
    check(await hide.getAttribute('aria-pressed') === 'true' && await password.getAttribute('type') === 'text' && await password.inputValue() === 'secret-123',
      'keyboard Enter shows the password (aria-pressed=true), value kept');
    await page.keyboard.press('Space');
    check(await password.getAttribute('type') === 'password', 'Space hides it again');
    await context.close();
  }

  console.log('-- screenshots and audit: log in, sign up, log out, My designs (1440, 1366, 390)');
  await mkdir(shots, { recursive: true });
  for (const [vp, width, height] of [['desktop', 1440, 900], ['laptop-1366x768', 1366, 768], ['phone', 390, 844]]) {
    const screens = [
      ['landing-signed-out', '/', 'landing'],
      ['landing-menu-open', '/', 'menu'],
      ['login', '/login', 'h1'],
      ['login-error', '/login', 'error'],
      ['login-focused', '/login', 'focused'],
      ['login-field-error', '/login', 'fielderror'],
      ['login-filled', '/login', 'filled'],
      ['signup', '/signup', 'h1'],
      ['signup-sent', '/signup', 'sent'],
      ['logout', '/logout', 'out'],
      ['home-signed-in', '/home', 'home'],
      ['privacy', '/privacy', 'h1'],
      ['terms', '/terms', 'h1'],
    ];
    for (const [name, path, state] of screens) {
      const { context, page } = await fresh({ width, height });
      if (state === 'home' || state === 'out' || state === 'menu') {
        await page.goto(`${base}/login`);
        await logInWith(page, 'right-password');
        await page.waitForURL(`${base}/home`);
      }
      await page.goto(`${base}${path}`);
      if (state === 'error') await logInWith(page, 'wrong-password');
      if (state === 'focused') { await page.locator('#email').waitFor(); await page.keyboard.press('Tab'); await page.locator('#email').focus(); }
      if (state === 'fielderror') { await page.locator('#email').fill('not-an-address'); await page.getByRole('button', { name: 'Log in', exact: true }).click(); }
      if (state === 'filled') { await page.locator('#email').fill(USER.email); await page.locator('#password').fill('right-password'); }
      if (state === 'sent') {
        await page.getByLabel('Email').fill('new@example.com');
        await page.getByLabel('Password', { exact: true }).fill('a-long-password');
        await page.getByRole('button', { name: 'Sign up', exact: true }).click();
      }
      if (state === 'menu') { await page.locator('header .acct[data-state="in"]').waitFor(); await page.getByRole('button', { name: 'Account menu' }).click(); }
      const ready = { landing: 'header .acct[data-state="out"]', menu: '[role=menu]', h1: 'h1', error: '[role=alert]', focused: '#email:focus', fielderror: '.fld__msg--error', filled: '#password', sent: 'text=Check your email', out: "text=You're logged out", home: '.design' }[state];
      await page.locator(ready).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (state !== 'focused') await page.mouse.move(0, 0);
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
    const noClient = run('dist-auth-noclient', { SUPABASE_SECRET_KEY: 'sb_secret_must_never_ship' });
    check(noClient.status === 0, 'the build without a client ID passes too');
    const google = join(root, 'dist-leak-test');
    await rm(google, { recursive: true, force: true });
    await cp(dist, google, { recursive: true });
    await writeFile(join(google, 'assets', 'leak.js'), 'const s = "GOCSPX-made-up-test-secret";');
    check(run('dist-leak-test', {}).status === 1, 'a planted Google client secret (GOCSPX-...) is caught');
    await rm(google, { recursive: true, force: true });
    // Whop: the two server-side secrets, by value, by name and by the webhook secret's shape.
    const whopEnv = { WHOP_API_KEY: 'made-up-whop-api-key-0001', WHOP_WEBHOOK_SECRET: 'ws_madeuptestsecretvalue0000000000' };
    check(run('dist-auth-fixture', whopEnv).status === 0, 'the sign-in build passes with Whop keys in its environment');
    for (const [label, planted] of [['the WHOP_API_KEY value', whopEnv.WHOP_API_KEY], ['the WHOP_WEBHOOK_SECRET value', whopEnv.WHOP_WEBHOOK_SECRET],
      ['the name WHOP_API_KEY', 'WHOP_API_KEY'], ['the name WHOP_WEBHOOK_SECRET', 'WHOP_WEBHOOK_SECRET'],
      ['a Whop webhook secret shape (ws_...)', 'ws_anothermadeupsecret000000000000']]) {
      const whop = join(root, 'dist-leak-test');
      await rm(whop, { recursive: true, force: true });
      await cp(dist, whop, { recursive: true });
      await writeFile(join(whop, 'assets', 'leak.js'), `const w = "${planted}";`);
      const out = run('dist-leak-test', whopEnv);
      check(out.status === 1 && !out.stdout.includes(whopEnv.WHOP_API_KEY) && !out.stdout.includes(whopEnv.WHOP_WEBHOOK_SECRET),
        `a planted copy of ${label} is caught (values not printed)`);
      await rm(whop, { recursive: true, force: true });
    }
    const shipped = (await readdir(join(dist, 'assets'))).map((f) => f);
    let hasId = false;
    for (const f of shipped) if ((await readFile(join(dist, 'assets', f), 'utf8')).includes(GOOGLE_ID)) hasId = true;
    check(hasId, 'the public Google client ID is in the sign-in build (and nothing secret beside it)');
  }
} finally {
  await browser.close();
  server.close();
  serverNoClient.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall auth checks passed');
process.exit(failures ? 1 : 0);
