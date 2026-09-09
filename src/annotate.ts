import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

export interface Box {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

const RED: [number, number, number] = [230, 30, 40];

function setPx(png: PNG, x: number, y: number, c: [number, number, number]) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = c[0];
  png.data[i + 1] = c[1];
  png.data[i + 2] = c[2];
  png.data[i + 3] = 255;
}

function rect(png: PNG, x0: number, y0: number, x1: number, y1: number, thickness = 4) {
  for (let t = 0; t < thickness; t++) {
    for (let x = x0; x <= x1; x++) {
      setPx(png, x, y0 + t, RED);
      setPx(png, x, y1 - t, RED);
    }
    for (let y = y0; y <= y1; y++) {
      setPx(png, x0 + t, y, RED);
      setPx(png, x1 - t, y, RED);
    }
  }
}

/** 5x7 bitmap digits, enough to stamp a finding number onto the crop. */
const DIGITS: Record<string, string[]> = {
  '0': ['11111', '10001', '10001', '10001', '10001', '10001', '11111'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['11111', '00001', '00001', '11111', '10000', '10000', '11111'],
  '3': ['11111', '00001', '00001', '11111', '00001', '00001', '11111'],
  '4': ['10001', '10001', '10001', '11111', '00001', '00001', '00001'],
  '5': ['11111', '10000', '10000', '11111', '00001', '00001', '11111'],
  '6': ['11111', '10000', '10000', '11111', '10001', '10001', '11111'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['11111', '10001', '10001', '11111', '10001', '10001', '11111'],
  '9': ['11111', '10001', '10001', '11111', '00001', '00001', '11111'],
};

function stampNumber(png: PNG, n: number, x: number, y: number, scale = 4) {
  const s = String(n);
  const boxW = s.length * 6 * scale + 8;
  const boxH = 7 * scale + 8;
  for (let yy = y; yy < y + boxH; yy++) for (let xx = x; xx < x + boxW; xx++) setPx(png, xx, yy, RED);
  let cx = x + 4;
  for (const ch of s) {
    const glyph = DIGITS[ch];
    if (!glyph) continue;
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) setPx(png, cx + gx * scale + sx, y + 4 + gy * scale + sy, [255, 255, 255]);
      }
    }
    cx += 6 * scale;
  }
}

/**
 * Draw a numbered red box on the screenshot and crop a window around it, so the report can show
 * the reader exactly where a finding is instead of making them hunt down a 7000px page.
 * Returns null when the box has no usable vertical position.
 */
export function annotateCrop(srcFile: string, box: Box, n: number, outFile: string, pad = 240): { file: string; cropTop: number } | null {
  if (box.y === undefined || !Number.isFinite(box.y)) return null;
  const png = PNG.sync.read(readFileSync(srcFile));
  const y = Math.max(0, Math.min(png.height - 1, Math.round(box.y)));
  const h = Math.max(24, Math.min(box.h ?? 90, png.height - y));
  const x = Math.max(0, Math.round(box.x ?? 0));
  const w = Math.max(24, Math.min(box.w ?? png.width - x, png.width - x));

  rect(png, x, y, Math.min(png.width - 1, x + w), Math.min(png.height - 1, y + h));

  const top = Math.max(0, y - pad);
  const bottom = Math.min(png.height, y + h + pad);
  const cropH = bottom - top;
  const out = new PNG({ width: png.width, height: cropH });
  png.data.copy(out.data, 0, top * png.width * 4, bottom * png.width * 4);
  stampNumber(out, n, 10, Math.max(4, y - top - 46));
  writeFileSync(outFile, PNG.sync.write(out));
  return { file: outFile, cropTop: top };
}
