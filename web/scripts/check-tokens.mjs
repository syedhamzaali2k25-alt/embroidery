// Fails if any colour literal appears outside src/css/tokens.css, or if a CSS rule for a focus
// state (:focus, :focus-visible, :focus-within) removes the outline without a replacement
// (a box-shadow ring or another outline in the same rule).
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const allowed = new Set(['src/css/tokens.css']);
const skip = new Set(['node_modules', '.git', 'screenshots', 'scripts', 'dist', 'dist-blog-fixture', 'dist-auth-fixture', 'dist-auth-noclient', 'dist-leak-test', 'dist-team-fixture', 'dist-landing-fixture', 'dist-landing-dev']);
const pattern = /#[0-9a-f]{3,8}\b(?![-\w])|\brgba?\(|\bhsla?\(/gi;

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(css|html|svg|js|jsx|ts|tsx)$/.test(entry.name)) yield path;
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
console.log(bad ? `\n${bad} hard-coded colour(s) found.` : 'No hard-coded colours outside src/css/tokens.css.');

let focusBad = 0;
for await (const file of files(join(root, 'src'))) {
  if (!file.endsWith('.css')) continue;
  const css = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [selector, body] = [m[1].trim(), m[2]];
    // Removing it only for mouse focus (:not(:focus-visible)) keeps it for the keyboard: allowed.
    if (!/:focus/.test(selector) || /:not\(:focus-visible\)/.test(selector)) continue;
    const removes = /(^|;)\s*outline(-style)?\s*:\s*(none|0)\b/.test(body);
    const replaced = /box-shadow\s*:\s*(?!none)/.test(body) || /(^|;)\s*outline\s*:\s*(?!none|0\b)[^;]*\d+px/.test(body);
    if (removes && !replaced) { focusBad++; console.log(`${relative(root, file)}: "${selector}" removes the focus outline with no replacement`); }
  }
}
console.log(focusBad ? `${focusBad} focus rule(s) remove the outline.` : 'No focus rule removes the outline without a replacement.');
process.exitCode = bad || focusBad ? 1 : 0;
