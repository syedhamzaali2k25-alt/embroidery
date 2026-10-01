// Checks the built web app (dist/) does not contain the Supabase secret key, or anything that
// looks like a server-only key. The browser may hold only the project URL and the publishable
// key. The secret's value is read from the environment or ../.env and is never printed.
// Usage: npm run check:secrets   (also runs at the end of npm run build)
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const web = resolve(new URL('..', import.meta.url).pathname);
const dist = join(web, process.argv[2] || 'dist');

async function envFile() {
  try {
    const text = await readFile(join(web, '..', '.env'), 'utf8');
    return Object.fromEntries(text.split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
      .map(([, k, v]) => [k, v.replace(/^(['"])(.*)\1$/, '$2')]));
  } catch {
    return {};
  }
}
const env = { ...(await envFile()), ...process.env };
const secret = (env.SUPABASE_SECRET_KEY || '').trim();
// Every other server-side secret whose value is known here: none of them may be in the bundle.
const otherSecrets = ['PAYMENT_PROVIDER_SECRET_KEY', 'PAYMENT_WEBHOOK_SECRET', 'STITCHBOOK_FAKE_PROVIDER_SECRET']
  .map((k) => [k, (env[k] || '').trim()]).filter(([, v]) => v.length >= 8);

async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await files(p));
    else if (/\.(js|mjs|html|css|json|map|txt)$/.test(e.name)) out.push(p);
  }
  return out;
}

// Server-only key shapes: the new secret keys, the Google client secret, and the variable names.
// Google: OAuth client secrets start with GOCSPX-; the client ID (public) is allowed.
// Payments: the provider's secret key and webhook secret (by name, and their values when set here),
// plus well-known secret-key shapes (sk_live_/sk_test_/whsec_).
const PATTERNS = [/sb_secret_[A-Za-z0-9_-]+/, /SUPABASE_SECRET_KEY/, /SUPABASE_SERVICE_ROLE_KEY/, /GOCSPX-[A-Za-z0-9_-]{10,}/,
  /GOOGLE_CLIENT_SECRET/, /PAYMENT_PROVIDER_SECRET_KEY/, /PAYMENT_WEBHOOK_SECRET/, /STITCHBOOK_FAKE_PROVIDER_SECRET/,
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/, /\bwhsec_[A-Za-z0-9]{10,}/];
let found = 0;
let scanned = 0;
for (const file of await files(dist)) {
  const text = await readFile(file, 'utf8');
  scanned++;
  const rel = file.slice(web.length + 1);
  if (secret && text.includes(secret)) { console.log(`FAIL ${rel}: contains the value of SUPABASE_SECRET_KEY`); found++; }
  for (const [name, value] of otherSecrets) if (text.includes(value)) { console.log(`FAIL ${rel}: contains the value of ${name}`); found++; }
  for (const re of PATTERNS) if (re.test(text)) { console.log(`FAIL ${rel}: matches ${re}`); found++; }
  // A legacy service_role JWT: a token whose payload says role service_role.
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try {
      if (JSON.parse(Buffer.from(m[1], 'base64url').toString()).role === 'service_role') {
        console.log(`FAIL ${rel}: contains a service_role JWT`); found++;
      }
    } catch { /* not a JWT */ }
  }
}
console.log(`check:secrets: ${scanned} files in ${dist.slice(web.length + 1)}/ scanned; secret value ${secret ? 'known (compared, not printed)' : 'not set here: patterns only'}.`);
if (!scanned) { console.log('FAIL nothing to scan: build first'); process.exit(1); }
process.exit(found ? 1 : 0);
