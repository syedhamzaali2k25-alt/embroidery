// Fails if any colour literal appears outside css/tokens.css.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const allowed = new Set(['css/tokens.css']);
const skip = new Set(['node_modules', '.git', 'screenshots', 'scripts']);
const pattern = /#[0-9a-f]{3,8}\b(?![-\w])|\brgba?\(|\bhsla?\(/gi;

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(css|html|svg|js)$/.test(entry.name)) yield path;
  }
}

let bad = 0;
for await (const file of files(root)) {
  const rel = relative(root, file);
  if (allowed.has(rel)) continue;
  (await readFile(file, 'utf8')).split('\n').forEach((line, i) => {
    // Ignore same-document fragment refs such as href="#star".
    const hits = [...line.matchAll(pattern)].filter((m) => !/(href|xlink:href)="$/.test(line.slice(0, m.index)));
    for (const m of hits) { bad++; console.log(`${rel}:${i + 1}  ${m[0]}`); }
  });
}
console.log(bad ? `\n${bad} hard-coded colour(s) found.` : 'No hard-coded colours outside css/tokens.css.');
process.exitCode = bad ? 1 : 0;
