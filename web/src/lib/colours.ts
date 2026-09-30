// Finds the main colours of an image in the browser, for the "Colours to keep" picker.
// These are colours of the user's own picture (data), not design colours.

// Display heuristics for the picker only (they do not affect stitching):
const SAMPLE_SIDE = 160; // image is scaled down to at most this many pixels per side
const BUCKET = 64; // colour channels are grouped in steps of this size (merges anti-aliasing shades)
const MIN_SHARE = 0.02; // colours covering less than 2% of the opaque pixels are ignored
const MAX_COLOURS = 6;

export type ImageColour = { hex: string; share: number };

function toHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function imageColours(url: string): Promise<ImageColour[]> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const scale = Math.min(1, SAMPLE_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(1, Math.round((img.naturalWidth || SAMPLE_SIDE) * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || SAMPLE_SIDE) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue; // transparent: not part of the picture
    opaque++;
    const key = [data[i], data[i + 1], data[i + 2]].map((v) => Math.floor(v / BUCKET)).join(",");
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += data[i];
    bucket.g += data[i + 1];
    bucket.b += data[i + 2];
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .filter((c) => opaque && c.n / opaque >= MIN_SHARE)
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_COLOURS)
    .map((c) => ({ hex: toHex(c.r / c.n, c.g / c.n, c.b / c.n), share: c.n / opaque }));
}
