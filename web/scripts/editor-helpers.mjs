// Shared by the editor browser tests and the screenshot audit: a mocked editor API built on the
// real editor state recorded from the API (fixtures/editor.json), and canvas helpers.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
export const editorFixture = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'editor.json'), 'utf8'));
export const formatsFixture = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'formats.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

const KIND = { running: 'Running', satin: 'Satin', fill: 'Fill' };
function label(edit) {
  if (edit.op === 'set_type') return `Change a shape to ${KIND[edit.kind]}`;
  if (edit.op === 'set_pull_compensation') return edit.mm === null ? 'Reset pull compensation' : `Set pull compensation to ${edit.mm} mm`;
  if (edit.op === 'split') return 'Split a satin shape';
  if (edit.op === 'sublayer') return 'Add a sublayer';
  if (edit.op === 'set_density') return edit.mm === null ? 'Reset density' : `Set density to ${edit.mm} mm`;
  if (edit.op === 'fabric') return edit.preset === null ? 'Fabric preset off' : 'Choose a fabric preset';
  return 'points' in edit.left ? 'Satin column from drawn edges' : 'Satin column from two outlines';
}

/**
 * Mocks /designs/{id}/editor, /edits, /edits/undo, /edits/redo and /formats for `designId`. A change is
 * applied to a copy of the recorded state as far as the page can see (stitch type, pull
 * compensation, history); the real engine is covered by the API tests and npm run e2e.
 * `mock.next` decides the next answer to a change: 'ok' | 'hold' | 'fail' (500) | 'refuse' (422) | 'offline'.
 */
export async function mockEditorApi(page, api, designId, { transform } = {}) {
  const mock = { next: 'ok', bodies: [], undos: 0, redos: 0, release: null, history: [], applied: 0 };
  const base = { ...clone(editorFixture), id: designId };
  transform?.(base); // e.g. a design with no satin shapes
  const state = () => {
    const s = clone(base);
    for (const edit of mock.history.slice(0, mock.applied)) {
      const shape = s.shapes.shapes.find((x) => x.number === edit.shape);
      if (edit.op === 'set_type' && shape) { shape.kind = edit.kind; shape.kind_chosen = true; }
      if (edit.op === 'set_pull_compensation' && shape) shape.pull_compensation_mm = edit.mm;
      if (edit.op === 'fabric') s.fabric.preset = s.shapes.fabric = edit.preset;
      if (edit.op === 'set_density' && shape) shape[shape.kind === 'fill' ? 'fill_spacing_mm' : 'satin_spacing_mm'] = edit.mm;
      if (edit.op === 'sublayer' && shape) { // as far as the page can see: a child shape listed under its parent
        const number = Math.max(...s.shapes.shapes.map((x) => x.number)) + 1;
        s.shapes.shapes.push({ ...clone(shape), number, parent: shape.number, sublayers: [], kind_chosen: false, rings: [edit.points] });
        shape.sublayers = [...(shape.sublayers ?? []), number];
      }
    }
    const n = mock.applied, total = mock.history.length;
    s.history = { applied: n, total, undo: n ? label(mock.history[n - 1]) : null, redo: n < total ? label(mock.history[n]) : null };
    return s;
  };
  await page.route(`${api}/designs/${designId}/editor`, (r) => r.fulfill({ json: state() }));
  await page.route(`${api}/formats`, (r) => r.fulfill({ json: formatsFixture }));
  await page.route(`${api}/designs/${designId}/edits`, (r) => answer(r).catch(() => {
    // a held change released after the page moved on: nothing is waiting for it any more
  }));
  async function answer(r) {
    const body = JSON.parse(r.request().postData());
    mock.bodies.push(body);
    const how = mock.next;
    if (how === 'hold') await new Promise((done) => { mock.release = done; });
    if (how === 'fail') return r.fulfill({ status: 500, json: { error: 'The server answered with an error (500). Try again in a moment.' } });
    if (how === 'refuse') return r.fulfill({ status: 422, json: { error: 'Click two points on the edge of the same satin shape, one on each side.' } });
    if (how === 'offline') return r.abort();
    mock.history = [...mock.history.slice(0, mock.applied), body];
    mock.applied = mock.history.length;
    return r.fulfill({ json: state() });
  }
  await page.route(`${api}/designs/${designId}/edits/undo`, (r) => { mock.undos++; mock.applied--; return r.fulfill({ json: state() }); });
  await page.route(`${api}/designs/${designId}/edits/redo`, (r) => { mock.redos++; mock.applied++; return r.fulfill({ json: state() }); });
  return mock;
}

/** The product config as it is today: every fabric preset value still a placeholder. */
export const noPresetValues = (state) => {
  for (const p of state.fabric.presets) { p.ready = false; p.values = null; }
};

/** A point well inside the bird's body (shape 1, navy), in mm: a sublayer outlined around it stays in the body. */
export const BODY_INSIDE = [14, -7.5];

/** A design with no satin shapes: every satin shape of the recorded bird sewn as fill. */
export const allFill = (state) => {
  for (const s of state.shapes.shapes) if (s.kind === 'satin') s.kind = 'fill';
  state.columns = [];
};

/** mm (design coordinates) -> page pixels, the way the editor canvas fits the design. */
export async function toScreen(page, bounds, [x, y]) {
  return page.evaluate(({ bounds, x, y }) => {
    const [minX, minY, maxX, maxY] = bounds;
    const scale = 360 / Math.max(maxX - minX, maxY - minY, 1);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const svg = document.querySelector('svg.design-canvas');
    const p = new DOMPoint(200 + (x - cx) * scale, 200 + (y - cy) * scale).matrixTransform(svg.getScreenCTM());
    return { x: p.x, y: p.y };
  }, { bounds, x, y });
}

/** Where a vertical line at x crosses a shape's outline: its lowest and highest points (mm). */
export function crossing(shape, x) {
  const ys = [];
  for (const ring of shape.rings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
      if ((x0 - x) * (x1 - x) <= 0 && x0 !== x1) ys.push(y0 + ((x - x0) / (x1 - x0)) * (y1 - y0));
    }
  }
  return [[x, Math.min(...ys)], [x, Math.max(...ys)]];
}

/** Click at a design point (mm) on the editor canvas. */
export async function clickAt(page, bounds, mm) {
  await page.evaluate(() => document.querySelector('svg.design-canvas').scrollIntoView({ block: 'center' }));
  const p = await toScreen(page, bounds, mm);
  await page.mouse.click(p.x, p.y);
}
