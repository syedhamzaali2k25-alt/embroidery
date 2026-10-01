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

async function fresh({ width = 1440, height = 900, gis = 'dismissed', authorize = 'ok' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const calls = [], seen = [], gisLoads = [];
  await page.addInitScript((mode) => { try { localStorage.setItem('gis-mode', mode); } catch {} }, gis);
  await page.route('https://accounts.google.com/gsi/client', (r) => {
    gisLoads.push(page.url());
    return gis === 'blocked' ? r.abort('blockedbyclient') : r.fulfill({ contentType: 'text/javascript', body: GSI });
  });
  await stubSupabase(page, calls, { authorize });
  await stubApi(page, seen);
  return { context, page, calls, seen, gisLoads };
}
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
    await page.getByRole('link', { name: 'Log out' }).click();
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
    await page.getByRole('link', { name: 'Log out' }).click();
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
      if (state === 'home' || state === 'out') {
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
      const ready = { h1: 'h1', error: '[role=alert]', focused: '#email:focus', fielderror: '.fld__msg--error', filled: '#password', sent: 'text=Check your email', out: "text=You're logged out", home: '.design' }[state];
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
