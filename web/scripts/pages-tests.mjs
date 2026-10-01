// Browser tests for the public pages: Privacy, Terms of Service, Contact and Blog, and the footer
// links to them on every public page. GET /site is mocked three ways: nothing chosen yet (the
// product config today), everything chosen, and the server unreachable. The blog is tested twice:
// the real build (no posts: empty state) and a second build pointed at scripts/fixtures/blog
// (STITCHBOOK_BLOG_DIR), so no post has to be shipped to test one.
// Usage: npm run test:pages   (builds first; no server needed)
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(new URL('..', import.meta.url).pathname);
const API = 'http://localhost:8000';
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const config = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'config.json'), 'utf8'));

const NOT_CHOSEN = {
  app_name: 'Stitchbook', demo_video_url: '', export_formats: ['dst'], company_name: null, contact_email: null,
  governing_country: null, data_retention_days: null, last_updated: null, max_upload_bytes: null,
};
// Test values only (example.com is reserved for examples); nothing here is shipped.
const CHOSEN = {
  ...NOT_CHOSEN, company_name: 'Example Owner', contact_email: 'hello@example.com', governing_country: 'Exampleland',
  data_retention_days: 30, last_updated: '2000-01-01', max_upload_bytes: 5_000_000,
};

function serve(dist) {
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

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

async function open(browser, base, path, { site = NOT_CHOSEN, width = 1440, height = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route(`${API}/site`, (r) => (site === 'down' ? r.abort() : r.fulfill({ json: site })));
  await page.route(`${API}/config`, (r) => r.fulfill({ json: config }));
  await page.route(`${API}/formats`, (r) => r.fulfill({ json: { formats: ['dst'], labels: {}, unavailable: [] } }));
  await page.goto(`${base}${path}`);
  await page.locator('footer .footer__links').waitFor(); // every public page has the footer
  return page;
}
const h1 = (page) => page.locator('h1').first().innerText();
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const browser = await chromium.launch();
const mainDist = join(root, 'dist');
const server = await serve(mainDist);
const base = `http://localhost:${server.address().port}`;
try {
  console.log('-- each page renders (390, 1366 and 1440 wide)');
  const PAGES = [['/privacy', 'Privacy'], ['/terms', 'Terms of Service'], ['/contact', 'Contact'], ['/blog', 'Blog']];
  for (const width of [390, 1366, 1440]) {
    for (const [path, title] of PAGES) {
      const page = await open(browser, base, path, { width, height: width === 390 ? 844 : 768 });
      check((await h1(page)) === title && await noSideScroll(page) && await page.locator('footer .footer__links a').count() === 4,
        `${width}px ${path}: "${title}", footer with 4 links, no sideways scroll`);
      await page.close();
    }
  }

  console.log('-- footer links work from every public page');
  for (const from of ['/', '/upload', '/preview', '/privacy', '/terms', '/contact', '/blog']) {
    const page = await open(browser, base, from);
    const links = await page.locator('footer .footer__links a').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), a.textContent]));
    check(JSON.stringify(links.map((l) => l[0])) === JSON.stringify(['/privacy', '/terms', '/contact', '/blog']), `${from}: footer links Privacy, Terms of Service, Contact, Blog`);
    for (const [href, label] of links) {
      await page.locator('footer .footer__links a', { hasText: label }).click();
      await page.waitForURL(`${base}${href}`);
      // The page is loaded on demand: wait for its own heading, not the one still on screen.
      const shown = await page.locator('h1', { hasText: new RegExp(`^${label}$`) }).waitFor({ timeout: 10000 }).then(() => true, () => false);
      check(shown, `${from} -> ${label}: ${href} shows "${label}"`);
      await page.goto(`${base}${from}`);
      await page.locator('footer .footer__links a').first().waitFor();
    }
    await page.close();
  }

  console.log('-- not chosen yet: a plain marker, never a made-up value');
  for (const path of ['/privacy', '/terms']) {
    const page = await open(browser, base, path);
    await page.locator('.not-chosen').first().waitFor();
    const banner = await page.locator('.draft-banner').innerText();
    const markers = await page.locator('.not-chosen').allInnerTexts();
    check(banner.includes('Draft: not yet reviewed by a lawyer.') && /Last updated:\s*Not chosen yet/.test(banner),
      `${path}: draft banner, "Last updated: Not chosen yet"`);
    check(markers.length >= 3 && markers.every((m) => m === 'Not chosen yet'), `${path}: ${markers.length} "Not chosen yet" markers`);
    check(await page.locator('a[href^="mailto:"]').count() === 0, `${path}: no email link while none is chosen`);
    await page.close();
  }
  {
    const page = await open(browser, base, '/contact');
    await page.locator('.not-chosen').waitFor();
    check((await page.locator('.not-chosen').innerText()) === 'Contact email not chosen yet'
      && await page.locator('form, input, textarea, a[href^="mailto:"]').count() === 0,
      '/contact: "Contact email not chosen yet", no form, no mailto link');
    await page.close();
  }

  console.log('-- chosen values are shown as set');
  {
    const page = await open(browser, base, '/contact', { site: CHOSEN });
    const link = page.locator('a[href^="mailto:"]');
    await link.waitFor();
    check((await link.getAttribute('href')) === 'mailto:hello@example.com' && await page.locator('form, input, textarea').count() === 0,
      '/contact: the chosen email as a mailto link, still no form');
    await page.close();
  }
  for (const path of ['/privacy', '/terms']) {
    const page = await open(browser, base, path, { site: CHOSEN });
    await page.locator('.draft-banner').getByText('2000-01-01').waitFor();
    const text = await page.locator('main').innerText();
    const expected = path === '/privacy' ? ['Example Owner', 'hello@example.com', '5 MB', '30 days'] : ['Example Owner', 'Exampleland', 'hello@example.com'];
    check(await page.locator('.not-chosen').count() === 0 && expected.every((v) => text.includes(v)),
      `${path}: chosen values shown (${expected.join(', ')}), no markers`);
    await page.close();
  }
  {
    const page = await open(browser, base, '/privacy', { site: 'down' });
    await page.locator('.not-chosen').first().waitFor();
    check((await page.locator('.not-chosen').first().innerText()).startsWith('Not loaded'), '/privacy with the server down: says not loaded, invents nothing');
    await page.close();
  }

  console.log('-- Privacy and Terms say what the product does today');
  {
    const page = await open(browser, base, '/privacy');
    const text = await page.locator('main').innerText();
    for (const phrase of ['PNG or JPG', 'STORAGE_DIR', 'There are no accounts yet', 'Cookies: none', 'Analytics, advertising or tracking: none',
      'Automatic deletion is not built yet', 'No accounts, no payments, no sharing and no email']) {
      check(text.includes(phrase), `/privacy says "${phrase}"`);
    }
    check(!/supabase|billing|credit|refund/i.test(text), '/privacy: no Supabase, billing, credits or refunds');
    await page.close();
  }
  {
    const page = await open(browser, base, '/terms');
    const text = await page.locator('main').innerText();
    for (const phrase of ['have not yet been sewn on an embroidery machine by its owner', 'No guarantee is given',
      'your own logo, or one whose owner has given you', 'Do not upload brand logos', 'There are no accounts and no payments yet',
      'These terms will change when accounts and payments are added']) {
      check(text.includes(phrase), `/terms says "${phrase}"`);
    }
    check(!/supabase|billing|credit|refund/i.test(text), '/terms: no Supabase, billing, credits or refunds');
    await page.close();
  }

  console.log('-- blog without posts (what ships)');
  {
    const page = await open(browser, base, '/blog');
    check((await page.locator('.empty-state').innerText()) === 'No posts yet.' && await page.locator('.post-card').count() === 0,
      '/blog: "No posts yet." and no post cards (_example.md is not shown)');
    await page.goto(`${base}/blog/_example`);
    await page.locator('h1').waitFor();
    check((await h1(page)) === 'Post not found', '/blog/_example: not a post');
    await page.close();
  }
} finally {
  server.close();
}

