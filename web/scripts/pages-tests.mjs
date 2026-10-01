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
  await page.locator('footer .footer__cols').waitFor(); // every public page has the footer
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
      check((await h1(page)) === title && await noSideScroll(page) && await page.locator('footer .footer__link').count() === 7,
        `${width}px ${path}: "${title}", footer with 7 links, no sideways scroll`);
      await page.close();
    }
  }

  // Where each footer link goes, and what shows there.
  const FOOTER = [
    ['Product', '/upload', 'Upload a logo', { h1: 'Upload your logo' }],
    ['Product', '/#how', 'How it works', { section: 'how' }],
    ['Product', '/#faq', 'FAQ', { section: 'faq' }],
    ['Company', '/contact', 'Contact', { h1: 'Contact' }],
    ['Company', '/blog', 'Blog', { h1: 'Blog' }],
    ['Legal', '/privacy', 'Privacy', { h1: 'Privacy' }],
    ['Legal', '/terms', 'Terms of Service', { h1: 'Terms of Service' }],
  ];

  console.log('-- footer layout: about line, three columns, copyright line');
  for (const [width, columns] of [[1440, 3], [1366, 3], [390, 2], [320, 1]]) {
    const page = await open(browser, base, '/privacy', { width, height: 800 });
    const footer = page.locator('footer');
    const tops = await footer.locator('.footer__col').evaluateAll((cols) => cols.map((c) => Math.round(c.getBoundingClientRect().top)));
    const perRow = tops.filter((t) => t === tops[0]).length;
    check(perRow === columns && await noSideScroll(page), `${width}px: ${columns} link column(s) per row, no sideways scroll`);
    const heights = await footer.locator('.footer__link').evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height));
    if (width <= 390) check(heights.every((h) => h >= 44), `${width}px: every footer link is at least 44px tall (${Math.min(...heights)}px)`);
    const size = await footer.locator('.footer__link').first().evaluate((a) => parseFloat(getComputedStyle(a).fontSize));
    check(size >= 16 && size <= 17, `${width}px: footer link text ${size}px`);
    await page.close();
  }
  {
    const page = await open(browser, base, '/blog');
    const footer = page.locator('footer');
    const headings = await footer.locator('.footer__heading').allInnerTexts();
    const groups = await footer.locator('.footer__col').evaluateAll((cols) => cols.map((c) => [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'))));
    check(JSON.stringify(headings) === JSON.stringify(['Product', 'Company', 'Legal'])
      && JSON.stringify(groups) === JSON.stringify([['/upload', '/#how', '/#faq'], ['/contact', '/blog'], ['/privacy', '/terms']]),
      'columns: Product (Upload a logo, How it works, FAQ), Company (Contact, Blog), Legal (Privacy, Terms of Service)');
    check((await footer.locator('.footer__tagline').innerText()) === 'Turn a PNG or JPG logo into an embroidery file.', 'about line: only what the product does today');
    await footer.locator('.footer__copy .not-chosen').waitFor();
    check((await footer.locator('.footer__copy').innerText()).replace(/\s+/g, ' ') === `© ${new Date().getFullYear()} Not chosen yet`
      && (await footer.locator('.footer__note').innerText()) === 'Made for people who sew.', `bottom row: "© ${new Date().getFullYear()} Not chosen yet" marker, "Made for people who sew."`);
    const style = await footer.evaluate((f) => {
      const s = getComputedStyle(f), inner = getComputedStyle(f.querySelector('.footer__inner'));
      return { bg: s.backgroundColor, body: getComputedStyle(document.body).backgroundColor, border: s.borderTopWidth, top: inner.paddingTop, bottom: inner.paddingBottom };
    });
    check(style.bg !== style.body && style.border === '1px' && style.top === '64px' && style.bottom === '40px',
      `desktop: own light background, 1px top border, 64px / 40px padding (${style.top} / ${style.bottom})`);
    await page.close();
  }
  {
    const page = await open(browser, base, '/contact', { site: CHOSEN });
    await page.locator('footer .footer__copy').getByText('Example Owner').waitFor();
    check(await page.locator('footer .footer__copy .not-chosen').count() === 0, `bottom row with company_name chosen: "© ${new Date().getFullYear()} Example Owner"`);
    await page.close();
  }

  {
    const page = await (await browser.newContext()).newPage();
    await page.route(`${API}/**`, (r) => r.abort());
    await page.goto(`${base}/editor`);
    await page.locator('h1').waitFor();
    check(await page.locator('footer.footer').count() === 0, '/editor: no site footer');
    await page.close();
  }

  console.log('-- footer links work from every public page');
  for (const from of ['/', '/upload', '/preview', '/privacy', '/terms', '/contact', '/blog']) {
    const page = await open(browser, base, from);
    const hrefs = await page.locator('footer .footer__link').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    check(JSON.stringify(hrefs) === JSON.stringify(FOOTER.map((f) => f[1])), `${from}: all 7 footer links`);
    for (const [, href, label, expect] of FOOTER) {
      await page.locator('footer .footer__link', { hasText: new RegExp(`^${label}$`) }).click();
      await page.waitForURL(`${base}${href}`);
      let shown;
      if (expect.h1) { // loaded on demand: wait for its own heading, not the one still on screen
        shown = await page.locator('h1', { hasText: new RegExp(`^${expect.h1}$`) }).waitFor({ timeout: 10000 }).then(() => true, () => false);
      } else { // a landing section, scrolled into view
        shown = await page.waitForFunction((id) => {
          const r = document.getElementById(id)?.getBoundingClientRect();
          return !!r && r.top < innerHeight && r.bottom > 0 && Math.abs(r.top) < 80;
        }, expect.section, { timeout: 10000 }).then(() => true, () => false);
      }
      check(shown, `${from} -> ${label}: ${href} ${expect.h1 ? `shows "${expect.h1}"` : `scrolls to #${expect.section}`}`);
      await page.goto(`${base}${from}`);
      await page.locator('footer .footer__link').first().waitFor();
    }
    await page.close();
  }

  console.log('-- not chosen yet: a plain marker, never a made-up value');
  for (const path of ['/privacy', '/terms']) {
    const page = await open(browser, base, path);
    await page.locator('main .not-chosen').first().waitFor();
    const banner = await page.locator('.draft-banner').innerText();
    const markers = await page.locator('main .not-chosen').allInnerTexts();
    check(banner.includes('Draft: not yet reviewed by a lawyer.') && /Last updated:\s*Not chosen yet/.test(banner),
      `${path}: draft banner, "Last updated: Not chosen yet"`);
    check(markers.length >= 3 && markers.every((m) => m === 'Not chosen yet'), `${path}: ${markers.length} "Not chosen yet" markers`);
    check(await page.locator('a[href^="mailto:"]').count() === 0, `${path}: no email link while none is chosen`);
    await page.close();
  }
  {
    const page = await open(browser, base, '/contact');
    await page.locator('main .not-chosen').waitFor();
    check((await page.locator('main .not-chosen').innerText()) === 'Contact email not chosen yet'
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
    check(await page.locator('main .not-chosen').count() === 0 && expected.every((v) => text.includes(v)),
      `${path}: chosen values shown (${expected.join(', ')}), no markers`);
    await page.close();
  }
  {
    const page = await open(browser, base, '/privacy', { site: 'down' });
    await page.locator('main .not-chosen').first().waitFor();
    check((await page.locator('main .not-chosen').first().innerText()).startsWith('Not loaded'), '/privacy with the server down: says not loaded, invents nothing');
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
