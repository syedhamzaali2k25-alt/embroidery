// Renders three realistic logo files and exports them the way real files are made (JPEG
// compression, a transparent PNG, a small soft screenshot). Lettering uses the machine's
// generic sans-serif/serif fonts. Test inputs only.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const out = join(root, 'scripts', 'test-images');
const fonts = 'body { margin: 0; }';

const images = [
  {
    file: 'cafe-luna.jpg', width: 900, height: 600, type: 'jpeg', background: 'white',
    html: `<svg width="900" height="600" viewBox="0 0 900 600">
      <circle cx="450" cy="230" r="150" fill="none" stroke="#1d2b4f" stroke-width="22"/>
      <path d="M470 140 A95 95 0 1 0 470 320 A75 75 0 1 1 470 140 Z" fill="#1d2b4f"/>
      <text x="450" y="500" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="92"
            letter-spacing="8" fill="#1d2b4f">CAFÉ LUNA</text></svg>`,
  },
  {
    file: 'fern-studio.png', width: 1000, height: 700, type: 'png', background: 'transparent',
    html: `<svg width="1000" height="700" viewBox="0 0 1000 700">
      <path d="M500 60 C640 140 690 300 520 470 L500 490 L480 470 C310 300 360 140 500 60 Z" fill="#2f6b3a"/>
      <path d="M500 110 L500 470" stroke="white" stroke-width="10" fill="none"/>
      <text x="500" y="630" text-anchor="middle" font-family="serif" font-size="120" fill="#161616">fern studio</text></svg>`,
  },
  {
    file: 'k-monogram-small.png', width: 240, height: 240, type: 'png', background: 'white',
    html: `<div style="filter: blur(1.4px)"><svg width="240" height="240" viewBox="0 0 240 240">
      <rect x="20" y="20" width="200" height="200" rx="40" fill="none" stroke="#111" stroke-width="16"/>
      <text x="120" y="172" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="150" fill="#111">K</text></svg></div>`,
  },
];

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
for (const img of images) {
  const page = await browser.newPage({ viewport: { width: img.width, height: img.height } });
  await page.setContent(`<!doctype html><style>${fonts} html,body{background:${img.background}}</style>${img.html}`);
  await page.screenshot({
    path: join(out, img.file), type: img.type, omitBackground: img.background === 'transparent',
    ...(img.type === 'jpeg' ? { quality: 85 } : {}),
  });
  await page.close();
  console.log('wrote', img.file);
}
await browser.close();
