// Browser tests for the editor's tools with a mocked API: stitch type, pull compensation, Split,
// Select Satin Columns, Draw edges, Undo and Redo. Each checks the exact change sent to the API,
// that nothing is shown as done before the server answers, and that a failure shows a plain
// message with Retry that sends the same change again. (The real engine: npm run e2e.)
// Usage: npm run test:editor   (builds first; no server needed)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { allFill, clickAt, crossing, editorFixture, mockEditorApi } from './editor-helpers.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const dist = join(root, 'dist');
const API = 'http://localhost:8000';
const DESIGN = 'c'.repeat(32);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const config = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'config.json'), 'utf8'));
const design = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'design.json'), 'utf8'));
const BOUNDS = editorFixture.shapes.bounds_mm;
const BRANCH = editorFixture.shapes.shapes.find((s) => s.number === 7); // brown branch, satin

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
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const near = (a, b, tol) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

async function open(browser, viewport = { width: 1440, height: 900 }, options = {}) {
  const page = await browser.newPage({ viewport });
  await page.route(`${API}/config`, (r) => r.fulfill({ json: config }));
  await page.route(`${API}/designs/${DESIGN}`, (r) => r.fulfill({ json: { ...design, id: DESIGN, trace_job_id: null } }));
  await page.route(`${API}/jobs/health`, (r) => r.fulfill({ json: { status: 'ok', workers: 1 } }));
  const mock = await mockEditorApi(page, API, DESIGN, options);
  await page.goto(`${base}/editor?design=${DESIGN}`);
  await page.locator('.stitch-line').first().waitFor();
  return { page, mock };
}
const status = (page) => page.locator('.file__state').innerText();
const kindChecked = (page) => page.locator('.segmented[aria-labelledby="stitch-type"] [aria-checked="true"]').innerText();