console.log('-- blog with a fixture post (separate build: STITCHBOOK_BLOG_DIR=scripts/fixtures/blog)');
const fixtureDist = join(root, 'dist-blog-fixture');
execFileSync('npx', ['vite', 'build', '--outDir', fixtureDist, '--emptyOutDir', '--logLevel', 'error'], {
  cwd: root, env: { ...process.env, STITCHBOOK_BLOG_DIR: 'scripts/fixtures/blog' }, stdio: 'inherit',
});
const fixtureServer = await serve(fixtureDist);
const fixtureBase = `http://localhost:${fixtureServer.address().port}`;
try {
  const page = await open(browser, fixtureBase, '/blog');
  const cards = await page.locator('.post-card__title').allInnerTexts();
  check(JSON.stringify(cards) === JSON.stringify(['Fixture post for the page tests', 'Older fixture post']),
    `list: newest first, the "_" file left out (${cards.join(' | ')})`);
  check((await page.locator('.post-card').first().innerText()).includes('2000-01-02')
    && (await page.locator('.post-card').first().innerText()).includes('Used only by scripts/pages-tests.mjs'), 'list: date and summary from the frontmatter');
  await page.locator('.post-card').first().click();
  await page.waitForURL(`${fixtureBase}/blog/fixture-post`);
  await page.locator('article h1').waitFor();
  const body = page.locator('.post-body');
  check((await h1(page)) === 'Fixture post for the page tests' && (await page.locator('article .post-meta').innerText()) === '2000-01-02',
    'post: title and date from the frontmatter');
  check(await body.locator('strong').innerText() === 'bold' && await body.locator('em').innerText() === 'italic'
    && await body.locator('h2').innerText() === 'A section heading' && await body.locator('li').count() === 2
    && (await body.locator('a', { hasText: 'link to upload' }).getAttribute('href')) === '/upload',
    'post: Markdown rendered (bold, italic, heading, list, link)');
  check(await page.evaluate(() => window.__injected === undefined) && (await body.innerText()).includes('<script>')
    && await body.locator('a', { hasText: 'unsafe link' }).count() === 0, 'post: HTML shown as text, javascript: links dropped');
  await page.goto(`${fixtureBase}/blog/_hidden`);
  await page.locator('h1').waitFor();
  check((await h1(page)) === 'Post not found', '/blog/_hidden: underscore files are never pages');
  await page.close();
} finally {
  fixtureServer.close();
  await browser.close();
  await rm(fixtureDist, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
