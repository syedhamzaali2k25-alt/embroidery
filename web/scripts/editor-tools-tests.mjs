// Browser tests for the editor's tools with a mocked API: stitch type, sliders (pull compensation, density),
// Sublayers, the Export card, header chips and Close, fabric preset, the
// Layers eye in the Stitches view, Split,
// Select Satin Columns, Draw edges, Undo and Redo. Each checks the exact change sent to the API,
// that nothing is shown as done before the server answers, and that a failure shows a plain
// message with Retry that sends the same change again. (The real engine: npm run e2e.)
// Usage: npm run test:editor   (builds first; no server needed)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { allFill, BODY_INSIDE, clickAt, crossing, editorFixture, formatsFixture, mockEditorApi, noPresetValues } from './editor-helpers.mjs';

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
      await page.locator('.file__state[title="Saving: Change shape 1 to Running"]').waitFor();
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

    console.log(`-- sliders: pull compensation and density (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      const d = editorFixture.defaults;
      await page.getByRole('button', { name: /^Shape 7 / }).click(); // satin
      const pull = page.locator('#pull'), density = page.locator('#density');
      check((await pull.getAttribute('type')) === 'range' && Number(await pull.getAttribute('min')) === d.pull_compensation_min_mm
        && Number(await pull.getAttribute('max')) === d.pull_compensation_max_mm && Number(await pull.inputValue()) === d.pull_compensation_mm,
        `${tag} satin shape: pull compensation slider from ${d.pull_compensation_min_mm} to ${d.pull_compensation_max_mm} mm, at the default`);
      check((await page.locator('#pull-range').innerText()).replace(/\s+/g, ' ') === `min ${d.pull_compensation_min_mm} mm max ${d.pull_compensation_max_mm} mm`,
        `${tag} the slider shows config.py's min and max`);
      check(Number(await density.getAttribute('min')) === d.satin_spacing_min_mm && Number(await density.getAttribute('max')) === d.satin_spacing_max_mm,
        `${tag} satin shape: density slider uses the satin spacing range (${d.satin_spacing_min_mm}-${d.satin_spacing_max_mm} mm)`);
      await pull.fill('0.6'); // moving and letting go
      await page.getByRole('button', { name: /Use the default/ }).first().waitFor();
      check(JSON.stringify(mock.bodies.at(-1)) === JSON.stringify({ op: 'set_pull_compensation', shape: 7, mm: 0.6 }),
        `${tag} letting go of the slider sends {op: set_pull_compensation, shape: 7, mm: 0.6}`);
      await page.getByRole('button', { name: /Use the default/ }).first().click();
      await page.waitForFunction(() => document.querySelector('.file__state')?.textContent === 'Saved');
      check(mock.bodies.at(-1).mm === null, `${tag} "Use the default" sends mm: null`);
      await density.fill('0.5');
      await page.waitForFunction(() => document.querySelector('.file__state')?.textContent === 'Saved');
      check(JSON.stringify(mock.bodies.at(-1)) === JSON.stringify({ op: 'set_density', shape: 7, mm: 0.5 }),
        `${tag} density slider sends {op: set_density, shape: 7, mm: 0.5}`);
      await page.getByRole('button', { name: /^Shape 1 / }).click(); // fill
      check(await pull.count() === 0 && Number(await density.getAttribute('min')) === d.fill_row_spacing_min_mm
        && Number(await density.getAttribute('max')) === d.fill_row_spacing_max_mm,
        `${tag} fill shape: no pull compensation; density uses the fill range (${d.fill_row_spacing_min_mm}-${d.fill_row_spacing_max_mm} mm)`);
      await page.close();
    }

    console.log(`-- Sublayers (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      await page.getByRole('button', { name: /^Shape 1 / }).click();
      const add = page.getByRole('button', { name: '+ Sublayer' });
      const sublayersBelowType = await page.evaluate(() => {
        const type = document.querySelector('[aria-labelledby="stitch-type"]'), list = document.querySelector('#sublayers-title');
        return !!type && !!list && (type.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      check(sublayersBelowType && (await add.evaluate((el) => getComputedStyle(el).borderStyle)) === 'dashed',
        `${tag} the Sublayers list sits under the stitch type, with a dashed "+ Sublayer" row`);
      await add.click();
      check((await page.locator('.tool-hint').innerText()).includes('Sublayer of shape 1: click around the part'), `${tag} "+ Sublayer" asks for the part's outline`);
      const [cx, cy] = BODY_INSIDE;
      for (const p of [[cx - 2.5, cy - 2.5], [cx + 2.5, cy - 2.5], [cx + 2.5, cy + 2.5]]) await clickAt(page, BOUNDS, p);
      await page.getByRole('button', { name: 'Finish sublayer' }).click();
      await page.getByRole('button', { name: /^Shape 10/ }).first().waitFor();
      const sent = mock.bodies.at(-1);
      check(sent.op === 'sublayer' && sent.shape === 1 && sent.points.length === 3 && near(sent.points[0], [cx - 2.5, cy - 2.5], 0.5),
        `${tag} sends {op: sublayer, shape: 1, points: the three clicks in mm}`);
      check(await page.locator('.sublayers .sublayer:not(.sublayer--add)').count() === 1, `${tag} the new sublayer is listed under shape 1`);
      await page.locator('.sublayers .sublayer:not(.sublayer--add)').click();
      check((await page.locator('.panel').innerText()).includes('This is a sublayer of shape 1') && await page.locator('#density').count() === 1,
        `${tag} picking it shows its own stitch type and sliders, and says whose sublayer it is`);
      await page.close();
    }

    console.log(`-- Export card (${viewport.width}px)`);
    {
      const { page } = await open(browser, viewport);
      const downloads = [];
      page.on('request', (r) => { if (r.url().includes('/download')) downloads.push(r.url()); });
      const card = page.locator('.export-card');
      const checked = () => card.locator('[role=radio][aria-checked=true]').innerText();
      const offered = formatsFixture.formats, refused = formatsFixture.unavailable.map((u) => u.format);
      check(offered.join() === 'dst' && (await checked()) === 'DST', `${tag} DST is offered and picked (GET /formats: ${offered.join(', ')})`);
      for (const f of refused) {
        const btn = card.getByRole('radio', { name: f.toUpperCase() });
        await btn.click({ force: true });
        check((await btn.getAttribute('aria-disabled')) === 'true' && (await checked()) === 'DST', `${tag} ${f.toUpperCase()} cannot be selected`);
      }
      const pes = card.getByRole('radio', { name: 'PES' });
      await pes.hover();
      const tip = page.locator('#why-pes');
      check(await tip.isVisible() && (await tip.innerText()) === formatsFixture.unavailable.find((u) => u.format === 'pes').reason,
        `${tag} hovering PES shows why: "${(await tip.innerText()).slice(0, 60)}..."`);
      const link = card.getByRole('link', { name: 'Export file' });
      check((await link.getAttribute('href')).endsWith('/download?format=dst') && downloads.length === 0,
        `${tag} "Export file" downloads DST; nothing asks for another format`);
      await page.close();
    }

    console.log(`-- header chips and Close (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      check((await status(page)) === 'Saved' && await page.locator('.chip--private').isVisible(), `${tag} chips: Saved and Private`);
      await page.locator('.chip--private').focus();
      check((await page.locator('#private-tip').innerText()).includes('no sharing yet'), `${tag} Private explains itself (read-only, no sharing yet)`);
      await page.locator('.chip--private').evaluate((el) => el.blur());

      // A change still saving: Close waits for it, then goes Home.
      await page.getByRole('button', { name: /^Shape 1 / }).click();
      mock.next = 'hold';
      await page.getByRole('radio', { name: 'Running' }).click();
      await page.waitForFunction(() => document.querySelector('.file__state')?.textContent === 'Saving…');
      await page.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('alertdialog').waitFor();
      check((await page.getByRole('alertdialog').innerText()).includes('Saving your last change') && page.url().includes('/editor'),
        `${tag} Close while saving: stays and says it is waiting for the save`);
      mock.release();
      await page.waitForURL(/\/home$/);
      check(mock.bodies.length === 1 && mock.applied === 1, `${tag} ...then goes Home once the change is saved (nothing lost)`);
      await page.close();
    }
    {
      const { page, mock } = await open(browser, viewport);
      await page.getByRole('button', { name: /^Shape 1 / }).click();
      mock.next = 'fail';
      await page.getByRole('radio', { name: 'Satin' }).click();
      await page.locator('.edit-error').waitFor();
      check((await status(page)) === 'Error' && await page.locator('.chip--action', { hasText: 'Retry' }).isVisible(), `${tag} a failed save: Error chip with Retry`);
      await page.getByRole('button', { name: 'Close' }).click();
      const dialog = page.getByRole('alertdialog');
      check((await dialog.innerText()).includes('Your last change is not saved') && page.url().includes('/editor'), `${tag} Close after a failed save asks inside the page`);
      await dialog.getByRole('button', { name: 'Stay here' }).click();
      check(await dialog.count() === 0 && page.url().includes('/editor'), `${tag} Stay here keeps the editor open`);
      await page.getByRole('button', { name: 'Close' }).click();
      mock.next = 'ok';
      await dialog.getByRole('button', { name: 'Retry, then close' }).click();
      await page.waitForURL(/\/home$/);
      check(mock.bodies.length === 2 && JSON.stringify(mock.bodies[0]) === JSON.stringify(mock.bodies[1]) && mock.applied === 1,
        `${tag} Retry, then close: the same change is saved first, then Home`);
      await page.close();
    }
    {
      const { page } = await open(browser, viewport);
      await page.getByRole('button', { name: 'Close' }).click();
      await page.waitForURL(/\/home$/);
      check(true, `${tag} Close with nothing pending goes straight Home`);
      await page.close();
    }

    console.log(`-- fabric preset (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      const picker = page.locator('#fabric');
      const note = page.locator('.fabric .fabric__status');
      check((await picker.inputValue()) === '' && (await note.innerText()) === 'Unverified: not yet tested on a machine',
        `${tag} picker starts on None, with "Unverified: not yet tested on a machine" next to it`);
      const box = async (l) => (await l.boundingBox());
      const [pb, nb] = [await box(picker), await box(note)];
      check(nb.y < pb.y + pb.height + 40, `${tag} the Unverified note sits right by the picker`);
      mock.next = 'hold';
      await picker.selectOption('knit_jersey');
      await page.locator('.file__state[title="Saving: Choose the Knit / jersey preset"]').waitFor();
      check((await picker.inputValue()) === '', `${tag} while saving, the picker still shows None (nothing shown as done early)`);
      check(JSON.stringify(mock.bodies.at(-1)) === JSON.stringify({ op: 'fabric', preset: 'knit_jersey' }),
        `${tag} sends {op: fabric, preset: knit_jersey} through the same edit path`);
      mock.release();
      await page.waitForFunction(() => document.querySelector('.file__state')?.textContent === 'Saved');
      const help = await page.locator('#fabric-help').innerText();
      check((await picker.inputValue()) === 'knit_jersey' && (await note.isVisible()) && help.startsWith('Fill spacing'),
        `${tag} after the server answers: Knit / jersey chosen, its values listed, still marked Unverified`);
      const rest = (await page.locator('.panel').innerText()).replaceAll('Unverified: not yet tested on a machine', '');
      check(!/tested|verified/i.test(rest), `${tag} nothing else on the panel calls a preset tested or verified`);
      check(await page.getByRole('button', { name: 'Undo: Choose a fabric preset' }).isEnabled(), `${tag} Undo names the preset change`);
      mock.next = 'ok';
      await picker.selectOption('');
      await page.getByRole('button', { name: 'Undo: Fabric preset off' }).waitFor();
      check(mock.bodies.at(-1).preset === null && (await picker.inputValue()) === '', `${tag} None sends preset: null`);
      await page.close();
    }
    {
      const { page } = await open(browser, viewport, { transform: noPresetValues });
      const disabled = await page.locator('#fabric option:disabled').allInnerTexts();
      check((await page.locator('#fabric').isDisabled()) && disabled.length === 3 && disabled.every((t) => t.endsWith('(no values yet)'))
        && (await page.locator('#fabric-help').innerText()) === 'No preset has values yet, so none can be chosen.',
        `${tag} presets without values (the product config today): listed, not choosable, says so`);
      check(await page.locator('.fabric__status').isVisible(), `${tag} ...and still marked Unverified`);
      await page.close();
    }

    console.log(`-- the Layers eye in the Stitches view (${viewport.width}px)`);
    {
      const { page, mock } = await open(browser, viewport);
      // Stitch segments drawn per thread colour (data-colour), and every request the page sends from here on.
      const drawn = () => page.$$eval('.stitch-line', (ps) => Object.fromEntries(ps.map((p) => [p.dataset.colour, (p.getAttribute('d').match(/M/g) || []).length])));
      const sent = [];
      page.on('request', (r) => { if (r.url().startsWith(API)) sent.push(`${r.method()} ${r.url()}`); });
      check((await page.getByRole('radio', { name: 'Stitches' }).getAttribute('aria-checked')) === 'true', `${tag} the editor opens in the Stitches view`);
      const download = await page.getByRole('link', { name: 'Export file' }).getAttribute('href');
      const before = await drawn();
      const others = (after, except) => Object.keys(before).every((c) => c === except || after[c] === before[c]);

      await page.getByRole('button', { name: 'Hide Shape 7', exact: true }).click(); // the branch: all of colour 5
      const noBranch = await drawn();
      check(before['5'] > 0 && !('5' in noBranch) && others(noBranch, '5'),
        `${tag} hiding shape 7 removes all its ${before['5']} stitch segments from the Stitches view; every other colour unchanged`);
      await page.getByRole('button', { name: 'Hide Shape 4', exact: true }).click(); // one of three shapes in colour 4
      const noLeaf = await drawn();
      check(noLeaf['4'] > 0 && noLeaf['4'] < before['4'] && ['1', '2', '3', '6', '7'].every((c) => noLeaf[c] === before[c]),
        `${tag} hiding shape 4 removes only its stitches from colour 4 (${before['4']} -> ${noLeaf['4']} segments)`);
      await page.getByRole('button', { name: 'Show Shape 7', exact: true }).click();
      await page.getByRole('button', { name: 'Show Shape 4', exact: true }).click();
      check(JSON.stringify(await drawn()) === JSON.stringify(before), `${tag} showing them again draws exactly the same stitches as before`);

      check(sent.length === 0 && mock.bodies.length === 0, `${tag} hiding and showing sends nothing to the server (a view setting only)`);
      check((await page.getByRole('link', { name: 'Export file' }).getAttribute('href')) === download
        && (await page.locator('.stats').innerText()).includes(editorFixture.stats.stitch_count.toLocaleString('en')),
        `${tag} Download link and stitch count unchanged`);
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
      check(text.includes('Not saved: Change shape 1 to Satin.') && text.includes('(500)') && (await status(page)) === 'Error'
        && (await kindChecked(page)) === 'Fill', `${tag} server error: plain message, "Not saved" banner, Error chip, type unchanged`);
      mock.next = 'ok';
      await page.locator('.edit-error').getByRole('button', { name: 'Retry' }).click();
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
