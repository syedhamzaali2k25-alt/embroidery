// Writes src/assets/hero-design.json, the stitches the landing page's hero draws, from the real
// preview recorded from the API (scripts/fixtures/preview.json: the bird sample at 90 mm, sewn with
// the test-run values). Nothing is invented: the runs are that DST's needle path, in sewing order,
// split at jumps, trims and colour changes, in DST units (0.1 mm).
// Usage: node scripts/make-hero-design.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const preview = JSON.parse(await readFile(join(root, 'scripts', 'fixtures', 'preview.json'), 'utf8'));
const colourOfLayer = new Map(preview.layers.map((l) => [l.number, l.colour]));
const hexOfColour = new Map(preview.colours.map((c) => [c.number, c.hex]));
const units = (mm) => Math.round(mm * 10);

const runs = [];
let prev = null, run = null, stitches = 0;
for (const s of preview.stitches) {
  if (s.command === 'stitch') {
    stitches++;
    const colour = hexOfColour.get(colourOfLayer.get(s.layer));
    if (!run || run.c !== colour) {
      run = { c: colour, p: prev ? [units(prev.x_mm), units(prev.y_mm)] : [] };
      runs.push(run);
    }
    run.p.push(units(s.x_mm), units(s.y_mm));
  } else {
    run = null; // a jump, trim or end breaks the line
  }
  if (s.command === 'stitch' || s.command === 'jump') prev = s;
}
if (stitches !== preview.stats.stitch_count) throw new Error(`stitch count ${stitches} != DST ${preview.stats.stitch_count}`);

const xs = runs.flatMap((r) => r.p.filter((_, i) => i % 2 === 0)), ys = runs.flatMap((r) => r.p.filter((_, i) => i % 2 === 1));
const out = {
  source: 'web/scripts/fixtures/preview.json: digitizer/samples/bird.png at 90 mm, recorded from the API (test-run values)',
  stitch_count: stitches,
  bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  runs,
};
await writeFile(join(root, 'src', 'assets', 'hero-design.json'), JSON.stringify(out) + '\n');
console.log(`wrote src/assets/hero-design.json: ${runs.length} runs, ${stitches} stitches (DST: ${preview.stats.stitch_count})`);