const browser = await chromium.launch();
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const tag = `${viewport.width}px:`;
    console.log(`-- stitch type, undo, redo (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      check((await page.getByRole('button', { name: /^Undo/ }).isDisabled()) && (await page.getByRole('button', { name: /^Redo/ }).isDisabled()),
        `${tag} Undo and Redo start disabled`);
      await page.getByRole('button', { name: /^Shape 1 / }).click();
      check((await kindChecked(page)) === 'Fill', `${tag} Shape 1 selected: stitch type shows Fill`);
      mock.next = 'hold';
      await page.getByRole('radio', { name: 'Running' }).click();
      await page.getByText('Saving: Change shape 1 to Running').first().waitFor();
      check((await kindChecked(page)) === 'Fill' && (await status(page)).startsWith('Saving'),
        `${tag} while saving, the type still shows Fill (nothing shown as done early)`);
      check(JSON.stringify(mock.bodies.at(-1)) === JSON.stringify({ op: 'set_type', shape: 1, kind: 'running' }),
        `${tag} sends {op: set_type, shape: 1, kind: running}`);
      mock.release();
      await page.waitForFunction(() => document.querySelector('.file__state')?.textContent === 'Saved');
      check((await kindChecked(page)) === 'Running', `${tag} after the server answers: Running`);
      const undo = page.getByRole('button', { name: 'Undo: Change a shape to Running' });
      check(await undo.isEnabled(), `${tag} Undo names the change`);
      mock.next = 'ok';
      await undo.click();
      await page.getByRole('button', { name: 'Redo: Change a shape to Running' }).waitFor();
      check(mock.undos === 1 && (await kindChecked(page)) === 'Fill', `${tag} Undo calls the API and shows Fill again`);
      await page.getByRole('button', { name: 'Redo: Change a shape to Running' }).click();
      await page.getByRole('button', { name: 'Undo: Change a shape to Running' }).waitFor();
      check(mock.redos === 1 && (await kindChecked(page)) === 'Running', `${tag} Redo calls the API and shows Running again`);
      await page.close();
    }

    console.log(`-- pull compensation (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      await page.getByRole('button', { name: /^Shape 7 / }).click();
      const input = page.locator('#pull');
      check((await input.inputValue()) === String(editorFixture.defaults.pull_compensation_mm), `${tag} satin shape: pull compensation shows the config default`);
      await input.fill('5');
      check((await page.getByRole('button', { name: 'Apply' }).isDisabled()) && (await page.locator('#pull-help').innerText()).includes('Enter 0 to 1 mm'),
        `${tag} out of range: Apply disabled with a plain message`);
      await input.fill('0.6');
      await page.getByRole('button', { name: 'Apply' }).click();
      await page.getByRole('button', { name: /Use the default/ }).waitFor();
      check(JSON.stringify(mock.bodies.at(-1)) === JSON.stringify({ op: 'set_pull_compensation', shape: 7, mm: 0.6 }),
        `${tag} sends {op: set_pull_compensation, shape: 7, mm: 0.6}`);
      await page.getByRole('button', { name: /Use the default/ }).click();
      await page.getByRole('button', { name: /Use the default/ }).waitFor({ state: 'detached' });
      check(mock.bodies.at(-1).mm === null, `${tag} "Use the default" sends mm: null`);
      await page.getByRole('button', { name: /^Shape 1 / }).click();
      check(await page.locator('#pull').count() === 0, `${tag} fill shape: no pull compensation control`);
      await page.close();
    }

    console.log(`-- Split (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      await page.getByRole('button', { name: /^Split/ }).click();
      check((await page.locator('.tool-hint').innerText()).includes('click a point on one edge of a satin shape'), `${tag} Split explains the first click`);
      const [a, b] = crossing(BRANCH, -30);
      await clickAt(page, BOUNDS, a);
      check((await page.locator('.tool-hint').innerText()).includes('opposite edge') && await page.locator('.tool-marks__point').count() === 1,
        `${tag} first point placed; asks for the opposite edge`);
      await clickAt(page, BOUNDS, b);
      await page.getByText('Saved: Split a satin shape.').waitFor();
      const sent = mock.bodies.at(-1);
      check(sent.op === 'split' && near(sent.a, a, 0.4) && near(sent.b, b, 0.4),
        `${tag} sends split with the two edge points (a ${sent.a.map((v) => v.toFixed(2))}, b ${sent.b.map((v) => v.toFixed(2))})`);
      await page.close();
    }

    console.log(`-- Select Satin Columns (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      await page.getByRole('button', { name: /^Select Satin Columns/ }).click();
      check(await page.locator('.ring__hit').count() === editorFixture.shapes.shapes.reduce((n, s) => n + s.rings.length, 0),
        `${tag} every outline and hole can be picked`);
      await page.getByRole('button', { name: 'Outline of shape 1' }).focus();
      await page.keyboard.press('Enter');
      check(await page.locator('.ring.is-picked').count() === 1 && (await page.locator('.tool-hint').innerText()).includes('second edge'),
        `${tag} first outline picked; asks for the second edge`);
      await page.getByRole('button', { name: 'Hole 1 of shape 1' }).dispatchEvent('click');
      await page.getByText('Saved: Satin column from two outlines.').waitFor();
      check(JSON.stringify(mock.bodies.at(-1)) === JSON.stringify({ op: 'column', left: { shape: 1, ring: 0 }, right: { shape: 1, ring: 1 } }),
        `${tag} sends a column between shape 1's outline and its hole`);
      await page.close();
    }

    console.log(`-- Draw edges (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      await page.getByRole('button', { name: /^Draw edges/ }).first().click();
      const first = [[-40, -27], [-32, -27.5], [-25, -27]], second = [[-40, -24], [-32, -24.5], [-25, -24]];
      for (const p of first) await clickAt(page, BOUNDS, p);
      check(await page.getByRole('button', { name: 'Finish edge' }).isEnabled(), `${tag} Finish edge after two or more points`);
      await page.getByRole('button', { name: 'Finish edge' }).click();
      check((await page.locator('.tool-hint').innerText()).includes('second side'), `${tag} asks for the second side`);
      await page.locator('.tool-hint select').selectOption('2');
      for (const p of second) await clickAt(page, BOUNDS, p);
      await page.getByRole('button', { name: 'Finish edge' }).click();
      await page.getByText('Saved: Satin column from drawn edges.').waitFor();
      const sent = mock.bodies.at(-1);
      check(sent.op === 'column' && sent.colour === 2 && sent.left.points.length === 3 && sent.right.points.length === 3
        // clicks land on whole screen pixels: about 0.16 mm (desktop) to 0.27 mm (phone) here
        && sent.left.points.every((p, i) => near(p, first[i], 0.3)) && sent.right.points.every((p, i) => near(p, second[i], 0.3)),
      `${tag} sends both drawn edges (mm) and the chosen thread colour`);
      await page.close();
    }

    console.log(`-- Split with no satin shapes (${viewport.width}px)`);
    {
      const { page } = await open(browser, viewport, { transform: allFill });
      const row = page.getByRole('button', { name: /^Split/ });
      check(await row.isDisabled() && (await row.innerText()).includes('No satin shapes in this design'),
        `${tag} Split is disabled and says "No satin shapes in this design"`);
      check(await page.getByRole('button', { name: /^Select Satin Columns/ }).isEnabled(), `${tag} the other tools stay available`);
      await page.close();
    }
    {
      // Split is open while satin shapes exist; once the last one becomes Fill, the tool says so.
      const { page } = await open(browser, viewport);
      await page.getByRole('button', { name: /^Split/ }).click();
      for (const n of editorFixture.shapes.shapes.filter((s) => s.kind === 'satin').map((s) => s.number)) {
        await page.getByRole('button', { name: new RegExp(`^Shape ${n} `) }).click();
        await page.getByRole('radio', { name: 'Fill' }).click();
        await page.getByRole('button', { name: new RegExp(`^Shape ${n} Fill`) }).waitFor();
      }
      check((await page.locator('.tool-hint').innerText()).includes('No satin shapes in this design.')
        && await page.getByRole('button', { name: /^Split/ }).isDisabled(),
      `${tag} after the last satin shape becomes Fill, the open Split tool says "No satin shapes in this design"`);
      await page.close();
    }

    console.log(`-- a "Not saved" banner goes when the person moves on (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      await page.getByRole('button', { name: /^Shape 1 / }).click();
      mock.next = 'fail';
      await page.getByRole('radio', { name: 'Satin' }).click();
      await page.locator('.edit-error').waitFor();
      await page.getByRole('button', { name: /^Shape 2 / }).click();
      check(await page.locator('.edit-error').count() === 0 && (await status(page)) === 'Saved',
        `${tag} picking another shape clears the banner (status back to Saved: nothing was changed)`);
      await page.getByRole('radio', { name: 'Running' }).click();
      await page.locator('.edit-error').waitFor();
      await page.getByRole('button', { name: /^Draw edges/ }).first().click();
      check(await page.locator('.edit-error').count() === 0, `${tag} switching tool clears the banner`);
      await page.close();
    }

    console.log(`-- failures (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      await page.getByRole('button', { name: /^Shape 1 / }).click();
      mock.next = 'fail';
      await page.getByRole('radio', { name: 'Satin' }).click();
      await page.locator('.edit-error').waitFor();
      const text = await page.locator('.edit-error').innerText();
      check(text.includes('Not saved: Change shape 1 to Satin.') && text.includes('(500)') && (await status(page)) === 'Not saved'
        && (await kindChecked(page)) === 'Fill', `${tag} server error: plain message, "Not saved", type unchanged`);
      mock.next = 'ok';
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.locator('.edit-error').waitFor({ state: 'detached' });
      check(mock.bodies.length === 2 && JSON.stringify(mock.bodies[0]) === JSON.stringify(mock.bodies[1]) && (await kindChecked(page)) === 'Satin',
        `${tag} Retry sends the same change again and then shows it`);
      mock.next = 'offline';
      await page.getByRole('radio', { name: 'Fill' }).click();
      await page.locator('.edit-error').waitFor();
      check((await page.locator('.edit-error').innerText()).includes("Can't reach the Stitchbook server"), `${tag} no connection: says so, with Retry`);
      await page.getByRole('button', { name: 'Dismiss' }).click();
      mock.next = 'refuse';
      await page.getByRole('button', { name: /^Split/ }).click();
      const [a] = crossing(BRANCH, -30);
      await clickAt(page, BOUNDS, a);
      await clickAt(page, BOUNDS, [0, -20]);
      await page.locator('.edit-error').waitFor();
      check((await page.locator('.edit-error').innerText()).includes('Click two points on the edge of the same satin shape'),
        `${tag} refused change: the server's reason in plain words`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
