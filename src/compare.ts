import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { MediaRegion } from './browser.js';

export interface DiffResult {
  /** no approved baseline for this viewport yet */
  noBaseline: boolean;
  changedPixels: number;
  /** path to the diff PNG (only when changed) */
  diffFile?: string;
  /** baseline and current image heights — a height change alone is a layout change */
  baselineHeight: number;
  currentHeight: number;
  /** rows (y ranges) where change concentrates, for the report */
  hotspots: Array<{ y: number; h: number }>;
  changed: boolean;
}

/**
 * Same lesson as v1's Playwright config: an ABSOLUTE pixel budget, never a ratio.
 * A ratio scales with image area, so a tall mobile page would tolerate thousands of changed
 * pixels and a real 12px shift slips through.
 */
const MAX_CHANGED_PIXELS = 150;

/** Paint media regions (video/iframe/canvas) magenta in both images so they can never differ. */
function maskMedia(png: PNG, regions: MediaRegion[]) {
  for (const r of regions) {
    if (r.kind !== 'video' && r.kind !== 'iframe' && r.kind !== 'canvas') continue;
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(png.width, r.x + r.w);
    const y1 = Math.min(png.height, r.y + r.h);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4;
        png.data[i] = 255;
        png.data[i + 1] = 0;
        png.data[i + 2] = 255;
        png.data[i + 3] = 255;
      }
    }
  }
}

/** Pad the shorter image with white so both have the same size; the height delta is itself evidence. */
function padTo(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  out.data.fill(255);
  for (let y = 0; y < Math.min(png.height, height); y++) {
    const srcStart = y * png.width * 4;
    const rowLen = Math.min(png.width, width) * 4;
    png.data.copy(out.data, y * width * 4, srcStart, srcStart + rowLen);
  }
  return out;
}

export function compare(baselineFile: string | undefined, currentFile: string, media: MediaRegion[], diffOut: string): DiffResult {
  const cur = PNG.sync.read(readFileSync(currentFile));
  if (!baselineFile || !existsSync(baselineFile)) {
    return { noBaseline: true, changedPixels: 0, baselineHeight: 0, currentHeight: cur.height, hotspots: [], changed: false };
  }
  const base = PNG.sync.read(readFileSync(baselineFile));
  const width = Math.max(base.width, cur.width);
  const height = Math.max(base.height, cur.height);
  const a = padTo(base, width, height);
  const b = padTo(cur, width, height);
  maskMedia(a, media);
  maskMedia(b, media);

  const diff = new PNG({ width, height });
  const changedPixels = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.15, includeAA: false, diffColor: [255, 0, 0], alpha: 0.35 });

  const changed = changedPixels > MAX_CHANGED_PIXELS || Math.abs(base.height - cur.height) > 8;
  let diffFile: string | undefined;
  const hotspots: DiffResult['hotspots'] = [];
  if (changed) {
    writeFileSync(diffOut, PNG.sync.write(diff));
    diffFile = diffOut;
    // Find the rows where red pixels concentrate — tells the reader where to look.
    const rowCounts = new Array<number>(height).fill(0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) rowCounts[y]++;
      }
    }
    let start = -1;
    for (let y = 0; y <= height; y++) {
      const hot = y < height && rowCounts[y] > 2;
      if (hot && start === -1) start = y;
      if (!hot && start !== -1) {
        if (y - start >= 3) hotspots.push({ y: start, h: y - start });
        start = -1;
      }
    }
  }
  return { noBaseline: false, changedPixels, diffFile, baselineHeight: base.height, currentHeight: cur.height, hotspots: mergeClose(hotspots).slice(0, 12), changed };
}

/** Hotspots within 40px of each other are one region to a human. */
function mergeClose(list: Array<{ y: number; h: number }>) {
  const out: Array<{ y: number; h: number }> = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.y - (last.y + last.h) < 40) last.h = r.y + r.h - last.y;
    else out.push({ ...r });
  }
  return out;
}
